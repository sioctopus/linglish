# Mobile and tablet interface polish

Completed on 2026-11-03, integrated with main at `812c394`.

## Result

- Signed-in phones and portrait tablets open a compact learning home with a resume
  card, eight learning entries and four persistent navigation destinations. Desktop
  and signed-out navigation remain available after rotation and logout.
- The home greeting updates when the profile arrives. Resume cards support library,
  YouTube and podcast history and carry the saved position to the mobile reader.
- Practice navigation moves secondary destinations into More. Daily speaking exposes
  its textbook and method choices in a sheet while keeping the sentence central.
- Reader routing and focus styles share the 1023px compact breakpoint. Portrait
  tablets get a centered reading column. Caption navigation retains main's position
  immediately above the recording row, with at least 44px touch targets.
- Tours begin with an optional invitation instead of an automatic full-screen
  takeover. Hidden dialog templates no longer block invitations or email reminders.
- More and choice sheets contain keyboard focus and background scrolling, restore
  focus on close, preserve original actions, and safely handle rapid reopen.
- First-run phone setup uses a dismissible bottom sheet. Recording labels use Chinese
  and touch devices no longer receive keyboard-only speaking instructions.
- Startup no longer waits for a decorative routing delay; affected pages allow zoom.
  Changed versioned assets receive fresh cache keys.

## Preserved integration

The later login/session fixes, word lookup, homepage account controls, Android
download entry, creator features, arena dialogue and 864-line course remain intact.
The removed practice onboarding block and relocated sentence controls were not
reintroduced while resolving the earlier branch's conflicts.

## Verification

- Backend `npm test`: **1497 passed, 36 skipped, 0 failed** (1533 total).
- Browser `npm run test:browser`: **43 passed, 0 failed**.
- Twenty-five real-page scenarios: home, both practice pages, reader and daily
  speaking at 360, 375, 393, 820 and 1180px. Checks include horizontal fit, controls,
  textbook selection and uncaught errors.
- Regression checks include real homepage logout, first-run setup, hidden dialogs,
  async profile loading, rapid menu reopen, modal keyboard/scroll containment, and
  homepage-to-reader resume using actual media playback time.
- Actual compact textbook checks at 393 and 820px switch built-in courses, restore
  the previous choice after a failed download, and show the asynchronously loaded
  course label. The menu uses the current select options rather than legacy buttons.
- Home cards refresh the lesson and saved time after history restoration, account
  updates and card activation, so a retained page does not reuse an earlier target.
- `git diff --check` passes; code review found no remaining blockers.

Browser checks use Chromium device emulation, production HTML adaptation, local
synthetic API responses and a generated video. They do not constitute physical
iPhone/iPad, Safari, microphone or production authentication acceptance. The skipped
backend tests retain their existing environment prerequisites; no production database
was used. Browser setup and fixture details are in
`app/backend/browser-test/README.md`.

Reader rotation across the compact/wide breakpoint remains a pre-existing limitation:
the already-open reader may need a reload to choose its other layout. No automatic
resize navigation is introduced here, which would interrupt active practice.

This change affects the website. Native App builds and iOS distribution are separate;
publication is tracked through the pull request and deployment verification records.
