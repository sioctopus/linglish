const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { randomBytes } = crypto;

// Dependencies from server
const dataStore = require('../data-store');
const videoTranscriptionService = require('../services/video-transcription');
const cacheService = require('../services/cache');
const { handleFileUpload, cleanupFile } = require('../upload-handler');
const youtubeDownloader = require('../services/yt-dlp-downloader');
const geoIPService = require('../services/geo-ip');
const vocabularyV2 = require('../services/vocabulary-v2');
const { canonicalLevel } = require('../services/video-level');
const { getUploadLimits, hasActivePaidEntitlement, isGuestAccount } = require('../services/entitlements');
const { mergeIncompleteSegments, normalizeSegmentsTiming } = require('../utils/segment-merger');
const { convertAudioToWav, ffmpegAvailable: audioFfmpegAvailable } = require('../utils/audio-utils');
const { downloadVideo: downloadYouTubeAudio, extractVideoId } = require('../services/youtube');

// Get ffmpeg if available
let ffmpeg;
let ffmpegAvailable = false;
try {
  ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller?.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    ffmpegAvailable = true;
  }
  try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller?.path) {
      ffmpeg.setFfprobePath(ffprobeInstaller.path);
    }
  } catch (e) {
    if (process.env.FFPROBE_PATH) {
      try { ffmpeg.setFfprobePath(process.env.FFPROBE_PATH); } catch (_) {}
    }
  }
} catch (err) {
  console.warn('[Videos] FFmpeg not available, transcoding disabled.');
}

const { URL } = require('url');

// Configuration
const STATIC_DIR = path.join(__dirname, '../public');
const VIDEO_DIR = path.join(STATIC_DIR, 'videos');
const RECORDINGS_DIR = path.join(STATIC_DIR, 'recordings');
const THUMBS_DIR = path.join(STATIC_DIR, 'thumbnails');
const VIDEO_TRANSCRIPTION_ENABLED = require('../config/ai-config').features?.videoTranscription !== false;
const FORCE_LOCAL_VIDEO = process.env.FORCE_LOCAL_VIDEO === 'true';
const FORCE_LOCAL_VIDEO_REQUIRE_FILE = process.env.FORCE_LOCAL_VIDEO_REQUIRE_FILE === 'true';
const LOCAL_VIDEO_INDEX_REFRESH_SEC = Number(process.env.LOCAL_VIDEO_INDEX_REFRESH_SEC || 60);

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0'
};

const WAVEFORM_CACHE_TTL_MS = 1000 * 60 * 20;
const waveformCache = new Map();
const waveformAudioCache = new Map();
const wavBufferCache = new Map(); // Cache converted WAV buffers to avoid reconversion

function buildWaveformCacheKey(videoId, startSec, endSec, points) {
  return `${videoId}:${Number(startSec || 0).toFixed(2)}:${Number(endSec || 0).toFixed(2)}:${Number(points || 240)}`;
}

function getCachedWaveform(key) {
  const entry = waveformCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > WAVEFORM_CACHE_TTL_MS) {
    waveformCache.delete(key);
    return null;
  }
  return entry.samples;
}

function setCachedWaveform(key, samples) {
  waveformCache.set(key, { ts: Date.now(), samples });
}

async function resolveAudioSourcePath(resource) {
  if (!resource) return null;
  const relLocal = resource.local_video_path ? String(resource.local_video_path).replace(/^\/+/, '') : '';
  if (relLocal) {
    const fullLocal = path.join(STATIC_DIR, relLocal);
    if (fs.existsSync(fullLocal)) return fullLocal;
  }
  if (resource.video_path && String(resource.video_path).startsWith('/videos/')) {
    const rel = String(resource.video_path).replace(/^\/+/, '');
    const full = path.join(STATIC_DIR, rel);
    if (fs.existsSync(full)) return full;
  }
  const youtubeId = resource.youtube_video_id || extractVideoId(resource.video_path || '') || null;
  if (!youtubeId) return null;
  const cached = waveformAudioCache.get(String(youtubeId));
  if (cached && cached.path && Date.now() - cached.ts < WAVEFORM_CACHE_TTL_MS && fs.existsSync(cached.path)) {
    return cached.path;
  }
  const tmpPath = path.join(os.tmpdir(), `linglish-yt-audio-${youtubeId}-${Date.now()}.webm`);
  await downloadYouTubeAudio(`https://www.youtube.com/watch?v=${youtubeId}`, tmpPath);
  waveformAudioCache.set(String(youtubeId), { ts: Date.now(), path: tmpPath });
  return tmpPath;
}

function parseWavData(buffer) {
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataOffset = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (id === 'fmt ') {
      const format = buffer.readUInt16LE(offset);
      channels = buffer.readUInt16LE(offset + 2);
      sampleRate = buffer.readUInt32LE(offset + 4);
      bitsPerSample = buffer.readUInt16LE(offset + 14);
      if (format !== 1) {
        throw new Error('Unsupported WAV format');
      }
    } else if (id === 'data') {
      dataOffset = offset;
      dataSize = size;
      break;
    }
    offset += size;
  }
  if (dataOffset == null || dataSize == null) {
    throw new Error('Invalid WAV data');
  }
  return { sampleRate, bitsPerSample, channels, dataOffset, dataSize };
}

function buildWaveformSamples(buffer, startSec, endSec, points) {
  const { sampleRate, bitsPerSample, channels, dataOffset, dataSize } = parseWavData(buffer);
  if (bitsPerSample !== 16 || channels !== 1) {
    throw new Error('Unsupported WAV format');
  }
  const pcm = buffer.subarray(dataOffset, dataOffset + dataSize);
  const totalSamples = Math.floor(pcm.length / 2);
  const start = Math.max(0, Math.floor((Number(startSec) || 0) * sampleRate));
  const end = Math.min(totalSamples, Math.floor((Number(endSec) || 0) * sampleRate) || totalSamples);
  const length = Math.max(1, end - start);
  const bucketSize = Math.max(1, Math.floor(length / points));
  const samples = [];
  for (let i = 0; i < points; i += 1) {
    const bucketStart = start + i * bucketSize;
    const bucketEnd = Math.min(end, bucketStart + bucketSize);
    let min = 32767;
    let max = -32768;
    for (let s = bucketStart; s < bucketEnd; s += 1) {
      const idx = s * 2;
      const value = pcm.readInt16LE(idx);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    samples.push(min / 32768, max / 32768);
  }
  return samples;
}

// ============================================================================
// Helper Functions
// ============================================================================

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[Videos] Attempted to send response after stream closed');
    return false;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

function sendError(res, status, message) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[Videos] Attempted to send error after stream closed');
    return false;
  }
  return sendJson(res, status, { code: status, message });
}

let localVideoIndexReady = false;
let localVideoIndexRefreshing = false;
let localVideoIndex = new Set();
let localVideoIndexTimer = null;

async function refreshLocalVideoIndex() {
  if (localVideoIndexRefreshing) return;
  localVideoIndexRefreshing = true;
  try {
    const next = new Set();
    const entries = await fsp.readdir(VIDEO_DIR, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) {
        next.add(`/videos/${entry.name}`);
        continue;
      }
      if (entry.isDirectory()) {
        const subdir = entry.name;
        const subEntries = await fsp.readdir(path.join(VIDEO_DIR, subdir), { withFileTypes: true }).catch(() => []);
        for (const subEntry of subEntries) {
          if (subEntry.isFile()) {
            next.add(`/videos/${subdir}/${subEntry.name}`);
          }
        }
      }
    }
    localVideoIndex = next;
    localVideoIndexReady = true;
  } catch (err) {
    console.warn('[Videos] Failed to refresh local video index:', err.message);
  } finally {
    localVideoIndexRefreshing = false;
  }
}

function scheduleLocalVideoIndexRefresh() {
  if (localVideoIndexTimer) return;
  refreshLocalVideoIndex();
  localVideoIndexTimer = setInterval(refreshLocalVideoIndex, Math.max(10, LOCAL_VIDEO_INDEX_REFRESH_SEC) * 1000);
}

if (FORCE_LOCAL_VIDEO_REQUIRE_FILE) {
  scheduleLocalVideoIndexRefresh();
}

function hasLocalVideoFile(video) {
  if (!video || !video.local_video_path) return false;
  if (localVideoIndexReady) {
    return localVideoIndex.has(video.local_video_path);
  }
  const rel = String(video.local_video_path).replace(/^\/+/, '');
  const fullPath = path.join(STATIC_DIR, rel);
  try {
    return fs.existsSync(fullPath);
  } catch (_) {
    return false;
  }
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    console.log('[parseBody] No body chunks received');
    return {};
  }

  const bodyString = Buffer.concat(chunks).toString();
  const bodyLength = bodyString.length;
  const timestamp = new Date().toISOString();

  console.log('─'.repeat(80));
  console.log(`[parseBody] ${timestamp} - Body size: ${bodyLength} bytes (${(bodyLength / 1024).toFixed(2)} KB)`);

  // Preview body even on success (first 200 chars)
  if (bodyLength > 0 && bodyLength <= 1000) {
    console.log('[parseBody] Full body preview:', bodyString);
  } else if (bodyLength > 0) {
    console.log('[parseBody] Body preview (first 200 chars):', bodyString.substring(0, 200) + '...');
  }

  try {
    const parsed = JSON.parse(bodyString);
    console.log('[parseBody] ✓ JSON parsing successful');
    console.log('[parseBody] Parsed keys:', Object.keys(parsed).join(', '));

    // Log segments info if present
    if (parsed.segments !== undefined) {
      const isArray = Array.isArray(parsed.segments);
      const segType = typeof parsed.segments;
      console.log('[parseBody] Segments field detected:');
      console.log('[parseBody]   - Type:', segType);
      console.log('[parseBody]   - Is Array:', isArray);
      if (isArray) {
        console.log('[parseBody]   - Length:', parsed.segments.length);
        if (parsed.segments.length > 0) {
          console.log('[parseBody]   - First item keys:', Object.keys(parsed.segments[0] || {}).join(', '));
          console.log('[parseBody]   - First item sample:', JSON.stringify(parsed.segments[0]).substring(0, 150));
        } else {
          console.warn('[parseBody]   ⚠️  WARNING: Segments array is EMPTY');
        }
      } else {
        console.warn('[parseBody]   ⚠️  WARNING: Segments is NOT an array');
      }
    } else {
    console.log('[parseBody] No segments field in parsed body');
  }

    console.log(`[${timestamp}] [parseBody] user=${parsed?.userId || 'unknown'} length=${bodyLength} bytes`);
    console.log('─'.repeat(80));
    return parsed;
  } catch (err) {
    console.error('═'.repeat(80));
    console.error(`[parseBody] ✗ JSON PARSE ERROR at ${timestamp}`);
    console.error('[parseBody] Error message:', err.message);
    console.error('[parseBody] Error stack:', err.stack);
    console.error('[parseBody] Body size:', bodyLength, 'bytes');
    console.error('[parseBody] Body preview (first 500 chars):');
    console.error(bodyString.substring(0, 500));
    if (bodyLength > 500) {
      console.error('[parseBody] Body preview (last 200 chars):');
      console.error('...' + bodyString.substring(bodyLength - 200));
    }
    console.error('═'.repeat(80));
    return {};
  }
}

function parseTimestampedTranscript(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const segments = [];
  const tsRegex = /^\(?(\d{1,2}):(\d{2})(?::(\d{2}))?\)?\s*(.+)$/;

  lines.forEach((line) => {
    const match = line.match(tsRegex);
    if (match) {
      const hasHour = Boolean(match[3]);
      const hh = hasHour ? Number(match[1]) : 0;
      const mm = hasHour ? Number(match[2]) : Number(match[1]);
      const ss = hasHour ? Number(match[3]) : Number(match[2]);
      const start = (hh * 3600) + (mm * 60) + ss;
      const rest = match[4].trim();
      const parts = rest.split(/\t+/);
      const text = (parts[0] || '').trim();
      const translation = (parts[1] || '').trim();
      segments.push({
        index: segments.length,
        start,
        end: start,
        text,
        translation: translation || null,
        speaker: null
      });
    } else if (segments.length) {
      // Append to previous segment text if no timestamp on this line
      const parts = line.split(/\t+/);
      const text = (parts[0] || '').trim();
      const translation = (parts[1] || '').trim();
      segments[segments.length - 1].text = `${segments[segments.length - 1].text} ${text}`.trim();
      if (translation) {
        segments[segments.length - 1].translation = `${segments[segments.length - 1].translation || ''} ${translation}`.trim();
      }
    } else if (line) {
      const parts = line.split(/\t+/);
      const text = (parts[0] || '').trim();
      const translation = (parts[1] || '').trim();
      segments.push({ index: 0, start: 0, end: 0, text, translation: translation || null, speaker: null });
    }
  });

  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    if (next && Number.isFinite(next.start) && next.start > segments[i].start) {
      segments[i].end = next.start;
    } else {
      segments[i].end = segments[i].start + 4;
    }
  }

  return segments;
}

function readCookie(req, key) {
  try {
    const raw = req.headers?.cookie;
    if (!raw || typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === key) {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
  } catch (_) {}
  return null;
}

function extractAuthToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0].toLowerCase() === 'bearer') return parts[1];
    if (parts.length === 1) return parts[0];
  }
  return readCookie(req, 'linglish_token') || readCookie(req, 'authToken') || readCookie(req, 'token');
}

async function authenticate(req) {
  // Import here to avoid circular dependencies
  const authService = require('../services/auth');
  const token = extractAuthToken(req);
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  return authService.requireUser(token);
}

async function getUserContext(req) {
  try {
    const authService = require('../services/auth');
    const token = extractAuthToken(req);
    if (!token || !authService?.requireUser) return { id: null, username: null, label: 'guest' };
    const user = await authService.requireUser(token);
    const username = user?.username || user?.email || null;
    return {
      id: user?.id || null,
      username,
      label: username || user?.id || 'guest',
    };
  } catch (_) {
    return { id: null, username: null, label: 'guest' };
  }
}

function logWithUser(prefix, userCtx, message) {
  const ts = new Date().toISOString();
  const label = (userCtx && userCtx.label) || 'guest';
  console.log(`[${ts}] [${prefix}] user=${label} ${message}`);
}

function warnWithUser(prefix, userCtx, message) {
  const ts = new Date().toISOString();
  const label = (userCtx && userCtx.label) || 'guest';
  console.warn(`[${ts}] [${prefix}] user=${label} ${message}`);
}

function errorWithUser(prefix, userCtx, message, err) {
  const ts = new Date().toISOString();
  const label = (userCtx && userCtx.label) || 'guest';
  if (err) {
    console.error(`[${ts}] [${prefix}] user=${label} ${message}`, err);
  } else {
    console.error(`[${ts}] [${prefix}] user=${label} ${message}`);
  }
}

function isSameUserId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

function canAccessVideoResource(resource, user) {
  if (!resource) return false;
  const isOwnerOrAdmin = Boolean(user?.is_admin) || isSameUserId(resource.uploader_id, user?.id);
  if (resource.is_public === false) return isOwnerOrAdmin;
  if (resource.is_vip_only === true && !isOwnerOrAdmin) {
    return hasActivePaidEntitlement(user);
  }
  return true;
}

function normalizeShareRequestType(value) {
  const type = String(value || 'public').trim().toLowerCase();
  if (type === 'public' || type === 'featured') return type;
  return null;
}

function normalizeShareRequestStatus(value, fallback = 'pending') {
  const status = String(value || fallback).trim().toLowerCase();
  if (['pending', 'approved', 'rejected', 'cancelled', 'all'].includes(status)) return status;
  return null;
}

function serializeVideoShareRequest(item) {
  if (!item) return null;
  return {
    id: item.id,
    video_id: item.video_resource_id,
    video_title: item.video_title || null,
    requester_id: item.requester_id,
    requester_username: item.requester_username || item.requester_email || null,
    request_type: item.request_type,
    note: item.note || null,
    status: item.status,
    reviewer_id: item.reviewer_id || null,
    reviewer_username: item.reviewer_username || null,
    review_note: item.review_note || null,
    reviewed_at: item.reviewed_at || null,
    created_at: item.created_at || null,
    updated_at: item.updated_at || null,
    already_pending: Boolean(item.already_pending),
  };
}

async function clearVideoResourceCaches(videoId) {
  try {
    await Promise.all([
      cacheService.del(`video:detail:${videoId}`),
      cacheService.del('videos:public:lite'),
      cacheService.del('videos:public:full'),
    ]);
  } catch (_) {}
}

/**
 * Calculate and update video difficulty based on transcript vocabulary
 * Called after transcript is saved to automatically determine video difficulty level
 *
 * @param {number} videoId - Video resource ID
 * @param {Array|string} transcriptData - Transcript segments or full transcript text
 */
async function updateVideoDifficultyFromTranscript(videoId, transcriptData) {
  try {
    if (!transcriptData) {
      console.log(`[Video Difficulty] Skipping difficulty calculation for video ${videoId} - no transcript data`);
      return null;
    }

    const { difficulty, score, stats } = await vocabularyV2.calculateVideoDifficulty(transcriptData);

    if (difficulty) {
      await dataStore.updateVideoResource(videoId, { difficulty_level: difficulty });
      console.log(`[Video Difficulty] Video ${videoId} difficulty set to ${difficulty} (score: ${score}, words: ${stats.total})`);
      return { difficulty, score, stats };
    } else {
      console.log(`[Video Difficulty] Could not calculate difficulty for video ${videoId} - insufficient vocabulary data`);
      return null;
    }
  } catch (err) {
    console.error(`[Video Difficulty] Failed to update difficulty for video ${videoId}:`, err.message);
    return null;
  }
}

/**
 * Merge subtitle segments into complete sentences.
 * YouTube subtitles are often split by time (every 2-3 seconds), not by sentence boundaries.
 * This function merges consecutive segments until a sentence-ending punctuation is found.
 *
 * @param {Array} segments - Array of segments with {text, start, end, speaker}
 * @returns {Array} - Merged segments with complete sentences
 */
function mergeSentenceSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return segments;
  }

  const merged = [];
  let currentSegment = null;

  // Sentence ending pattern: . ! ? 。 ! ? (with optional closing quotes/brackets)
  // Match sentence enders followed by optional quotes and whitespace, then more text or end
  const sentenceEndPattern = /[.!?。！？]['"\u201d\u2019\u300d）】\]]*(?:\s|$)/;
  const sentenceEndAtEnd = /[.!?。！？]['"\u201d\u2019\u300d）】\]]*\s*$/;

  /**
   * Split text at sentence boundaries while preserving the punctuation
   * Returns array of sentences
   */
  function splitAtSentences(text) {
    const sentences = [];
    let remaining = text;

    while (remaining.length > 0) {
      const match = remaining.match(sentenceEndPattern);
      if (match) {
        const endIndex = match.index + match[0].length;
        const sentence = remaining.substring(0, endIndex).trim();
        if (sentence) {
          sentences.push(sentence);
        }
        remaining = remaining.substring(endIndex).trim();
      } else {
        // No more sentence endings, keep the rest as one piece
        if (remaining.trim()) {
          sentences.push(remaining.trim());
        }
        break;
      }
    }

    return sentences;
  }

  function flushCurrentSegment() {
    if (currentSegment === null) return;
    const text = (currentSegment.text || '').trim();
    if (!text) {
      currentSegment = null;
      return;
    }

    const sentences = splitAtSentences(text).map(s => s.trim()).filter(Boolean);
    const duration = Number(currentSegment.end) - Number(currentSegment.start);
    const hasDuration = Number.isFinite(duration) && duration > 0.01;
    const allTextLen = sentences.join('').length || 1;
    const baseStart = Number(currentSegment.start) || 0;

    let cursor = 0;
    for (const sentence of sentences) {
      const partLen = (sentence || '').length;
      const partStart = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : baseStart;
      cursor += partLen;
      const partEnd = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : (Number(currentSegment.end) || baseStart);
      merged.push({
        index: merged.length,
        text: sentence,
        start: partStart,
        end: partEnd,
        speaker: currentSegment.speaker,
      });
    }
    currentSegment = null;
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = (seg.text || '').trim();

    if (!text) continue;

    // Do not merge across speaker changes (prevents mixing dialogue lines)
    if (currentSegment !== null) {
      const currentSpeaker = (currentSegment.speaker || '').trim();
      const nextSpeaker = (seg.speaker || '').trim();
      const isGenericSpeaker = (name) => /^Speaker\\s+\\d+$/i.test(String(name || '').trim());
      if (
        currentSpeaker &&
        nextSpeaker &&
        currentSpeaker !== nextSpeaker &&
        !isGenericSpeaker(currentSpeaker) &&
        !isGenericSpeaker(nextSpeaker)
      ) {
        flushCurrentSegment();
      }
    }

    if (currentSegment === null) {
      // Start a new segment
      currentSegment = {
        text: text,
        start: seg.start,
        end: seg.end,
        speaker: seg.speaker || null,
      };
    } else {
      // Append to current segment
      // Add space between merged texts (avoid double spaces)
      currentSegment.text = (currentSegment.text + ' ' + text).replace(/\s+/g, ' ').trim();
      currentSegment.end = seg.end;
      // Keep the speaker from the first segment if not set
      if (!currentSegment.speaker && seg.speaker) {
        currentSegment.speaker = seg.speaker;
      }
    }

    // Split current text at sentence boundaries
    const sentences = splitAtSentences(currentSegment.text);

    if (sentences.length > 1) {
      const duration = Number(currentSegment.end) - Number(currentSegment.start);
      const hasDuration = Number.isFinite(duration) && duration > 0.01;
      const lastPart = sentences[sentences.length - 1];
      const lastIsComplete = sentenceEndAtEnd.test(lastPart);
      const completeParts = lastIsComplete ? sentences : sentences.slice(0, -1);
      const remainder = lastIsComplete ? '' : lastPart;
      const allTextLen = (completeParts.join('') + remainder).length || 1;
      const baseStart = Number(currentSegment.start) || 0;

      let cursor = 0;
      let lastEnd = baseStart;
      for (let j = 0; j < completeParts.length; j++) {
        const part = completeParts[j];
        const partLen = (part || '').length;
        const partStart = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : baseStart;
        cursor += partLen;
        const partEnd = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : (Number(currentSegment.end) || baseStart);
        lastEnd = partEnd;
        merged.push({
          index: merged.length,
          text: part,
          start: partStart,
          end: partEnd,
          speaker: currentSegment.speaker,
        });
      }

      if (lastIsComplete) {
        currentSegment = null;
      } else {
        currentSegment.text = remainder;
        currentSegment.start = lastEnd;
      }
    } else if (sentenceEndAtEnd.test(currentSegment.text)) {
      // Single complete sentence
      merged.push({
        index: merged.length,
        text: currentSegment.text,
        start: currentSegment.start,
        end: currentSegment.end,
        speaker: currentSegment.speaker,
      });
      currentSegment = null;
    }
    // If neither condition met, currentSegment continues accumulating
  }

  // Don't forget the last segment if it doesn't end with punctuation
  flushCurrentSegment();

  console.log(`[MergeSentences] Merged ${segments.length} segments into ${merged.length} sentences`);

  // Normalize timings to avoid repeated/overlapping starts (common in some subtitle sources),
  // which can make clients seek back to the same time when advancing sentences.
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    const prevStart = Number(prev?.start) || 0;
    const prevEnd = Number(prev?.end ?? prevStart) || prevStart;
    let curStart = Number(cur?.start);
    let curEnd = Number(cur?.end);
    if (!Number.isFinite(curStart)) curStart = prevEnd;
    if (!Number.isFinite(curEnd)) curEnd = curStart;

    const sameSpeaker = String(cur?.speaker || '') === String(prev?.speaker || '');
    if (curStart <= prevStart + 0.001 || (sameSpeaker && curStart < prevEnd - 0.05)) {
      curStart = prevEnd;
    }
    if (curEnd < curStart + 0.05) {
      curEnd = curStart + 0.05;
    }
    cur.start = curStart;
    cur.end = curEnd;
  }

  return merged;
}

function serializeVideoResource(resource) {
  if (!resource) return null;

  let segments = [];
  if (Array.isArray(resource.transcript_segments)) {
    segments = resource.transcript_segments;
  } else if (resource.transcript_segments) {
    if (typeof resource.transcript_segments === 'string') {
      // Handle "undefined", "null", or empty string
      if (resource.transcript_segments === 'undefined' ||
          resource.transcript_segments === 'null' ||
          resource.transcript_segments === '') {
        segments = [];
      } else {
        try {
          segments = JSON.parse(resource.transcript_segments);
        } catch (err) {
          console.warn('[Serialize] Failed to parse transcript_segments for video', resource.id, ':', err.message);
          segments = [];
        }
      }
    } else {
      segments = resource.transcript_segments;
    }
  }

  // Parse tags if stored as string
  let tags = [];
  if (Array.isArray(resource.tags)) {
    tags = resource.tags;
  } else if (resource.tags) {
    if (typeof resource.tags === 'string') {
      try {
        tags = JSON.parse(resource.tags);
      } catch (err) {
        tags = [];
      }
    }
  }

  // Parse characters if stored as string
  let characters = [];
  if (Array.isArray(resource.characters)) {
    characters = resource.characters;
  } else if (resource.characters) {
    if (typeof resource.characters === 'string') {
      try {
        characters = JSON.parse(resource.characters);
      } catch (err) {
        characters = [];
      }
    }
  }

  return {
    id: resource.id,
    uploader_id: resource.uploader_id,
    title: resource.title,
    description: resource.description,
    video_path: resource.video_path,
    youtube_video_id: resource.youtube_video_id,  // Add YouTube video ID for YouTube videos
    thumbnail_path: (typeof resource.thumbnail_path === 'string' && resource.thumbnail_path.includes('${')) ? null : resource.thumbnail_path,
    original_filename: resource.original_filename,
    transcript: resource.transcript,
    transcript_segments: segments,
    language: resource.language,
    duration_sec: resource.duration_sec,
    status: resource.status,
    failure_reason: resource.failure_reason,
    // File information
    file_size: resource.file_size,
    mime_type: resource.mime_type,
    file_hash: resource.file_hash,
    // Content classification and management
    tags: tags,
    category: resource.category,
    collection_name: resource.collection_name || null,
    difficulty_level: resource.difficulty_level,
    is_public: resource.is_public !== undefined ? resource.is_public : true,
    is_featured: resource.is_featured === true,
    is_vip_only: resource.is_vip_only === true,
    view_count: resource.view_count || 0,
    practice_count: resource.practice_count || 0,
    // Learning-related
    subtitle_language: resource.subtitle_language,
    has_subtitles: resource.has_subtitles || false,
    word_count: resource.word_count,
    unique_word_count: resource.unique_word_count,
    // Roleplay and character information
    characters: characters,
    is_roleplay_enabled: resource.is_roleplay_enabled || false,
    default_user_character: resource.default_user_character,
    total_segments: resource.total_segments || 0,
    // Local video support (for mainland China)
    local_video_path: resource.local_video_path || null,
    local_video_status: resource.local_video_status || 'not_downloaded',
    // Timestamps
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

function serializeVideoResourceLite(resource) {
  if (!resource) return null;
  let tags = [];
  if (Array.isArray(resource.tags)) {
    tags = resource.tags;
  } else if (resource.tags && typeof resource.tags === 'string') {
    try { tags = JSON.parse(resource.tags); } catch (_) { tags = []; }
  }

  return {
    id: resource.id,
    uploader_id: resource.uploader_id,
    title: resource.title,
    description: resource.description,
    video_path: resource.video_path,
    youtube_video_id: resource.youtube_video_id,
    thumbnail_path: (typeof resource.thumbnail_path === 'string' && resource.thumbnail_path.includes('${')) ? null : resource.thumbnail_path,
    original_filename: resource.original_filename,
    language: resource.language,
    duration_sec: resource.duration_sec,
    status: resource.status,
    failure_reason: resource.failure_reason,
    tags: tags,
    category: resource.category,
    collection_name: resource.collection_name || null,
    difficulty_level: resource.difficulty_level,
    is_public: resource.is_public !== undefined ? resource.is_public : true,
    is_featured: resource.is_featured === true,
    is_vip_only: resource.is_vip_only === true,
    view_count: resource.view_count || 0,
    practice_count: resource.practice_count || 0,
    has_subtitles: resource.has_subtitles || false,
    word_count: resource.word_count,
    unique_word_count: resource.unique_word_count,
    is_roleplay_enabled: resource.is_roleplay_enabled || false,
    local_video_path: resource.local_video_path || null,
    local_video_status: resource.local_video_status || 'not_downloaded',
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

function serializePracticeRecording(recording) {
  if (!recording) return null;
  return {
    id: recording.id,
    video_id: recording.video_resource_id,
    user_id: recording.user_id,
    speaker: recording.speaker,
    segment_index: recording.segment_index,
    audio_url: recording.audio_path,
    duration_sec: recording.duration_sec,
    created_at: recording.created_at,
    updated_at: recording.updated_at,
  };
}

function parseBase64DataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('INVALID_AUDIO_DATA');
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('INVALID_AUDIO_DATA');
  }
  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  if (!buffer.length) {
    throw new Error('INVALID_AUDIO_DATA');
  }
  return { mimeType, buffer };
}

function getExtensionFromMime(mimeType = '') {
  if (!mimeType) return 'webm';
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  const map = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
  };
  return map[normalized] || 'webm';
}

async function generateThumbnail(videoPath, targetName) {
  if (!ffmpegAvailable) return null;
  if (!videoPath) return null;
  try {
    await fsp.mkdir(THUMBS_DIR, { recursive: true });
    // 文件名必须可复现：两台服务器共用一个数据库，各自本地生成缩略图。
    // 名字里带 Date.now() 会让同一个视频在两台机器上产出不同文件名，
    // 而库里只存得下一个，另一台就永远 404。
    const baseName = targetName || path.basename(videoPath, path.extname(videoPath));
    const thumbName = `${baseName}.jpg`;
    const thumbAbs = path.join(THUMBS_DIR, thumbName);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on('error', (err) => {
          console.warn('[Thumb] Failed to generate thumbnail:', err?.message || err);
          reject(err);
        })
        .on('end', resolve)
        .screenshots({
          timestamps: ['10%'],
          filename: thumbName,
          folder: THUMBS_DIR,
          size: '640x?',
        });
    });

    const publicPath = `/static/thumbnails/${thumbName}`;
    console.log('[Thumb] Generated thumbnail for YouTube download:', publicPath);
    return publicPath;
  } catch (err) {
    console.warn('[Thumb] Thumbnail generation skipped/fallback:', err?.message || err);
    return null;
  }
}

async function removeFileSafe(absPath) {
  if (!absPath) return;
  try {
    await fsp.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[Videos] Failed to remove file:', absPath, err.message);
    }
  }
}

async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function shouldTranscodeToMp4Audio(extension) {
  const lower = (extension || '').toLowerCase();
  return ffmpegAvailable && ['webm', 'ogg', 'wav'].includes(lower);
}

function transcodeToMp4Audio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('aac')
      .format('mp4')
      .outputOptions(['-movflags', 'faststart'])
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });
}

function mapErrorToStatus(err, defaultStatus = 500) {
  if (!err || !err.message) return defaultStatus;
  if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
    return 401;
  }
  if (err.message === 'FORBIDDEN' || err.message === 'BANNED' || err.status === 403) {
    return 403;
  }
  if (err.message === 'DATASTORE_UNAVAILABLE') {
    return 503;
  }
  return defaultStatus;
}

function extractWordsFromText(text) {
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

// Speaker resolution helpers
const FALLBACK_SPEAKER_NAMES = ['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4'];
const CONTINUATION_PREFIXES = [
  'and', 'then', 'also', 'but', 'so', 'because', 'when', 'while',
  'after', 'before', 'if', 'well', 'umm', 'uh',
];
const REPLY_LEXICON = /^(sure|okay|alright|of course|no problem|thanks|thank you|you're welcome|yes|no|absolutely|definitely|certainly|please)\b/i;

function extractInlineSpeaker(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;

  const colonMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9 .,'"-]{0,30}):\s*(.+)$/);
  if (colonMatch) {
    return {
      speaker: colonMatch[1].trim(),
      text: colonMatch[2].trim(),
    };
  }

  const bracketMatch = trimmed.match(/^\[([^\]]{1,30})\]\s*[:\-]?\s*(.+)$/);
  if (bracketMatch) {
    return {
      speaker: bracketMatch[1].trim(),
      text: bracketMatch[2].trim(),
    };
  }

  return null;
}

function extractCharactersFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { characters: [], totalSegments: 0 };
  }

  const characterMap = new Map();
  let totalSegments = 0;

  segments.forEach((segment, idx) => {
    if (!segment || !segment.text) return;

    totalSegments++;
    let speaker = segment.speaker;

    // Try to extract inline speaker if not set
    if (!speaker) {
      const inline = extractInlineSpeaker(segment.text);
      if (inline) {
        speaker = inline.speaker;
      }
    }

    // Use a fallback if still no speaker
    if (!speaker || typeof speaker !== 'string') {
      speaker = 'Unknown';
    }

    speaker = speaker.trim();

    if (!characterMap.has(speaker)) {
      characterMap.set(speaker, {
        name: speaker,
        line_count: 0,
        segment_indices: []
      });
    }

    const char = characterMap.get(speaker);
    char.line_count++;
    char.segment_indices.push(segment.index != null ? segment.index : idx);
  });

  const characters = Array.from(characterMap.values());

  return {
    characters,
    totalSegments
  };
}

function deriveSpeakerLabel(rawSpeaker, fallbackIndex) {
  if (rawSpeaker && typeof rawSpeaker === 'string' && rawSpeaker.trim()) {
    return rawSpeaker.trim();
  }
  if (Number.isFinite(rawSpeaker)) {
    return `Speaker ${Number(rawSpeaker)}`;
  }
  return `Speaker ${fallbackIndex + 1}`;
}

function shouldSwitchSpeaker(prevSegment, currentSegment) {
  const prevText = (prevSegment?.text || '').trim();
  const currentText = (currentSegment?.text || '').trim();
  if (!currentText) {
    return false;
  }
  const currentLower = currentText.toLowerCase();
  const prevLower = prevText.toLowerCase();

  if (CONTINUATION_PREFIXES.some((prefix) => currentLower.startsWith(`${prefix} `))) {
    return false;
  }

  if (!prevText) {
    return false;
  }

  if (prevLower.endsWith(',') || prevLower.endsWith(';') || prevLower.endsWith(':') || prevLower.endsWith('...')) {
    return false;
  }

  if (REPLY_LEXICON.test(currentText)) {
    return true;
  }

  if (prevText.endsWith('?')) {
    return true;
  }

  if (/^((yes|yeah|no|sure|okay|alright|absolutely|definitely|of course|please)\b)/i.test(currentText)) {
    return true;
  }

  if (/^(you|your|let's|don't|do not|ask|tell|go|come|please)/i.test(currentText)) {
    return true;
  }

  if (prevText.endsWith('!') && !currentLower.startsWith('and ')) {
    return true;
  }

  return false;
}

function assignFallbackSpeakers(segments) {
  if (!segments.length) {
    return [];
  }

  const questionCount = segments.reduce((count, seg) => (/\?/.test(seg.text || '') ? count + 1 : count), 0);
  const dialogueMarkers = segments.reduce(
    (count, seg) =>
      (/(you|your|thank|please|sure|okay|of course|help|hello|hi|good morning|good afternoon|good evening)/i.test(
        seg.text || '',
      )
        ? count + 1
        : count),
    0,
  );
  const isLikelyDialogue = segments.length > 1 && (questionCount > 0 || dialogueMarkers > 1);
  if (!isLikelyDialogue) {
    return segments.map(() => FALLBACK_SPEAKER_NAMES[0]);
  }

  const assignments = [];
  let currentIndex = 0;
  assignments[0] = FALLBACK_SPEAKER_NAMES[currentIndex];

  for (let i = 1; i < segments.length; i += 1) {
    const shouldSwitch = shouldSwitchSpeaker(segments[i - 1], segments[i]);
    if (shouldSwitch) {
      currentIndex = currentIndex === 0 ? 1 : 0;
    }
    assignments[i] = FALLBACK_SPEAKER_NAMES[currentIndex];
  }

  return assignments;
}

async function resolveSpeakersForVideo(videoId) {
  const video = await dataStore.getVideoResourceById(videoId);
  if (!video) {
    const err = new Error('Video not found');
    err.statusCode = 404;
    throw err;
  }

  let segmentsRaw = video.transcript_segments;
  if (typeof segmentsRaw === 'string') {
    try {
      segmentsRaw = JSON.parse(segmentsRaw);
    } catch (parseErr) {
      segmentsRaw = [];
    }
  }
  if (!Array.isArray(segmentsRaw)) {
    segmentsRaw = [];
  }

  const cleanedSegments = segmentsRaw
    .map((segment, idx) => {
      if (!segment) return null;
      let speaker = segment.speaker;
      let text = typeof segment.text === 'string' ? segment.text.trim() : '';

      if (!speaker) {
        const inline = extractInlineSpeaker(text);
        if (inline) {
          speaker = inline.speaker;
          text = inline.text;
        }
      }

      return {
        rawSpeaker: speaker,
        index: segment.index != null ? segment.index : idx,
        start: Number(segment.start) || 0,
        end: Number(segment.end != null ? segment.end : segment.start) || 0,
        text,
      };
    })
    .filter((segment) => segment && segment.text);

  const explicitSpeakers = new Set(
    cleanedSegments
      .map((segment) =>
        segment.rawSpeaker && typeof segment.rawSpeaker === 'string'
          ? segment.rawSpeaker.trim()
          : null,
      )
      .filter(Boolean),
  );

  let assignedSpeakers = [];
  if (explicitSpeakers.size > 0) {
    assignedSpeakers = cleanedSegments.map((segment, idx) =>
      deriveSpeakerLabel(segment.rawSpeaker, idx % FALLBACK_SPEAKER_NAMES.length),
    );
  } else {
    assignedSpeakers = assignFallbackSpeakers(cleanedSegments);
  }

  const speakerMap = new Map();
  cleanedSegments.forEach((segment, idx) => {
    const label = assignedSpeakers[idx] || FALLBACK_SPEAKER_NAMES[0];
    if (!speakerMap.has(label)) {
      speakerMap.set(label, []);
    }
    speakerMap.get(label).push({
      index: segment.index,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    });
  });

  const speakers = Array.from(speakerMap.entries()).map(([name, lines]) => ({
    speaker: name,
    lines,
  }));

  return { speakers };
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Registers all video resource routes
 * @param {string} pathname - The URL pathname
 * @param {Object} req - HTTP request object
 * @param {Object} res - HTTP response object
 * @returns {Promise<boolean>} true if route was handled, false otherwise
 */
async function registerVideoRoutes(pathname, req, res) {
  // POST /api/video-share-requests - User asks admins to publish or feature a video
  if (pathname === '/api/video-share-requests' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const videoId = Number(body?.video_id || body?.videoId);
      const requestType = normalizeShareRequestType(body?.request_type || body?.requestType || body?.type);
      const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : null;

      if (!Number.isFinite(videoId) || videoId <= 0) {
        return sendError(res, 400, 'Invalid video_id');
      }
      if (!requestType) {
        return sendError(res, 400, 'request_type must be public or featured');
      }

      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }
      if (!isSameUserId(video.uploader_id, user.id) && !user.is_admin) {
        return sendError(res, 403, 'Only the owner can submit this video for review');
      }

      if (requestType === 'public' && video.is_public !== false) {
        return sendJson(res, 200, {
          success: true,
          already_public: true,
          video: serializeVideoResource(video),
        });
      }
      if (requestType === 'featured' && video.is_featured === true) {
        return sendJson(res, 200, {
          success: true,
          already_featured: true,
          video: serializeVideoResource(video),
        });
      }

      const request = await dataStore.createVideoShareRequest({
        requesterId: user.id,
        videoResourceId: videoId,
        requestType,
        note,
      });

      return sendJson(res, request?.already_pending ? 200 : 201, {
        success: true,
        request: serializeVideoShareRequest(request),
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('[VideoShareRequest] Create failed:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /api/video-share-requests - User can inspect their own review requests
  if (pathname === '/api/video-share-requests' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const status = normalizeShareRequestStatus(url.searchParams.get('status'), 'all');
      const requestType = url.searchParams.get('request_type')
        ? normalizeShareRequestType(url.searchParams.get('request_type'))
        : null;
      const videoResourceId = url.searchParams.get('video_id') ? Number(url.searchParams.get('video_id')) : null;
      if (!status || (url.searchParams.get('request_type') && !requestType)) {
        return sendError(res, 400, 'Invalid request filters');
      }
      const items = await dataStore.listVideoShareRequests({
        status,
        requestType,
        requesterId: user.id,
        videoResourceId,
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
        offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0,
      });
      return sendJson(res, 200, { items: items.map(serializeVideoShareRequest) });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/video-share-requests/summary - Admin moderation badge counts
  if (pathname === '/admin/video-share-requests/summary' && req.method === 'GET') {
    try {
      const admin = await authenticate(req);
      if (!admin.is_admin) {
        return sendError(res, 403, 'FORBIDDEN');
      }
      const summary = await dataStore.getVideoShareRequestSummary();
      return sendJson(res, 200, { summary });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/video-share-requests - Admin moderation queue
  if (pathname === '/admin/video-share-requests' && req.method === 'GET') {
    try {
      const admin = await authenticate(req);
      if (!admin.is_admin) {
        return sendError(res, 403, 'FORBIDDEN');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const status = normalizeShareRequestStatus(url.searchParams.get('status'), 'pending');
      const requestType = url.searchParams.get('request_type')
        ? normalizeShareRequestType(url.searchParams.get('request_type'))
        : null;
      if (!status || (url.searchParams.get('request_type') && !requestType)) {
        return sendError(res, 400, 'Invalid request filters');
      }
      const items = await dataStore.listVideoShareRequests({
        status,
        requestType,
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
        offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0,
      });
      return sendJson(res, 200, { items: items.map(serializeVideoShareRequest) });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/video-share-requests/:id/review - Approve/reject moderation request
  const reviewMatch = pathname.match(/^\/admin\/video-share-requests\/(\d+)\/review$/);
  if (reviewMatch && req.method === 'POST') {
    try {
      const admin = await authenticate(req);
      if (!admin.is_admin) {
        return sendError(res, 403, 'FORBIDDEN');
      }
      const requestId = Number(reviewMatch[1]);
      const body = await parseBody(req);
      const status = normalizeShareRequestStatus(body?.status, null);
      const reviewNote = typeof body?.review_note === 'string'
        ? body.review_note.trim().slice(0, 500)
        : typeof body?.reviewNote === 'string'
          ? body.reviewNote.trim().slice(0, 500)
          : null;
      if (status !== 'approved' && status !== 'rejected') {
        return sendError(res, 400, 'status must be approved or rejected');
      }

      const request = await dataStore.getVideoShareRequestById(requestId);
      if (!request) {
        return sendError(res, 404, 'Review request not found');
      }
      if (request.status !== 'pending') {
        return sendError(res, 409, 'Review request is no longer pending');
      }

      let updatedVideo = null;
      if (status === 'approved') {
        const updates = request.request_type === 'featured'
          ? { is_public: true, is_featured: true }
          : { is_public: true };
        updatedVideo = await dataStore.updateVideoResource(request.video_resource_id, updates);
        await clearVideoResourceCaches(request.video_resource_id);
      }

      await dataStore.updateVideoShareRequestReview(requestId, {
        status,
        reviewerId: admin.id,
        reviewNote,
      });
      const reviewed = await dataStore.getVideoShareRequestById(requestId);
      try {
        await dataStore.logAdminAction(admin.id, request.requester_id, 'review_video_share_request', {
          request_id: requestId,
          video_resource_id: request.video_resource_id,
          request_type: request.request_type,
          status,
          review_note: reviewNote,
        });
      } catch (_) {}

      return sendJson(res, 200, {
        success: true,
        request: serializeVideoShareRequest(reviewed),
        video: updatedVideo ? serializeVideoResource(updatedVideo) : null,
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('[VideoShareRequest] Review failed:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources - List all or user's videos
  // 支持参数:
  //   mine=1 - 只显示用户自己的视频
  //   difficulty=beginner|intermediate|advanced - 按难度筛选
  //   recommended=true - 根据用户学习级别推荐视频
  if (pathname === '/video-resources' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mine = (url.searchParams.get('mine') || '').trim();
      const difficulty = url.searchParams.get('difficulty'); // beginner/intermediate/advanced
      const recommended = url.searchParams.get('recommended') === 'true';
      const lite = url.searchParams.get('lite') === '1' || url.searchParams.get('lite') === 'true';

      const userCtx = await getUserContext(req);
      // Check if user is from mainland China
      const geoInfo = await geoIPService.isRequestFromChina(req, userCtx.label);
      const isMainlandUser = FORCE_LOCAL_VIDEO || geoInfo.isChina;

      // Helper function to get user's current learning level
      async function getUserLearningLevel(userId) {
        if (!userId || !dataStore.isDatabaseAvailable()) return 'beginner';
        try {
          const { pool } = require('../data-store/core');
          const result = await pool.query(
            'SELECT current_vocabulary_level FROM user_profiles WHERE user_id = $1',
            [userId]
          );
          return result.rows[0]?.current_vocabulary_level || 'beginner';
        } catch (e) {
          console.warn('[Video List] Failed to get user level:', e.message);
          return 'beginner';
        }
      }

      // Helper function to filter videos by difficulty
      function filterByDifficulty(videos, targetDifficulty) {
        const target = canonicalLevel(targetDifficulty);
        if (!target) return videos;
        return videos.filter(video => canonicalLevel(video.difficulty_level) === target);
      }

      if (mine === '1' || mine.toLowerCase() === 'true') {
        const user = await authenticate(req);
        const userCtx = { id: user?.id || null, username: user?.username || user?.email || null, label: user?.username || user?.email || `user-${user?.id || 'unknown'}` };
        let videos = lite
          ? await dataStore.listVideoResourcesByUploaderLite(user.id)
          : await dataStore.listVideoResourcesByUploader(user.id);

        // Filter YouTube videos for mainland users
        if (isMainlandUser) {
          videos = videos.filter(video => {
            // Keep non-YouTube videos
            if (!video.youtube_video_id) return true;
            // For YouTube videos, only show completed downloads
            if (video.local_video_status !== 'completed') return false;
            if (!FORCE_LOCAL_VIDEO_REQUIRE_FILE) return true;
            return hasLocalVideoFile(video);
          });
          logWithUser('Video List', userCtx, 'Mainland user - filtered YouTube videos to completed only');
        }

        // Filter by difficulty if specified
        if (difficulty) {
          videos = filterByDifficulty(videos, difficulty);
          logWithUser('Video List', userCtx, `Filtered by difficulty: ${difficulty}`);
        }

        return sendJson(res, 200, {
          items: videos.map(lite ? serializeVideoResourceLite : serializeVideoResource),
          isMainlandUser: isMainlandUser // Add region info for client
        });
      } else {
        // Public listing (allow guests): try auth but don't require it
        let user = null;
        try {
          if (dataStore.isDatabaseAvailable()) {
            user = await authenticate(req);
          }
        } catch(_) { /* allow unauthenticated */ }
        const userCtx = await getUserContext(req);

        // Try cache for public video list (only for non-filtered requests)
        const cacheKey = lite ? 'videos:public:lite' : 'videos:public:full';
        let videos = null;

        if (!difficulty && !recommended) {
          const cached = await cacheService.get(cacheKey);
          if (cached) {
            videos = cached;
            logWithUser('Video List', userCtx, `Cache HIT for ${cacheKey}`);
          }
        }

        if (!videos) {
          videos = lite
            ? await dataStore.listVideoResourcesLite()
            : await dataStore.listVideoResources();

          // Cache the result for future requests (only non-filtered)
          if (!difficulty && !recommended) {
            await cacheService.set(cacheKey, videos, 120); // 2 minute TTL
          }
        }

        videos = videos.filter(video => canAccessVideoResource(video, user));

        // Filter YouTube videos for mainland users
        if (isMainlandUser) {
          videos = videos.filter(video => {
            // Keep non-YouTube videos
            if (!video.youtube_video_id) return true;
            // For YouTube videos, only show completed downloads
            if (video.local_video_status !== 'completed') return false;
            if (!FORCE_LOCAL_VIDEO_REQUIRE_FILE) return true;
            return hasLocalVideoFile(video);
          });
          logWithUser('Video List', userCtx, 'Mainland user - filtered YouTube videos to completed only');
        }

        // Filter by difficulty if specified, or use recommended level
        let targetDifficulty = difficulty;
        if (recommended && user) {
          targetDifficulty = await getUserLearningLevel(user.id);
          logWithUser('Video List', userCtx, `Recommending videos for level: ${targetDifficulty}`);
        }
        if (targetDifficulty) {
          videos = filterByDifficulty(videos, targetDifficulty);
        }

        // Get difficulty stats for the response
        const difficultyStats = await dataStore.getDifficultyStats();

        return sendJson(res, 200, {
          items: videos.map(lite ? serializeVideoResourceLite : serializeVideoResource),
          isMainlandUser: isMainlandUser, // Add region info for client
          difficultyStats, // Add difficulty statistics
          recommendedLevel: recommended && user ? targetDifficulty : null
        });
      }
    } catch (err) {
      const status = (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED')
        ? 401
        : err.message === 'DATASTORE_UNAVAILABLE'
          ? 503
          : 500;
      if (status >= 500) {
        console.error('[Route /video-resources] Failed:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/upload - Upload video
  if (pathname === '/video-resources/upload' && req.method === 'POST') {
    try {
      const user = await authenticate(req);

      // 检查是否为游客 - 游客不允许上传视频
      if (isGuestAccount(user)) {
        return sendError(res, 403, 'GUEST_UPLOAD_FORBIDDEN');
      }

      // Determine per-tier server-side size limit (MB)
      const uploadLimits = getUploadLimits(user);
      let tierMaxMb = uploadLimits.maxVideoSizeMb;

      // Optional proxy-safe cap to avoid upstream 50MB limits
      const proxyCapMbEnv = process.env.PROXY_UPLOAD_MAX_MB ? Number(process.env.PROXY_UPLOAD_MAX_MB) : null;
      if (proxyCapMbEnv && Number.isFinite(proxyCapMbEnv)) {
        tierMaxMb = Math.min(tierMaxMb, proxyCapMbEnv);
      }

      // If Content-Length known and exceeds cap, fail fast
      const contentLength = Number(req.headers['content-length'] || 0);
      if (contentLength && Number.isFinite(contentLength)) {
        const maxBytes = Number.isFinite(tierMaxMb) ? tierMaxMb * 1024 * 1024 : Infinity;
        if (Number.isFinite(maxBytes) && contentLength > maxBytes) {
          return sendError(res, 413, 'FILE_TOO_LARGE');
        }
      }

      const { files, fields } = await handleFileUpload(req, {
        maxTotalBytes: Number.isFinite(tierMaxMb) ? tierMaxMb * 1024 * 1024 : null,
      });

      // Per-user upload quota enforcement (free: 3; VIP/Family: 50; admin: unlimited)
      try {
        const limit = uploadLimits.maxVideos;
        if (Number.isFinite(limit)) {
          const used = await dataStore.countVideoResourcesByUploader(user.id);
          if (used >= limit) {
            // Clean up uploaded temp file if present
            try { if (files?.video?.path) await cleanupFile(files.video.path); } catch (_) {}
            return sendError(res, 403, 'UPLOAD_LIMIT_REACHED');
          }
        }
      } catch (e) {
        console.warn('[Upload] quota check warning:', e?.message || e);
      }

      if (!files.video) {
        return sendError(res, 400, 'Video file is required');
      }

      const videoFile = files.video;
      if (!videoFile.mimetype || !videoFile.mimetype.startsWith('video/')) {
        await cleanupFile(videoFile.path);
        return sendError(res, 400, 'Invalid video file type');
      }

      // Calculate hash on temp file to detect duplicates before saving
      let precomputedHash = null;
      try {
        precomputedHash = await calculateFileHash(videoFile.path);
        const dup = await dataStore.getVideoResourceByFileHash(precomputedHash);
        if (dup) {
          await cleanupFile(videoFile.path);
          return sendJson(res, 409, {
            code: 'DUPLICATE_UPLOAD',
            message: '该视频已被上传，请直接观看',
            existing_video_id: dup.id,
            existing_title: dup.title || dup.original_filename || '已存在视频',
          });
        }
      } catch (e) {
        console.warn('[Upload] Hash pre-check failed:', e?.message || e);
      }

      const safeBasename = `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(videoFile.originalname || '.mp4')}`;
      const destinationPath = path.join(VIDEO_DIR, safeBasename);
      let tempPath = videoFile.path;
      try {
        await fsp.rename(videoFile.path, destinationPath);
        tempPath = null;
      } catch (err) {
        if (tempPath) {
          await cleanupFile(tempPath);
        }
        throw err;
      }

      const publicPath = `/videos/${safeBasename}`;
      const title = fields.title || videoFile.originalname || 'Uploaded Video';
      const description = fields.description || null;
      const language = fields.language || 'en';

      // Get file stats for metadata
      const fileStats = await fsp.stat(destinationPath);
      const fileSize = fileStats.size;
      const mimeType = videoFile.mimetype;

      // Optional secondary tag: collection/series name (合集)
      const collectionName = (() => {
        const raw = (fields.collection_name ?? fields.collection ?? fields.series ?? '').toString().trim();
        if (!raw) return null;
        return raw.slice(0, 120);
      })();

      // Parse tags from fields (expect JSON array or comma-separated string)
      let tags = [];
      if (fields.tags) {
        try {
          tags = typeof fields.tags === 'string' ? JSON.parse(fields.tags) : fields.tags;
          if (!Array.isArray(tags)) tags = [];
        } catch (err) {
          // If not JSON, try comma-separated
          tags = fields.tags.split(',').map(t => t.trim()).filter(Boolean);
        }
      }

      // Create video resource immediately without waiting for thumbnail/duration
      const resource = await dataStore.createVideoResource({
        uploader_id: user.id,
        title,
        description,
        video_path: publicPath,
        thumbnail_path: null, // Will be set by background job
        original_filename: videoFile.originalname || null,
        duration_sec: null, // Will be set by background job
        status: 'processing',
        // File information
        file_size: fileSize,
        mime_type: mimeType,
        file_hash: precomputedHash || null, // Will be calculated in background if null
        // Content classification
        tags: tags,
        category: fields.category || null,
        collection_name: collectionName,
        difficulty_level: null,
        is_public: user.is_admin && fields.is_public !== undefined
          ? (fields.is_public === 'true' || fields.is_public === true)
          : false,
        // Learning-related
        subtitle_language: language,
      });

      // Process thumbnail and duration in background (non-blocking)
      setImmediate(async () => {
        const updates = {};

        // Calculate file hash for deduplication if not already set
        if (!resource.file_hash) {
          try {
            console.log('[Hash] Calculating file hash for:', destinationPath);
            const fileHash = await calculateFileHash(destinationPath);
            updates.file_hash = fileHash;
            console.log('[Hash] File hash calculated:', fileHash);
          } catch (e) {
            console.warn('[Hash] Failed to calculate file hash:', e?.message || e);
          }
        }

        // Generate thumbnail if ffmpeg is available
        if (ffmpegAvailable) {
          try {
            const thumbName = `${path.basename(safeBasename, path.extname(safeBasename))}.jpg`;
            const thumbAbs = path.join(THUMBS_DIR, thumbName);
            console.log('[Thumb] Generating thumbnail:', { requested: true });
            await new Promise((resolve, reject) => {
              ffmpeg(destinationPath)
                .on('start', (cmd) => {
                  console.log('[Thumb] ffmpeg start:', cmd);
                })
                .on('filenames', (files) => {
                  try { console.log('[Thumb] target filenames:', files); } catch (_) {}
                })
                .on('end', resolve)
                .on('error', (err) => {
                  console.error('[Thumb] ffmpeg error:', err?.message || err);
                  reject(err);
                })
                .screenshots({
                  timestamps: ['10%'],
                  filename: thumbName,
                  folder: THUMBS_DIR,
                  size: '640x?'
                });
            });
            console.log('[Thumb] Generated successfully:', true);
            updates.thumbnail_path = `/static/thumbnails/${thumbName}`;
          } catch (e) {
            console.warn('[Thumb] Thumbnail generation failed:', e?.message || e);
          }

          // Extract video duration using ffprobe
          try {
            console.log('[Duration] Extracting video duration from:', destinationPath);
            const durationSec = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(destinationPath, (err, metadata) => {
                if (err) {
                  console.error('[Duration] ffprobe error:', err?.message || err);
                  reject(err);
                  return;
                }
                try {
                  const duration = metadata?.format?.duration;
                  if (duration && Number.isFinite(Number(duration))) {
                    const durationSeconds = Math.round(Number(duration));
                    console.log('[Duration] Extracted:', durationSeconds, 'seconds');
                    resolve(durationSeconds);
                  } else {
                    console.warn('[Duration] No valid duration found in metadata');
                    resolve(null);
                  }
                } catch (parseErr) {
                  console.error('[Duration] Failed to parse duration:', parseErr);
                  resolve(null);
                }
              });
            });
            if (durationSec !== null) {
              updates.duration_sec = durationSec;
            }
          } catch (e) {
            console.warn('[Duration] Failed to extract duration:', e?.message || e);
          }
        }

        // Update resource with thumbnail and duration if available
        if (Object.keys(updates).length > 0) {
          try {
            await dataStore.updateVideoResource(resource.id, updates);
            console.log('[Video] Updated resource with metadata:', updates);
          } catch (e) {
            console.error('[Video] Failed to update resource metadata:', e);
          }
        }
      });

      // Start transcription in background (non-blocking)
      if (VIDEO_TRANSCRIPTION_ENABLED) {
        setImmediate(async () => {
          const startTime = Date.now();
          try {
            console.log('[Transcription] Starting background transcription for video:', resource.id);
            console.log('[Transcription] Video source present:', Boolean(resource.video_path));
            console.log('[Transcription] Language:', language);

            const result = await videoTranscriptionService.transcribeAndStore(resource, {
              language,
            });

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log('[Transcription] Completed successfully for video:', resource.id);
            console.log('[Transcription] Duration:', duration, 'seconds');
            console.log('[Transcription] Text length:', result?.text?.length || 0);
            console.log('[Transcription] Segments:', result?.segments?.length || 0);

            // Calculate word count, unique word count, and extract character information from transcript
            try {
              const updatedVideo = await dataStore.getVideoResourceById(resource.id);
              if (updatedVideo && updatedVideo.transcript) {
                const allWords = extractWordsFromText(updatedVideo.transcript);
                const uniqueWords = [...new Set(allWords)];

                // Extract character information from segments
                let segments = updatedVideo.transcript_segments;
                if (typeof segments === 'string') {
                  try {
                    segments = JSON.parse(segments);
                  } catch (e) {
                    segments = [];
                  }
                }

                const { characters, totalSegments } = extractCharactersFromSegments(segments);

                // Determine if roleplay should be enabled (at least 2 characters with at least 3 lines each)
                const isRoleplayEnabled = characters.length >= 2 &&
                  characters.filter(c => c.line_count >= 3).length >= 2;

                // Find the character with the second-most lines as the default user character
                // (assuming the character with the most lines is the main speaker/narrator)
                let defaultUserCharacter = null;
                if (characters.length >= 2) {
                  const sorted = [...characters].sort((a, b) => b.line_count - a.line_count);
                  defaultUserCharacter = sorted[1].name;
                }

                await dataStore.updateVideoResource(resource.id, {
                  word_count: allWords.length,
                  unique_word_count: uniqueWords.length,
                  has_subtitles: true,
                  characters: characters,
                  is_roleplay_enabled: isRoleplayEnabled,
                  default_user_character: defaultUserCharacter,
                  total_segments: totalSegments,
                });

                console.log('[Transcription] Updated word counts - total:', allWords.length, 'unique:', uniqueWords.length);
                console.log('[Transcription] Extracted characters:', characters.length, 'roleplay enabled:', isRoleplayEnabled);
                if (defaultUserCharacter) {
                  console.log('[Transcription] Default user character:', defaultUserCharacter);
                }

                await updateVideoDifficultyFromTranscript(
                  resource.id,
                  segments && segments.length ? segments : updatedVideo.transcript
                );
              }
            } catch (err) {
              console.warn('[Transcription] Failed to update metadata:', err.message);
            }
          } catch (err) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.error('[Transcription] Failed for video:', resource.id);
            console.error('[Transcription] Duration:', duration, 'seconds');
            console.error('[Transcription] Error:', err.message);
            console.error('[Transcription] Stack:', err.stack);

            // Try to update status to failed if not already done
            try {
              const current = await dataStore.getVideoResourceById(resource.id);
              if (current && current.status === 'processing') {
                await dataStore.updateVideoResource(resource.id, {
                  status: 'failed',
                  failure_reason: err.userMessage || err.message || 'Transcription failed',
                });
                console.log('[Transcription] Updated video status to failed');
              }
            } catch (updateErr) {
              console.error('[Transcription] Failed to update video status:', updateErr);
            }
          }
        });
      } else {
        // If transcription is disabled, mark as skipped
        setImmediate(async () => {
          try {
            await dataStore.updateVideoResource(resource.id, {
              status: 'skipped',
              failure_reason: 'Video transcription disabled by configuration.',
            });
          } catch (e) {
            console.error('[Video] Failed to update status to skipped:', e);
          }
        });
      }

      // Return immediately with 202 Accepted status
      return sendJson(res, 202, {
        video: serializeVideoResource(resource),
        message: 'Video uploaded successfully. Processing in background.',
        transcript: null,
        error: null,
      });
    } catch (err) {
      // Map common upload errors to clearer HTTP statuses
      if (err && (err.message === 'CLIENT_ABORTED' || err.message === 'aborted' || err.code === 'ECONNRESET' || err.code === 'CLIENT_ABORTED')) {
        // Heuristic: if large bytes received, likely upstream proxy body limit
        const bytes = Number(err.bytesReceived || 0);
        if (bytes > 45 * 1024 * 1024) {
          return sendError(res, 413, 'PROXY_UPLOAD_LIMIT');
        }
        return sendError(res, 408, 'UPLOAD_ABORTED');
      }
      if (err && err.message === 'FILE_TOO_LARGE') {
        return sendError(res, 413, 'FILE_TOO_LARGE');
      }
      if (err && err.message === 'PAYLOAD_TOO_LARGE') {
        return sendError(res, 413, 'FILE_TOO_LARGE');
      }
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Video upload error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/youtube - Save YouTube video to library
  if (pathname === '/video-resources/youtube' && req.method === 'POST') {
    try {
      const user = await authenticate(req);

      // Check if guest user - guests cannot save videos
      if (isGuestAccount(user)) {
        return sendError(res, 403, 'GUEST_SAVE_FORBIDDEN');
      }

      // Per-user upload quota enforcement (same as local videos)
      const uploadLimits = getUploadLimits(user);
      try {
        const limit = uploadLimits.maxVideos;
        if (Number.isFinite(limit)) {
          const used = await dataStore.countVideoResourcesByUploader(user.id);
          if (used >= limit) {
            return sendError(res, 403, 'UPLOAD_LIMIT_REACHED');
          }
        }
      } catch (e) {
        console.warn('[YouTube Save] quota check warning:', e?.message || e);
      }

      const body = await parseBody(req);
      const timestamp = new Date().toISOString();

      console.log('');
      console.log('═'.repeat(80));
      console.log(`[YouTube Save] ▶ NEW YOUTUBE VIDEO SAVE REQUEST - ${timestamp}`);
      console.log('═'.repeat(80));
      console.log('[YouTube Save] User ID:', user.id);
      console.log('[YouTube Save] User tier:', uploadLimits.tier);
      console.log('[YouTube Save] Request body keys:', Object.keys(body).join(', '));
      console.log('─'.repeat(80));

      // Video metadata
      console.log('[YouTube Save] Video Metadata:');
      console.log('[YouTube Save]   - youtube_video_id:', body.youtube_video_id || '❌ MISSING');
      console.log('[YouTube Save]   - title:', body.title || '(empty)');
      console.log('[YouTube Save]   - description length:', body.description?.length || 0, 'chars');
      console.log('[YouTube Save]   - language:', body.language || 'en');
      console.log('[YouTube Save]   - duration_sec:', body.duration_sec || 'N/A');
      console.log('[YouTube Save]   - tags:', Array.isArray(body.tags) ? body.tags.join(', ') : 'none');
      console.log('─'.repeat(80));

      // Segments analysis
      console.log('[YouTube Save] Segments Analysis:');
      if (body.segments === undefined) {
        console.error('[YouTube Save]   ❌ CRITICAL: segments field is UNDEFINED');
      } else if (body.segments === null) {
        console.error('[YouTube Save]   ❌ CRITICAL: segments field is NULL');
      } else if (!Array.isArray(body.segments)) {
        console.error('[YouTube Save]   ❌ CRITICAL: segments is NOT an array');
        console.error('[YouTube Save]   - Type:', typeof body.segments);
        console.error('[YouTube Save]   - Value:', String(body.segments).substring(0, 200));
      } else if (body.segments.length === 0) {
        console.error('[YouTube Save]   ⚠️  WARNING: Segments array is EMPTY (length = 0)');
      } else {
        console.log('[YouTube Save]   ✓ Segments is valid array');
        console.log('[YouTube Save]   - Count:', body.segments.length);

        // Analyze segment structure
        const firstSeg = body.segments[0];
        const lastSeg = body.segments[body.segments.length - 1];
        const midSeg = body.segments[Math.floor(body.segments.length / 2)];

        console.log('[YouTube Save]   - First segment (#0):');
        console.log('[YouTube Save]     * Keys:', Object.keys(firstSeg || {}).join(', '));
        console.log('[YouTube Save]     * Text length:', firstSeg?.text?.length || 0);
        console.log('[YouTube Save]     * Start:', firstSeg?.start ?? firstSeg?.start_sec ?? 'missing');
        console.log('[YouTube Save]     * End:', firstSeg?.end ?? firstSeg?.end_sec ?? 'missing');
        console.log('[YouTube Save]     * Speaker:', firstSeg?.speaker || 'none');
        console.log('[YouTube Save]     * Full object:', JSON.stringify(firstSeg).substring(0, 200));

        console.log('[YouTube Save]   - Middle segment (#' + Math.floor(body.segments.length / 2) + '):');
        console.log('[YouTube Save]     * Text length:', midSeg?.text?.length || 0);
        console.log('[YouTube Save]     * Start:', midSeg?.start ?? midSeg?.start_sec ?? 'missing');
        console.log('[YouTube Save]     * Full object:', JSON.stringify(midSeg).substring(0, 200));

        console.log('[YouTube Save]   - Last segment (#' + (body.segments.length - 1) + '):');
        console.log('[YouTube Save]     * Text length:', lastSeg?.text?.length || 0);
        console.log('[YouTube Save]     * Start:', lastSeg?.start ?? lastSeg?.start_sec ?? 'missing');
        console.log('[YouTube Save]     * End:', lastSeg?.end ?? lastSeg?.end_sec ?? 'missing');
        console.log('[YouTube Save]     * Full object:', JSON.stringify(lastSeg).substring(0, 200));

        // Count empty text segments
        const emptyCount = body.segments.filter(s => !s?.text || s.text.trim() === '').length;
        if (emptyCount > 0) {
          console.warn('[YouTube Save]   ⚠️  WARNING:', emptyCount, 'segments have empty text');
        }
      }
      console.log('═'.repeat(80));
      console.log('');

      if (!body.youtube_video_id) {
        return sendError(res, 400, 'YouTube video ID is required');
      }

      const youtubeVideoId = body.youtube_video_id;
      const title = body.title || 'YouTube Video';
      const description = body.description || null;
      const language = body.language || 'en';
      const durationSec = body.duration_sec || null;

      // Parse tags
      let tags = [];
      if (body.tags) {
        tags = Array.isArray(body.tags) ? body.tags : [];
      }

      // Optional secondary tag: collection/series name (合集)
      const collectionName = (() => {
        const raw = (body.collection_name ?? body.collection ?? body.series ?? '').toString().trim();
        if (!raw) return null;
        return raw.slice(0, 120);
      })();

      // YouTube watch URL
      const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

      // Check if video already exists (by video_path to handle duplicates)
      const existingVideo = await dataStore.getVideoResourceByPath(youtubeUrl);
      if (existingVideo) {
        // If video exists but has no segments, update it with new segments
        const hasSegments = existingVideo.transcript_segments &&
                           (Array.isArray(existingVideo.transcript_segments) ?
                            existingVideo.transcript_segments.length > 0 :
                            false);

        console.log('[YouTube] Video exists:', existingVideo.id, 'has segments:', hasSegments);

        // If video has no segments but we have segments to add, update it
        if (!hasSegments && body.segments && Array.isArray(body.segments) && body.segments.length > 0) {
          console.log('[YouTube] Updating existing video with', body.segments.length, 'segments');

          // Continue with saving segments (fall through to segment saving code below)
          // But use the existing video resource instead of creating a new one
          const resource = existingVideo;

          // Save transcript segments
          try {
            console.log('');
            console.log('─'.repeat(80));
            console.log('[YouTube Update] Starting segment save for existing video ID:', resource.id);
            console.log('[YouTube Update] Original segments count:', body.segments.length);

            // Merge segments into complete sentences (YouTube subtitles are often split mid-sentence)
            const mergedSegments = mergeSentenceSegments(body.segments);
            console.log('[YouTube Update] After merging, segments count:', mergedSegments.length);
            console.log('─'.repeat(80));

            // Build transcript_segments array and transcript text
            const transcriptSegments = [];
            const transcriptParts = [];
            let saveErrors = 0;

            for (let i = 0; i < mergedSegments.length; i++) {
              const seg = mergedSegments[i];
              const text = seg.text || '';

              // Log progress every 50 segments
              if (i % 50 === 0 || i === mergedSegments.length - 1) {
                console.log(`[YouTube Update] Processing segment ${i + 1}/${mergedSegments.length}...`);
              }

              // Save to video_sentences table
              try {
                await dataStore.createVideoSentence({
                  video_id: resource.id,
                  sentence_index: i,
                  text: text,
                  start_time_sec: seg.start || seg.start_sec || 0,
                  end_time_sec: seg.end || seg.end_sec || 0,
                  speaker: seg.speaker || null,
                });
              } catch (err) {
                console.error(`[YouTube Update] Failed to save segment ${i} to video_sentences:`, err.message);
                saveErrors++;
              }

              // Build segment for transcript_segments field
              transcriptSegments.push({
                index: i,
                text: text,
                start: seg.start || seg.start_sec || 0,
                end: seg.end || seg.end_sec || 0,
                speaker: seg.speaker || null,
                source: 'youtube',  // YouTube 自动字幕标记
              });

              // Build transcript text
              if (text) {
                transcriptParts.push(text);
              }
            }

            console.log('[YouTube Update] ✓ Finished processing segments');
            if (saveErrors > 0) {
              console.warn(`[YouTube Update] ⚠️  ${saveErrors} errors occurred during segment save`);
            }

            const fullTranscript = transcriptParts.join(' ').trim();
            console.log('[YouTube Update] Full transcript length:', fullTranscript.length, 'chars');

            // Extract word counts and character information
            console.log('[YouTube Update] Extracting word and character information...');
            const allWords = extractWordsFromText(fullTranscript);
            const uniqueWords = [...new Set(allWords)];
            const { characters, totalSegments } = extractCharactersFromSegments(transcriptSegments);

            // Determine if roleplay should be enabled
            const isRoleplayEnabled = characters.length >= 2 &&
              characters.filter(c => c.line_count >= 3).length >= 2;

            // Find default user character (second-most lines)
            let defaultUserCharacter = null;
            if (characters.length >= 2) {
              const sorted = [...characters].sort((a, b) => b.line_count - a.line_count);
              defaultUserCharacter = sorted[1].name;
            }

            console.log('[YouTube Update] Analysis results:');
            console.log('[YouTube Update]   - Words (total):', allWords.length);
            console.log('[YouTube Update]   - Words (unique):', uniqueWords.length);
            console.log('[YouTube Update]   - Characters found:', characters.length);
            console.log('[YouTube Update]   - Roleplay enabled:', isRoleplayEnabled);
            console.log('[YouTube Update]   - Default user character:', defaultUserCharacter || 'none');
            console.log('[YouTube Update]   - Total segments:', totalSegments);

            // Update video resource with transcript data
            console.log('[YouTube Update] Updating video resource in database...');
            const updateData = {
              transcript: fullTranscript,
              transcript_segments: transcriptSegments,
              has_subtitles: true,
              word_count: allWords.length,
              unique_word_count: uniqueWords.length,
              characters: characters,
              is_roleplay_enabled: isRoleplayEnabled,
              default_user_character: defaultUserCharacter,
              total_segments: totalSegments
            };
            console.log('[YouTube Update] Update payload keys:', Object.keys(updateData).join(', '));

            await dataStore.updateVideoResource(resource.id, updateData);

            console.log('[YouTube Update] ✓ Successfully updated video resource');

            // Auto-calculate video difficulty based on transcript vocabulary
            await updateVideoDifficultyFromTranscript(resource.id, transcriptSegments);

            console.log('─'.repeat(80));
            console.log('');

            // Fetch updated video data from database to include transcript_segments
            const updatedResource = await dataStore.getVideoResourceById(resource.id);

            // Return success response with updated video
            return sendJson(res, 200, {
              video: serializeVideoResource(updatedResource || resource),
              message: 'YouTube video updated with subtitles successfully',
              updated: true,
            });
          } catch (err) {
            console.error('[YouTube] Failed to update with transcript segments:', err);
            return sendError(res, 500, 'Failed to update video with subtitles');
          }
        }

        // Video already exists with segments
        return sendError(res, 409, 'VIDEO_ALREADY_EXISTS');
      }

      // Create video resource for YouTube video
      const resource = await dataStore.createVideoResource({
        uploader_id: user.id,
        title,
        description,
        video_path: youtubeUrl,
        // hqdefault 对任何 YouTube 视频都存在；maxresdefault 只有源片 ≥720p 才有，
        // 否则直接 404，前端只能落到"暂无封面"占位图。
        thumbnail_path: body.thumbnail_path || `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`,
        original_filename: null,
        duration_sec: durationSec,
        status: 'ready',
        // File information (not applicable for YouTube)
        file_size: null,
        mime_type: 'video/youtube',
        file_hash: null,
        // Content classification
        tags: tags,
        category: body.category || null,
        collection_name: collectionName,
        difficulty_level: null,
        is_public: user.is_admin && body.is_public !== undefined
          ? (body.is_public === true || body.is_public === 'true')
          : false,
        // Learning-related
        subtitle_language: language,
        // YouTube specific
        video_type: 'youtube',
        youtube_video_id: youtubeVideoId,
        // Local video support (for mainland China)
        local_video_status: 'pending',
      });

      // Start downloading YouTube video in background for mainland users
      setImmediate(async () => {
        const startTime = Date.now();
        try {
          console.log('[YouTube Download] Starting background download for video:', resource.id, youtubeVideoId);

          // Check if already downloaded
          const existingDownload = await youtubeDownloader.checkExistingDownload(youtubeVideoId);
          if (existingDownload && existingDownload.exists) {
            console.log('[YouTube Download] Video already downloaded, using existing file:', existingDownload.publicPath);
            const localThumb = await generateThumbnail(existingDownload.filePath, youtubeVideoId);
            const updates = {
              local_video_path: existingDownload.publicPath,
              local_video_status: 'completed',
              file_size: existingDownload.fileSize,
            };
            if (localThumb) {
              updates.thumbnail_path = localThumb;
            }
            await dataStore.updateVideoResource(resource.id, updates);
            return;
          }

          // Update status to downloading
          await dataStore.updateVideoResource(resource.id, {
            local_video_status: 'downloading',
          });

          // Download video
          const result = await youtubeDownloader.downloadVideo(youtubeVideoId);

          // Update resource with local path
          const localThumb = await generateThumbnail(result.filePath, youtubeVideoId);
          await dataStore.updateVideoResource(resource.id, {
            local_video_path: result.localPath,
            local_video_status: 'completed',
            file_size: result.fileSize,
            thumbnail_path: localThumb || resource.thumbnail_path,
          });

          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log('[YouTube Download] ✓ Successfully downloaded and saved video:', resource.id);
          console.log('[YouTube Download] Duration:', duration, 'seconds');
          console.log('[YouTube Download] Local copy present:', Boolean(result.localPath));
        } catch (err) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.error('[YouTube Download] ✗ Download failed for video:', resource.id);
          console.error('[YouTube Download] Duration:', duration, 'seconds');
          console.error('[YouTube Download] Error:', err.message);

          // Update status to failed
          try {
            await dataStore.updateVideoResource(resource.id, {
              local_video_status: 'failed',
              failure_reason: `Download failed: ${err.message}`,
            });
          } catch (updateErr) {
            console.error('[YouTube Download] Failed to update video status:', updateErr);
          }
        }
      });

      // Save transcript segments if provided
      console.log('');
      console.log('─'.repeat(80));
      console.log('[YouTube New] Checking for segments...');
      console.log('[YouTube New]   - segments exists:', !!body.segments);
      console.log('[YouTube New]   - segments is array:', Array.isArray(body.segments));
      console.log('[YouTube New]   - segments length:', body.segments?.length || 0);
      console.log('─'.repeat(80));

      if (body.segments && Array.isArray(body.segments) && body.segments.length > 0) {
        try {
          console.log('');
          console.log('[YouTube New] ▶ Starting segment save for NEW video ID:', resource.id);
          console.log('[YouTube New] Original segments count:', body.segments.length);
          console.log('[YouTube New] First segment sample:', JSON.stringify(body.segments[0]).substring(0, 200));

          // Merge segments into complete sentences (YouTube subtitles are often split mid-sentence)
          const mergedSegments = mergeSentenceSegments(body.segments);
          console.log('[YouTube New] After merging, segments count:', mergedSegments.length);

          // Build transcript_segments array and transcript text
          const transcriptSegments = [];
          const transcriptParts = [];
          let saveErrors = 0;

          for (let i = 0; i < mergedSegments.length; i++) {
            const seg = mergedSegments[i];
            const text = seg.text || '';

            // Log progress every 50 segments
            if (i % 50 === 0 || i === mergedSegments.length - 1) {
              console.log(`[YouTube New] Processing segment ${i + 1}/${mergedSegments.length}...`);
            }

            // Save to video_sentences table
            try {
              await dataStore.createVideoSentence({
                video_id: resource.id,
                sentence_index: i,
                text: text,
                start_time_sec: seg.start || seg.start_sec || 0,
                end_time_sec: seg.end || seg.end_sec || 0,
                speaker: seg.speaker || null,
              });
            } catch (err) {
              console.error(`[YouTube New] Failed to save segment ${i} to video_sentences:`, err.message);
              saveErrors++;
            }

            // Build segment for transcript_segments field
            transcriptSegments.push({
              index: i,
              text: text,
              start: seg.start || seg.start_sec || 0,
              end: seg.end || seg.end_sec || 0,
              speaker: seg.speaker || null,
              source: 'youtube',  // YouTube 自动字幕标记
            });

            // Build transcript text
            if (text) {
              transcriptParts.push(text);
            }
          }

          console.log('[YouTube New] ✓ Finished processing segments');
          if (saveErrors > 0) {
            console.warn(`[YouTube New] ⚠️  ${saveErrors} errors occurred during segment save`);
          }

          const fullTranscript = transcriptParts.join(' ').trim();
          console.log('[YouTube New] Full transcript length:', fullTranscript.length, 'chars');

          // Extract word counts and character information
          console.log('[YouTube New] Extracting word and character information...');
          const allWords = extractWordsFromText(fullTranscript);
          const uniqueWords = [...new Set(allWords)];
          const { characters, totalSegments } = extractCharactersFromSegments(transcriptSegments);

          // Determine if roleplay should be enabled
          const isRoleplayEnabled = characters.length >= 2 &&
            characters.filter(c => c.line_count >= 3).length >= 2;

          // Find default user character (second-most lines)
          let defaultUserCharacter = null;
          if (characters.length >= 2) {
            const sorted = [...characters].sort((a, b) => b.line_count - a.line_count);
            defaultUserCharacter = sorted[1].name;
          }

          console.log('[YouTube New] Analysis results:');
          console.log('[YouTube New]   - Words (total):', allWords.length);
          console.log('[YouTube New]   - Words (unique):', uniqueWords.length);
          console.log('[YouTube New]   - Characters found:', characters.length);
          console.log('[YouTube New]   - Roleplay enabled:', isRoleplayEnabled);
          console.log('[YouTube New]   - Default user character:', defaultUserCharacter || 'none');
          console.log('[YouTube New]   - Total segments:', totalSegments);

          // Update video resource with transcript data
          console.log('[YouTube New] Updating video resource with transcript data...');
          const updateData = {
            transcript: fullTranscript,
            transcript_segments: transcriptSegments,
            has_subtitles: true,
            word_count: allWords.length,
            unique_word_count: uniqueWords.length,
            characters: characters,
            is_roleplay_enabled: isRoleplayEnabled,
            default_user_character: defaultUserCharacter,
            total_segments: totalSegments
          };
          console.log('[YouTube New] Update payload keys:', Object.keys(updateData).join(', '));
          console.log('[YouTube New] transcript_segments type:', typeof updateData.transcript_segments, 'isArray:', Array.isArray(updateData.transcript_segments), 'length:', updateData.transcript_segments.length);

          await dataStore.updateVideoResource(resource.id, updateData);

          console.log('[YouTube New] ✓ Successfully saved transcript segments');
          console.log('[YouTube New] Video ID:', resource.id);
          console.log('[YouTube New] has_subtitles:', true);

          // Auto-calculate video difficulty based on transcript vocabulary
          await updateVideoDifficultyFromTranscript(resource.id, transcriptSegments);

          console.log('─'.repeat(80));
          console.log('');
        } catch (err) {
          console.error('═'.repeat(80));
          console.error('[YouTube New] ✗ FAILED to save transcript segments');
          console.error('[YouTube New] Error:', err.message);
          console.error('[YouTube New] Stack:', err.stack);
          console.error('═'.repeat(80));
        }
      } else {
        console.log('[YouTube New] ⚠️  Skipping segment save - no valid segments provided');
        console.log('─'.repeat(80));
        console.log('');
      }

      // Fetch updated video data from database to include transcript_segments
      const updatedVideo = await dataStore.getVideoResourceById(resource.id);

      return sendJson(res, 201, {
        video: serializeVideoResource(updatedVideo || resource),
        message: 'YouTube video saved to library successfully',
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('[YouTube Save] Error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // DELETE /video-resources/:id - Delete video resource
  if (pathname.match(/^\/video-resources\/\d+$/) && req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const id = Number(pathname.split('/').pop());
      if (!id) {
        return sendError(res, 400, 'Invalid ID');
      }

      const resource = await dataStore.getVideoResourceById(id);
      if (!resource) {
        return sendError(res, 404, 'Video not found');
      }

      // Check if user has permission to delete this video (owner or admin)
      // Use string comparison to handle type mismatches between database and JWT
      const isOwner = String(resource.uploader_id) === String(user.id);
      const isAdmin = user && user.is_admin;
      if (!isOwner && !isAdmin) {
        console.log(`[DELETE] Permission denied: uploader_id=${resource.uploader_id} (${typeof resource.uploader_id}), user.id=${user.id} (${typeof user.id}), is_admin=${isAdmin}`);
        return sendError(res, 403, '需要管理员或上传者权限');
      }

      // Delete from database (will cascade delete related vocab_contexts)
      const deleted = await dataStore.deleteVideoResource(id);

      // Delete video file from disk
      if (resource.youtube_video_id) {
        // For YouTube videos, delete the local downloaded file if it exists
        if (resource.local_video_path) {
          try {
            await youtubeDownloader.deleteDownload(resource.local_video_path);
            console.log('[DELETE] Deleted YouTube local video:', true);
          } catch (fileErr) {
            console.warn('[DELETE] Could not delete YouTube local video:', { code: fileErr?.code || 'FILE_DELETE_ERROR' });
            // Continue even if file deletion fails
          }
        } else {
          console.log(`[DELETE] YouTube video has no local download to delete`);
        }
      } else if (resource.video_path && resource.video_path.startsWith('/videos/')) {
        // For regular uploaded videos, delete from the videos directory
        const filename = resource.video_path.replace('/videos/', '');
        const videoFilePath = path.join(VIDEO_DIR, filename);
        try {
          await fsp.unlink(videoFilePath);
          console.log(`[DELETE] Deleted video file: ${videoFilePath}`);
        } catch (fileErr) {
          console.warn(`[DELETE] Could not delete video file: ${videoFilePath}`, fileErr.message);
          // Continue even if file deletion fails
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: 'Video deleted successfully',
        deletedVideo: serializeVideoResource(deleted),
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Video deletion error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // PATCH /video-resources/:id - Update video resource (title, description)
  if (pathname.match(/^\/video-resources\/\d+$/) && req.method === 'PATCH') {
    try {
      const user = await authenticate(req);
      const id = Number(pathname.split('/').pop());
      if (!id) {
        return sendError(res, 400, 'Invalid ID');
      }

      const updates = {};
      const body = await parseBody(req);

      if (Object.prototype.hasOwnProperty.call(body, 'title')) {
        const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
        if (!rawTitle) {
          return sendError(res, 400, 'Title must be a non-empty string');
        }
        updates.title = rawTitle;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        const rawDescription = body.description;
        if (rawDescription === null) {
          updates.description = null;
        } else if (typeof rawDescription === 'string') {
          updates.description = rawDescription.trim();
        } else {
          return sendError(res, 400, 'Description must be a string or null');
        }
      }

      // Handle new metadata fields
      if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
        if (Array.isArray(body.tags)) {
          updates.tags = body.tags;
        } else if (body.tags === null) {
          updates.tags = [];
        } else {
          return sendError(res, 400, 'Tags must be an array or null');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'category')) {
        if (typeof body.category === 'string' || body.category === null) {
          updates.category = body.category ? body.category.trim() : null;
        } else {
          return sendError(res, 400, 'Category must be a string or null');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'difficulty_level')) {
        if (typeof body.difficulty_level === 'string' || body.difficulty_level === null) {
          const validLevels = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'beginner', 'intermediate', 'advanced'];
          const level = body.difficulty_level ? body.difficulty_level.toLowerCase().trim() : null;
          if (level && !validLevels.includes(level)) {
            return sendError(res, 400, `Difficulty level must be one of: ${validLevels.join(', ')}`);
          }
          updates.difficulty_level = level;
        } else {
          return sendError(res, 400, 'Difficulty level must be a string or null');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'collection_name')) {
        const raw = body.collection_name;
        if (raw === null) {
          updates.collection_name = null;
        } else if (typeof raw === 'string') {
          const trimmed = raw.trim();
          updates.collection_name = trimmed ? trimmed.slice(0, 120) : null;
        } else {
          return sendError(res, 400, 'collection_name must be a string or null');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'is_public')) {
        if (typeof body.is_public === 'boolean') {
          if (body.is_public === true && !user.is_admin) {
            return sendError(res, 403, 'Public publishing requires review');
          }
          updates.is_public = body.is_public;
        } else {
          return sendError(res, 400, 'is_public must be a boolean');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'is_featured')) {
        if (!user.is_admin) {
          return sendError(res, 403, 'Only admins can set featured status');
        }
        if (typeof body.is_featured === 'boolean') {
          updates.is_featured = body.is_featured;
          if (body.is_featured === true) {
            updates.is_public = true;
          }
        } else {
          return sendError(res, 400, 'is_featured must be a boolean');
        }
      }

      // Handle roleplay-related fields
      if (Object.prototype.hasOwnProperty.call(body, 'is_roleplay_enabled')) {
        if (typeof body.is_roleplay_enabled === 'boolean') {
          updates.is_roleplay_enabled = body.is_roleplay_enabled;
        } else {
          return sendError(res, 400, 'is_roleplay_enabled must be a boolean');
        }
      }

      // Handle VIP-only field (admin only)
      if (Object.prototype.hasOwnProperty.call(body, 'is_vip_only')) {
        // Check if user is admin
        if (!user.is_admin) {
          return sendError(res, 403, 'Only admins can set VIP-only status');
        }
        if (typeof body.is_vip_only === 'boolean') {
          updates.is_vip_only = body.is_vip_only;
        } else {
          return sendError(res, 400, 'is_vip_only must be a boolean');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'default_user_character')) {
        if (typeof body.default_user_character === 'string' || body.default_user_character === null) {
          updates.default_user_character = body.default_user_character ? body.default_user_character.trim() : null;
        } else {
          return sendError(res, 400, 'default_user_character must be a string or null');
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'characters')) {
        if (Array.isArray(body.characters)) {
          updates.characters = body.characters;
        } else if (body.characters === null) {
          updates.characters = [];
        } else {
          return sendError(res, 400, 'characters must be an array or null');
        }
      }

      if (!Object.keys(updates).length) {
        return sendError(res, 400, 'Nothing to update');
      }

      const existing = await dataStore.getVideoResourceById(id);
      if (!existing) {
        return sendError(res, 404, 'Video not found');
      }

      // Check if user has permission to edit this video
      // Admins can edit any video, regular users can only edit their own
      // Use string comparison to handle type mismatches between database and JWT
      if (String(existing.uploader_id) !== String(user.id) && !user.is_admin) {
        console.log(`[PATCH] Permission denied: uploader_id=${existing.uploader_id} (${typeof existing.uploader_id}), user.id=${user.id} (${typeof user.id}), is_admin=${user.is_admin}`);
        return sendError(res, 403, 'You do not have permission to edit this video');
      }

      const updated = await dataStore.updateVideoResource(id, updates);
      await clearVideoResourceCaches(id);
      return sendJson(res, 200, { video: serializeVideoResource(updated) });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Video update error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id - Get single video resource
  if (pathname.match(/^\/video-resources\/\d+$/) && req.method === 'GET') {
    try {
      // Public read allowed: try auth but don't require it (mirror list route behavior)
      let user = null;
      try { if (dataStore.isDatabaseAvailable()) { user = await authenticate(req); } } catch(_) { /* allow unauthenticated */ }
      const id = Number(pathname.split('/').pop());
      if (!id) {
        return sendError(res, 400, 'Invalid ID');
      }

      const userCtx = await getUserContext(req);
      // Check if user is from mainland China
      const geoInfo = await geoIPService.isRequestFromChina(req, userCtx.label);
      const isMainlandUser = FORCE_LOCAL_VIDEO || geoInfo.isChina;

      const resource = await dataStore.getVideoResourceById(id);
      if (!resource || !canAccessVideoResource(resource, user)) {
        return sendError(res, 404, 'Video not found');
      }

      // Try cache first (2 minute TTL for video details)
      const cacheKey = `video:detail:${id}`;
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, {
          video: cached,
          isMainlandUser: isMainlandUser
        });
      }

      const serialized = serializeVideoResource(resource);
      // Cache the serialized result
      await cacheService.set(cacheKey, serialized, 120); // 2 minute TTL

      return sendJson(res, 200, {
        video: serialized,
        isMainlandUser: isMainlandUser
      });
    } catch (err) {
      const status = (err.message === 'DATASTORE_UNAVAILABLE') ? 503 : 500;
      if (status >= 500) {
        console.error('[Route /video-resources/:id] Failed:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id/transcript - Get video transcript segments
  if (pathname.match(/^\/video-resources\/\d+\/transcript$/) && req.method === 'GET') {
    try {
      // Public read allowed
      let user = null;
      try { if (dataStore.isDatabaseAvailable()) { user = await authenticate(req); } } catch(_) { /* allow unauthenticated */ }
      const id = Number(pathname.split('/')[2]);
      if (!id) {
        return sendError(res, 400, 'Invalid ID');
      }

      // Use lightweight query - only fetch transcript and access-control fields
      const { pool } = require('../data-store/core');
      const { rows } = await pool.query(
        `SELECT id, uploader_id, is_public, transcript, transcript_segments, language
         FROM video_resources
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      const resource = rows[0];
      if (!resource || !canAccessVideoResource(resource, user)) {
        return sendError(res, 404, 'Video not found');
      }

      // Try cache first (5 minute TTL for transcripts)
      const cacheKey = `transcript:${id}`;
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      let segments = [];
      if (Array.isArray(resource.transcript_segments)) {
        segments = resource.transcript_segments;
      } else if (resource.transcript_segments) {
        if (typeof resource.transcript_segments === 'string' &&
            resource.transcript_segments !== 'undefined' &&
            resource.transcript_segments !== 'null' &&
            resource.transcript_segments !== '') {
          try {
            segments = JSON.parse(resource.transcript_segments);
          } catch (err) {
            console.warn('[Transcript] Failed to parse transcript_segments for video', id, ':', err.message);
            segments = [];
          }
        }
      }

      const result = {
        videoId: id,
        segments: segments,
        transcript: resource.transcript || '',
        language: resource.language || 'en',
      };

      // Cache the result
      await cacheService.set(cacheKey, result, 300); // 5 minute TTL

      return sendJson(res, 200, result);
    } catch (err) {
      const status = (err.message === 'DATASTORE_UNAVAILABLE') ? 503 : 500;
      if (status >= 500) {
        console.error('[Route /video-resources/:id/transcript] Failed:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // PUT /video-resources/:id/transcript/:index - Update transcript segment
  if (pathname.match(/^\/video-resources\/\d+\/transcript\/\d+$/) && req.method === 'PUT') {
    try {
      await authenticate(req);
      const parts = pathname.split('/');
      const videoId = Number(parts[2]);
      const segmentIndex = Number(parts[4]);

      if (!videoId || segmentIndex < 0) {
        return sendError(res, 400, 'Invalid video ID or segment index');
      }

      const body = await parseBody(req);
      const hasText = Object.prototype.hasOwnProperty.call(body, 'text');
      const hasSpeaker = Object.prototype.hasOwnProperty.call(body, 'speaker');

      if (!hasText && !hasSpeaker) {
        return sendError(res, 400, 'Nothing to update');
      }

      const nextText =
        hasText && typeof body.text === 'string'
          ? body.text.trim()
          : undefined;
      const nextSpeakerRaw = hasSpeaker ? body.speaker : undefined;
      const nextSpeaker =
        typeof nextSpeakerRaw === 'string'
          ? nextSpeakerRaw.trim()
          : nextSpeakerRaw === null
            ? null
            : undefined;

      if (hasText && (!nextText || !nextText.length)) {
        return sendError(res, 400, 'Text must be a non-empty string');
      }
      if (hasSpeaker && nextSpeaker === undefined) {
        return sendError(res, 400, 'Speaker must be a string or null');
      }

      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }

      if (!video.transcript_segments || !Array.isArray(video.transcript_segments)) {
        return sendError(res, 400, 'Video has no transcript segments');
      }

      if (segmentIndex >= video.transcript_segments.length) {
        return sendError(res, 400, 'Segment index out of range');
      }

      const segment = video.transcript_segments[segmentIndex];
      if (hasText) {
        segment.text = nextText;
      }
      if (hasSpeaker) {
        segment.speaker = nextSpeaker;
      }

      const updatedSegments = video.transcript_segments;
      const transcriptText = updatedSegments
        .map((seg) => (seg && seg.text ? seg.text : ''))
        .join(' ')
        .trim();

      // Save to database
      await dataStore.updateVideoResource(videoId, {
        transcript_segments: updatedSegments,
        transcript: transcriptText,
      });

      return sendJson(res, 200, {
        success: true,
        segment: updatedSegments[segmentIndex],
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Transcript update error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // PATCH /video-resources/:id/speakers - Update speakers (replace speaker names)
  if (pathname.match(/^\/video-resources\/\d+\/speakers$/) && req.method === 'PATCH') {
    try {
      await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video ID');
      }

      const body = await parseBody(req);
      const rawFrom = typeof body.from === 'string' ? body.from.trim() : '';
      const rawTo = typeof body.to === 'string' ? body.to.trim() : '';
      if (!rawFrom || !rawTo) {
        return sendError(res, 400, 'Both from and to speaker names are required');
      }

      let segmentIndices = null;
      if (Array.isArray(body.segment_indices)) {
        segmentIndices = new Set(
          body.segment_indices
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value >= 0),
        );
      }

      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }

      let segments = video.transcript_segments;
      if (typeof segments === 'string') {
        try {
          segments = JSON.parse(segments);
        } catch (err) {
          segments = [];
        }
      }
      if (!Array.isArray(segments) || !segments.length) {
        return sendError(res, 400, 'No transcript segments found');
      }

      // Replace speaker name in segments
      let updated = 0;
      segments.forEach((segment, idx) => {
        if (!segment) return;
        const shouldUpdate = !segmentIndices || segmentIndices.has(idx);
        if (shouldUpdate && segment.speaker === rawFrom) {
          segment.speaker = rawTo;
          updated++;
        }
      });

      if (updated === 0) {
        return sendJson(res, 200, {
          success: true,
          message: 'No segments matched the speaker name',
          updated: 0,
        });
      }

      // Update transcript text (regenerate from segments)
      const transcriptText = segments
        .map((seg) => (seg && seg.text ? seg.text : ''))
        .join(' ')
        .trim();

      // Save to database
      await dataStore.updateVideoResource(videoId, {
        transcript_segments: segments,
        transcript: transcriptText,
      });

      return sendJson(res, 200, {
        success: true,
        message: `Updated ${updated} segments`,
        updated,
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Speaker update error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id/speakers - Get speakers for video
  if (pathname.match(/^\/video-resources\/\d+\/speakers$/) && req.method === 'GET') {
    try {
      await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!Number.isFinite(videoId)) {
        return sendError(res, 400, 'Invalid video id');
      }

      const { speakers } = await resolveSpeakersForVideo(videoId);
      return sendJson(res, 200, { speakers });
    } catch (err) {
      const status = err.statusCode || (err.message === 'UNAUTHORIZED' ? 401 : 500);
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id/recordings - Get practice recordings for video
  if (pathname.match(/^\/video-resources\/\d+\/recordings$/) && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video id');
      }
      const video = await dataStore.getVideoResourceById(videoId);
      if (!video || !canAccessVideoResource(video, user)) {
        return sendError(res, 404, 'Video not found');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const speaker = url.searchParams.get('speaker') || null;
      const recordings = await dataStore.listPracticeRecordingsForUser(videoId, user.id, speaker);
      return sendJson(res, 200, { items: recordings.map(serializePracticeRecording) });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /api/practice-shares - Create a share link for practice recordings
  if (pathname === '/api/practice-shares' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const videoId = Number(body?.video_id || body?.videoId);
      const speaker = String(body?.speaker || '').trim();
      const publishToCommunity = Boolean(body?.publish_to_community || body?.publishToCommunity);
      const communityText = String(body?.text || '').trim();
      if (!Number.isFinite(videoId) || videoId <= 0) {
        return sendError(res, 400, 'Invalid video_id');
      }
      if (!speaker) {
        return sendError(res, 400, 'speaker is required');
      }

      const recordings = await dataStore.listPracticeRecordingsForUser(videoId, user.id, speaker);
      if (!recordings.length) {
        return sendError(res, 400, 'No recordings found for this role');
      }

      const shareToken = randomBytes(18)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

      const share = await dataStore.createPracticeRecordingShare({
        token: shareToken,
        userId: user.id,
        videoResourceId: videoId,
        speaker,
      });

      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host || 'www.example.com';
      const shareUrl = `${proto}://${host}/practice-session-desktop.html?share=${encodeURIComponent(shareToken)}`;
      let community = null;
      if (publishToCommunity) {
        const text = communityText || `对话回放：${speaker}`;
        try {
          community = await dataStore.createVoiceCheckin(user.id, {
            text,
            audioPath: null,
            shareUrl,
            shareToken: shareToken
          });
        } catch (err) {
          console.warn('[PracticeShare] Failed to publish to community:', err);
        }
      }

      return sendJson(res, 201, {
        share: {
          token: share?.token || shareToken,
          video_id: videoId,
          speaker,
          created_at: share?.created_at || null,
        },
        community_id: community?.id || null,
        share_url: shareUrl,
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/practice-shares/:token - Resolve shared practice recordings
  const shareMatch = pathname.match(/^\/api\/practice-shares\/([A-Za-z0-9_-]+)$/);
  if (shareMatch && req.method === 'GET') {
    try {
      const shareToken = shareMatch[1];
      const share = await dataStore.getPracticeRecordingShareByToken(shareToken);
      if (!share) {
        return sendError(res, 404, 'Share not found');
      }
      if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
        return sendError(res, 410, 'Share expired');
      }

      const video = await dataStore.getVideoResourceById(share.video_resource_id);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }

      const recordings = await dataStore.listPracticeRecordingsForUser(
        share.video_resource_id,
        share.user_id,
        share.speaker,
      );

      dataStore.touchPracticeRecordingShare(share.token).catch(() => {});

      return sendJson(res, 200, {
        share: {
          token: share.token,
          video_id: share.video_resource_id,
          speaker: share.speaker,
          created_at: share.created_at,
        },
        video: serializeVideoResource(video),
        recordings: recordings.map(serializePracticeRecording),
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /api/practice-shares/:token/feedback - Submit feedback for a shared recording
  const feedbackMatch = pathname.match(/^\/api\/practice-shares\/([A-Za-z0-9_-]+)\/feedback$/);
  if (feedbackMatch && req.method === 'POST') {
    try {
      const shareToken = feedbackMatch[1];
      const share = await dataStore.getPracticeRecordingShareByToken(shareToken);
      if (!share) {
        return sendError(res, 404, 'Share not found');
      }

      const body = await parseBody(req);
      const rating = body?.rating ? Number(body.rating) : null;
      const comment = body?.comment ? String(body.comment).trim() : null;

      if (!rating && !comment) {
        return sendError(res, 400, 'Rating or comment is required');
      }

      if (rating && (rating < 1 || rating > 5)) {
        return sendError(res, 400, 'Rating must be between 1 and 5');
      }

      // Log feedback (TODO: store in database)
      console.log('[ShareFeedback] Received:', {
        userId: share.user_id,
        videoResourceId: share.video_resource_id,
        rating,
        hasComment: Boolean(comment),
        timestamp: new Date().toISOString(),
      });

      return sendJson(res, 200, { success: true, message: 'Feedback submitted' });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id/role-history - Get role practice history summary
  if (pathname.match(/^\/video-resources\/\d+\/role-history$/) && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video id');
      }
      const rows = await dataStore.getPracticeRoleHistoryForUser(videoId, user.id);
      const counts = {};
      let lastSpeaker = null;
      let lastAt = null;
      rows.forEach((row) => {
        if (!row || !row.speaker) return;
        counts[row.speaker] = Number(row.count) || 0;
        if (!lastSpeaker) {
          lastSpeaker = row.speaker;
          lastAt = row.last_at || null;
        }
      });
      return sendJson(res, 200, { counts, lastSpeaker, lastAt });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /video-resources/:id/waveform - Get waveform samples for audio segment
  if (pathname.match(/^\/video-resources\/\d+\/waveform$/) && req.method === 'GET') {
    let userCtx = { label: 'guest' };
    try {
      userCtx = await getUserContext(req);
      let user = null;
      try { user = await authenticate(req); } catch (_) {}
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video id');
      }
      if (!audioFfmpegAvailable) {
        return sendError(res, 503, 'FFmpeg unavailable');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const startSec = Math.max(0, Number(url.searchParams.get('start') || 0));
      const endSec = Math.max(startSec + 0.1, Number(url.searchParams.get('end') || 0));
      const points = Math.min(600, Math.max(80, Number(url.searchParams.get('points') || 240)));
      logWithUser('Waveform', userCtx, `video=${videoId} start=${startSec.toFixed(2)} end=${endSec.toFixed(2)} points=${points}`);
      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource || !canAccessVideoResource(resource, user)) {
        return sendError(res, 404, 'Video not found');
      }
      const cacheKey = buildWaveformCacheKey(videoId, startSec, endSec, points);
      const cached = getCachedWaveform(cacheKey);
      if (cached) {
        logWithUser('Waveform', userCtx, `cache hit video=${videoId}`);
        return sendJson(res, 200, { samples: cached, cached: true });
      }
      const sourcePath = await resolveAudioSourcePath(resource);
      if (!sourcePath) {
        return sendError(res, 404, 'Audio source not found');
      }
      logWithUser('Waveform', userCtx, `source=${sourcePath}`);

      // Check if we have a cached WAV buffer for this video
      let wavBuffer;
      const wavCacheKey = `wav:${videoId}`;
      const cachedWav = wavBufferCache.get(wavCacheKey);
      if (cachedWav && Date.now() - cachedWav.ts < WAVEFORM_CACHE_TTL_MS) {
        wavBuffer = cachedWav.buffer;
        logWithUser('Waveform', userCtx, `wav buffer cache hit video=${videoId}`);
      } else {
        const wavPath = await convertAudioToWav(sourcePath, 16000);
        wavBuffer = await fsp.readFile(wavPath);
        // Cache the WAV buffer (limit to 50MB to prevent memory issues)
        if (wavBuffer.length < 50 * 1024 * 1024) {
          wavBufferCache.set(wavCacheKey, { ts: Date.now(), buffer: wavBuffer });
        }
        try { await fsp.unlink(wavPath); } catch (_) {}
      }

      const samples = buildWaveformSamples(wavBuffer, startSec, endSec, points);
      setCachedWaveform(cacheKey, samples);
      logWithUser('Waveform', userCtx, `done video=${videoId} samples=${samples.length}`);
      return sendJson(res, 200, { samples });
    } catch (err) {
      warnWithUser('Waveform', userCtx, `failed ${err?.message || err}`);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/:id/recordings - Save practice recording
  if (pathname.match(/^\/video-resources\/\d+\/recordings$/) && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video id');
      }
      const video = await dataStore.getVideoResourceById(videoId);
      if (!video || !canAccessVideoResource(video, user)) {
        return sendError(res, 404, 'Video not found');
      }

      const body = await parseBody(req);
      const segmentIndex = Number(body.segmentIndex);
      const speaker = (body.speaker || '').trim();
      const durationSec = Number(body.durationSec);
      const audioData = body.audioData;

      if (!Number.isFinite(segmentIndex)) {
        return sendError(res, 400, 'segmentIndex is required');
      }
      if (!speaker) {
        return sendError(res, 400, 'speaker is required');
      }
      if (!audioData) {
        return sendError(res, 400, 'audioData is required');
      }

      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource) {
        return sendError(res, 404, 'Video not found');
      }

      const existing = await dataStore.getPracticeRecording(videoId, user.id, speaker, segmentIndex);
      const { mimeType, buffer } = parseBase64DataUrl(audioData);
      if (buffer.length > 15 * 1024 * 1024) {
        return sendError(res, 413, 'Audio file too large');
      }

      const extension = getExtensionFromMime(mimeType);
      const subDirParts = [`video-${videoId}`, `user-${user.id}`];
      const fileName = `seg-${segmentIndex}-${Date.now()}.${extension}`;
      const absDir = path.join(RECORDINGS_DIR, ...subDirParts);
      const relPath = `/recordings/${subDirParts.join('/')}/${fileName}`;
      const absPath = path.join(absDir, fileName);

      await fsp.mkdir(absDir, { recursive: true });

      try {
        await fsp.writeFile(absPath, buffer);
      } catch (err) {
        console.error('Failed to write recording file:', err);
        return sendError(res, 500, 'Failed to save audio');
      }

      let finalRelPath = relPath;
      let finalAbsPath = absPath;
      if (shouldTranscodeToMp4Audio(extension)) {
        const baseName = path.basename(fileName, `.${extension}`);
        const targetName = `${baseName}.mp4`;
        const targetAbsPath = path.join(absDir, targetName);
        const targetRelPath = `/recordings/${subDirParts.join('/')}/${targetName}`;
        try {
          await transcodeToMp4Audio(absPath, targetAbsPath);
          await removeFileSafe(absPath);
          finalRelPath = targetRelPath;
          finalAbsPath = targetAbsPath;
        } catch (err) {
          console.warn('Audio transcode failed, keeping original format:', err?.message || err);
        }
      }

      try {
        const record = await dataStore.upsertPracticeRecording({
          videoResourceId: videoId,
          userId: user.id,
          speaker,
          segmentIndex,
          audioPath: finalRelPath,
          durationSec: Number.isFinite(durationSec) ? durationSec : null,
        });

        if (existing && existing.audio_path && existing.audio_path !== finalRelPath) {
          const oldAbsPath = path.join(STATIC_DIR, existing.audio_path.replace(/^\//, ''));
          try {
            await removeFileSafe(oldAbsPath);
            console.log('[Recording] Removed old audio file:', oldAbsPath);
          } catch (err) {
            console.warn('[Recording] Could not delete old audio file:', oldAbsPath);
          }
        }

        return sendJson(res, 200, {
          success: true,
          recording: serializePracticeRecording(record),
        });
      } catch (err) {
        console.error('Failed to save recording to database:', err);
        return sendError(res, 500, 'Failed to save recording');
      }
    } catch (err) {
      if (err.message === 'INVALID_AUDIO_DATA') {
        return sendError(res, 400, 'Invalid audio data format');
      }
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Recording error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/:id/import-words - Import words from video transcript
  if (pathname.match(/^\/video-resources\/\d+\/import-words$/) && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video id');
      }

      // Get video resource
      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource || !canAccessVideoResource(resource, user)) {
        return sendError(res, 404, 'Video not found');
      }

      const serialized = serializeVideoResource(resource);
      const segments = Array.isArray(serialized.transcript_segments)
        ? serialized.transcript_segments
        : [];

      if (segments.length === 0) {
        return sendJson(res, 200, {
          message: 'No transcription available',
          imported: 0,
          skipped: 0,
          total: 0
        });
      }

      // Extract words from all segments with context
      const wordContextMap = new Map(); // word -> { sentence, segmentIndex, startSec, endSec }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const text = seg?.text || '';
        const words = extractWordsFromText(text);

        for (const word of words) {
          if (!wordContextMap.has(word)) {
            // Save first occurrence as context
            wordContextMap.set(word, {
              sentence: text,
              segmentIndex: seg?.index != null ? seg.index : i,
              startSec: Number(seg?.start_sec ?? seg?.start ?? seg?.startTime) || null,
              endSec: Number(seg?.end_sec ?? seg?.end ?? seg?.endTime) || null,
            });
          }
        }
      }

      const uniqueWords = Array.from(wordContextMap.keys());
      const importUserLabel = user?.username || `user-${user?.id || 'unknown'}`;
      const tsImport = new Date().toISOString();
      console.log(`[${tsImport}] [Import Words] user=${importUserLabel} video=${videoId} Extracted ${uniqueWords.length} unique words`);

      // Process word import in background (non-blocking)
      setImmediate(async () => {
        const startTime = Date.now();
        try {
          console.log(`[${new Date().toISOString()}] [Import Words] user=${importUserLabel} video=${videoId} Starting background import`);

          // 使用 vocabulary-v2 系统批量导入
          const vocabularyV2 = require('../services/vocabulary-v2');

          // 批量导入词汇到新系统
          const result = await vocabularyV2.batchAddWordsForUser(
            user.id,
            uniqueWords,
            { videoId: videoId }
          );

          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`[${new Date().toISOString()}] [Import Words] user=${importUserLabel} video=${videoId} Successfully imported ${result.added} words with context in ${duration}s`);
        } catch (err) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.error(`[${new Date().toISOString()}] [Import Words] user=${importUserLabel} video=${videoId} Background import failed after ${duration}s:`, err);
        }
      });

      // Return immediately with 202 Accepted status
      return sendJson(res, 202, {
        message: '词汇导入已开始，正在后台处理',
        status: 'processing',
        total: uniqueWords.length
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('[Import Words] Error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/:id/retranscribe - Re-run transcription/text extraction (admin or uploader)
  if (pathname.match(/^\/video-resources\/\d+\/retranscribe$/) && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) return sendError(res, 400, 'Invalid video id');

      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource) return sendError(res, 404, 'Video not found');

      const isOwner = resource.uploaded_by && Number(resource.uploaded_by) === Number(user.id);
      const isAdmin = user.role === 'admin' || user.is_admin;
      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const body = await parseBody(req);
      const language = body?.language || resource.language || 'en';

      await dataStore.updateVideoResource(videoId, {
        status: 'processing',
        failure_reason: null,
        transcript: null,
        transcript_segments: [],
        word_count: null,
        unique_word_count: null,
        total_segments: null,
        has_subtitles: false,
      });

      setImmediate(async () => {
        const startTime = Date.now();
        try {
          const fresh = await dataStore.getVideoResourceById(videoId);
          const result = await videoTranscriptionService.transcribeAndStore(fresh, { language });
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log('[Retranscribe] Completed for video:', videoId, 'duration(s):', duration, 'text len:', result?.text?.length || 0);
        } catch (err) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.error('[Retranscribe] Failed for video:', videoId, 'after', duration, 's', err?.message || err);
          try {
            await dataStore.updateVideoResource(videoId, {
              status: 'failed',
              failure_reason: err?.userMessage || err?.message || 'Transcription failed',
            });
          } catch (e) {
            console.error('[Retranscribe] Failed to update status:', e?.message || e);
          }
        }
      });

      return sendJson(res, 202, {
        success: true,
        message: '重新提取已开始，后台处理中',
      });
    } catch (err) {
      console.error('Retranscribe error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/:id/reprocess-segments - Re-apply segment merging algorithm to existing segments
  if (pathname.match(/^\/video-resources\/\d+\/reprocess-segments$/) && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) return sendError(res, 400, 'Invalid video id');

      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource) return sendError(res, 404, 'Video not found');

      const isOwner = resource.uploaded_by && Number(resource.uploaded_by) === Number(user.id);
      const isAdmin = user.role === 'admin' || user.is_admin;
      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      // 获取现有 segments
      let existingSegments = resource.transcript_segments;
      if (typeof existingSegments === 'string') {
        try {
          existingSegments = JSON.parse(existingSegments);
        } catch (e) {
          existingSegments = [];
        }
      }

      if (!Array.isArray(existingSegments) || existingSegments.length === 0) {
        return sendError(res, 400, '没有可处理的字幕数据');
      }

      console.log(`[ReprocessSegments] Video ${videoId}: 原始 ${existingSegments.length} 段`);

      // 打印原始数据前10条
      console.log('[ReprocessSegments] 原始数据前10条:');
      existingSegments.slice(0, 10).forEach((seg, i) => {
        console.log(`  [${i}] ${(seg.start || 0).toFixed(2)}s - ${(seg.end || 0).toFixed(2)}s: "${(seg.text || '').substring(0, 50)}"`);
      });

      // 应用智能合并算法
      const normalizedSegments = normalizeSegmentsTiming(existingSegments);
      const mergedSegments = mergeIncompleteSegments(normalizedSegments, {
        maxMergeGap: 3,
        maxSegmentDuration: 25,
        minSegmentDuration: 0.8,
      });

      console.log(`[ReprocessSegments] Video ${videoId}: 合并后 ${mergedSegments.length} 段`);

      // 打印合并后数据前10条
      console.log('[ReprocessSegments] 合并后数据前10条:');
      mergedSegments.slice(0, 10).forEach((seg, i) => {
        console.log(`  [${i}] ${(seg.start || 0).toFixed(2)}s - ${(seg.end || 0).toFixed(2)}s: "${(seg.text || '').substring(0, 50)}"`);
      });

      // 更新数据库
      const fullTranscript = mergedSegments.map(seg => seg.text).join(' ');
      await dataStore.updateVideoResource(videoId, {
        transcript: fullTranscript,
        transcript_segments: mergedSegments,
        total_segments: mergedSegments.length,
      });

      return sendJson(res, 200, {
        success: true,
        message: `断句重新处理完成：${existingSegments.length} 段 → ${mergedSegments.length} 段`,
        originalCount: existingSegments.length,
        mergedCount: mergedSegments.length,
        segments: mergedSegments.slice(0, 10), // 返回前10条供检查
      });
    } catch (err) {
      console.error('ReprocessSegments error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /video-resources/:id/import-transcript - Manually import transcript (admin or uploader)
  if (pathname.match(/^\/video-resources\/\d+\/import-transcript$/) && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) return sendError(res, 400, 'Invalid video id');

      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource) return sendError(res, 404, 'Video not found');

      const isOwner = resource.uploaded_by && Number(resource.uploaded_by) === Number(user.id);
      const isAdmin = user.role === 'admin' || user.is_admin;
      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const body = await parseBody(req);
      const transcriptTextRaw = (body?.transcript || '').trim();
      const language = (body?.language || resource.language || 'en').trim();
      const incomingSegments = Array.isArray(body?.segments) ? body.segments : null;

      if (!transcriptTextRaw && (!incomingSegments || !incomingSegments.length)) {
        return sendError(res, 400, 'transcript 字段或 segments 数组不能为空');
      }

      // Parse transcript into segments if caller only provided text
      let segments = [];
      if (incomingSegments && incomingSegments.length) {
        segments = incomingSegments.map((seg, idx) => ({
          index: Number(seg.index ?? idx),
          text: (seg.text || '').trim(),
          start: Number(seg.start ?? seg.start_time_sec ?? seg.start_sec ?? 0),
          end: Number(seg.end ?? seg.end_time_sec ?? seg.end_sec ?? 0),
          translation: (seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim() || null,
          speaker: seg.speaker || null,
          source: 'manual',  // 手动导入的字幕标记
        })).filter(s => s.text);
      } else {
        segments = parseTimestampedTranscript(transcriptTextRaw);
        // 从文本解析的也标记为手动导入
        segments = segments.map(seg => ({ ...seg, source: 'manual' }));
      }

      if (!segments.length) {
        return sendError(res, 400, '未能解析有效的字幕片段');
      }

      // Normalize end times (ensure end > start)
      for (let i = 0; i < segments.length; i++) {
        const current = segments[i];
        const next = segments[i + 1];
        if (!Number.isFinite(current.start)) current.start = 0;
        if (!Number.isFinite(current.end) || current.end <= current.start) {
          if (next && Number.isFinite(next.start) && next.start > current.start) {
            current.end = next.start;
          } else {
            current.end = current.start + 4;
          }
        }
        current.index = i;
      }

      const transcriptText = segments.map(s => s.text).join(' ') || transcriptTextRaw;
      const words = extractWordsFromText(transcriptText);
      const uniqueWords = [...new Set(words)];
      const { characters, totalSegments } = extractCharactersFromSegments(segments);
      const isRoleplayEnabled = characters.length >= 2 &&
        characters.filter(c => c.line_count >= 3).length >= 2;
      let defaultUserCharacter = null;
      if (characters.length >= 2) {
        const sorted = [...characters].sort((a, b) => b.line_count - a.line_count);
        defaultUserCharacter = sorted[1].name;
      }

      // Replace video_sentences with new segments
      try {
        await dataStore.deleteVideoSentences(videoId);
      } catch (e) {
        console.warn('[Import Transcript] Failed to clear old sentences:', e?.message || e);
      }
      let saveErrors = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        try {
          await dataStore.createVideoSentence({
            video_id: videoId,
            sentence_index: i,
            text: seg.text,
            start_time_sec: seg.start || 0,
            end_time_sec: seg.end || 0,
            speaker: seg.speaker || null,
          });
        } catch (err) {
          saveErrors += 1;
          console.error('[Import Transcript] Failed to save segment', i, err?.message || err);
        }
      }

      await dataStore.updateVideoResource(videoId, {
        transcript: transcriptText,
        transcript_segments: segments,
        has_subtitles: true,
        word_count: words.length,
        unique_word_count: uniqueWords.length,
        characters,
        is_roleplay_enabled: isRoleplayEnabled,
        default_user_character: defaultUserCharacter,
        total_segments: totalSegments,
        status: 'ready',
        failure_reason: null,
        language,
      });

      // Auto-calculate video difficulty based on transcript vocabulary
      await updateVideoDifficultyFromTranscript(videoId, segments);

      return sendJson(res, 200, {
        success: true,
        message: saveErrors ? `字幕导入完成，但有 ${saveErrors} 条保存失败` : '字幕导入成功',
        totalSegments,
      });
    } catch (err) {
      console.error('[Import Transcript] error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /recordings/video/:videoId - Delete all recordings for a video
  if (pathname.match(/^\/recordings\/video\/\d+$/) && req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const videoIdMatch = pathname.match(/^\/recordings\/video\/(\d+)$/);
      const videoId = parseInt(videoIdMatch[1], 10);

      if (!videoId || isNaN(videoId)) {
        return sendError(res, 400, '无效的视频ID');
      }

      // Build the recordings directory path for this video/user
      const videoRecordingsDir = path.join(RECORDINGS_DIR, `video-${videoId}`, `user-${user.id}`);

      console.log(`[删除录音] 用户 ${user.id} 请求删除视频 ${videoId} 的所有录音`);
      console.log(`[删除录音] 目录路径: ${videoRecordingsDir}`);

      // Check if directory exists
      let deletedCount = 0;
      try {
        const stats = await fsp.stat(videoRecordingsDir);
        if (stats.isDirectory()) {
          // List all files in the directory
          const files = await fsp.readdir(videoRecordingsDir);

          // Delete each file
          for (const file of files) {
            const filePath = path.join(videoRecordingsDir, file);
            try {
              await fsp.unlink(filePath);
              deletedCount++;
              console.log(`[删除录音] 已删除: ${file}`);
            } catch (err) {
              console.error(`[删除录音] 删除文件失败: ${file}`, err);
            }
          }

          // Try to remove the empty directory
          try {
            await fsp.rmdir(videoRecordingsDir);
            console.log(`[删除录音] 已删除空目录: ${videoRecordingsDir}`);
          } catch (err) {
            console.warn(`[删除录音] 无法删除目录（可能不为空）: ${err.message}`);
          }
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`[删除录音] 录音目录不存在，视为已清除`);
        } else {
          throw err;
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: `成功删除 ${deletedCount} 个录音文件`,
        deletedCount,
      });
    } catch (err) {
      console.error('[删除录音] 错误:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || '删除录音失败');
    }
  }

  // PATCH /video-resources/batch-order - Batch update video manual order (Admin only)
  if (pathname === '/video-resources/batch-order' && req.method === 'PATCH') {
    try {
      const user = await authenticate(req);

      // Only allow admin users to update video order
      if (!user.is_admin) {
        return sendError(res, 403, 'ADMIN_REQUIRED');
      }

      const body = await parseBody(req);
      const updates = body.updates; // Array of { id, manual_order }

      if (!Array.isArray(updates) || updates.length === 0) {
        return sendError(res, 400, 'updates array is required');
      }

      // Validate updates array
      for (const update of updates) {
        if (!update.id || typeof update.manual_order !== 'number') {
          return sendError(res, 400, 'Each update must have id and manual_order');
        }
      }

      // Execute batch update
      const results = [];
      for (const update of updates) {
        try {
          await dataStore.pool.query(
            'UPDATE video_resources SET manual_order = $1, updated_at = NOW() WHERE id = $2',
            [update.manual_order, update.id]
          );
          results.push({ id: update.id, success: true });
        } catch (err) {
          console.error(`[Batch Order] Failed to update video ${update.id}:`, err);
          results.push({ id: update.id, success: false, error: err.message });
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: `Updated ${results.filter(r => r.success).length} of ${results.length} videos`,
        results,
      });
    } catch (err) {
      console.error('[Batch Order] Error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to update video order');
    }
  }

  // POST /video-resources/:id/increment-view - Increment view count
  if (pathname.match(/^\/video-resources\/\d+\/increment-view$/) && req.method === 'POST') {
    try {
      const videoId = Number(pathname.split('/')[2]);
      if (!videoId) {
        return sendError(res, 400, 'Invalid video ID');
      }

      // Try to authenticate but allow guests
      let user = null;
      try {
        user = await authenticate(req);
      } catch (err) {
        // Allow unauthenticated users to increment view count
      }

      const resource = await dataStore.getVideoResourceById(videoId);
      if (!resource || !canAccessVideoResource(resource, user)) {
        return sendError(res, 404, 'Video not found');
      }

      // Increment view count
      if (typeof dataStore.init === 'function') {
        await dataStore.init();
      }
      if (typeof dataStore.dbUnavailable === 'function' && dataStore.dbUnavailable()) {
        throw new Error('DATASTORE_UNAVAILABLE');
      }
      const userCtx = await getUserContext(req);
      const timestamp = new Date().toISOString();
      if (dataStore.pool && typeof dataStore.pool.query === 'function') {
        await dataStore.pool.query(
          'UPDATE video_resources SET view_count = view_count + 1, updated_at = NOW() WHERE id = $1',
          [videoId]
        );
        console.log(`[${timestamp}] [Increment View] video=${videoId} user=${userCtx.label}`);
      } else {
        throw new Error('DATASTORE_UNAVAILABLE');
      }

      return sendJson(res, 200, { success: true, message: 'View count incremented' });
    } catch (err) {
      const ts = new Date().toISOString();
      const userCtx = await getUserContext(req);
      console.error(`[${ts}] [Increment View] Error for video=${pathname.split('/')[2] || 'unknown'} user=${userCtx.label}:`, err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to increment view count');
    }
  }

  // No route matched
  return false;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  registerVideoRoutes,
  // Export helpers for testing if needed
  serializeVideoResource,
  serializePracticeRecording,
  resolveSpeakersForVideo,
  extractWordsFromText,
  extractCharactersFromSegments,
};
