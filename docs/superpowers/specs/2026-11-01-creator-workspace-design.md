# English creator workspace and learning polish

## Purpose

Let members share their own English-learning videos through an explicit application and moderation flow. Reuse the existing private resource/upload and public video-review system. Keep personal learning usable while a creator application or video review is pending.

## Workflow

1. A signed-in member submits a display name, introduction, topic, optional example link and confirmation that they hold the rights to share their material.
2. An administrator approves or rejects the application. Approval grants creator submission permission only; membership and administrator privileges are unchanged.
3. A creator uploads a video privately under the existing upload quotas. Processing and usable subtitles must complete before submission.
4. The creator can edit a private draft and submit it for publication. Pending or already-public source content is locked against owner edits. Personal tags remain personal.
5. An administrator reviews the current resource. Publication and the review decision commit together only while ownership, creator eligibility, readiness, pending state and the submitted content revision remain valid.
6. Approved public videos appear in the existing video library. Rejected drafts remain private and can be revised and resubmitted.

The first version supports video files through the existing upload pipeline. Audio publication, creator payments and a separate social feed are outside this delivery. The creator centre is available on phones, tablets and desktop; the native client links to the official website without putting credentials in URLs.

## Interfaces

- `GET/POST /api/creator/application`: the caller's own application.
- `GET /admin/creator-applications`: bounded, filtered review queue and summary.
- `POST /admin/creator-applications/:id/review`: administrator decision with an expected application revision.
- Existing private upload, owned-resource, metadata editing and `/api/video-share-requests` interfaces remain the resource publishing foundation.
- `creator-center.html` provides application status, private drafts and submission state. `admin-creators.html` handles qualification; the existing video-review page handles content approval.

All new creator mutations use explicit Bearer authentication. Resource authorization is shared across ordinary resource APIs, media/thumbnail paths, practice aliases, tag endpoints and vocabulary contexts. Unknown visibility and database fallback metadata fail closed. Server-generated media paths cannot be supplied through user thumbnail metadata.

Application storage is additive (`V35`). Publication revision columns and media indexes are additive (`V36`). Runtime schema checks support an application role without schema ownership after owner-run migrations. Required permission-schema failures remain errors. Existing users, recordings, memberships and private deployment configuration are preserved.

## Learning improvements

- Speaking practice confirms words with Space or Enter, retains editable mistakes, reports accuracy and advances a completed sentence. Input methods, microphone startup and later course/material selections cannot be overwritten by delayed work.
- Five original starter packs provide 20 scenarios and 120 bilingual lines. The former placeholder corpus label is now “基础表达”; it does not claim an 850-sentence corpus.
- Desktop reading shows the current Chinese subtitle according to the bilingual toggle. The transcript toolbar uses short labels with full tooltips, and reading settings stay below the controls.
- Tablet layouts keep media and subtitles usable; duplicated practice branding is removed. Third-party YouTube controls remain available.

## Validation

Behavioral tests cover application ownership, revision conflicts, private resource reads, moderation transactions, late transcription callbacks, tag consistency, explicit authentication and upload/submission status. Disposable PostgreSQL tests execute the SQL and rollback paths; their embedded single connection does not establish independent-session lock contention coverage.

Browser checks exercise mobile, tablet and desktop application states, failed uploads/edits, account changes, retained drafts/files, paginated pending reviews, keyboard learning, delayed course/material loads, reading modes and subtitle synchronization. Production checks are read-only; tests do not create applications or publish content on existing users' accounts.
