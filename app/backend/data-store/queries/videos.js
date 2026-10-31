const path = require('path');
const fs = require('fs/promises');
const { pool, init, dbUnavailable } = require('../core');

const PUBLIC_VIDEO_DIR = path.join(__dirname, '../../public', 'videos');

let fallbackVideoCache = null;

// PostgreSQL INTEGER max value
const MAX_INTEGER = 2147483647;

async function loadFallbackVideos() {
  if (fallbackVideoCache) return fallbackVideoCache;
  try {
    const entries = await fs.readdir(PUBLIC_VIDEO_DIR);
    const items = [];
    let autoId = 1000001; // Start from 1000001 for fallback IDs to avoid conflicts
    for (const entry of entries) {
      const absPath = path.join(PUBLIC_VIDEO_DIR, entry);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const baseName = entry.replace(/\.[^.]+$/, '');
      const idMatch = entry.match(/^(\d{4,})/);
      let derivedId = idMatch ? Number.parseInt(idMatch[1], 10) : autoId++;
      // Ensure ID doesn't exceed PostgreSQL INTEGER max
      if (derivedId > MAX_INTEGER) {
        derivedId = autoId++;
      }
      items.push({
        id: derivedId,
        uploader_id: null,
        title: baseName,
        description: '本地上传视频',
        video_path: `/videos/${entry}`,
        original_filename: entry,
        transcript: null,
        transcript_segments: [],
        language: 'en',
        duration_sec: null,
        status: 'ready',
        failure_reason: null,
        collection_name: null,
        created_at: stat.birthtime ? stat.birthtime.toISOString() : null,
        updated_at: stat.mtime ? stat.mtime.toISOString() : null,
      });
    }
    items.sort((a, b) => {
      const aTime = a.updated_at ? Date.parse(a.updated_at) : 0;
      const bTime = b.updated_at ? Date.parse(b.updated_at) : 0;
      return bTime - aTime;
    });
    fallbackVideoCache = items;
    return fallbackVideoCache;
  } catch (err) {
    console.warn('[DataStore] Failed to load fallback videos:', err.message);
    fallbackVideoCache = [];
    return fallbackVideoCache;
  }
}

async function createVideoResource(payload) {
  await init();
  const {
    uploader_id = null,
    title,
    description = null,
    video_path,
    thumbnail_path = null,
    original_filename = null,
    duration_sec = null,
    status = 'processing',
    failure_reason = null,
    // File information
    file_size = null,
    mime_type = null,
    file_hash = null,
    // Content classification
    tags = [],
    category = null,
    collection_name = null,
    difficulty_level = null,
    is_public = false,
    // Learning-related
    subtitle_language = null,
    // YouTube-related
    video_type = 'local',
    youtube_video_id = null,
    transcript = null,
    transcript_segments = null,
    has_subtitles = false,
    word_count = 0,
    unique_word_count = 0,
  } = payload;

  const { rows } = await pool.query(
    `INSERT INTO video_resources
       (uploader_id, title, description, video_path, thumbnail_path, original_filename, duration_sec, status, failure_reason,
        file_size, mime_type, file_hash, tags, category, collection_name, difficulty_level, is_public, subtitle_language,
        video_type, youtube_video_id, transcript, transcript_segments, has_subtitles, word_count, unique_word_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
     RETURNING *`,
    [uploader_id, title, description, video_path, thumbnail_path, original_filename, duration_sec, status, failure_reason,
     file_size, mime_type, file_hash, JSON.stringify(tags), category, collection_name, difficulty_level, is_public, subtitle_language,
     video_type, youtube_video_id, transcript,
     transcript_segments ? JSON.stringify(transcript_segments) : null,
     has_subtitles, word_count, unique_word_count],
  );

  return rows[0];
}

async function createVideoShareRequest(payload) {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }

  const {
    requesterId,
    videoResourceId,
    requestType = 'public',
    note = null,
  } = payload;

  const existing = await pool.query(
    `SELECT *
     FROM video_share_requests
     WHERE requester_id = $1
       AND video_resource_id = $2
       AND request_type = $3
       AND status = 'pending'
     LIMIT 1`,
    [requesterId, videoResourceId, requestType],
  );
  if (existing.rows[0]) {
    return { ...existing.rows[0], already_pending: true };
  }

  const { rows } = await pool.query(
    `INSERT INTO video_share_requests
       (requester_id, video_resource_id, request_type, note)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [requesterId, videoResourceId, requestType, note],
  );

  return rows[0] || null;
}

async function getVideoShareRequestById(id) {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }

  const { rows } = await pool.query(
    `SELECT
       vsr.*,
       requester.username AS requester_username,
       requester.email AS requester_email,
       reviewer.username AS reviewer_username,
       vr.title AS video_title,
       vr.uploader_id,
       vr.is_public,
       vr.is_featured
     FROM video_share_requests vsr
     LEFT JOIN users requester ON requester.id = vsr.requester_id
     LEFT JOIN users reviewer ON reviewer.id = vsr.reviewer_id
     LEFT JOIN video_resources vr ON vr.id = vsr.video_resource_id
     WHERE vsr.id = $1
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function listVideoShareRequests(filters = {}) {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }

  const {
    status = 'pending',
    requestType = null,
    requesterId = null,
    videoResourceId = null,
    limit = 50,
    offset = 0,
  } = filters;

  const clauses = [];
  const values = [];
  let idx = 1;

  if (status && status !== 'all') {
    clauses.push(`vsr.status = $${idx++}`);
    values.push(status);
  }
  if (requestType) {
    clauses.push(`vsr.request_type = $${idx++}`);
    values.push(requestType);
  }
  if (requesterId) {
    clauses.push(`vsr.requester_id = $${idx++}`);
    values.push(requesterId);
  }
  if (videoResourceId) {
    clauses.push(`vsr.video_resource_id = $${idx++}`);
    values.push(videoResourceId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.max(1, Math.min(100, Number(limit) || 50)));
  values.push(Math.max(0, Number(offset) || 0));

  const { rows } = await pool.query(
    `SELECT
       vsr.*,
       requester.username AS requester_username,
       requester.email AS requester_email,
       reviewer.username AS reviewer_username,
       vr.title AS video_title,
       vr.uploader_id,
       vr.is_public,
       vr.is_featured
     FROM video_share_requests vsr
     LEFT JOIN users requester ON requester.id = vsr.requester_id
     LEFT JOIN users reviewer ON reviewer.id = vsr.reviewer_id
     LEFT JOIN video_resources vr ON vr.id = vsr.video_resource_id
     ${where}
     ORDER BY
       CASE vsr.status WHEN 'pending' THEN 0 ELSE 1 END,
       vsr.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  return rows;
}

async function getVideoShareRequestSummary() {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
       COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE status = 'pending' AND request_type = 'public')::int AS public_pending,
       COUNT(*) FILTER (WHERE status = 'pending' AND request_type = 'featured')::int AS featured_pending
     FROM video_share_requests`,
  );
  const summary = rows[0] || {};
  return {
    total: Number(summary.total) || 0,
    pending: Number(summary.pending) || 0,
    approved: Number(summary.approved) || 0,
    rejected: Number(summary.rejected) || 0,
    cancelled: Number(summary.cancelled) || 0,
    public_pending: Number(summary.public_pending) || 0,
    featured_pending: Number(summary.featured_pending) || 0,
  };
}

async function updateVideoShareRequestReview(id, payload) {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }

  const {
    status,
    reviewerId,
    reviewNote = null,
  } = payload;

  const { rows } = await pool.query(
    `UPDATE video_share_requests
     SET status = $2,
         reviewer_id = $3,
         review_note = $4,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, reviewerId, reviewNote],
  );
  return rows[0] || null;
}

async function updateVideoResource(id, updates) {
  await init();

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'undefined') {
      continue;
    }

    let storedValue = value;
    // Handle JSONB fields
    if (['transcript_segments', 'tags', 'characters'].includes(key) && value != null) {
      storedValue = JSON.stringify(value);
    }

    fields.push(`${key} = $${idx++}`);
    values.push(storedValue);
  }

  fields.push(`updated_at = NOW()`);

  values.push(id);

  const sql = `
    UPDATE video_resources
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `;

  const { rows } = await pool.query(sql, values);

  return rows[0] || null;
}

async function getVideoResourceById(id) {
  await init();
  // Validate ID is within PostgreSQL INTEGER range
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0 || numId > MAX_INTEGER) {
    console.warn(`[DataStore] Invalid video ID: ${id} (out of INTEGER range or invalid)`);
    return null;
  }
  if (dbUnavailable()) {
    const fallback = await loadFallbackVideos();
    return fallback.find((item) => String(item.id) === String(id)) || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM video_resources WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function getVideoResourceByPath(videoPath) {
  await init();
  if (dbUnavailable()) {
    const fallback = await loadFallbackVideos();
    return fallback.find((item) => item.video_path === videoPath) || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM video_resources WHERE video_path = $1 LIMIT 1`,
    [videoPath],
  );
  return rows[0] || null;
}

async function getVideoResourceByFileHash(fileHash) {
  await init();
  if (!fileHash) return null;
  if (dbUnavailable()) {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM video_resources WHERE file_hash = $1 LIMIT 1`,
    [fileHash],
  );
  return rows[0] || null;
}

async function listVideoResources() {
  await init();
  if (dbUnavailable()) {
    return loadFallbackVideos();
  }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM video_resources
       ORDER BY manual_order NULLS LAST, view_count DESC, created_at DESC`,
    );
    return rows;
  } catch (err) {
    console.warn('[DataStore] listVideoResources fallback due to error:', err.message);
    return loadFallbackVideos();
  }
}

async function listVideoResourcesLite() {
  await init();
  if (dbUnavailable()) {
    return loadFallbackVideos();
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, uploader_id, title, description, video_path, youtube_video_id, thumbnail_path,
              original_filename, language, duration_sec, status, failure_reason,
              tags, category, collection_name, difficulty_level, is_public,
              view_count, practice_count, subtitle_language, has_subtitles,
              word_count, unique_word_count, characters, is_roleplay_enabled,
              default_user_character, total_segments, local_video_path, local_video_status,
              created_at, updated_at, manual_order, is_vip_only, is_featured
       FROM video_resources
       ORDER BY manual_order NULLS LAST, view_count DESC, created_at DESC`,
    );
    return rows;
  } catch (err) {
    console.warn('[DataStore] listVideoResourcesLite fallback due to error:', err.message);
    return loadFallbackVideos();
  }
}

// List videos uploaded by a specific user
async function listVideoResourcesByUploader(userId) {
  await init();
  if (dbUnavailable()) {
    // Fallback filter when DB unavailable
    const all = await loadFallbackVideos();
    return all.filter(v => String(v.uploader_id) === String(userId));
  }
  const { rows } = await pool.query(
    `SELECT * FROM video_resources WHERE uploader_id = $1
     ORDER BY manual_order NULLS LAST, view_count DESC, created_at DESC`,
    [userId]
  );
  return rows;
}

async function listVideoResourcesByUploaderLite(userId) {
  await init();
  if (dbUnavailable()) {
    const all = await loadFallbackVideos();
    return all.filter(v => String(v.uploader_id) === String(userId));
  }
  const { rows } = await pool.query(
    `SELECT id, uploader_id, title, description, video_path, youtube_video_id, thumbnail_path,
            original_filename, language, duration_sec, status, failure_reason,
            tags, category, collection_name, difficulty_level, is_public,
            view_count, practice_count, subtitle_language, has_subtitles,
            word_count, unique_word_count, characters, is_roleplay_enabled,
            default_user_character, total_segments, local_video_path, local_video_status,
            created_at, updated_at, manual_order, is_vip_only, is_featured
     FROM video_resources
     WHERE uploader_id = $1
     ORDER BY manual_order NULLS LAST, view_count DESC, created_at DESC`,
    [userId]
  );
  return rows;
}

async function getDifficultyStats() {
  await init();
  if (dbUnavailable()) {
    return { a1: 0, a2: 0, b1: 0, b2: 0, c1: 0, c2: 0, unset: 0 };
  }
  const { rows } = await pool.query(
    `SELECT difficulty_level, COUNT(*)::int AS count
     FROM video_resources
     GROUP BY difficulty_level`
  );
  const legacy = { beginner: 'a1', intermediate: 'b1', advanced: 'c1' };
  const stats = { a1: 0, a2: 0, b1: 0, b2: 0, c1: 0, c2: 0, unset: 0 };
  for (const row of rows) {
    const raw = String(row.difficulty_level || '').trim().toLowerCase();
    const key = legacy[raw] || raw;
    if (Object.prototype.hasOwnProperty.call(stats, key)) {
      stats[key] += row.count;
    } else {
      stats.unset += row.count;
    }
  }
  return stats;
}

// Count videos uploaded by a specific user
async function countVideoResourcesByUploader(userId) {
  await init();
  if (dbUnavailable()) {
    const all = await loadFallbackVideos();
    return all.filter(v => String(v.uploader_id) === String(userId)).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM video_resources WHERE uploader_id = $1`,
    [userId]
  );
  return rows?.[0]?.c || 0;
}

// List all video resources with user information (for admin)
async function listVideoResourcesWithUserInfo() {
  await init();
  if (dbUnavailable()) {
    return loadFallbackVideos();
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        vr.*,
        u.username,
        u.email,
        (
          SELECT jsonb_agg(t.name ORDER BY t.id)
          FROM video_tags vt
          JOIN tags t ON t.id = vt.tag_id
          WHERE vt.video_id = vr.id
        ) AS tags_joined
      FROM video_resources vr
      LEFT JOIN users u ON vr.uploader_id = u.id
      ORDER BY vr.manual_order NULLS LAST, vr.view_count DESC, vr.created_at DESC
    `);
    return rows;
  } catch (err) {
    console.warn('[DataStore] listVideoResourcesWithUserInfo fallback due to error:', err.message);
    return loadFallbackVideos();
  }
}

async function deleteVideoResource(id) {
  await init();
  if (dbUnavailable()) {
    return null;
  }
  const { rows } = await pool.query(
    `DELETE FROM video_resources WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function getArticles() {
  await init();
  const { rows } = await pool.query(
    `SELECT id, title, content, level, tags, audio_url, word_count, difficulty_score, source_type, pdf_path
     FROM articles
     ORDER BY id ASC`,
  );
  return rows;
}

async function getArticleById(id) {
  await init();
  const { rows } = await pool.query(
    `SELECT * FROM articles WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function deleteArticle(id) {
  await init();
  const { rows } = await pool.query(
    `DELETE FROM articles WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function getMediaByArticle(articleId) {
  await init();
  if (articleId) {
    const { rows } = await pool.query(
      `SELECT id, article_id, kind, url, duration_sec
       FROM media_assets
       WHERE article_id = $1
       ORDER BY id ASC`,
      [articleId],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, article_id, kind, url, duration_sec
     FROM media_assets
     ORDER BY id ASC`,
  );
  return rows;
}

async function getSegmentsByMedia(mediaId) {
  await init();
  if (mediaId) {
    const { rows } = await pool.query(
      `SELECT id, media_id, start_ms, end_ms, text
       FROM audio_segments
       WHERE media_id = $1
       ORDER BY start_ms ASC`,
      [mediaId],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, media_id, start_ms, end_ms, text
     FROM audio_segments
     ORDER BY media_id ASC, start_ms ASC`,
  );
  return rows;
}

async function getOcrCache(pdfFingerprint, pageNumber) {
  await init();
  const { rows } = await pool.query(
    'SELECT * FROM pdf_ocr_cache WHERE pdf_fingerprint = $1 AND page_number = $2 LIMIT 1',
    [pdfFingerprint, pageNumber]
  );
  return rows[0] || null;
}

async function saveOcrCache(payload) {
  await init();
  const { pdfFingerprint, pageNumber, ocrText, confidence, wordPositions } = payload;
  const { rows } = await pool.query(
    `INSERT INTO pdf_ocr_cache (pdf_fingerprint, page_number, ocr_text, confidence, word_positions)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (pdf_fingerprint, page_number)
     DO UPDATE SET ocr_text = EXCLUDED.ocr_text,
                   confidence = EXCLUDED.confidence,
                   word_positions = EXCLUDED.word_positions,
                   created_at = NOW()
     RETURNING *`,
    [pdfFingerprint, pageNumber, ocrText, confidence, JSON.stringify(wordPositions)]
  );
  return rows[0];
}

// Video sentences (transcript segments)
async function createVideoSentence(payload) {
  await init();
  const {
    video_id,
    sentence_index,
    text,
    start_time_sec,
    end_time_sec,
    speaker = null,
  } = payload;

  const { rows } = await pool.query(
    `INSERT INTO video_sentences
       (video_id, sentence_index, text, start_time_sec, end_time_sec, speaker)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (video_id, sentence_index)
     DO UPDATE SET
       text = EXCLUDED.text,
       start_time_sec = EXCLUDED.start_time_sec,
       end_time_sec = EXCLUDED.end_time_sec,
       speaker = EXCLUDED.speaker
     RETURNING *`,
    [video_id, sentence_index, text, start_time_sec, end_time_sec, speaker]
  );

  return rows[0];
}

async function getVideoSentences(videoId) {
  await init();
  if (dbUnavailable()) {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT * FROM video_sentences WHERE video_id = $1 ORDER BY sentence_index ASC`,
    [videoId]
  );
  return rows;
}

async function deleteVideoSentences(videoId) {
  await init();
  if (dbUnavailable()) {
    return 0;
  }
  const { rowCount } = await pool.query(
    `DELETE FROM video_sentences WHERE video_id = $1`,
    [videoId]
  );
  return rowCount;
}

module.exports = {
  createVideoResource,
  updateVideoResource,
  getVideoResourceById,
  getVideoResourceByPath,
  createVideoShareRequest,
  getVideoShareRequestById,
  listVideoShareRequests,
  getVideoShareRequestSummary,
  updateVideoShareRequestReview,
  listVideoResources,
  listVideoResourcesLite,
  listVideoResourcesByUploader,
  listVideoResourcesByUploaderLite,
  countVideoResourcesByUploader,
  listVideoResourcesWithUserInfo,
  getDifficultyStats,
  deleteVideoResource,
  getArticles,
  getArticleById,
  deleteArticle,
  getMediaByArticle,
  getSegmentsByMedia,
  getOcrCache,
  saveOcrCache,
  createVideoSentence,
  getVideoSentences,
  deleteVideoSentences,
  getVideoResourceByFileHash,
};
