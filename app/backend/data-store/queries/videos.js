const path = require('path');
const fs = require('fs/promises');
const { pool, init, dbUnavailable } = require('../core');
const { publicationError, isVideoReadyForPublication, CREATOR_APPROVAL_MESSAGE, VIDEO_REVIEW_LOCK_MESSAGE, VIDEO_PROCESSING_LOCK_MESSAGE } = require('../../services/video-publication-policy');

const PUBLIC_VIDEO_DIR = path.join(__dirname, '../../public', 'videos');
// Compare the content reviewed by moderators without invalidating a submission on a preview/view count.
const RESOURCE_REVISION_SQL = `md5(jsonb_build_object(
  'resource', to_jsonb(vr) - ARRAY['updated_at', 'created_at', 'view_count', 'practice_count', 'manual_order'],
  'global_tags', COALESCE((
    SELECT jsonb_agg(to_jsonb(publication_tag) - ARRAY['created_at', 'updated_at'] ORDER BY publication_tag.id)
    FROM video_tags publication_assignment
    JOIN tags publication_tag ON publication_tag.id = publication_assignment.tag_id
    WHERE publication_assignment.video_id = vr.id AND publication_tag.scope = 'global'
  ), '[]'::jsonb)
)::text)`;

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
        is_public: false,
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
  const { requesterId, videoResourceId, requestType = 'public', note = null } = payload;
  if (!['public', 'featured'].includes(requestType)) throw publicationError(400, 'Invalid request type');
  return withVideoTransaction(async client => {
    const { rows: videos } = await client.query('SELECT * FROM video_resources WHERE id = $1 FOR UPDATE', [videoResourceId]);
    const video = videos[0];
    if (!video) throw publicationError(404, 'Video not found');
    const { rows: users } = await client.query('SELECT id, is_admin FROM users WHERE id = $1', [requesterId]);
    const isAdmin = users[0]?.is_admin === true;
    if (!isAdmin && String(video.uploader_id) !== String(requesterId)) throw publicationError(403, 'Only the owner can submit this video for review');
    await requireApprovedCreator(client, requesterId, isAdmin);
    if (!isVideoReadyForPublication(video)) throw publicationError(409, 'Video must be ready with usable subtitles before review');
    const { rows } = await client.query(
      `INSERT INTO video_share_requests
         (requester_id, video_resource_id, request_type, note, video_updated_at, resource_revision)
       VALUES ($1, $2, $3, $4, (SELECT updated_at FROM video_resources WHERE id = $2),
         (SELECT ${RESOURCE_REVISION_SQL} FROM video_resources vr WHERE vr.id = $2))
       ON CONFLICT (requester_id, video_resource_id, request_type) WHERE status = 'pending'
       DO UPDATE SET note = video_share_requests.note
       RETURNING *, (xmax <> 0) AS already_pending`,
      [requesterId, videoResourceId, requestType, note],
    );
    return rows[0] || null;
  });
}

async function withVideoTransaction(work) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function requireApprovedCreator(client, userId, isAdmin) {
  if (isAdmin) return;
  const { rows } = await client.query('SELECT status FROM creator_applications WHERE user_id = $1 FOR SHARE', [userId]);
  if (rows[0]?.status !== 'approved') throw publicationError(403, CREATOR_APPROVAL_MESSAGE);
}

async function reviewVideoShareRequest(id, { status, reviewerId, reviewNote = null }) {
  if (!['approved', 'rejected'].includes(status)) throw publicationError(400, 'Invalid review status');
  return withVideoTransaction(async client => {
    const { rows: initial } = await client.query('SELECT video_resource_id FROM video_share_requests WHERE id = $1', [id]);
    if (!initial[0]) throw publicationError(404, 'Review request not found');
    // Submit, review and owner edits all lock the video first, preventing lock-order races.
    const { rows: videos } = await client.query('SELECT * FROM video_resources WHERE id = $1 FOR UPDATE', [initial[0].video_resource_id]);
    const video = videos[0];
    const { rows: requests } = await client.query(
      `SELECT vsr.*, (vsr.resource_revision = ${RESOURCE_REVISION_SQL}) AS revision_matches
       FROM video_share_requests vsr JOIN video_resources vr ON vr.id = vsr.video_resource_id
       WHERE vsr.id = $1 FOR UPDATE OF vsr`, [id]);
    const request = requests[0];
    if (!request || request.status !== 'pending') throw publicationError(409, 'Review request is no longer pending');
    let updatedVideo = null;
    if (status === 'approved') {
      const { rows: users } = await client.query('SELECT id, is_admin FROM users WHERE id = $1', [request.requester_id]);
      const requesterIsAdmin = users[0]?.is_admin === true;
      if (!video || (!requesterIsAdmin && String(video.uploader_id) !== String(request.requester_id))) {
        throw publicationError(409, 'Video ownership changed; a new review request is required');
      }
      await requireApprovedCreator(client, request.requester_id, requesterIsAdmin);
      if (request.revision_matches !== true) throw publicationError(409, 'Video changed after submission; reject this request and submit it again');
      if (!isVideoReadyForPublication(video)) throw publicationError(409, 'Video must be ready with usable subtitles before approval');
      updatedVideo = await updateVideoResourceOn(client, video.id, request.request_type === 'featured'
        ? { is_public: true, is_featured: true } : { is_public: true });
    }
    const { rows } = await client.query(
      `UPDATE video_share_requests SET status = $2, reviewer_id = $3, review_note = $4,
         reviewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, reviewerId, reviewNote]);
    if (!rows[0]) throw publicationError(409, 'Review request is no longer pending');
    return { request: rows[0], video: updatedVideo };
  });
}

async function updateVideoResourceForOwner(id, updates, user, { sentences = null, allowProcessingCompletion = false } = {}) {
  return withVideoTransaction(async client => {
    const { rows } = await client.query('SELECT * FROM video_resources WHERE id = $1 FOR UPDATE', [id]);
    const video = rows[0];
    if (!video) throw publicationError(404, 'Video not found');
    if (!user?.is_admin && String(video.uploader_id) !== String(user?.id)) throw publicationError(403, 'Only the owner can edit this video');
    // Reject duplicate job starts and manual replacements until the active transcription finishes.
    if (video.status === 'processing' && !allowProcessingCompletion) throw publicationError(409, VIDEO_PROCESSING_LOCK_MESSAGE);
    if (!user?.is_admin) {
      const pending = await client.query("SELECT id FROM video_share_requests WHERE video_resource_id = $1 AND status = 'pending' LIMIT 1", [id]);
      if (video.is_public === true || pending.rows.length) throw publicationError(409, VIDEO_REVIEW_LOCK_MESSAGE);
    }
    if (sentences) {
      await client.query('DELETE FROM video_sentences WHERE video_id = $1', [id]);
      if (sentences.length) {
        const values = sentences.map((segment, index) => ({ sentence_index: index, text: segment.text,
          start_time_sec: segment.start || 0, end_time_sec: segment.end || 0, speaker: segment.speaker || null }));
        await client.query(`INSERT INTO video_sentences (video_id, sentence_index, text, start_time_sec, end_time_sec, speaker)
          SELECT $1, sentence_index, text, start_time_sec, end_time_sec, speaker
          FROM jsonb_to_recordset($2::jsonb) AS segments(sentence_index INTEGER, text TEXT,
            start_time_sec DOUBLE PRECISION, end_time_sec DOUBLE PRECISION, speaker TEXT)`, [id, JSON.stringify(values)]);
      }
    }
    return updateVideoResourceOn(client, id, updates);
  });
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
  return updateVideoResourceOn(pool, id, updates);
}

async function updateVideoResourceOn(executor, id, updates) {
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

  const { rows } = await executor.query(sql, values);

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

async function getVideoResourcesForMediaPath(mediaPath, mediaKind = 'video') {
  await init();
  // Files on disk alone do not establish public visibility or ownership.
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  if (!['video', 'thumbnail'].includes(mediaKind)) throw publicationError(400, 'Invalid media kind');
  const binding = mediaKind === 'thumbnail' ? 'thumbnail_path = $1' : '(video_path = $1 OR local_video_path = $1)';
  const { rows } = await pool.query(
    `SELECT id, uploader_id, is_public, is_vip_only FROM video_resources
     WHERE ${binding}`, [mediaPath]);
  return rows;
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

function articleAccessSql(alias, ownerParam, adminParam) {
  return `(${alias}.owner_user_id = ${ownerParam} OR ${adminParam}::boolean OR (
    COALESCE(${alias}.visibility, 'public') = 'public'
    AND (${alias}.source_type IS DISTINCT FROM 'workbench-practice' OR EXISTS (
      SELECT 1 FROM workbench_documents shared
      WHERE shared.practice_article_id = ${alias}.id
        AND shared.user_id = ${alias}.owner_user_id
        AND shared.share_token IS NOT NULL
        AND (shared.share_expires_at IS NULL OR shared.share_expires_at > NOW())
    ))
  ))`;
}

function articleViewer(user) {
  const id = Number(user?.id);
  return [Number.isSafeInteger(id) && id > 0 ? id : null, user?.is_admin === true];
}

async function getArticles(user = null) {
  await init();
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.content, a.level, a.tags, a.audio_url, a.word_count,
            a.difficulty_score, a.source_type, a.pdf_path, a.note_image_path,
            a.owner_user_id, a.visibility
     FROM articles a
     WHERE ${articleAccessSql('a', '$1', '$2')}
     ORDER BY a.id ASC`,
    articleViewer(user)
  );
  return rows;
}

async function getArticleById(id, user = null) {
  await init();
  const { rows } = await pool.query(
    `SELECT a.* FROM articles a WHERE a.id = $1
     AND ${articleAccessSql('a', '$2', '$3')} LIMIT 1`,
    [id, ...articleViewer(user)]
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

async function getMediaByArticle(articleId, user = null) {
  await init();
  const { rows } = await pool.query(
    `SELECT m.id, m.article_id, m.kind, m.url, m.duration_sec
     FROM media_assets m LEFT JOIN articles a ON a.id = m.article_id
     WHERE ($1::bigint IS NULL OR m.article_id = $1)
       AND (a.id IS NULL OR ${articleAccessSql('a', '$2', '$3')})
     ORDER BY m.id ASC`,
    [articleId || null, ...articleViewer(user)]
  );
  return rows;
}

async function getSegmentsByMedia(mediaId, user = null) {
  await init();
  const { rows } = await pool.query(
    `SELECT s.id, s.media_id, s.start_ms, s.end_ms, s.text
     FROM audio_segments s
     JOIN media_assets m ON m.id = s.media_id
     LEFT JOIN articles a ON a.id = m.article_id
     WHERE ($1::bigint IS NULL OR s.media_id = $1)
       AND (a.id IS NULL OR ${articleAccessSql('a', '$2', '$3')})
     ORDER BY s.media_id ASC, s.start_ms ASC`,
    [mediaId || null, ...articleViewer(user)]
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
  updateVideoResourceForOwner,
  reviewVideoShareRequest,
  getVideoResourcesForMediaPath,
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
