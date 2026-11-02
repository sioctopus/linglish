const { pool, init, dbUnavailable } = require('../core');

const STATUSES = new Set(['pending', 'approved', 'rejected']);

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function idValue(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) fail('INVALID_CREATOR_ID', 400);
  return id;
}

async function requireDatabase() {
  await init();
  if (dbUnavailable()) fail('DATASTORE_UNAVAILABLE', 503);
}

async function getCreatorApplication(userId) {
  const id = idValue(userId);
  await requireDatabase();
  const { rows } = await pool.query('SELECT * FROM creator_applications WHERE user_id = $1', [id]);
  return rows[0] || null;
}

async function submitCreatorApplication(userId, payload) {
  const id = idValue(userId);
  await requireDatabase();
  const values = [id, payload.display_name, payload.bio, payload.topic, payload.sample_url ?? null, payload.rights_confirmed];
  const inserted = await pool.query(`INSERT INTO creator_applications
    (user_id, display_name, bio, topic, sample_url, rights_confirmed)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id) DO NOTHING RETURNING *`, values);
  if (inserted.rows[0]) return { application: inserted.rows[0], created: true };

  // Only rejected applications may be replaced. Pending retries are a no-op;
  // a concurrent approval cannot be reset by this conditional update.
  const resubmitted = await pool.query(`UPDATE creator_applications
    SET display_name = $2, bio = $3, topic = $4, sample_url = $5,
      rights_confirmed = $6, status = 'pending', revision = revision + 1,
      reviewed_by = NULL, review_note = NULL, reviewed_at = NULL,
      submitted_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND status = 'rejected'
    RETURNING *`, values);
  if (resubmitted.rows[0]) return { application: resubmitted.rows[0], created: false };
  const application = await getCreatorApplication(id);
  if (!application) fail('CREATOR_APPLICATION_CONFLICT', 409);
  if (application.status === 'approved') fail('CREATOR_APPLICATION_APPROVED', 409);
  return { application, created: false };
}

function boundedInteger(value, fallback, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), max) : fallback;
}

async function listCreatorApplications({ status = 'pending', limit = 50, offset = 0 } = {}) {
  if (status !== 'all' && !STATUSES.has(status)) fail('INVALID_CREATOR_STATUS', 400);
  const boundedLimit = Math.max(1, boundedInteger(limit, 50, 100));
  const boundedOffset = boundedInteger(offset, 0, 1000000);
  await requireDatabase();
  const values = status === 'all' ? [] : [status];
  const where = status === 'all' ? '' : 'WHERE status = $1';
  values.push(boundedLimit, boundedOffset);
  const items = await pool.query(`SELECT * FROM creator_applications ${where}
    ORDER BY submitted_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const summary = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
    COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
    COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
    FROM creator_applications`);
  return { items: items.rows, summary: summary.rows[0], limit: boundedLimit, offset: boundedOffset };
}

async function reviewCreatorApplication(applicationId, { reviewer_id, decision, review_note = null, expected_revision } = {}) {
  const id = idValue(applicationId);
  const reviewerId = idValue(reviewer_id);
  if (decision !== 'approved' && decision !== 'rejected') fail('INVALID_CREATOR_DECISION', 400);
  if (!Number.isSafeInteger(expected_revision) || expected_revision < 1) fail('INVALID_CREATOR_REVISION', 400);
  if (review_note != null && (typeof review_note !== 'string' || review_note.length > 1200)) fail('INVALID_CREATOR_REVIEW_NOTE', 400);
  await requireDatabase();
  const result = await pool.query(`UPDATE creator_applications
    SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = NOW(),
      updated_at = NOW(), revision = revision + 1
    WHERE id = $1 AND status = 'pending' AND revision = $5 AND user_id <> $3
    RETURNING *`, [id, decision, reviewerId, review_note, expected_revision]);
  if (result.rows[0]) return result.rows[0];
  const existing = await pool.query('SELECT user_id FROM creator_applications WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('CREATOR_APPLICATION_NOT_FOUND', 404);
  if (String(existing.rows[0].user_id) === reviewerId) fail('CREATOR_SELF_REVIEW_FORBIDDEN', 403);
  fail('CREATOR_APPLICATION_CONFLICT', 409);
}

module.exports = { getCreatorApplication, submitCreatorApplication, listCreatorApplications, reviewCreatorApplication };
