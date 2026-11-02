const { pool } = require('./core');

// Required for creator authorization. Let failures reject startup rather than
// treating a missing or inaccessible table as an approved creator.
async function ensureCreatorApplicationSchema(query = pool.query.bind(pool)) {
  const probe = `SELECT id, user_id, display_name, bio, topic, sample_url,
    rights_confirmed, status, revision, reviewed_by, review_note, reviewed_at,
    submitted_at, created_at, updated_at FROM creator_applications LIMIT 0`;
  try {
    await query(probe);
    return;
  } catch (error) {
    // A migrated table may belong to a separate owner. Existing schemas need
    // only read access; permissions and incompatible columns must fail closed.
    if (error.code !== '42P01') throw error;
  }

  await query(`CREATE TABLE IF NOT EXISTS creator_applications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(80) NOT NULL CHECK (length(btrim(display_name)) > 0),
    bio VARCHAR(1200) NOT NULL CHECK (length(btrim(bio)) > 0),
    topic VARCHAR(80) NOT NULL CHECK (length(btrim(topic)) > 0),
    sample_url VARCHAR(2000),
    rights_confirmed BOOLEAN NOT NULL CHECK (rights_confirmed = TRUE),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    review_note VARCHAR(1200),
    reviewed_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT creator_application_review_state CHECK (
      (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
      OR (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL)
    )
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_creator_applications_status_submitted
    ON creator_applications (status, submitted_at DESC, id DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_creator_applications_reviewed_by
    ON creator_applications (reviewed_by)`);
  await query(probe);
}

module.exports = { ensureCreatorApplicationSchema };
