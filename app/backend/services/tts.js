// app/backend/services/tts.js
// Unified TTS: Edge TTS (CLI) with Google TTS fallback
// Output mp3 cache: /app/backend/tts_cache/<md5(provider+voice/lang+text)>.mp3
// Cache keys are provider-scoped so Google fallback audio never poisons an Edge key.

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

const run = promisify(execFile);

// ====== Configuration ======
const PROJECT_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, 'tts_cache');
// 尝试多个可能的 edge-tts 路径
const EDGE_PATHS = [
  '/opt/linglish-edge-tts/bin/edge-tts',
  '/usr/local/bin/edge-tts',
  '/usr/local/bin/edge-tts-safe',
  '/Library/Frameworks/Python.framework/Versions/3.14/bin/edge-tts',
  '/opt/homebrew/bin/edge-tts',
  process.env.HOME + '/.local/bin/edge-tts',
];
const EDGE_CMD = EDGE_PATHS.find(p => fs.existsSync(p)) || 'edge-tts';
console.log('[TTS] Using edge-tts at:', EDGE_CMD);

const DEFAULT_VOICE = 'en-US-JennyNeural';
const GOOGLE_LANG = 'en';
const EDGE_TIMEOUT_MS = 15000;  // 默认15秒，单词发音够用
const EDGE_SHORT_TIMEOUT_MS = 8000;  // 短文本（<50字符）用8秒
const MAX_CACHE_SIZE = 500;  // 增加缓存数量

// Edge TTS failure tracking
const EDGE_TTS_STATS = {
  attempts: 0,
  failures: 0,
  lastFailureTime: 0,
  consecutiveFailures: 0,
};

const MAX_CONSECUTIVE_FAILURES = 2; // Reduced from 3 to fail faster
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const REDUCED_TIMEOUT_MS = 10000; // 10 seconds when Edge TTS is failing

/**
 * TTS Configuration (supports both Google TTS and Edge TTS)
 */
const TTS_CONFIG = {
  provider: 'edge',  // 'google' or 'edge' - Edge has better Neural voices
  lang: 'en',          // Language code
  slow: false,         // Speech speed
  host: 'https://translate.google.com',
  enableCache: true,
  cacheSize: 100,
  edgeVoice: 'en-US-AriaNeural', // Default Edge TTS voice (专业清晰女声)
};

// ====== Utility Functions ======
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function stripMp3Ext(p) {
  return p.toLowerCase().endsWith('.mp3') ? p.slice(0, -4) : p;
}

// Validate MP3: non-trivial size + ID3 tag or MPEG frame-sync header.
// Rejects truncated/corrupted files left behind by killed edge-tts processes.
function isValidAudioFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 128) return false;
    const buf = Buffer.alloc(3);
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, buf, 0, 3, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // 'ID3'
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
    return false;
  } catch {
    return false;
  }
}

// Unique per-attempt temp path so retries/concurrent requests never write the same file
function makeTempPath(outFile) {
  return `${outFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ====== Edge TTS (CLI) ======
/**
 * Synthesize text to MP3 file using Edge TTS CLI
 * Note: Node 18+ needs webcrypto injection via NODE_OPTIONS
 * Also clears all proxy variables to avoid 403 errors
 * @param {number} timeoutMs - Timeout in milliseconds (defaults to EDGE_TIMEOUT_MS)
 */
async function edgeSynthesizeToFile(text, voice, outFile, timeoutMs = EDGE_TIMEOUT_MS) {
  ensureDir(path.dirname(outFile));

  // Prepare environment: no proxy + webcrypto
  const env = {
    ...process.env,
    NODE_OPTIONS: '--experimental-global-webcrypto',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '*',
  };

  // Simple retry for occasional throttling/network glitches.
  // Each attempt writes to a unique temp file, validates, then renames atomically —
  // a killed/late process can never leave a corrupted file at the cache path.
  const maxTries = 2;
  for (let i = 0; i < maxTries; i++) {
    const tmpFile = makeTempPath(outFile);
    const args = [
      '-t', text,
      '-v', voice,
      '--write-media', tmpFile,
    ];
    try {
      // Native timeout + SIGKILL: no zombie edge-tts processes on timeout
      await run(EDGE_CMD, args, {
        env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });

      if (!isValidAudioFile(tmpFile)) {
        throw new Error('edge-tts produced invalid/empty audio');
      }
      fs.renameSync(tmpFile, outFile);
      return outFile;
    } catch (e) {
      fs.rmSync(tmpFile, { force: true });
      if (i === maxTries - 1) throw e;
      await sleep(250 * (i + 1));
    }
  }
}

// ====== Google TTS Fallback ======
function buildGoogleTtsUrl(text, { lang = GOOGLE_LANG, slow = false, host = TTS_CONFIG.host } = {}) {
  const url = new URL('/translate_tts', host || 'https://translate.google.com');
  url.searchParams.set('ie', 'UTF-8');
  url.searchParams.set('q', text);
  url.searchParams.set('tl', lang || GOOGLE_LANG);
  url.searchParams.set('client', 'tw-ob');
  if (slow) {
    url.searchParams.set('ttsspeed', '0.24');
  }
  return url.toString();
}

function downloadUrlToFile(url, outFile, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outFile);
    const protocol = url.startsWith('https://') ? https : http;

    const req = protocol.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        file.close();
        fs.rmSync(outFile, { force: true });
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(downloadUrlToFile(nextUrl, outFile, redirectsLeft - 1));
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(outFile, { force: true });
        return reject(new Error(`Google TTS HTTP ${res.statusCode}`));
      }

      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    req.on('error', (err) => {
      file.close();
      fs.rmSync(outFile, { force: true });
      reject(err);
    });
  });
}

async function googleFallbackToFile(text, outFile, lang = GOOGLE_LANG) {
  ensureDir(path.dirname(outFile));
  const url = buildGoogleTtsUrl(text, {
    lang,
    slow: false,
    host: 'https://translate.google.com',
  });
  const tmp = makeTempPath(outFile);

  try {
    await downloadUrlToFile(url, tmp);
    if (!isValidAudioFile(tmp)) {
      throw new Error('google tts produced invalid/empty audio');
    }
    fs.renameSync(tmp, outFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return outFile;
}

// ====== Main TTS Function ======
/**
 * Generate/return cached TTS mp3 file
 * @param {string} text - Text to synthesize
 * @param {object} options - Options { voice?, lang?, slow?, provider? }
 * @returns {Promise<string>} Path to audio file
 */
async function textToSpeech(text, options = {}) {
  const {
    lang = 'en',
    slow = false,
    format = 'mp3',
    provider = TTS_CONFIG.provider,
    voice = TTS_CONFIG.edgeVoice,
  } = options;

  // Limit text length
  if (text.length > 200) {
    text = text.substring(0, 200);
    console.warn('Text truncated to 200 characters for TTS');
  }

  // Provider-scoped cache keys: Google fallback audio never poisons an Edge key
  const edgeKey = md5(`edge\n${voice}\n${text}`);
  const googleKey = md5(`google\n${lang}\n${text}`);
  const edgeFile = path.join(CACHE_DIR, `${edgeKey}.${format}`);
  const googleFile = path.join(CACHE_DIR, `${googleKey}.${format}`);

  // Check cache — validate content so poisoned/truncated files self-heal
  if (TTS_CONFIG.enableCache) {
    const preferred = provider === 'edge' ? edgeFile : googleFile;
    if (isValidAudioFile(preferred)) {
      console.log(`TTS cache hit: ${path.basename(preferred)}`);
      return preferred;
    }
    if (fs.existsSync(preferred)) {
      console.warn(`TTS cache invalid, regenerating: ${path.basename(preferred)}`);
      fs.rmSync(preferred, { force: true });
    }
  }

  console.log(`Generating TTS for text (${text.length} chars) using ${provider}...`);

  // Check if Edge TTS should be temporarily disabled due to failures
  const shouldSkipEdge =
    provider === 'edge' &&
    EDGE_TTS_STATS.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
    Date.now() - EDGE_TTS_STATS.lastFailureTime < FAILURE_COOLDOWN_MS;

  if (shouldSkipEdge) {
    const cooldownRemaining = Math.ceil(
      (FAILURE_COOLDOWN_MS - (Date.now() - EDGE_TTS_STATS.lastFailureTime)) / 1000
    );
    console.log(
      `[Edge TTS] Temporarily disabled due to ${EDGE_TTS_STATS.consecutiveFailures} consecutive failures. ` +
      `Cooldown: ${cooldownRemaining}s. Using Google TTS.`
    );
  }

  // Try Edge TTS first (if not skipped)
  if (provider === 'edge' && !shouldSkipEdge) {
    // Use shorter timeout for short texts, reduced timeout if recent failures
    const isShortText = text.length < 50;
    const hasRecentFailures = EDGE_TTS_STATS.consecutiveFailures > 0;
    const baseTimeout = isShortText ? EDGE_SHORT_TIMEOUT_MS : EDGE_TIMEOUT_MS;
    const timeout = hasRecentFailures ? REDUCED_TIMEOUT_MS : baseTimeout;

    console.log(`Using Edge TTS with voice: ${voice} (timeout: ${timeout}ms)`);
    EDGE_TTS_STATS.attempts++;

    try {
      await edgeSynthesizeToFile(text, voice, edgeFile, timeout);

      // Edge TTS succeeded
      EDGE_TTS_STATS.consecutiveFailures = 0;
      const successRate = (
        ((EDGE_TTS_STATS.attempts - EDGE_TTS_STATS.failures) /
          EDGE_TTS_STATS.attempts) *
        100
      ).toFixed(1);
      console.log(`Edge TTS generated: ${edgeFile} (Success rate: ${successRate}%)`);

      // Clean up old cache if needed
      if (TTS_CONFIG.enableCache) {
        await cleanupCache();
      }

      return edgeFile;
    } catch (e) {
      // Edge TTS failed
      EDGE_TTS_STATS.failures++;
      EDGE_TTS_STATS.consecutiveFailures++;
      EDGE_TTS_STATS.lastFailureTime = Date.now();

      console.error('[Edge TTS] fail -> fallback Google:', e?.message || e);
      console.log(
        `[Edge TTS] Stats: ${EDGE_TTS_STATS.failures}/${EDGE_TTS_STATS.attempts} failures, ` +
        `${EDGE_TTS_STATS.consecutiveFailures} consecutive`
      );
    }
  }

  if (provider === 'edge' && options.allowFallback === false) {
    const error = new Error('Neural speech is temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }

  // Fallback to Google TTS — writes under its own cache key, never the edge key
  if (TTS_CONFIG.enableCache && isValidAudioFile(googleFile)) {
    console.log(`TTS cache hit (google fallback): ${path.basename(googleFile)}`);
    return googleFile;
  }
  console.log('Using Google TTS...');
  const gOut = await googleFallbackToFile(text, googleFile, lang);
  console.log(`Google TTS generated: ${gOut}`);

  // Clean up old cache if needed
  if (TTS_CONFIG.enableCache) {
    await cleanupCache();
  }

  return gOut;
}

/**
 * Generate speech for book content with sentence segmentation
 * @param {string} text - Book content text
 * @param {object} options - TTS options
 * @returns {Promise<Array>} Array of audio file paths with timestamps
 */
async function textToSpeechWithSegments(text, options = {}) {
  const sentences = segmentText(text);
  const results = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (sentence.trim().length === 0) continue;

    console.log(`Generating TTS for sentence ${i + 1}/${sentences.length}`);

    try {
      const audioFile = await textToSpeech(sentence, options);
      results.push({
        index: i,
        text: sentence,
        audioFile: audioFile,
        duration: null,
      });
    } catch (err) {
      console.error(`Failed to generate TTS for sentence ${i}:`, err);
      results.push({
        index: i,
        text: sentence,
        audioFile: null,
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * Segment text into sentences
 * @param {string} text - Text to segment
 * @returns {Array<string>} Array of sentences
 */
function segmentText(text) {
  // Split by sentence endings and limit to 200 chars per segment
  const sentences = text
    .split(/([.!?。!?]+[\s\n]*)/)
    .filter(s => s.trim().length > 0)
    .reduce((acc, curr, idx, arr) => {
      if (idx % 2 === 0) {
        const sentence = curr + (arr[idx + 1] || '');
        if (sentence.trim().length > 0) {
          // Split long sentences
          if (sentence.length > 200) {
            const chunks = sentence.match(/.{1,200}/g) || [];
            acc.push(...chunks);
          } else {
            acc.push(sentence.trim());
          }
        }
      }
      return acc;
    }, []);

  return sentences;
}

/**
 * Clean up old cache files to maintain cache size limit
 */
async function cleanupCache() {
  try {
    const files = await fsPromises.readdir(CACHE_DIR);

    if (files.length <= MAX_CACHE_SIZE) {
      return;
    }

    // Get file stats
    const fileStats = await Promise.all(
      files.map(async file => {
        const filePath = path.join(CACHE_DIR, file);
        const stats = await fsPromises.stat(filePath);
        return { file, path: filePath, mtime: stats.mtime };
      })
    );

    // Sort by modification time (oldest first)
    fileStats.sort((a, b) => a.mtime - b.mtime);

    // Delete oldest files
    const filesToDelete = fileStats.slice(0, fileStats.length - MAX_CACHE_SIZE);

    for (const fileInfo of filesToDelete) {
      await fsPromises.unlink(fileInfo.path);
      console.log(`Deleted old TTS cache: ${fileInfo.file}`);
    }
  } catch (err) {
    console.error('Failed to cleanup TTS cache:', err);
  }
}

/**
 * Get available voices/languages
 * @returns {Promise<Array>} List of available languages
 */
async function getAvailableVoices() {
  return [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: 'Chinese (Simplified)' },
    { value: 'zh-TW', label: 'Chinese (Traditional)' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
  ];
}

// Ensure cache directory exists
ensureDir(CACHE_DIR);

module.exports = {
  textToSpeech,
  textToSpeechWithSegments,
  getAvailableVoices,
  segmentText,
  TTS_CONFIG,
};
