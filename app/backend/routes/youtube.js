const youtubeService = require('../services/youtube');
const videoTranscription = require('../services/video-transcription');
const dataStore = require('../data-store');
const fs = require('fs');
const path = require('path');
const os = require('os');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
};

/**
 * Send JSON response
 */
function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[YouTube Routes] Attempted to send response after stream closed');
    return false;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

/**
 * Send error response
 */
function sendError(res, status, message) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[YouTube Routes] Attempted to send error after stream closed');
    return false;
  }
  return sendJson(res, status, { success: false, error: message });
}

/**
 * Fetch transcript using YouTube APIs and fall back to local STT download+transcription.
 * Returns transcriptData and method used.
 */
async function fetchTranscriptWithFallback(url, videoId, language, infoForDuration) {
  let transcriptData = null;
  let transcriptMethod = 'youtube-api';

  try {
    console.log('[YouTube] Attempting to fetch transcript via YouTube API...');
    transcriptData = await youtubeService.getTranscript(url, language);
    console.log('[YouTube] Successfully fetched transcript via YouTube API');
    return { transcriptData, transcriptMethod };
  } catch (transcriptError) {
    console.log('[YouTube] YouTube API transcript failed:', transcriptError.message);
  }

  // Configuration for Whisper fallback
  const WHISPER_CONFIG = {
    enabled: process.env.WHISPER_FALLBACK_ENABLED !== 'false', // Default: enabled
    maxDurationMinutes: parseInt(process.env.WHISPER_MAX_DURATION_MINUTES) || 60, // Default: 60 minutes to allow longer videos
  };

  // Check if Whisper fallback is enabled
  if (!WHISPER_CONFIG.enabled) {
    throw new Error('No transcript available for this video. Whisper fallback is disabled.');
  }

  const info = infoForDuration;
  // Check video duration before attempting expensive Whisper transcription
  const durationMinutes = info.duration / 60;
  if (info.duration > WHISPER_CONFIG.maxDurationMinutes * 60) {
    throw new Error(
      `Video is too long for Whisper transcription (${durationMinutes.toFixed(1)} minutes). ` +
      `Maximum allowed: ${WHISPER_CONFIG.maxDurationMinutes} minutes. ` +
      `Please select a shorter video or one with official subtitles.`
    );
  }

  console.log('[YouTube] Attempting fallback: Download video and transcribe with local STT...');
  console.log(`[YouTube] Video duration: ${durationMinutes.toFixed(1)} minutes (within ${WHISPER_CONFIG.maxDurationMinutes} min limit)`);

  let videoPath = null;
  try {
    // Download video to temporary file
    videoPath = path.join(os.tmpdir(), `linglish-youtube-${videoId}-${Date.now()}.mp4`);
    console.log('[YouTube] Downloading video to:', videoPath);

    await youtubeService.downloadVideo(url, videoPath);
    console.log('[YouTube] Video downloaded successfully');

    // Transcribe using the same logic as local video uploads (config-driven provider)
    const targetLanguage = language === 'auto' ? 'en' : language;
    const configuredProvider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
    console.log('[YouTube] Starting video transcription with configured provider:', configuredProvider);

    const transcriptionResult = await videoTranscription.transcribeVideoFile(videoPath, {
      language: targetLanguage,
      // For longer videos, force chunking to avoid long single requests (e.g., Cloudflare 524)
      chunkThresholdMinutes: 5,
      chunkDurationMinutes: 5,
    });

    console.log('[YouTube] Local transcription completed');

    const rawSegments = Array.isArray(transcriptionResult.segments)
      ? transcriptionResult.segments
      : [];

    const normalizedSegments = rawSegments
      .map((seg, index) => {
        const text = typeof seg.text === 'string' ? seg.text.trim() : '';
        if (!text) return null;

        const startRaw = Number(seg.start ?? seg.startTime ?? seg.offset ?? 0);
        const endRaw = Number(
          seg.end ??
          seg.endTime ??
          (seg.duration != null ? startRaw + Number(seg.duration) : startRaw)
        );

        const start = Number.isFinite(startRaw) ? startRaw : 0;
        const end = Number.isFinite(endRaw) ? endRaw : start;

        return {
          index,
          text,
          start,
          end,
          speaker: seg.speaker || seg.spk || seg.speaker_id || null,
        };
      })
      .filter(Boolean);

    const transcriptText = (transcriptionResult.text || '').trim().length
      ? (transcriptionResult.text || '').trim()
      : normalizedSegments.map((seg) => seg.text).join(' ');

    // Convert transcription format to YouTube transcript format
    transcriptData = {
      success: true,
      transcript: transcriptText,
      segments: normalizedSegments,
      language: transcriptionResult.language || targetLanguage,
      source: `local-${transcriptionResult.provider || configuredProvider || 'stt'}`,
    };

    transcriptMethod = transcriptData.source;
    console.log('[YouTube] Successfully transcribed video using local STT fallback:', transcriptMethod);
    return { transcriptData, transcriptMethod };
  } catch (whisperError) {
    const fallbackMessage = whisperError.userMessage || whisperError.message || 'Unknown transcription error';
    console.error('[YouTube] Local transcription fallback also failed:', fallbackMessage);
    throw new Error(fallbackMessage);
  } finally {
    // Clean up temporary video file
    if (videoPath && fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        console.log('[YouTube] Cleaned up temporary video file');
      } catch (cleanupError) {
        console.warn('[YouTube] Failed to clean up temp file:', cleanupError.message);
      }
    }
  }
}

/**
 * Parse request body
 */
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (err) {
    return {};
  }
}

/**
 * Authenticate request
 */
async function authenticate(req) {
  const authService = require('../services/auth');
  const authHeader = req.headers['authorization'] || '';
  const [, token] = authHeader.split(' ');
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  return authService.requireUser(token);
}

/**
 * POST /youtube/info - Get YouTube video information
 */
async function getVideoInfo(req, res) {
  try {
    await authenticate(req);
    const body = await parseBody(req);
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return sendError(res, 400, 'YouTube URL is required');
    }

    if (!youtubeService.isValidYouTubeUrl(url)) {
      return sendError(res, 400, 'Invalid YouTube URL');
    }

    const info = await youtubeService.getVideoInfo(url);
    return sendJson(res, 200, info);
  } catch (error) {
    console.error('[YouTube] Get info error:', error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : 500;
    return sendError(res, status, error.message);
  }
}

/**
 * POST /youtube/transcript - Get YouTube video transcript
 */
async function getTranscript(req, res) {
  try {
    await authenticate(req);
    const body = await parseBody(req);
    const { url, language = 'en' } = body;

    if (!url || typeof url !== 'string') {
      return sendError(res, 400, 'YouTube URL is required');
    }

    if (!youtubeService.isValidYouTubeUrl(url)) {
      return sendError(res, 400, 'Invalid YouTube URL');
    }

    const transcript = await youtubeService.getTranscript(url, language);

    // Calculate word counts
    const words = youtubeService.extractWords(transcript.transcript);
    const wordCount = words.length;
    const uniqueWordCount = new Set(words).size;

    return sendJson(res, 200, {
      ...transcript,
      wordCount,
      uniqueWordCount,
    });
  } catch (error) {
    console.error('[YouTube] Get transcript error:', error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : 500;
    return sendError(res, status, error.message);
  }
}

/**
 * Score a transcript as A1–C2. Persists the level when videoId is set.
 * A missing dictionary still leaves a structure-based level.
 */
async function applyAutoDifficulty(videoId, transcriptData) {
  try {
    const vocabularyV2 = require('../services/vocabulary-v2');
    const payload = Array.isArray(transcriptData?.segments) && transcriptData.segments.length
      ? transcriptData.segments
      : transcriptData?.transcript;
    const result = await vocabularyV2.calculateVideoDifficulty(payload);
    if (result?.difficulty && videoId != null) {
      await dataStore.updateVideoResource(videoId, { difficulty_level: result.difficulty });
      console.log(`[YouTube] Auto level ${result.difficulty} for video ${videoId} via ${result.source}`);
    }
    return result;
  } catch (err) {
    console.warn('[YouTube] Auto level failed:', err.message);
    return null;
  }
}

/**
 * POST /youtube/import - Import YouTube video (save to database)
 * This creates a permanent video resource with YouTube source
 */
async function importVideo(req, res) {
  try {
    const user = await authenticate(req);
    const body = await parseBody(req);
    const { url, language = 'en', mode = 'permanent' } = body;

    if (!url || typeof url !== 'string') {
      return sendError(res, 400, 'YouTube URL is required');
    }

    if (!youtubeService.isValidYouTubeUrl(url)) {
      return sendError(res, 400, 'Invalid YouTube URL');
    }

    const videoId = youtubeService.extractVideoId(url);

    // Check if video already imported by this user
    const existing = await dataStore.pool.query(
      `SELECT id FROM video_resources
       WHERE youtube_video_id = $1 AND uploader_id = $2 AND video_type = 'youtube'`,
      [videoId, user.id]
    );

    if (existing.rows.length > 0) {
      return sendJson(res, 200, {
        success: true,
        message: 'Video already imported',
        alreadyExists: true,
        video: { id: existing.rows[0].id },
      });
    }

    // Get video info
    console.log('[YouTube] Fetching video info for:', url);
    const info = await youtubeService.getVideoInfo(url);

    const collectionName = (() => {
      try {
        const raw = (body.collection_name ?? body.collection ?? body.series ?? '').toString().trim();
        if (!raw) return null;
        return raw.slice(0, 120);
      } catch (_) {
        return null;
      }
    })();

    // 难度不接受导入时手填。字幕拿到后由 applyAutoDifficulty 写入 A1–C2。

    // 全局标签 ID：规范化为正整数，校验存在且 scope = 'global'；非法 ID 静默丢弃并记录日志
    let globalTagIds = [];
    if (Array.isArray(body.tags) && body.tags.length > 0) {
      const requested = Array.from(new Set(
        body.tags
          .map(t => Number(String(t).trim()))
          .filter(n => Number.isInteger(n) && n > 0)
      ));
      if (requested.length > 0) {
        const { rows: validTags } = await dataStore.pool.query(
          `SELECT id FROM tags WHERE scope = 'global' AND id = ANY($1::bigint[])`,
          [requested]
        );
        globalTagIds = validTags.map(r => Number(r.id));
        const dropped = requested.filter(id => !globalTagIds.includes(id));
        if (dropped.length > 0) {
          console.warn('[YouTube] Dropping invalid tag ids on import:', dropped);
        }
      }
    }

    // Create video resource first, then transcribe in background (non-blocking for user)
    const resource = await dataStore.createVideoResource({
      uploader_id: user.id,
      title: info.title,
      description: info.description || '',
      video_path: url, // Store YouTube URL as video path
      thumbnail_path: info.thumbnail,
      duration_sec: info.duration,
      status: 'processing', // Will be updated after transcription
      failure_reason: null,
      video_type: 'youtube',
      youtube_video_id: videoId,
      subtitle_language: language,
      is_public: mode === 'permanent', // Temporary videos are private
      collection_name: collectionName,
      difficulty_level: null,
      transcript: null,
      transcript_segments: null,
      has_subtitles: false,
      word_count: 0,
      unique_word_count: 0,
    });

    console.log('[YouTube] Video resource created with ID:', resource.id, 'status: processing');

    // 写入全局标签指派（与 POST /videos/:id/tags 全局路径一致）。
    // 失败则删除刚创建的视频行并整体报错——禁止留下孤儿视频行，
    // 否则用户重试会命中查重，误报"该视频已经在视频库中"。
    if (globalTagIds.length > 0) {
      try {
        for (const tagId of globalTagIds) {
          await dataStore.pool.query(
            `INSERT INTO video_tags(video_id, tag_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [resource.id, tagId, user.id]
          );
        }
      } catch (tagErr) {
        console.error('[YouTube] Tag assignment failed, rolling back video:', resource.id, tagErr.message);
        try {
          await dataStore.deleteVideoResource(resource.id);
        } catch (delErr) {
          console.error('[YouTube] Rollback delete failed for video:', resource.id, delErr.message);
        }
        return sendError(res, 500, 'Failed to save video tags, import aborted');
      }
    }

    // Start transcript job in background
    setImmediate(async () => {
      const startTime = Date.now();
      let hasSubtitles = false;
      let failureReason = null;
      try {
        console.log('[YouTube] (BG) Fetching transcript for video:', resource.id);
        const { transcriptData } = await fetchTranscriptWithFallback(url, videoId, language, info);

        // Calculate word counts
        const words = youtubeService.extractWords(transcriptData.transcript);
        const wordCount = words.length;
        const uniqueWordCount = new Set(words).size;
        hasSubtitles = true;

        console.log('[YouTube] (BG) Transcript fetched successfully:', transcriptData.segments.length, 'segments');

        await dataStore.updateVideoResource(resource.id, {
          transcript: transcriptData.transcript,
          transcript_segments: transcriptData.segments,
          has_subtitles: hasSubtitles,
          word_count: wordCount,
          unique_word_count: uniqueWordCount,
          status: 'completed',
          failure_reason: null,
        });

        await applyAutoDifficulty(resource.id, transcriptData);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('[YouTube] (BG) Transcript job completed for video:', resource.id, 'in', duration, 'seconds');
      } catch (error) {
        failureReason = `No subtitles: ${error.message}`;
        console.error('[YouTube] (BG) Failed to fetch transcript for video', resource.id, ':', error.message);
        try {
          await dataStore.updateVideoResource(resource.id, {
            status: 'completed_no_subtitles',
            failure_reason: failureReason,
            has_subtitles: false,
          });
        } catch (updateErr) {
          console.warn('[YouTube] (BG) Failed to update video status:', updateErr.message);
        }
      }
    });

    return sendJson(res, 200, {
      success: true,
      message: 'YouTube video imported. Transcript is processing in background.',
      alreadyExists: false,
      video: {
        id: resource.id,
        title: resource.title,
        description: resource.description,
        youtube_url: url,
        youtube_video_id: videoId,
        status: 'processing',
        has_subtitles: false,
        mode,
      },
    });
  } catch (error) {
    console.error('[YouTube] Import error:', error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : 500;
    return sendError(res, status, error.message);
  }
}

/**
 * POST /youtube/session - Create temporary YouTube session
 * Returns video info and transcript without saving to database
 */
async function createTempSession(req, res) {
  try {
    await authenticate(req);
    const body = await parseBody(req);
    const { url, language = 'en' } = body;

    if (!url || typeof url !== 'string') {
      return sendError(res, 400, 'YouTube URL is required');
    }

    if (!youtubeService.isValidYouTubeUrl(url)) {
      return sendError(res, 400, 'Invalid YouTube URL');
    }

    const videoId = youtubeService.extractVideoId(url);

    // Get video info
    console.log('[YouTube] Creating temp session for:', url);
    const info = await youtubeService.getVideoInfo(url);

    const { transcriptData } = await fetchTranscriptWithFallback(url, videoId, language, info);

    // Calculate word counts
    const words = youtubeService.extractWords(transcriptData.transcript);
    const wordCount = words.length;
    const uniqueWordCount = new Set(words).size;
    const classified = await applyAutoDifficulty(null, transcriptData);

    return sendJson(res, 200, {
      success: true,
      session: {
        youtube_url: url,
        youtube_video_id: videoId,
        title: info.title,
        description: info.description,
        duration: info.duration,
        thumbnail: info.thumbnail,
        transcript: transcriptData.transcript,
        segments: transcriptData.segments,
        language: transcriptData.language,
        wordCount,
        uniqueWordCount,
        difficulty_level: classified?.difficulty || null,
        mode: 'temporary',
      },
    });
  } catch (error) {
    console.error('[YouTube] Create temp session error:', error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : 500;
    return sendError(res, status, error.message);
  }
}

/**
 * Register YouTube routes
 */
async function registerYouTubeRoutes(pathname, req, res) {
  if (pathname === '/youtube/info' && req.method === 'POST') {
    return await getVideoInfo(req, res);
  }

  if (pathname === '/youtube/transcript' && req.method === 'POST') {
    return await getTranscript(req, res);
  }

  if (pathname === '/youtube/import' && req.method === 'POST') {
    return await importVideo(req, res);
  }

  if (pathname === '/youtube/session' && req.method === 'POST') {
    return await createTempSession(req, res);
  }

  return false;
}

module.exports = {
  registerYouTubeRoutes,
  getVideoInfo,
  getTranscript,
  importVideo,
  createTempSession,
};
