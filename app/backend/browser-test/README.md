# Responsive browser checks

From `app/backend`, install development dependencies and Chromium once:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

The tests use real frontend files and the production device-adaptation injection.
Requests use local synthetic API responses; external hosts are blocked. No accounts,
production databases, recording, uploads or external model calls are needed.

Coverage includes five viewport sizes (360, 375, 393, 820 and 1180 pixels), the home,
video reader, both practice pages, and daily speaking. The behavior checks cover
sign-out, rotation, late profile loading, history, modal keyboard/scroll containment,
hidden dialog templates and email reminders. The home-to-reader test plays a local
fixture and checks the actual saved playback position, beyond the link parameters.

Screenshots go to the operating system temporary directory under
`linglish-responsive-shots`. Set `RESPONSIVE_SCREENSHOTS` to override it.
Chromium device emulation is not a physical iPhone/iPad or Safari test. The fixture
API responses exercise frontend integration, not production server authentication.

`fixtures/lesson.webm` is a generated, silent, solid-color 12-second VP8 video with
no external content. It can be regenerated with:

```sh
ffmpeg -f lavfi -i color=c=0x0f766e:s=160x90:r=1 -t 12 \
  -c:v libvpx -b:v 20k fixtures/lesson.webm
```
