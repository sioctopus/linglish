const ytdl = require('@distube/ytdl-core');
const { YoutubeTranscript } = require('@danielxceron/youtube-transcript');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { decodeHtmlEntities } = require('../utils/text-utils');
const { mergeIncompleteSegments, normalizeSegmentsTiming } = require('../utils/segment-merger');
const path = require('path');

/**
 * YouTube Service
 * Handles YouTube video information extraction, subtitle fetching
 */

// Lazy-load Innertube (ESM module) using dynamic import
let innertubePromise = null;
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(module => module.Innertube);
  }
  return innertubePromise;
}

// Configure agent with proxy if available
let agent = null;
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  agent = new HttpsProxyAgent(proxyUrl);
  console.log('[YouTube] Using proxy:', proxyUrl);
}

// Configure ytdl options
const ytdlOptions = {
  requestOptions: {
    timeout: 30000, // 30 seconds timeout
  },
  // Suppress parser warnings - these are non-critical
  // The library can still function without parsing the n-transform function
};

if (agent) {
  ytdlOptions.agent = agent;
}

// Suppress ytdl-core parser warnings (they're not critical errors)
const originalConsoleWarn = console.warn;
const suppressedWarnings = new Set();
console.warn = function(...args) {
  const message = args[0];
  if (typeof message === 'string' &&
      (message.includes('Could not parse n transform') ||
       message.includes('WARNING: Could not parse'))) {
    // Only log once to avoid spam
    if (!suppressedWarnings.has(message)) {
      suppressedWarnings.add(message);
      originalConsoleWarn('[YouTube] Parser warning (suppressed future occurrences):', message.substring(0, 100));
    }
    return;
  }
  originalConsoleWarn.apply(console, args);
};

/**
 * Extract YouTube video ID from URL
 * @param {string} url - YouTube URL
 * @returns {string|null} Video ID or null if invalid
 */
function extractVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Handle various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#/]+)/, // Shorts links
    /^([a-zA-Z0-9_-]{11})$/, // Direct video ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate YouTube URL
 * @param {string} url - YouTube URL
 * @returns {boolean} True if valid YouTube URL
 */
function isValidYouTubeUrl(url) {
  const videoId = extractVideoId(url);
  return videoId !== null && videoId.length === 11;
}

/**
 * Retry helper function
 * @param {Function} fn - Function to retry
 * @param {number} retries - Number of retries
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise<any>} Result of the function
 */
async function retryWithDelay(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`[YouTube] Retry ${i + 1}/${retries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Get YouTube video info via yt-dlp (more reliable than ytdl-core)
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<Object>} Video information
 */
async function getVideoInfoViaYtDlp(videoId) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-download', '--no-warnings',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github',
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    execFile('yt-dlp', args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr?.trim() || error.message));
      }
      try {
        const data = JSON.parse(stdout);
        resolve({
          success: true,
          videoId,
          title: data.title,
          description: data.description || '',
          duration: data.duration || 0,
          thumbnail: data.thumbnail || null,
          author: data.uploader || data.channel || 'Unknown',
          viewCount: data.view_count || 0,
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

/**
 * Get YouTube video info
 * Tries yt-dlp first (more reliable), falls back to ytdl-core
 * @param {string} url - YouTube URL
 * @returns {Promise<Object>} Video information
 */
async function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Try yt-dlp first
  try {
    console.log(`[YouTube] Fetching video info via yt-dlp: ${videoId}`);
    const result = await getVideoInfoViaYtDlp(videoId);
    console.log(`[YouTube] yt-dlp success: ${result.title}`);
    return result;
  } catch (ytDlpError) {
    console.log(`[YouTube] yt-dlp failed: ${ytDlpError.message}, falling back to ytdl-core`);
  }

  // Fallback to ytdl-core
  try {
    const info = await retryWithDelay(async () => {
      return await ytdl.getInfo(videoId, ytdlOptions);
    }, 3, 2000);

    const { videoDetails } = info;

    return {
      success: true,
      videoId,
      title: videoDetails.title,
      description: videoDetails.description,
      duration: parseInt(videoDetails.lengthSeconds, 10),
      thumbnail: videoDetails.thumbnails && videoDetails.thumbnails.length > 0
        ? videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url
        : null,
      author: videoDetails.author?.name || 'Unknown',
      viewCount: parseInt(videoDetails.viewCount, 10) || 0,
    };
  } catch (error) {
    console.error('[YouTube] Failed to get video info:', error.message);
    throw new Error(`Failed to fetch YouTube video info: ${error.message}`);
  }
}

/**
 * Get YouTube video transcript using youtubei.js (Innertube API)
 * This is more reliable than web scraping
 * @param {string} videoId - YouTube video ID
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
async function getTranscriptViaInnertube(videoId, language = 'en') {
  try {
    console.log(`[YouTube] Fetching transcript via Innertube API for: ${videoId}`);

    const Innertube = await getInnertube();

    // Create Innertube instance with error handling
    let youtube;
    try {
      youtube = await Innertube.create({
        lang: language || 'en',
        location: 'US',
        retrieve_player: false, // Skip player retrieval to avoid parsing errors
      });
    } catch (createError) {
      // If creation fails due to parser errors, skip and use fallback
      console.warn('[YouTube] Innertube.create failed (likely parser error):', createError.message);
      throw new Error('Innertube initialization failed');
    }

    const info = await youtube.getInfo(videoId);
    const transcriptData = await info.getTranscript();

    if (!transcriptData || !transcriptData.transcript) {
      throw new Error('No transcript data returned from Innertube API');
    }

    // Extract segments from transcript data
    const initialSegments = transcriptData.transcript.content?.body?.initial_segments;

    if (!initialSegments || !Array.isArray(initialSegments)) {
      throw new Error('No transcript segments found in response');
    }

    // Convert to our segment format
    const rawSegments = initialSegments.map((segment, index) => {
      const snippet = segment.snippet || {};
      const startMs = parseInt(snippet.start_ms, 10) || 0;
      const durationMs = parseInt(snippet.duration_ms, 10) || 0;

      return {
        index,
        text: decodeHtmlEntities(snippet.text || ''),
        start: startMs / 1000, // Convert ms to seconds
        end: (startMs + durationMs) / 1000, // Convert ms to seconds
        speaker: null,
      };
    });

    // 智能合并不完整的句子segments
    // YouTube字幕通常按固定时间间隔切分，需要合并成自然句子
    console.log(`[YouTube] Raw segments: ${rawSegments.length}, applying smart merge...`);
    const normalizedSegments = normalizeSegmentsTiming(rawSegments);
    const segments = mergeIncompleteSegments(normalizedSegments, {
      maxMergeGap: 0.9,
      maxSegmentDuration: 6,
      minSegmentDuration: 0.45,
    });

    // Combine all text
    const fullText = segments.map(seg => seg.text).join(' ');

    console.log(`[YouTube] Successfully merged into ${segments.length} segments via Innertube`);

    return {
      success: true,
      transcript: fullText,
      segments,
      language,
      source: 'innertube',
    };
  } catch (error) {
    // Log parser-specific errors differently
    if (error.message && (error.message.includes('Unexpected token') || error.message.includes('parser'))) {
      console.warn('[YouTube] Innertube parser error (YouTube may have updated their code):', error.message);
    } else {
      console.error('[YouTube] Innertube transcript fetch failed:', error.message);
    }
    throw error;
  }
}

/**
 * Fetch a transcript by downloading YouTube's own caption track with yt-dlp,
 * then parsing the json3 caption format.
 *
 * This is the most reliable tier in practice: Innertube is prone to youtubei.js
 * parser breakage when YouTube changes their response shape, and the web-scrape
 * library is often blocked — but yt-dlp reaches caption tracks directly and is
 * already the trusted tool for video info/download elsewhere in this service.
 *
 * json3 shape: { events: [ { tStartMs, dDurationMs, segs: [ { utf8 } ] } ] }
 * Window-definition events have no `segs` and are skipped.
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
function resolveYtDlpBin() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  // Prefer the Python Scripts shim on Windows after `pip install yt-dlp`.
  try {
    const fsSync = require('fs');
    const candidates = process.platform === 'win32'
      ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python314', 'Scripts', 'yt-dlp.exe'),
        'C:\\Python314\\Scripts\\yt-dlp.exe',
        'C:\\Python313\\Scripts\\yt-dlp.exe',
        'C:\\Python312\\Scripts\\yt-dlp.exe',
        'yt-dlp.exe',
        'yt-dlp',
      ]
      : ['yt-dlp'];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate === 'yt-dlp' || candidate === 'yt-dlp.exe') return candidate;
      if (fsSync.existsSync(candidate)) return candidate;
    }
  } catch (_) {}
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

async function getTranscriptViaYtDlp(videoId, language = 'en') {
  const { execFile } = require('child_process');
  const fsp = require('fs/promises');
  const osMod = require('os');
  const pathMod = require('path');
  const ytDlpBin = resolveYtDlpBin();

  // Exact language codes only — never wildcards. YouTube exposes hundreds of
  // "translated from English" tracks (en-en-US, ab-en-US, ...) and a pattern
  // like `en.*` makes yt-dlp fetch them all, which trips YouTube's HTTP 429
  // rate limit partway through.
  const langPref = language && language !== 'auto'
    ? [...new Set([language, 'en', 'en-orig'])].join(',')
    : 'en,en-orig';
  const tmpDir = await fsp.mkdtemp(pathMod.join(osMod.tmpdir(), `linglish-subs-${videoId}-`));
  const outTemplate = pathMod.join(tmpDir, 'cap');

  const args = [
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--write-subs',        // manual/official captions (preferred)
    '--write-auto-subs',   // auto-generated captions (fallback)
    '--sub-langs', langPref,
    '--sub-format', 'json3',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
    args.push('--proxy', process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  }

  try {
    console.log(`[YouTube] Fetching transcript via yt-dlp captions for: ${videoId} (${ytDlpBin})`);
    // Don't reject on a non-zero exit: yt-dlp may fail on ONE requested track
    // (e.g. a 429 on a secondary language) after having already written a
    // perfectly good one. What matters is whether a caption file landed on
    // disk, which we check next.
    const cliError = await new Promise((resolve) => {
      execFile(ytDlpBin, args, { timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
        resolve(error ? (stderr?.trim() || error.message) : null);
      });
    });

    // yt-dlp writes cap.<lang>.json3. Pick the best available track:
    // manual/official over auto, exact language over variants.
    const files = (await fsp.readdir(tmpDir)).filter(f => f.endsWith('.json3'));
    if (!files.length) {
      throw new Error(cliError || 'No caption track downloaded by yt-dlp');
    }
    if (cliError) {
      console.warn('[YouTube] yt-dlp reported an error but usable captions were written:', String(cliError).slice(0, 200));
    }
    const preferred =
      files.find(f => f.includes(`.${language}.`) && !f.includes('auto')) ||
      files.find(f => !f.includes('auto')) ||
      files[0];

    const raw = await fsp.readFile(pathMod.join(tmpDir, preferred), 'utf8');
    const data = JSON.parse(raw);
    const events = Array.isArray(data.events) ? data.events : [];

    const rawSegments = [];
    let index = 0;
    for (const ev of events) {
      if (!Array.isArray(ev.segs)) continue;
      const text = decodeHtmlEntities(ev.segs.map(s => s.utf8 || '').join('').trim());
      if (!text) continue;
      const start = (Number(ev.tStartMs) || 0) / 1000;
      const end = start + (Number(ev.dDurationMs) || 0) / 1000;
      rawSegments.push({ index: index++, text, start, end, speaker: null });
    }

    if (!rawSegments.length) {
      throw new Error('yt-dlp caption track contained no text segments');
    }

    console.log(`[YouTube] Raw segments from yt-dlp: ${rawSegments.length}, applying smart merge...`);
    const normalizedSegments = normalizeSegmentsTiming(rawSegments);
    const segments = mergeIncompleteSegments(normalizedSegments, {
      maxMergeGap: 0.9,
      maxSegmentDuration: 6,
      minSegmentDuration: 0.45,
    });
    const fullText = segments.map(seg => seg.text).join(' ');

    console.log(`[YouTube] Successfully merged into ${segments.length} segments via yt-dlp (${preferred})`);
    return {
      success: true,
      transcript: fullText,
      segments,
      language,
      source: 'yt-dlp',
    };
  } finally {
    // Best-effort cleanup of the temp caption dir.
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Get YouTube video transcript/subtitles
 * Tries Innertube API, then yt-dlp captions, then web scraping.
 * @param {string} url - YouTube URL
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label || 'operation'} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

function httpsGetText(url, timeoutMs = 8000) {
  // Mirror-provided track URLs and redirects must use the same public-address
  // validation and resource limits as user-supplied media URLs.
  return require('./media-library').fetchText(url, {
    maxBytes: 1536 * 1024,
    timeoutMs,
    redirects: 3,
  });
}

function parseVttOrSrtToSegments(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const blocks = text
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  const segments = [];
  const timeRe = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3}/;
  const toSec = (stamp) => {
    const clean = String(stamp || '').replace(',', '.');
    const parts = clean.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(clean) || 0;
  };
  for (const block of blocks) {
    if (/^WEBVTT/i.test(block) || /^NOTE\b/i.test(block) || /^STYLE\b/i.test(block)) continue;
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let timeLine = lines.find((l) => timeRe.test(l));
    if (!timeLine && timeRe.test(lines[0])) timeLine = lines[0];
    if (!timeLine) continue;
    const m = timeLine.match(/((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3})/);
    if (!m) continue;
    const start = toSec(m[1]);
    const end = toSec(m[2]);
    const body = lines
      .filter((l) => l !== timeLine && !/^\d+$/.test(l))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    segments.push({
      index: segments.length,
      text: decodeHtmlEntities(body),
      start,
      end: end > start ? end : start + 1.5,
      speaker: null,
    });
  }
  return segments;
}

function parseJson3CaptionEvents(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch (_) { return []; }
  }
  const events = Array.isArray(data && data.events) ? data.events : [];
  const segments = [];
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;
    const text = decodeHtmlEntities(ev.segs.map((s) => s.utf8 || '').join('').trim());
    if (!text) continue;
    const start = (Number(ev.tStartMs) || 0) / 1000;
    const end = start + (Number(ev.dDurationMs) || 0) / 1000;
    segments.push({
      index: segments.length,
      text,
      start,
      end: end > start ? end : start + 1.2,
      speaker: null,
    });
  }
  return segments;
}

function finalizeCaptionSegments(rawSegments, language, source) {
  if (!rawSegments.length) throw new Error('No caption segments from ' + source);
  const normalizedSegments = normalizeSegmentsTiming(rawSegments);
  const segments = mergeIncompleteSegments(normalizedSegments, {
    maxMergeGap: 0.9,
    maxSegmentDuration: 6,
    minSegmentDuration: 0.45,
  });
  return {
    success: true,
    transcript: segments.map((s) => s.text).join(' '),
    segments,
    language,
    source,
  };
}

async function getTranscriptViaMirrors(videoId, language = 'en') {
  const lang = String(language || 'en').toLowerCase();
  const invidiousHosts = [
    'yewtu.be',
    'invidious.nerdvpn.de',
    'inv.perditum.com',
    'invidious.f5.si',
    'inv.nadeko.net',
  ];
  const pipedHosts = [
    'pipedapi.adminforge.de',
    'pipedapi.kavin.rocks',
    'api.piped.private.coffee',
  ];

  for (const host of invidiousHosts) {
    try {
      console.log(`[YouTube] Trying Invidious captions via ${host}...`);
      const listRaw = await httpsGetText(`https://${host}/api/v1/captions/${encodeURIComponent(videoId)}`, 7000);
      const list = JSON.parse(listRaw);
      if (!Array.isArray(list) || !list.length) continue;
      const preferred =
        list.find((t) => String(t.languageCode || '').toLowerCase() === lang) ||
        list.find((t) => String(t.language_code || '').toLowerCase() === lang) ||
        list.find((t) => /en/i.test(String(t.languageCode || t.language_code || t.label || ''))) ||
        list[0];
      const label = preferred.label || preferred.languageCode || preferred.language_code || 'en';
      const captionUrl = preferred.url
        ? (preferred.url.startsWith('http') ? preferred.url : `https://${host}${preferred.url}`)
        : `https://${host}/api/v1/captions/${encodeURIComponent(videoId)}?label=${encodeURIComponent(label)}`;
      const body = await httpsGetText(captionUrl, 8000);
      const rawSegments = body.trim().startsWith('{')
        ? parseJson3CaptionEvents(body)
        : parseVttOrSrtToSegments(body);
      return finalizeCaptionSegments(rawSegments, lang, `invidious:${host}`);
    } catch (err) {
      console.warn(`[YouTube] Invidious ${host} failed:`, err.message);
    }
  }

  for (const host of pipedHosts) {
    try {
      console.log(`[YouTube] Trying Piped captions via ${host}...`);
      const raw = await httpsGetText(`https://${host}/streams/${encodeURIComponent(videoId)}`, 8000);
      const data = JSON.parse(raw);
      const bags = [data.subtitles || {}, data.automaticCaptions || data.autoCaptions || {}];
      let trackUrl = null;
      for (const bag of bags) {
        const keys = Object.keys(bag || {});
        const key =
          keys.find((k) => k.toLowerCase() === lang) ||
          keys.find((k) => k.toLowerCase().startsWith('en')) ||
          keys[0];
        if (!key) continue;
        const tracks = Array.isArray(bag[key]) ? bag[key] : [];
        const hit = tracks.find((t) => /json3|vtt|srt|text/i.test(String(t.mimeType || t.url || ''))) || tracks[0];
        if (hit && hit.url) {
          trackUrl = hit.url;
          break;
        }
      }
      if (!trackUrl) continue;
      const body = await httpsGetText(trackUrl, 8000);
      const rawSegments = body.trim().startsWith('{')
        ? parseJson3CaptionEvents(body)
        : parseVttOrSrtToSegments(body);
      return finalizeCaptionSegments(rawSegments, lang, `piped:${host}`);
    } catch (err) {
      console.warn(`[YouTube] Piped ${host} failed:`, err.message);
    }
  }

  throw new Error('All caption mirrors failed');
}

async function getTranscriptInner(url, language = 'en') {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Prefer yt-dlp first: on restricted networks Node fetch/Innertube often time out,
  // while yt-dlp still reaches caption tracks. Keep Innertube as a fast secondary.
  try {
    const result = await getTranscriptViaYtDlp(videoId, language);
    return result;
  } catch (ytDlpError) {
    console.log('[YouTube] yt-dlp caption fetch failed, trying Innertube:', ytDlpError.message);
  }

  const ENABLE_INNERTUBE = process.env.YOUTUBE_ENABLE_INNERTUBE !== '0';
  const INNERTUBE_TIMEOUT_MS = Number(process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS) || 8000;

  if (ENABLE_INNERTUBE) {
    try {
      console.log('[YouTube] Attempting transcript fetch via Innertube API...');
      const result = await withTimeout(
        getTranscriptViaInnertube(videoId, language),
        INNERTUBE_TIMEOUT_MS,
        'Innertube transcript'
      );
      return result;
    } catch (innertubeError) {
      console.log('[YouTube] Innertube API failed:', innertubeError.message);
    }
  }

  // Sending a video ID to third-party caption mirrors requires operator opt-in.
  if (process.env.YOUTUBE_ENABLE_MIRRORS === '1') {
    try {
      const result = await withTimeout(
        getTranscriptViaMirrors(videoId, language),
        12000,
        'mirror transcript'
      );
      return result;
    } catch (mirrorError) {
      console.log('[YouTube] Mirror caption fetch failed, falling back to web scraping:', mirrorError.message);
    }
  }

  // Use web scraping method directly
  try {
    // Prefer requested language, then English / auto. Keep the list short so
    // unreachable networks fail fast instead of retrying every locale.
    const languagesToTry = [
      language,
      language === 'en' ? null : 'en',
      null,
    ].filter((lang, index, arr) => arr.indexOf(lang) === index);

      let transcript = null;
      let usedLanguage = null;
      let lastError = null;

      for (const lang of languagesToTry) {
        try {
          console.log(`[YouTube] Trying to fetch transcript with language: ${lang || 'auto'}`);

          const options = lang ? { lang } : {};

          // One retry is enough when YouTube is reachable; network failures
          // should not burn 3×N language attempts.
          transcript = await withTimeout(
            retryWithDelay(async () => YoutubeTranscript.fetchTranscript(videoId, options), 1, 800),
            6000,
            `web transcript (${lang || 'auto'})`
          );

          if (transcript && transcript.length > 0) {
            usedLanguage = lang || 'auto';
            console.log(`[YouTube] Successfully fetched transcript with language: ${usedLanguage}`);
            break;
          }
        } catch (err) {
          lastError = err;
          console.log(`[YouTube] Failed with language ${lang || 'auto'}: ${err.message}`);
          if (/fetch failed|timed out|ECONN|ENOTFOUND|network/i.test(String(err && err.message))) {
            break;
          }
        }
      }

      // If no transcript found after all attempts
      if (!transcript || transcript.length === 0) {
        throw new Error('No transcript available for this video');
      }

      // Convert to our segment format
      // Note: @danielxceron/youtube-transcript returns offset and duration in SECONDS, not milliseconds
      const rawSegments = transcript.map((item, index) => ({
        index,
        text: decodeHtmlEntities(item.text), // Decode HTML entities (e.g., &amp;#39; -> ')
        start: item.offset, // Already in seconds
        end: item.offset + item.duration, // Already in seconds
        speaker: null, // YouTube doesn't provide speaker info
      }));

      // 智能合并不完整的句子segments
      // YouTube字幕通常按固定时间间隔切分，需要合并成自然句子
      console.log(`[YouTube] Raw segments from web-scraping: ${rawSegments.length}, applying smart merge...`);
      const normalizedSegments = normalizeSegmentsTiming(rawSegments);
      const segments = mergeIncompleteSegments(normalizedSegments, {
        maxMergeGap: 0.9,
        maxSegmentDuration: 6,
        minSegmentDuration: 0.45,
      });

      // Combine all text
      const fullText = segments.map(seg => seg.text).join(' ');

      console.log(`[YouTube] Successfully merged into ${segments.length} segments via web-scraping`);

      return {
        success: true,
        transcript: fullText,
        segments,
        language: usedLanguage,
        source: 'web-scraping',
      };
    } catch (error) {
      console.error('[YouTube] Failed to get transcript:', error.message);

      // Check if it's a "no transcript" error
      if (error.message && (
        error.message.includes('Could not find transcripts') ||
        error.message.includes('No transcript available') ||
        error.message.includes('Transcript is disabled')
      )) {
        throw new Error('No transcript available for this video. Please try another video or enable captions on YouTube.');
      }

      throw new Error(`Failed to fetch YouTube transcript: ${error.message}`);
    }
}

async function getTranscript(url, language = 'en') {
  // yt-dlp alone often needs ~10–20s; leave room after failed Node-fetch tiers.
  const overallMs = Number(process.env.YOUTUBE_TRANSCRIPT_TIMEOUT_MS) || 45000;
  try {
    return await withTimeout(getTranscriptInner(url, language), overallMs, 'YouTube transcript');
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'Failed to fetch YouTube transcript';
    if (/timed out/i.test(message)) {
      throw new Error('字幕拉取超时。当前网络可能无法访问 YouTube，请配置代理、安装 yt-dlp，或改用已上传的本地视频。');
    }
    throw error;
  }
}

/**
 * Get available transcript languages for a video
 * @param {string} url - YouTube URL
 * @returns {Promise<Array>} List of available language codes
 */
async function getAvailableLanguages(url) {
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // Try to fetch transcripts for common languages
    const languages = ['en', 'zh', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'ja', 'ko'];
    const available = [];

    for (const lang of languages) {
      try {
        await YoutubeTranscript.fetchTranscript(videoId, { lang });
        available.push(lang);
      } catch (e) {
        // Language not available, continue
      }
    }

    return available;
  } catch (error) {
    console.error('[YouTube] Failed to get available languages:', error.message);
    return [];
  }
}

/**
 * Extract words from transcript text
 * @param {string} text - Transcript text
 * @returns {Array<string>} Array of unique words
 */
function extractWords(text) {
  if (!text || typeof text !== 'string') return [];

  const words = text
    .toLowerCase()
    .replace(/['']/g, "'")
    .split(/[\s\-—–]+/)
    .map(word => {
      const cleaned = word.replace(/[^a-z'-]/gi, '');
      return cleaned.replace(/^['\-]+|['\-]+$/g, '');
    })
    .filter(word => {
      return word.length >= 2 &&
             /[a-z]/i.test(word) &&
             !/^\d+$/.test(word) &&
             !/[']{2,}/.test(word);
    });

  return [...new Set(words)];
}

/**
 * Download YouTube video to local file using yt-dlp
 * yt-dlp is more reliable than ytdl-core and bypasses YouTube restrictions
 * @param {string} url - YouTube URL
 * @param {string} outputPath - Local file path to save video
 * @returns {Promise<string>} Path to downloaded video file
 */
async function downloadVideo(url, outputPath) {
  try {
    const fs = require('fs');
    const fsPromises = require('fs/promises');
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`[YouTube Download] Starting download with yt-dlp: ${videoId}`);
    console.log(`[YouTube Download] Output path: ${outputPath}`);

    // Prepare yt-dlp options
    const ytDlpOptions = {
      output: outputPath,
      format: 'bestaudio/best', // Download best audio quality
      noPlaylist: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      jsRuntimes: 'node',
      remoteComponents: 'ejs:github',
      addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ],
    };

    // Add proxy if available
    if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      ytDlpOptions.proxy = proxyUrl;
      console.log(`[YouTube Download] Using proxy: ${proxyUrl}`);
    }

    let usedDownloader = 'yt-dlp';
    try {
      // Download video using yt-dlp if available
      console.log('[YouTube Download] Executing yt-dlp...');
      const ytDlp = require('yt-dlp-exec');
      await ytDlp(url, ytDlpOptions);
    } catch (ytDlpErr) {
      console.warn('[YouTube Download] yt-dlp not available or failed:', ytDlpErr.message);

      // Attempt bundled binary if present
      const bundledBinary = path.resolve(__dirname, '..', 'bin', 'yt-dlp');
      const hasBundledBinary = fs.existsSync(bundledBinary);

      if (hasBundledBinary) {
        console.log('[YouTube Download] Trying bundled yt-dlp binary...');
        usedDownloader = 'yt-dlp-bundled';
        try {
          const { spawn } = require('child_process');
          await new Promise((resolve, reject) => {
            const args = [
              '-o', outputPath,
              '-f', 'bestaudio/best',
              '--no-playlist',
              '--no-check-certificates',
              '--prefer-free-formats',
              '--js-runtimes', 'node',
              '--remote-components', 'ejs:github',
              '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              url,
            ];
            if (ytDlpOptions.proxy) {
              args.push('--proxy', ytDlpOptions.proxy);
            }
            const proc = spawn(bundledBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            proc.stdout.on('data', (d) => console.log('[yt-dlp]', d.toString().trim()));
            proc.stderr.on('data', (d) => console.warn('[yt-dlp]', d.toString().trim()));
            proc.on('error', reject);
            proc.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`yt-dlp binary exited with code ${code}`));
            });
          });
        } catch (binErr) {
          console.warn('[YouTube Download] Bundled yt-dlp failed:', binErr.message);
          usedDownloader = 'ytdl-core';
        }
      } else {
        usedDownloader = 'ytdl-core';
      }

      if (usedDownloader === 'ytdl-core') {
        console.log('[YouTube Download] Falling back to ytdl-core download');
        // Fallback: use ytdl-core to grab best audio
        const audioStream = ytdl(url, {
          filter: 'audioonly',
          quality: 'highestaudio',
          requestOptions: ytdlOptions.requestOptions,
          dlChunkSize: 0,
          highWaterMark: 1 << 25, // 32MB buffer to reduce 403 retry churn
        });

        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(outputPath);
          audioStream.pipe(writeStream);
          audioStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', resolve);
        });
      }
    }

    // Verify file exists and has content
    const stats = await fsPromises.stat(outputPath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    console.log(`[YouTube Download] Download completed successfully via ${usedDownloader}`);
    console.log(`[YouTube Download] File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    return outputPath;
  } catch (error) {
    console.error('[YouTube Download] Error:', error.message);

    // Clean up partial file if it exists
    try {
      const fs = require('fs');
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('[YouTube Download] Cleaned up partial download file');
      }
    } catch (cleanupError) {
      console.warn('[YouTube Download] Failed to clean up:', cleanupError.message);
    }

    throw new Error(`Video download failed: ${error.message}`);
  }
}

module.exports = {
  extractVideoId,
  isValidYouTubeUrl,
  getVideoInfo,
  getTranscript,
  getAvailableLanguages,
  extractWords,
  downloadVideo,
};
