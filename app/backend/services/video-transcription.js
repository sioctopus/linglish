const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const aiConfig = require('../config/ai-config');
const dataStore = require('../data-store');
const baiduAsr = require('./baidu-asr');
const { mergeIncompleteSegments, normalizeSegmentsTiming } = require('../utils/segment-merger');

let openaiClient = null;
let openaiWhisperClient = null;
let geminiApiKey = null;
let localWhisperChecked = false;
let localWhisperAvailable = false;

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  if (!aiConfig.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  openaiClient = new OpenAI({
    apiKey: aiConfig.openai.apiKey,
    baseURL: aiConfig.openai.baseURL,
  });

  return openaiClient;
}

function resolveWhisperCredentials() {
  const cfg = getSpeechConfig();
  const directKey = process.env.OPENAI_WHISPER_API_KEY || aiConfig.openai.apiKey;
  if (directKey) {
    return {
      apiKey: directKey,
      baseURL: process.env.OPENAI_WHISPER_API_BASE || 'https://api.openai.com/v1',
      model: process.env.OPENAI_WHISPER_MODEL || cfg.model || 'whisper-1',
      via: 'openai',
    };
  }
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    return {
      apiKey: openRouterKey,
      baseURL: process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_WHISPER_MODEL || 'qwen/qwen3-asr-0.6b',
      via: 'openrouter',
    };
  }
  return null;
}

function getOpenAIWhisperClient() {
  if (openaiWhisperClient) return openaiWhisperClient;

  const creds = resolveWhisperCredentials();
  if (!creds) {
    throw new Error('OPENAI_WHISPER_API_KEY / OPENAI_API_KEY is not configured');
  }

  // Important: Disable proxy for Whisper API calls
  // OpenAI SDK (v4+) uses fetch API which respects HTTPS_PROXY env var
  // Temporarily disable proxy by clearing the env var during initialization
  const savedProxy = process.env.HTTPS_PROXY;
  const savedProxy2 = process.env.HTTP_PROXY;
  const savedOpenAIProxy = process.env.OPENAI_PROXY;

  try {
    // Temporarily clear proxy env vars
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.OPENAI_PROXY;

    openaiWhisperClient = new OpenAI({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      timeout: Number(process.env.OPENAI_WHISPER_TIMEOUT_MS) || 600000,
      maxRetries: 2,
      defaultHeaders: creds.via === 'openrouter'
        ? {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://linglish.app',
          'X-Title': process.env.OPENROUTER_APP_TITLE || 'Linglish',
        }
        : undefined,
    });
    openaiWhisperClient.__linglishWhisperModel = creds.model;
    openaiWhisperClient.__linglishWhisperVia = creds.via;

    console.log('[Whisper Client] Initialized with baseURL:', creds.baseURL, 'via:', creds.via, '(proxy disabled)');
  } finally {
    // Restore proxy env vars
    if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
    if (savedProxy2) process.env.HTTP_PROXY = savedProxy2;
    if (savedOpenAIProxy) process.env.OPENAI_PROXY = savedOpenAIProxy;
  }

  return openaiWhisperClient;
}

function getGeminiApiKey() {
  if (geminiApiKey) return geminiApiKey;
  geminiApiKey = process.env.GEMINI_API_KEY || aiConfig.gemini?.apiKey;
  return geminiApiKey;
}

function hasGeminiCredentials() {
  const key = getGeminiApiKey();
  return Boolean(key);
}

function getSpeechConfig() {
  return aiConfig.speechToText || {};
}

function hasBaiduCredentials() {
  const cfg = getSpeechConfig().baidu || {};
  return Boolean(cfg.apiKey && cfg.secretKey);
}

/**
 * 将文本分割成句子
 * 用于Gemini等不提供时间戳分段的转录服务
 */
function splitIntoSentences(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // 按句号、问号、感叹号分割，保留标点符号
  // 支持中英文标点
  const sentenceEnders = /([.!?。!?]+)/g;
  const parts = text.split(sentenceEnders);

  const sentences = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i]?.trim();
    const punctuation = parts[i + 1] || '';

    if (content) {
      sentences.push((content + punctuation).trim());
    }
  }

  // 如果没有找到句子分隔符，返回整个文本作为一个句子
  if (sentences.length === 0 && text.trim()) {
    return [text.trim()];
  }

  return sentences.filter(s => s.length > 0);
}

function inferSpeakerIdFromWords(wordItems) {
  if (!Array.isArray(wordItems) || wordItems.length === 0) return null;
  const counts = new Map();
  for (const item of wordItems) {
    if (!item || typeof item !== 'object') continue;
    const raw =
      item.speaker ??
      item.spk ??
      item.speaker_id ??
      item.speakerId ??
      item.speakerID;
    if (raw === null || raw === undefined || raw === '') continue;
    const key = String(raw);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function extractWordItems(seg) {
  if (!seg || typeof seg !== 'object') return [];

  const candidates = [
    seg.words,
    seg.word_timestamps,
    seg.wordTimestamps,
    seg.tokens,
    seg.result?.words,
    seg.result?.word_timestamps,
    seg.result?.wordTimestamps,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.words) && candidate.words.length) {
      return candidate.words;
    }
  }

  return [];
}

function normalizeWordItem(item) {
  if (!item || typeof item !== 'object') return null;
  const textRaw = item.word ?? item.text ?? item.token ?? item.w;
  const text = typeof textRaw === 'string' ? textRaw : '';
  const start = Number(item.start ?? item.s ?? item.begin ?? item.t0 ?? item.ts ?? item.time_start);
  const end = Number(item.end ?? item.e ?? item.finish ?? item.t1 ?? item.te ?? item.time_end);
  const speaker =
    item.speaker ??
    item.spk ??
    item.speaker_id ??
    item.speakerId ??
    item.speakerID;
  const speakerId = speaker === null || speaker === undefined || speaker === '' ? null : String(speaker);

  return {
    text: text.trim(),
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    speaker: speakerId,
  };
}

function joinWordTokens(tokens) {
  const out = [];
  for (const raw of tokens) {
    const t = (raw || '').trim();
    if (!t) continue;
    if (out.length === 0) {
      out.push(t);
      continue;
    }
    if (/^[,.;:!?)]/.test(t)) {
      out[out.length - 1] = out[out.length - 1] + t;
      continue;
    }
    if (/^'/.test(t)) {
      out[out.length - 1] = out[out.length - 1] + t;
      continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

function splitSegmentBySpeakerWords(seg) {
  const wordsRaw = extractWordItems(seg);
  if (!wordsRaw.length) return null;

  const words = wordsRaw.map(normalizeWordItem).filter((w) => w && w.text);
  if (!words.length) return null;

  const speakers = new Set(words.map((w) => w.speaker).filter((s) => s));
  if (speakers.size <= 1) return null;

  // Only split if we have at least some usable word timings.
  const hasTimings = words.some((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  if (!hasTimings) return null;

  const chunks = [];
  let current = null;

  for (const w of words) {
    const speaker = w.speaker || null;
    if (!current) {
      current = { speaker, words: [w] };
      continue;
    }
    if (current.speaker === speaker) {
      current.words.push(w);
      continue;
    }
    chunks.push(current);
    current = { speaker, words: [w] };
  }
  if (current) chunks.push(current);

  const baseStart = Number(seg.start ?? 0);
  const baseEnd = Number(seg.end ?? baseStart);
  const results = [];

  for (const chunk of chunks) {
    const wordStarts = chunk.words.map((x) => x.start).filter((n) => Number.isFinite(n));
    const wordEnds = chunk.words.map((x) => x.end).filter((n) => Number.isFinite(n));
    const start = wordStarts.length ? Math.min(...wordStarts) : baseStart;
    const end = wordEnds.length ? Math.max(...wordEnds) : baseEnd;
    const text = joinWordTokens(chunk.words.map((x) => x.text));
    if (!text) continue;
    results.push({
      start,
      end,
      text,
      speaker: chunk.speaker,
    });
  }

  return results.length ? results : null;
}

function explodeSegmentsBySpeaker(segments) {
  if (!Array.isArray(segments) || !segments.length) return [];
  const out = [];
  for (const seg of segments) {
    const split = splitSegmentBySpeakerWords(seg);
    if (Array.isArray(split) && split.length) {
      for (const s of split) out.push(s);
    } else {
      out.push(seg);
    }
  }
  return out;
}

function inferSpeakerId(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const direct =
    seg.speaker ??
    seg.spk ??
    seg.speaker_id ??
    seg.speakerId ??
    seg.speakerID;
  if (direct !== null && direct !== undefined && direct !== '') return String(direct);

  // Some STT servers attach diarization to word-level timestamps instead of segments.
  // Try common shapes without assuming a specific schema.
  const wordItems = extractWordItems(seg);
  if (wordItems.length) {
    const inferred = inferSpeakerIdFromWords(wordItems);
    if (inferred) return inferred;
  }
  return null;
}

// normalizeSegmentsTiming 已移至 utils/segment-merger.js

// mergeIncompleteSegments 已移至 utils/segment-merger.js

/**
 * 根据使用场景获取最佳provider
 * @param {string} scenario - 使用场景: 'video-upload' (视频上传) 或 'practice-recording' (练习录音)
 */
function getPrimaryProvider(scenario = 'video-upload') {
  const config = getSpeechConfig();

  // 场景特定的provider配置
  if (scenario === 'practice-recording') {
    // 练习录音：优先使用Gemini（快速、免费），备份Custom STT
    const practiceProvider = process.env.STT_PRACTICE_PROVIDER || config.practiceProvider || 'gemini';
    console.log(`[STT] Practice recording using provider: ${practiceProvider}`);
    return practiceProvider.toLowerCase();
  }

  // 视频上传：优先使用Custom STT（有时间戳），备份Gemini
  const provider = process.env.STT_VIDEO_PROVIDER || config.provider || 'custom';
  console.log(`[STT] Video upload using provider: ${provider}`);
  return provider.toLowerCase();
}

/**
 * 根据主provider和场景获取fallback provider
 * @param {string} primaryProvider - 主provider
 * @param {string} scenario - 使用场景
 */
function getFallbackProvider(primaryProvider, scenario = 'video-upload') {
  const cfg = getSpeechConfig();

  // 场景特定的fallback配置
  if (scenario === 'practice-recording') {
    // 练习录音：Gemini失败 -> Custom STT
    const practiceFallback = process.env.STT_PRACTICE_FALLBACK || cfg.practiceFallback || 'custom';
    if (practiceFallback === 'none') return null;
    console.log(`[STT] Practice fallback provider: ${practiceFallback}`);
    return practiceFallback.toLowerCase();
  }

  // 视频上传：Custom STT失败 -> Gemini
  const videoFallback = process.env.STT_VIDEO_FALLBACK || cfg.fallbackProvider || 'gemini';
  if (videoFallback === 'none') return null;
  console.log(`[STT] Video fallback provider: ${videoFallback}`);
  return videoFallback.toLowerCase();
}

function normalizeProviderLabel(provider) {
  const value = (provider || '').toLowerCase();
  // Allow using "whisper" explicitly in scenario configs.
  // Internally it uses the OpenAI transcription endpoint with model whisper-1 by default.
  if (value === 'whisper' || value === 'openai-whisper') return 'whisper';
  return value;
}

function buildUserMessage(err, label) {
  if (err && (err.code === 'model_not_found' || err.status === 503)) {
    return `Transcription provider "${label}" is unavailable. Please try again later or switch providers.`;
  }
  return `Transcription failed: ${err && err.message ? err.message : 'unknown error'}. Please try again later.`;
}

function convertToPCM(filePath, sampleRate = 16000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);

    ffmpeg(filePath)
      .audioChannels(1)
      .audioFrequency(sampleRate)
      .format('s16le')
      .on('error', reject)
      .pipe(stream, { end: true });
  });
}

function convertToWavFile(filePath, sampleRate = 16000) {
  const tmpFile = path.join(
    os.tmpdir(),
    `linglish-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`,
  );

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .audioChannels(1)
      .audioFrequency(sampleRate)
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve(tmpFile))
      .save(tmpFile);
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const duration = metadata?.format?.duration;
        if (duration && Number.isFinite(Number(duration))) {
          resolve(Number(duration));
        } else {
          reject(new Error('No valid duration found in metadata'));
        }
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function splitAudioIntoChunks(filePath, chunkDurationSeconds, sampleRate = 16000) {
  return new Promise(async (resolve, reject) => {
    try {
      const totalDuration = await getAudioDuration(filePath);
      const chunks = [];
      const numChunks = Math.ceil(totalDuration / chunkDurationSeconds);

      console.log(`[Audio Chunking] Total duration: ${totalDuration.toFixed(2)}s, splitting into ${numChunks} chunks of ${chunkDurationSeconds}s each`);

      for (let i = 0; i < numChunks; i++) {
        const startTime = i * chunkDurationSeconds;
        const tmpFile = path.join(
          os.tmpdir(),
          `linglish-chunk-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}.wav`,
        );

        await new Promise((resolveChunk, rejectChunk) => {
          ffmpeg(filePath)
            .audioChannels(1)
            .audioFrequency(sampleRate)
            .format('wav')
            .seekInput(startTime)
            .duration(chunkDurationSeconds)
            .on('error', rejectChunk)
            .on('end', () => {
              console.log(`[Audio Chunking] Created chunk ${i + 1}/${numChunks}: ${tmpFile}`);
              resolveChunk();
            })
            .save(tmpFile);
        });

        chunks.push({
          path: tmpFile,
          index: i,
          startTime,
          duration: Math.min(chunkDurationSeconds, totalDuration - startTime),
        });
      }

      resolve({ chunks, totalDuration });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 使用Gemini API转录音频文件
 */
async function transcribeWithGemini(filePath, options = {}) {
  const {
    language = 'en',
    triedProviderFallback = false,
  } = options;

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  try {
    console.log('[Gemini STT] Reading audio file:', filePath);

    // 读取音频文件并转换为base64
    const audioBuffer = fs.readFileSync(filePath);
    const base64Audio = audioBuffer.toString('base64');

    // 获取文件的MIME类型
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypeMap = {
      '.mp3': 'audio/mp3',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.mp4': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
    };
    const mimeType = mimeTypeMap[ext] || 'audio/mp3';

    console.log(`[Gemini STT] File type: ${ext}, MIME: ${mimeType}, size: ${audioBuffer.length} bytes`);

    // 构建请求
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Audio
              }
            },
            {
              text: language === 'zh' || language === 'zh-CN'
                ? '请将这段音频完整转写成中文文本。务必转写所有内容，包括最后的单词。只返回转写结果，不要解释，不要加别的文字。'
                : 'Please transcribe this entire audio to English text. Make sure to transcribe ALL words including the very last word in the audio. Listen carefully to the end of the recording. Only return the complete transcription result without any explanations.'
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,  // 降低随机性，提高准确性
        maxOutputTokens: 2048,  // 确保有足够的输出空间
        topP: 0.8,
        topK: 40
      }
    };

    // 使用 gemini-2.5-flash（最新模型）或环境变量指定的模型
    const model = options.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    console.log(`[Gemini STT] Using model: ${model}`);

    console.log('[Gemini STT] Sending request to Gemini API...');
    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 120000 // 2分钟超时
    });

    console.log('[Gemini STT] Received response from Gemini');

    // 解析响应
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error('Gemini API returned empty transcription');
    }

    console.log(`[Gemini STT] Transcription successful, length: ${text.length} chars`);
    console.log(`[Gemini STT] Transcription text: "${text.trim()}"`);

    // 将文本分割成句子segments（因为Gemini不返回时间戳）
    const trimmedText = text.trim();
    const sentences = splitIntoSentences(trimmedText);

    console.log(`[Gemini STT] Split text into ${sentences.length} sentences`);

    // 创建简单的segments（没有时间戳）
    const segments = sentences.map((sentence, index) => ({
      text: sentence,
      start_sec: 0,
      end_sec: 0,
      index: index
    }));

    // 返回标准格式
    return {
      text: trimmedText,
      segments: segments,
      duration: null,
      language: language,
      model: model,
      provider: 'gemini',
    };

  } catch (err) {
    const statusCode = err.response?.status;
    const errorData = err.response?.data;

    console.error('[Gemini STT] Transcription failed:', {
      message: err.message,
      status: statusCode,
      errorData: errorData ? JSON.stringify(errorData).slice(0, 200) : 'N/A'
    });

    // 503错误 - 服务暂时不可用，立即fallback
    if (statusCode === 503) {
      console.warn('[Gemini STT] Service unavailable (503), falling back immediately...');
      // 直接跳到fallback，不重试
    }
    // 429错误 - 配额限制，直接fallback到其他provider
    else if (statusCode === 429) {
      console.warn('[Gemini STT] Rate limit (429), quota exceeded. Falling back to alternative provider...');
      // 不再尝试其他Gemini模型，直接使用fallback provider
      // 因为429通常意味着整个API key的配额用完了，换模型也没用
    }
    // 500系列错误 - 服务器错误，可能是临时问题
    else if (statusCode >= 500 && statusCode < 600) {
      console.warn(`[Gemini STT] Server error (${statusCode}), will fallback...`);
    }
    // 400系列错误 - 客户端错误，记录详细信息
    else if (statusCode >= 400 && statusCode < 500) {
      console.error('[Gemini STT] Client error:', {
        status: statusCode,
        data: errorData,
        apiKey: getGeminiApiKey()?.slice(0, 10) + '...'
      });
    }

    // 如果还没有尝试fallback，根据场景选择fallback provider
    if (!triedProviderFallback) {
      const scenario = options.scenario || 'video-upload';
      const fallbackProvider = getFallbackProvider('gemini', scenario);

      if (fallbackProvider === 'custom') {
        console.warn(`[Gemini STT] Failed, attempting Custom STT fallback (scenario: ${scenario})`);
        return transcribeWithCustom(filePath, {
          ...options,
          triedProviderFallback: true,
        });
      }
      if (fallbackProvider === 'openai' || fallbackProvider === 'whisper') {
        console.warn(`[Gemini STT] Failed, attempting OpenAI Whisper fallback (scenario: ${scenario})`);
        const result = await transcribeWithOpenAI(filePath, {
          ...options,
          triedProviderFallback: true,
          provider: fallbackProvider,
        });
        return { ...result, provider: fallbackProvider === 'whisper' ? 'whisper' : (result.provider || 'openai') };
      }
      if (fallbackProvider === 'baidu') {
        console.warn(`[Gemini STT] Failed, attempting Baidu ASR fallback (scenario: ${scenario})`);
        return transcribeWithBaidu(filePath, {
          ...options,
          triedProviderFallback: true,
        });
      }
    }

    throw err;
  }
}

async function transcribeWithBaidu(filePath, options = {}) {
  const cfg = getSpeechConfig().baidu || {};
  const sampleRate = options.sampleRate || cfg.sampleRate || 16000;
  const pcmBuffer = await convertToPCM(filePath, sampleRate);
  let devPid = options.devPid || cfg.devPid;
  if (!devPid) {
    const lang = (options.language || '').toLowerCase();
    if (lang.startsWith('en')) {
      devPid = 1737; // Baidu English model
    } else {
      devPid = 1536; // Default Mandarin model
    }
  }

  const result = await baiduAsr.transcribe(pcmBuffer, {
    sampleRate,
    format: cfg.format || 'pcm',
    cuid: cfg.cuid || 'linglish-app',
    language: options.language || 'zh',
    devPid,
  });

  return {
    text: result.text || '',
    segments: result.segments || [],
    duration: null,
    language: result.language || options.language || 'zh',
    model: 'baidu-asr',
    provider: 'baidu',
  };
}

async function transcribeWithOpenAI(filePath, options = {}) {
  const preferWhisper = normalizeProviderLabel(options.provider) === 'whisper'
    || (!aiConfig.openai.apiKey && Boolean(process.env.OPENROUTER_API_KEY));
  let client;
  try {
    client = preferWhisper ? getOpenAIWhisperClient() : getOpenAIClient();
  } catch (err) {
    if (!preferWhisper && /not configured/i.test(String(err && err.message || ''))) {
      client = getOpenAIWhisperClient();
    } else {
      throw err;
    }
  }
  const cfg = getSpeechConfig();
  const {
    language = 'en',
    model,
    scenario = 'video-upload',
    triedFallbackModel = false,
    triedProviderFallback = false,
  } = options;

  const targetModel = model
    || client.__linglishWhisperModel
    || cfg.model
    || 'whisper-1';

  try {
    // OpenAI SDK v4+ uses toFile() helper for proper file handling
    // This ensures the file extension and MIME type are correctly detected
    const response = await client.audio.transcriptions.create({
      file: await OpenAI.toFile(fs.createReadStream(filePath), path.basename(filePath)),
      model: targetModel,
      response_format: 'verbose_json',
      language: language === 'auto' ? undefined : language,
    });

    return {
      text: response.text || '',
      segments: Array.isArray(response.segments) ? response.segments : [],
      duration: typeof response.duration === 'number' ? response.duration : null,
      language: response.language || language,
      model: targetModel,
      provider: normalizeProviderLabel(options.provider) === 'whisper' ? 'whisper' : 'openai',
    };
  } catch (err) {
    err.apiModel = targetModel;

    // Log detailed error information for debugging
    console.error('[Whisper STT] Transcription failed:', {
      message: err.message,
      status: err.status,
      code: err.code,
      type: err.type,
      apiModel: targetModel,
      apiKey: process.env.OPENAI_API_KEY?.substring(0, 20) + '...',
      baseURL: normalizeProviderLabel(options.provider) === 'whisper' ?
        (process.env.OPENAI_WHISPER_API_BASE || 'https://api.openai.com/v1') :
        aiConfig.openai.baseURL
    });

    const fallbackModel = !triedFallbackModel ? cfg.fallbackModel : null;
    if (fallbackModel && fallbackModel !== targetModel) {
      console.warn(`Transcription model "${targetModel}" failed, attempting fallback model "${fallbackModel}"`);
      return transcribeWithOpenAI(filePath, {
        ...options,
        model: fallbackModel,
        triedFallbackModel: true,
      });
    }

    if (!triedProviderFallback) {
      const fallbackProvider = getFallbackProvider('openai', scenario);
      if (fallbackProvider === 'baidu') {
        console.warn('OpenAI transcription failed, attempting Baidu ASR fallback');
        return transcribeWithBaidu(filePath, {
          ...options,
          triedProviderFallback: true,
        });
      }
      if (fallbackProvider === 'custom') {
        console.warn('OpenAI transcription failed, attempting custom STT fallback');
        return transcribeWithCustom(filePath, {
          ...options,
          triedProviderFallback: true,
        });
      }
    }

    throw err;
  }
}

async function transcribeSingleAudioFile(wavFile, options = {}) {
  const cfg = getSpeechConfig().custom || {};
  const endpoint = options.endpoint || cfg.endpoint;
  const method = (options.method || cfg.method || 'POST').toUpperCase();
  const url = new URL(endpoint);
  const languageParam = options.languageParam || cfg.languageParam;
  if (languageParam && options.language) {
    url.searchParams.set(languageParam, options.language);
  }
  if (options.initialPrompt) {
    url.searchParams.set('initial_prompt', options.initialPrompt);
  }
  if (options.vadFilter !== undefined) {
    url.searchParams.set('vad_filter', String(Boolean(options.vadFilter)));
  }
  const outputParam = cfg.outputParam || 'output';
  const outputFormat = (options.output || cfg.outputFormat || 'text').toLowerCase();
  if (outputParam) {
    url.searchParams.set(outputParam, outputFormat);
  }
  const diarizeValue = options.diarize !== undefined ? options.diarize : cfg.diarizeValue;
  if (diarizeValue && String(diarizeValue) !== 'false') {
    const diarizeParam = cfg.diarizeParam || 'diarize';
    url.searchParams.set(diarizeParam, String(diarizeValue));
  }
  // Enable word_timestamps for better sentence segmentation
  const wordTimestampsValue = options.wordTimestamps !== undefined
    ? options.wordTimestamps
    : cfg.wordTimestampsValue;
  if (wordTimestampsValue && String(wordTimestampsValue) !== 'false') {
    const wordTimestampsParam = cfg.wordTimestampsParam || 'word_timestamps';
    url.searchParams.set(wordTimestampsParam, String(wordTimestampsValue));
  }

  let heartbeatInterval = null;

  try {
    const form = new FormData();
    const wavBuffer = await fs.promises.readFile(wavFile);
    const fileField = options.fileField || cfg.fileField || 'audio_file';
    form.append(fileField, wavBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });

    console.log('[Custom STT] WAV file size:', (wavBuffer.length / 1024 / 1024).toFixed(2), 'MB');

    // 检查音频文件是否太小（可能录音失败）
    if (wavBuffer.length < 1000) {
      console.warn('[Custom STT] ⚠️  Audio file is very small (<1KB), likely recording failed!');
    }

    console.log('[Custom STT] Sending request to:', url.toString());

    const headers = {
      ...(cfg.headers || {}),
      ...form.getHeaders(),
    };

    const startTime = Date.now();
    console.log('[Custom STT] Request started at:', new Date().toISOString());

    // Add heartbeat logging for long-running requests
    heartbeatInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log('[Custom STT] Still waiting for response... (elapsed:', elapsed, 'seconds)');
    }, 30000); // Log every 30 seconds

    const timeout = cfg.timeout || 3600000; // Default 60 minutes from config
    const response = await axios({
      method,
      url: url.toString(),
      data: form,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      timeout,
    });

    clearInterval(heartbeatInterval);
    heartbeatInterval = null;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('[Custom STT] Response received in', duration, 'seconds');
    console.log('[Custom STT] Response status:', response.status);

    if (response.status < 200 || response.status >= 300) {
      const bodyText = Buffer.from(response.data || '').toString('utf8');
      const error = new Error(`Custom STT error: ${response.status}`);
      error.status = response.status;
      error.body = bodyText;
      throw error;
    }

    let raw;
    if (Buffer.isBuffer(response.data)) {
      raw = response.data.toString('utf8');
    } else if (typeof response.data === 'string') {
      raw = response.data;
    } else {
      raw = JSON.stringify(response.data);
    }

	    if (outputFormat === 'json') {
	      try {
	        const data = JSON.parse(raw);

	        // 记录原始响应数据（用于诊断）
	        console.log('[Custom STT] Raw response data:', {
	          hasText: !!data.text,
	          textLength: data.text?.length || 0,
	          hasSegments: Array.isArray(data.segments),
	          segmentsCount: Array.isArray(data.segments) ? data.segments.length : 0,
	          duration: data.duration,
	          language: data.language,
	          error: data.error || null
	        });

	        // Optional schema debug (very small, opt-in)
	        if (cfg.debugSegments && Array.isArray(data.segments) && data.segments.length) {
	          const s0 = data.segments[0] || {};
	          const s1 = data.segments[1] || {};
	          function summarizeSeg(seg) {
	            const keys = seg && typeof seg === 'object' ? Object.keys(seg).slice(0, 30) : [];
	            const words =
	              (Array.isArray(seg?.words) && seg.words) ||
	              (Array.isArray(seg?.word_timestamps) && seg.word_timestamps) ||
	              (Array.isArray(seg?.wordTimestamps) && seg.wordTimestamps) ||
	              null;
	            const wordsLen = Array.isArray(words) ? words.length : 0;
	            const sampleWordKeys = wordsLen ? Object.keys(words[0] || {}).slice(0, 20) : [];
	            return { keys, wordsLen, sampleWordKeys, speakerFields: { speaker: seg?.speaker, spk: seg?.spk, speaker_id: seg?.speaker_id } };
	          }
	          console.log('[Custom STT] Debug segment[0] shape:', summarizeSeg(s0));
	          console.log('[Custom STT] Debug segment[1] shape:', summarizeSeg(s1));
	        }

        const explodedInputSegments = Array.isArray(data.segments)
          ? explodeSegmentsBySpeaker(data.segments)
          : [];

        const rawSegments = explodedInputSegments
          .map((seg, index) => ({
            index,
            start: Number(seg.start ?? 0),
            end: Number(seg.end ?? seg.start ?? 0),
            text: typeof seg.text === 'string' ? seg.text.trim() : '',
            speaker: inferSpeakerId(seg),
          }))
          .filter((seg) => seg.text.length > 0);

        // 智能合并不完整的句子segments
        const normalizedSegments = normalizeSegmentsTiming(rawSegments);
        const segments = mergeIncompleteSegments(normalizedSegments);

        const transcriptText =
          (typeof data.text === 'string' && data.text.trim().length
            ? data.text.trim()
            : segments.map((seg) => seg.text).join(' ')
          ).replace(/\r\n/g, '\n');

        console.log('[Custom STT] Transcription result:', {
          text: transcriptText,
          textLength: transcriptText.length,
          segmentsCount: segments.length,
          language: data.language || options.language || 'en'
        });

        return {
          text: transcriptText,
          segments,
          duration: typeof data.duration === 'number' ? data.duration : null,
          language: data.language || options.language || 'en',
        };
      } catch (err) {
        console.warn('[Custom STT] Failed to parse JSON output:', err.message);
        // fall through to treat as plain text
      }
    }

    const cleanedText = raw.replace(/\r\n/g, '\n').trim();
    const segments =
      cleanedText.length > 0
        ? [
          {
            index: 0,
            start: 0,
            end: 0,
            text: cleanedText,
          },
        ]
        : [];

    return {
      text: cleanedText,
      segments,
      duration: null,
      language: options.language || 'en',
    };
  } catch (error) {
    console.error('[Custom STT] Error occurred:', error.message);
    console.error('[Custom STT] Error code:', error.code);
    if (error.response) {
      console.error('[Custom STT] Response status:', error.response.status);
      console.error('[Custom STT] Response data:', error.response.data);
    }
    throw error;
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  }
}

async function transcribePracticeWav(wavFile, options = {}) {
  const result = await transcribeSingleAudioFile(wavFile, {
    ...options,
    output: 'json',
    language: options.language || 'en',
    languageParam: options.languageParam || 'language',
    initialPrompt: options.initialPrompt,
    vadFilter: true,
    diarize: false,
    wordTimestamps: false,
  });
  return {
    ...result,
    model: 'custom-stt',
    provider: 'custom',
  };
}

async function transcribeWithCustom(filePath, options = {}) {
  const cfg = getSpeechConfig().custom || {};
  const endpoint = options.endpoint || cfg.endpoint;
  if (!endpoint) {
    throw new Error('Custom STT endpoint is not configured. Set STT_CUSTOM_ENDPOINT in the environment.');
  }

  console.log('[Custom STT] Starting transcription');
  console.log('[Custom STT] Endpoint:', endpoint);
  console.log('[Custom STT] File path:', filePath);

  const sampleRate = cfg.sampleRate || 16000;
  const enableChunking = options.enableChunking !== undefined ? options.enableChunking : cfg.enableChunking !== false;
  const chunkThresholdMinutes = options.chunkThresholdMinutes || cfg.chunkThresholdMinutes || 15;
  const chunkDurationMinutes = options.chunkDurationMinutes || cfg.chunkDurationMinutes || 10;

  // Check if we should use chunking
  let shouldChunk = false;
  let audioDuration = null;

  if (enableChunking) {
    try {
      audioDuration = await getAudioDuration(filePath);
      const durationMinutes = audioDuration / 60;
      console.log(`[Custom STT] Audio duration: ${durationMinutes.toFixed(2)} minutes`);

      if (durationMinutes > chunkThresholdMinutes) {
        shouldChunk = true;
        console.log(`[Custom STT] Audio exceeds ${chunkThresholdMinutes} minutes, will use chunked processing`);
      }
    } catch (err) {
      console.warn('[Custom STT] Failed to get audio duration, proceeding without chunking:', err.message);
    }
  }

  // Process with chunking if needed
  if (shouldChunk) {
    console.log('[Custom STT] Converting to WAV format and splitting into chunks...');
    const wavFile = await convertToWavFile(filePath, sampleRate);
    const chunkDurationSeconds = chunkDurationMinutes * 60;

    let chunkFiles = [];
    try {
      const { chunks, totalDuration } = await splitAudioIntoChunks(wavFile, chunkDurationSeconds, sampleRate);
      chunkFiles = chunks;

      console.log(`[Custom STT] Processing ${chunks.length} chunks...`);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[Custom STT] Processing chunk ${i + 1}/${chunks.length} (${chunk.startTime.toFixed(1)}s - ${(chunk.startTime + chunk.duration).toFixed(1)}s)...`);

        try {
          const result = await transcribeSingleAudioFile(chunk.path, options);

          // Adjust segment timestamps based on chunk start time
          if (result.segments && Array.isArray(result.segments)) {
            result.segments = result.segments.map(seg => ({
              ...seg,
              start: seg.start + chunk.startTime,
              end: seg.end + chunk.startTime,
            }));
          }

          chunkResults.push(result);
          console.log(`[Custom STT] Chunk ${i + 1}/${chunks.length} completed`);
        } catch (err) {
          console.error(`[Custom STT] Failed to process chunk ${i + 1}:`, err.message);
          throw new Error(`Chunk ${i + 1} transcription failed: ${err.message}`);
        }
      }

      // Merge results
      console.log('[Custom STT] Merging chunk results...');
      const rawMergedSegments = [];
      let segmentIndex = 0;

      for (const result of chunkResults) {
        if (result.segments && Array.isArray(result.segments)) {
          for (const seg of result.segments) {
            rawMergedSegments.push({
              ...seg,
              index: segmentIndex++,
            });
          }
        }
      }

      // 智能合并不完整的句子segments
      const normalizedMergedSegments = normalizeSegmentsTiming(rawMergedSegments);
      const mergedSegments = mergeIncompleteSegments(normalizedMergedSegments);
      const mergedText = mergedSegments.map(seg => seg.text).join(' ').trim();

      return {
        text: mergedText,
        segments: mergedSegments,
        duration: totalDuration,
        language: chunkResults[0]?.language || options.language || 'en',
        model: 'custom-stt',
        provider: 'custom',
      };
    } finally {
      // Clean up all chunk files
      console.log('[Custom STT] Cleaning up chunk files...');
      for (const chunk of chunkFiles) {
        try {
          await fs.promises.unlink(chunk.path);
        } catch (err) {
          console.warn(`[Custom STT] Failed to delete chunk file ${chunk.path}:`, err.message);
        }
      }
      // Clean up main WAV file
      try {
        await fs.promises.unlink(wavFile);
      } catch (err) {
        console.warn('[Custom STT] Failed to delete WAV file:', err.message);
      }
    }
  }

  // Process as single file (original behavior)
  console.log('[Custom STT] Converting to WAV format...');
  const wavFile = await convertToWavFile(filePath, sampleRate);
  console.log('[Custom STT] WAV file created:', wavFile);

  try {
    const result = await transcribeSingleAudioFile(wavFile, options);
    return {
      ...result,
      model: 'custom-stt',
      provider: 'custom',
    };
  } finally {
    console.log('[Custom STT] Cleaning up WAV file:', wavFile);
    fs.promises.unlink(wavFile).catch((err) => {
      console.warn('[Custom STT] Failed to delete WAV file:', err.message);
    });
  }
}

function localWhisperScriptPath() {
  return path.join(__dirname, '..', 'scripts', 'local-whisper-transcribe.py');
}

async function hasLocalWhisper() {
  if (localWhisperChecked) return localWhisperAvailable;
  localWhisperChecked = true;
  const script = localWhisperScriptPath();
  if (!fs.existsSync(script)) {
    localWhisperAvailable = false;
    return false;
  }
  localWhisperAvailable = true;
  return true;
}

async function transcribeWithLocalWhisper(filePath, options = {}) {
  const script = localWhisperScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error('本地 Whisper 脚本不存在');
  }
  const model = process.env.LOCAL_WHISPER_MODEL || options.localModel || 'tiny';
  const language = options.language || 'en';
  const pythonBin = process.env.LOCAL_WHISPER_PYTHON || process.env.PYTHON || 'python';
  const timeoutMs = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS) || 900000;

  console.log(`[Local Whisper] Transcribing with model=${model} language=${language}`);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [
      script,
      '--file', filePath,
      '--language', language,
      '--model', model,
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('本地 Whisper 超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      let payload = null;
      try { payload = JSON.parse(last); } catch (_) {}
      if (!payload || payload.ok !== true) {
        const message = (payload && payload.error)
          || stderr.trim()
          || `本地 Whisper 失败 (code=${code})`;
        reject(new Error(message));
        return;
      }
      resolve(payload);
    });
  });

  const segments = Array.isArray(result.segments) ? result.segments : [];
  return {
    text: String(result.text || ''),
    segments,
    duration: Number(result.duration) || null,
    language: result.language || language,
    model: result.model || model,
    provider: 'local-whisper',
  };
}

/**
 * 转录音频/视频文件
 * @param {string} filePath - 文件路径
 * @param {Object} options - 选项
 * @param {string} options.scenario - 使用场景: 'video-upload' 或 'practice-recording'
 * @param {string} options.provider - 强制使用的provider（可选）
 */
async function transcribeVideoFile(filePath, options = {}) {
  const scenario = options.scenario || 'video-upload';
  const provider = normalizeProviderLabel(options.provider || getPrimaryProvider(scenario));
  const allowLocalFallback = options.allowLocalFallback !== false;

  console.log(`[Transcribe] Scenario: ${scenario}, Using provider: ${provider}`);

  const runCloud = async () => {
    if (provider === 'gemini') {
      return transcribeWithGemini(filePath, options);
    }
    if (provider === 'custom') {
      return transcribeWithCustom(filePath, options);
    }
    if (provider === 'baidu') {
      return transcribeWithBaidu(filePath, options);
    }
    if (provider === 'local' || provider === 'local-whisper') {
      return transcribeWithLocalWhisper(filePath, options);
    }
    if (provider === 'whisper') {
      return transcribeWithOpenAI(filePath, { ...options, provider: 'whisper' });
    }
    return transcribeWithOpenAI(filePath, options);
  };

  try {
    return await runCloud();
  } catch (err) {
    if (!allowLocalFallback || provider === 'local' || provider === 'local-whisper') {
      throw err;
    }
    if (!(await hasLocalWhisper())) {
      throw err;
    }
    console.warn('[Transcribe] Cloud STT failed, falling back to local Whisper:', err && err.message);
    return transcribeWithLocalWhisper(filePath, options);
  }
}

async function translateTextToEnglish(text) {
  const client = getOpenAIClient();
  const model = aiConfig.openai.models?.gpt35 || 'gpt-4o-mini';

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Translate the user text to natural English. Respond with English text only.',
      },
      {
        role: 'user',
        content: text,
      },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || text;
}

async function translateSegmentsToEnglish(segments) {
  if (!segments || !segments.length) return [];

  const results = [];
  for (const segment of segments) {
    const segmentText = typeof segment.text === 'string' ? segment.text : '';
    if (!segmentText) {
      results.push({ ...segment });
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(segmentText)) {
      try {
        const translated = await translateTextToEnglish(segmentText);
        results.push({ ...segment, text: translated });
      } catch (err) {
        console.warn('Segment translation failed:', err.message);
        results.push({ ...segment });
      }
    } else {
      results.push({ ...segment });
    }
  }
  return results;
}

async function ensureEnglishTranscript(transcript, options = {}) {
  const targetLanguage = (options.language || 'en').toLowerCase();
  if (targetLanguage.startsWith('en')) {
    return { ...transcript, language: 'en' };
  }
  return transcript;
}

async function transcribeAndStore(resource, options = {}) {
  const { id, video_path: videoPath, youtube_video_id: youtubeVideoId, local_video_path: localVideoPath } = resource;

  // For YouTube videos, prefer local_video_path (downloaded file)
  let effectivePath = videoPath;

  if (youtubeVideoId) {
    // This is a YouTube video
    if (localVideoPath) {
      // Use the downloaded local file
      effectivePath = localVideoPath;
      console.log(`[transcribeAndStore] YouTube video ${id}, using local path: ${localVideoPath}`);
    } else {
      // No local file available - cannot transcribe directly from YouTube URL
      const error = new Error('YouTube视频尚未下载到本地，无法提取字幕。请先在视频详情页点击"下载到本地"按钮。');
      error.userMessage = error.message;
      throw error;
    }
  }

  if (!effectivePath) {
    throw new Error('Video path missing');
  }

  const relativePath = effectivePath.startsWith('/') ? effectivePath.slice(1) : effectivePath;
  const absolutePath = path.resolve(__dirname, '..', 'public', relativePath);

  try {
    console.log(`[transcribeAndStore] Starting for video ${id}, path: ${absolutePath}`);

    // 视频上传场景 - 需要时间戳segments
    const transcribeOptions = {
      ...options,
      scenario: 'video-upload'
    };

    let transcript = await transcribeVideoFile(absolutePath, transcribeOptions);
    console.log(`[transcribeAndStore] Transcription complete:`, {
      textLength: transcript.text?.length || 0,
      segmentsCount: transcript.segments?.length || 0,
      language: transcript.language,
      provider: transcript.provider
    });

    transcript = await ensureEnglishTranscript(transcript, options);

    // 为每个 segment 添加 source 标记（基于 provider）
    const sourceLabel = transcript.provider || 'whisper';
    const segmentsWithSource = Array.isArray(transcript.segments)
      ? transcript.segments.map(seg => ({ ...seg, source: sourceLabel }))
      : [];

    const updates = {
      transcript: transcript.text,
      transcript_segments: segmentsWithSource,
      language: transcript.language,
      status: 'ready',
      failure_reason: null,
    };

    console.log(`[transcribeAndStore] Preparing to update video ${id} with:`, {
      transcriptLength: updates.transcript?.length || 0,
      segmentsCount: Array.isArray(updates.transcript_segments) ? updates.transcript_segments.length : 0,
      segmentsType: typeof updates.transcript_segments,
      status: updates.status
    });

    // Only update duration_sec if the transcription service returned a valid duration
    // This preserves the duration extracted from ffprobe during video upload
    if (transcript.duration && Number.isFinite(transcript.duration)) {
      updates.duration_sec = Math.round(transcript.duration);
    }

    console.log(`[transcribeAndStore] Calling dataStore.updateVideoResource for video ${id}...`);
    const result = await dataStore.updateVideoResource(id, updates);
    console.log(`[transcribeAndStore] Update successful for video ${id}:`, {
      returned: !!result,
      resultId: result?.id,
      resultStatus: result?.status,
      resultSegmentsLength: Array.isArray(result?.transcript_segments) ? result.transcript_segments.length : 'N/A'
    });

    return transcript;
  } catch (err) {
    const label = err.apiModel || options.provider || getPrimaryProvider();
    const friendlyMessage = err.userMessage || buildUserMessage(err, label);

    await dataStore.updateVideoResource(id, {
      status: 'failed',
      failure_reason: friendlyMessage,
    });

    err.userMessage = friendlyMessage;
    throw err;
  }
}

module.exports = {
  transcribeVideoFile,
  transcribePracticeWav,
  transcribeAndStore,
  transcribeWithLocalWhisper,
  hasLocalWhisper,
};
