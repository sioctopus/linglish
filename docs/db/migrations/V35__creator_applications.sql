-- Creator qualification is independent of membership and administrator rights.
-- Existing users/content remain unchanged; only explicit admin approval enables it.
CREATE TABLE IF NOT EXISTS creator_applications (
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
);

CREATE INDEX IF NOT EXISTS idx_creator_applications_status_submitted
  ON creator_applications (status, submitted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_creator_applications_reviewed_by
  ON creator_applications (reviewed_by);

-- Some deployments run migrations as a separate owner. Keep fresh OSS databases
-- without that deployment-specific role supported too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linklish') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE creator_applications TO linklish;
    GRANT USAGE ON SEQUENCE creator_applications_id_seq TO linklish;
  END IF;
END $$;
