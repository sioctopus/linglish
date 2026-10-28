# Guided English Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Upgrade the existing short speaking lesson into an inviting listen, speak, and feedback experience on phones, tablets, and desktop.

**Architecture:** Enhance the shared first-lesson goal card and its existing reader integrations. Keep playback, microphone capture, server assessment, and verified progress in the existing controllers; the card presents their real state and owns only its temporary recording playback URL.

**Tech Stack:** Existing browser JavaScript, CommonJS-compatible UI module, native audio controls, existing CSS tokens, Node tests.

**Spec:** The accepted brief below, based on the user's approved reference review and request to adapt the interaction and visual treatment for English learning.

## Accepted brief

- Give the current English sentence prominence, with a deliberate translation reveal.
- Show three clear stages: listen to the original, speak, and review feedback.
- Borrow the reference's soft panels, strong task hierarchy, and clear next action; use Linglish's own colors and content.
- Preserve actual assessment, account boundaries, word lookup, subtitles, and recording behavior.
- Let learners replay their own real recording and retry a sentence after feedback.
- Retain the existing short-lesson entry and add a discoverable entry from the mobile reader when a video is selected.
- Stack content on narrow screens; supporting subtitles and controls must remain accessible without covering the learning card.

## Global Constraints

- Node.js 22 or newer; no new runtime dependencies.
- Only server-verified assessments update practiced progress.
- No reference code, art, proprietary lesson content, secrets, or user recordings enter Git.
- Render sentence, translation, and recognized text as text, never untrusted HTML.
- Preserve the existing goal storage format and resume links.
- Do not prefetch a future immutable asset URL before deployment.

## Review Focus

- Microphone denial or assessment failure leaves a retry path and does not show completion.
- Selecting another sentence or video clears stale feedback and releases recording URLs.
- An assessment can update goal progress before feedback renders; keep the assessed sentence visible.
- A zero-success exit must not claim a completed sentence in the destination URL.
- Narrow viewports, long sentences, keyboard focus, and reduced motion remain usable.

## Task 1: Shared guided lesson card

**Files:** `app/frontend/js/video-reader/first-lesson-goal.js`, `app/frontend/styles/first-lesson-goal.css`, `app/backend/test/guided-english-goal.test.js`, `app/backend/test/first-lesson-goal.test.js`.

**Interfaces:** Preserve `createCard().update/hide/setState/feedback/settle`; add `setSentence({index,text,translation})`, `setRecording(blob)`, read-only `getSentenceIndex()`, optional `getSentence(index)` and `pauseOriginal()` callbacks. `settle(note, {success,recognizedText,missedWords})` adds structured real feedback while retaining legacy callers.

- [x] Write and observe failing tests for phase changes, translation reveal, current-sentence identity, retry, actual recording cleanup, untrusted text, and truthful zero-success exits.
- [x] Implement the card and responsive styling without changing the goal store.
- [x] Run focused goal tests and review the actual rendered component on mobile.

## Task 2: Reader integration and discoverability

**Files:** `app/frontend/js/video-reader/main.js`, `app/frontend/js/pages/video-reader-desktop-app.js`, both reader HTML entry points, and integration tests where appropriate.

**Interfaces:** Supply sentence data, real captured blobs, pause-source callbacks, and structured assessment feedback to Task 1. Existing context guards remain the authority for accepting results.

- [x] Connect sentence changes and recording/assessment lifecycle on both readers.
- [x] Make the next action follow the next unpracticed short-lesson target.
- [x] Expose the short lesson from a selected mobile video; preserve the selected video in the entry URL.
- [x] In the guided mobile layout, retain accessible subtitle and playback controls with clear disclosure and no overlay.
- [x] Bump all changed asset references consistently, then run the full backend test suite.

## Task 3: Verification and release

- [ ] Verify the real rendered UI at phone, tablet, and desktop sizes; cover listen, recording state, feedback, retry, translation, and empty/error states.
- [x] Obtain independent JavaScript and general code review; resolve material findings.
- [ ] Commit and push the reviewed change to the canonical public repository.
- [ ] Back up and deploy the exact release to both existing production sites, preserving private configuration and data.
- [ ] Verify live asset content, short-lesson entry, and major routes; retain a screenshot and a private release record.
