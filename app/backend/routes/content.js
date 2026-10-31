const { URL } = require('url');
const crypto = require('crypto');
const path = require('path');
const dataStore = require('../data-store');
const dictionaryService = require('../services/dictionary');
const videoTranscriptionService = require('../services/video-transcription');
const { parseBody } = require('../utils/parsers');
const { convertAudioToWav } = require('../utils/audio-utils');
const { removeFileSafe } = require('../utils/file-utils');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { handleFileUpload, cleanupFile } = require('../upload-handler');
const sentenceSegments = require('../../frontend/js/video-reader/sentence-segments');
const firstLessonProgress = require('../../frontend/js/video-reader/first-lesson-progress');

// Constants for speaker resolution
const FALLBACK_SPEAKER_NAMES = ['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4'];
const CONTINUATION_PREFIXES = [
  'and',
  'then',
  'also',
  'but',
  'so',
  'because',
  'when',
  'while',
  'after',
  'before',
  'if',
  'well',
  'umm',
  'uh',
];
const REPLY_LEXICON = /^(sure|okay|alright|of course|no problem|thanks|thank you|you're welcome|yes|no|absolutely|definitely|certainly|please)\b/i;

/**
 * Tokenize sentence into words
 */
function tokenizeSentence(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Compute word-level similarity between reference and hypothesis using edit distance
 */
function computeWordSimilarity(reference, hypothesis) {
  const refTokens = tokenizeSentence(reference);
  const hypTokens = tokenizeSentence(hypothesis);
  if (!refTokens.length && !hypTokens.length) return 1;
  if (!refTokens.length || !hypTokens.length) return 0;

  const m = refTokens.length;
  const n = hypTokens.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : Math.max(0, 1 - distance / maxLen);
}

function parseSourceIndices(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { return null; }
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const normalized = Array.from(new Set(parsed.map(Number)))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => left - right);
  return normalized.length === parsed.length ? normalized : null;
}

function sameIndices(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function resolveExactPracticeTarget(videoId, rawSegments, stableSegmentId, sourceIndices, displayIndex) {
  const requestedId = String(stableSegmentId || '').trim();
  const requestedSources = parseSourceIndices(sourceIndices);
  const requestedDisplayIndex = Number(displayIndex);
  if (!requestedId || !requestedSources) return null;
  const displayed = sentenceSegments.toDisplayedSentences(rawSegments);
  for (let index = 0; index < displayed.length; index += 1) {
    if (Number.isInteger(requestedDisplayIndex) && requestedDisplayIndex >= 0 && index !== requestedDisplayIndex) continue;
    const segment = displayed[index];
    const sources = parseSourceIndices(segment.source_indices);
    if (!sameIndices(sources, requestedSources)) continue;
    if (firstLessonProgress.stableSegmentId(videoId, segment, index) === requestedId) {
      return { segment, stableSegmentId: requestedId, sourceIndices: sources };
    }
  }
  return null;
}

/**
 * Extract speaker from inline text (e.g., "John: hello" or "[John] hello")
 */
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

/**
 * Determine if speaker should change based on segment content
 */
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

/**
 * Assign fallback speaker names to segments based on content heuristics
 */
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

/**
 * Derive speaker label from raw speaker name or index
 */
function deriveSpeakerLabel(rawSpeaker, fallbackIndex) {
  if (rawSpeaker && typeof rawSpeaker === 'string' && rawSpeaker.trim()) {
    return rawSpeaker.trim();
  }
  if (Number.isFinite(rawSpeaker)) {
    return `Speaker ${Number(rawSpeaker)}`;
  }
  return `Speaker ${fallbackIndex + 1}`;
}

/**
 * Resolve speakers from video transcript segments
 */
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

/**
 * Register and handle content-related routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerContentRoutes(pathname, req, res) {
  // Parse URL for query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /articles/:id
  const articleMatch = pathname.match(/^\/articles\/(\d+)$/);
  if (articleMatch && req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await optionalAuth(req);
      const article = await dataStore.getArticleById(Number(articleMatch[1]), user);
      if (!article) return sendError(res, 404, '找不到这篇内容');
      return sendJson(res, 200, article);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /articles
  if (pathname === '/articles' && req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await optionalAuth(req);
      const articles = await dataStore.getArticles(user);
      const payload = { items: articles };
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /media
  if (pathname === '/media' && req.method === 'GET') {
    try {
      const articleId = url.searchParams.get('article_id')
        ? Number(url.searchParams.get('article_id'))
        : null;
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await optionalAuth(req);
      const items = await dataStore.getMediaByArticle(articleId, user);
      const payload = { items };
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /segments
  if (pathname === '/segments' && req.method === 'GET') {
    try {
      const mediaId = url.searchParams.get('media_id')
        ? Number(url.searchParams.get('media_id'))
        : null;
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await optionalAuth(req);
      const items = await dataStore.getSegmentsByMedia(mediaId, user);
      const payload = { items };
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /practice/speakers
  if (pathname === '/practice/speakers' && req.method === 'GET') {
    try {
      await authenticate(req);
      const videoId = Number(url.searchParams.get('videoId'));
      if (!Number.isFinite(videoId)) {
        return sendError(res, 400, 'videoId is required');
      }

      const { speakers } = await resolveSpeakersForVideo(videoId);
      return sendJson(res, 200, { speakers });
    } catch (err) {
      const status = err.statusCode || (err.message === 'UNAUTHORIZED' ? 401 : 500);
      return sendError(res, status, err.message);
    }
  }

  // POST /practice/evaluate
  if (pathname === '/practice/evaluate' && req.method === 'POST') {
    let uploadedPath = null;
    let wavPath = null;
    try {
      const user = await authenticate(req);
      const { files, fields } = await handleFileUpload(req);

      if (!files.audio) {
        return sendError(res, 400, 'Audio file is required');
      }

      uploadedPath = files.audio.path;
      const videoId = Number(fields.videoId);
      const segmentIndex = Number(fields.segmentIndex);
      const requestedStableSegmentId = String(fields.stableSegmentId || '').trim();
      const requestedSourceIndices = fields.sourceIndices;
      const exactIdentityRequested = Boolean(requestedStableSegmentId || requestedSourceIndices);

      if (!Number.isFinite(videoId) || (!exactIdentityRequested && !Number.isFinite(segmentIndex))) {
        return sendError(res, 400, 'videoId and segment identity are required');
      }

      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }

      let segmentsRaw = video.transcript_segments;
      if (typeof segmentsRaw === 'string') {
        try {
          segmentsRaw = JSON.parse(segmentsRaw);
        } catch (err) {
          segmentsRaw = [];
        }
      }
      if (!Array.isArray(segmentsRaw)) segmentsRaw = [];

      let exactTarget = null;
      let targetSegment = null;
      if (exactIdentityRequested) {
        exactTarget = resolveExactPracticeTarget(
          videoId,
          segmentsRaw,
          requestedStableSegmentId,
          requestedSourceIndices,
          segmentIndex,
        );
        if (!exactTarget) return sendError(res, 409, 'Displayed sentence identity is stale or invalid');
        targetSegment = exactTarget.segment;
      } else {
        targetSegment = segmentsRaw.find((segment) => {
          const idx = segment?.index != null ? Number(segment.index) : null;
          return idx === segmentIndex;
        }) || segmentsRaw[segmentIndex];
      }

      if (!targetSegment || !targetSegment.text) {
        return sendError(res, 404, 'Target line not found');
      }

      const targetText = targetSegment.text;

      wavPath = await convertAudioToWav(uploadedPath, 16000);

      const transcription = await videoTranscriptionService.transcribeVideoFile(wavPath, {
        provider: 'custom',
        output: 'json',
        language: 'en',
        languageParam: 'language',
      });

      const recognizedText = (transcription && transcription.text) || '';
      const similarity = computeWordSimilarity(targetText, recognizedText);
      const success = similarity >= 0.85;

      return sendJson(res, 200, {
        assessment_id: crypto.randomUUID(),
        success,
        similarity,
        recognizedText,
        targetText,
        stableSegmentId: exactTarget ? exactTarget.stableSegmentId : null,
        sourceIndices: exactTarget ? exactTarget.sourceIndices : null,
      });
    } catch (err) {
      console.error('Practice evaluation error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    } finally {
      if (uploadedPath) {
        await cleanupFile(uploadedPath);
      }
      if (wavPath) {
        await cleanupFile(wavPath);
      }
    }
  }

  // GET /video-role-profiles
  if (pathname === '/video-role-profiles' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const videoId = Number(url.searchParams.get('video_id') || url.searchParams.get('videoId'));
      if (!Number.isFinite(videoId)) {
        return sendError(res, 400, 'video_id is required');
      }
      const row = await dataStore.getVideoRoleProfileEffective(videoId, user.id);
      return sendJson(res, 200, { profile: row || null });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to load');
    }
  }

  // PUT /video-role-profiles
  if (pathname === '/video-role-profiles' && req.method === 'PUT') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const videoId = Number(body?.video_resource_id || body?.videoId);
      if (!Number.isFinite(videoId)) {
        return sendError(res, 400, 'video_resource_id is required');
      }
      const scope = (body?.scope === 'global') ? 'global' : 'user';
      if (scope === 'global' && !user.is_admin) {
        return sendError(res, 403, 'FORBIDDEN');
      }
      const payload = {
        video_resource_id: videoId,
        user_id: user.id,
        scope,
        role_count: body?.role_count,
        role_rotation: body?.role_rotation,
        role_names: Array.isArray(body?.role_names) ? body.role_names : [],
        overrides: body?.overrides || null,
        infer_mode: body?.infer_mode || 'content_aware',
        max_consecutive: body?.max_consecutive == null ? null : Number(body.max_consecutive),
      };
      const saved = await dataStore.upsertVideoRoleProfile(payload);
      return sendJson(res, 200, { profile: saved });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to save');
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerContentRoutes };
