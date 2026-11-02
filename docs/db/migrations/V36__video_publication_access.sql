-- Audit the submitted timestamp separately from the reviewed content fingerprint.
-- Legacy requests retain NULL fingerprints and must be resubmitted for approval.
ALTER TABLE video_share_requests
  ADD COLUMN IF NOT EXISTS video_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resource_revision TEXT;

-- Media authorization checks all three exact paths. video_path already has a
-- unique index; the other OR branches need indexes to avoid catalog-wide scans.
CREATE INDEX IF NOT EXISTS idx_video_resources_local_video_path
  ON video_resources (local_video_path);

CREATE INDEX IF NOT EXISTS idx_video_resources_thumbnail_path
  ON video_resources (thumbnail_path);
