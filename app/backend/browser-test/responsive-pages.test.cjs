// Run against real HTML, production device injection, and deterministic local API fixtures.
// No account, external services, production data or media uploads are used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium, devices } = require('playwright');
const { injectDeviceAdapt } = require('../routes/static');

const frontend = path.resolve(__dirname, '../../frontend');
const output = process.env.RESPONSIVE_SCREENSHOTS || path.join(os.tmpdir(), 'linglish-responsive-shots');
const captions = [
  ['Hello! How have you been?', '你好！最近怎么样？'],
  ['Pretty good. I just got back from a trip.', '挺好的，我刚旅行回来。'],
  ['That sounds great. Tell me about it.', '听起来不错，跟我说说吧。'],
].map(([text, translation], i) => ({ text, translation, start: i * 4, end: i * 4 + 4, start_sec: i * 4, end_sec: i * 4 + 4 }));
const video = { id: 1, title: 'A conversation with a friend', video_path: '/videos/fixture.webm', transcript_segments: captions, total_segments: captions.length, has_subtitles: true, duration_sec: 12, status: 'ready', tags: [], characters: [], difficulty_level: 'beginner', category: 'daily' };
let browser, server, origin;
before(async () => {
  await fs.mkdir(output, { recursive: true });
  server = http.createServer(async (req, res) => {
    try {
      if (new URL(req.url, 'http://local').pathname === '/videos/fixture.webm') {
        const bytes = await fs.readFile(path.join(__dirname, 'fixtures/lesson.webm'));
        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end) { res.writeHead(416).end(); return; }
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        res.end(bytes.subarray(start, end + 1));
        return;
      }
      const file = path.resolve(frontend, '.' + new URL(req.url, 'http://local').pathname);
      if (!file.startsWith(frontend + path.sep)) { res.writeHead(404).end(); return; }
      const ext = path.extname(file);
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }[ext] || 'application/octet-stream');
      res.end(ext === '.html' ? injectDeviceAdapt(bytes.toString(), file) : bytes);
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function contextFor(t, width, height) {
  const device = width < 768 ? devices['iPhone 14'] : width < 1024 ? devices['iPad (gen 7)'] : {};
  const context = await browser.newContext({ ...device, viewport: { width, height } });
  t.after(() => context.close());
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/videos/')) return route.continue();
    if (['fetch', 'xhr'].includes(request.resourceType()) && !/\.(js|css|html|json)$/.test(url.pathname)) {
      let body = { items: [], data: [], success: true };
      if (url.pathname === '/users/me') body = { id: 7, username: 'Demo Learner', email: 'learner@example.invalid', email_verified: true, membership_type: 'free', level: 'beginner' };
      else if (url.pathname === '/auth/profile') body = { user: { id: 7, level: 'beginner', email_verified: true } };
      else if (url.pathname === '/video-resources/1') body = { video };
      else if (url.pathname === '/video-resources') body = { items: [video] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const payload = btoa(JSON.stringify({ userId: 7, exp: 4102444800 }));
    const token = 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.fixture';
    localStorage.setItem('authToken', token);
    localStorage.setItem('linglish_token', token);
    localStorage.setItem('linglish_onboarding_done', '1');
    localStorage.setItem('userEmail', 'learner@example.invalid');
  });
  return context;
}

for (const [width, height] of [[360, 640], [375, 667], [393, 852], [820, 1180], [1180, 820]]) {
  for (const [name, target] of [
    ['home', 'index-desktop.html'],
    ['reader', 'video-reader-desktop.html?videoId=1'],
    ['practice', 'practice-session-desktop.html?videoId=1&mode=shadowing'],
    ['practice-mobile', 'practice-session.html?videoId=1&mode=shadowing'],
    ['speaking', 'daily-speaking.html'],
  ]) {
    test(`${name} at ${width}×${height}: content fits and primary controls remain reachable`, { timeout: 30000 }, async (t) => {
      const context = await contextFor(t, width, height);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/' + target, { waitUntil: 'load' });
      if (name === 'home') await page.waitForFunction(() => document.querySelector('#user-display-name')?.textContent.includes('Demo Learner'));
      else if (name === 'reader') {
        await page.locator(width <= 1023 ? '.mobile-transcript-item' : '#transcript-list .seg').first().waitFor({ state: 'attached' });
        await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(v => v.duration >= 12));
      }
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 1, `page overflows by ${overflow}px at ${page.url()}`);
      if (name === 'home' && width <= 1023) {
        assert.equal(await page.locator('.lx-home-bottom-nav').isVisible(), true);
        assert.equal(await page.locator('.lx-home-tile').count(), 8);
        await page.getByRole('button', { name: '我的', exact: true }).click();
        assert.equal(await page.locator('.lx-more-sheet').isVisible(), true);
        await page.keyboard.press('Escape');
      }
      if (name === 'reader' && width <= 1023) {
        const next = page.locator('#mobile-subtitle-next');
        const rect = await next.boundingBox();
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width + 1, 'next caption control must fit');
        assert.ok(rect.height >= 44, 'caption controls need a 44px touch target');
        await next.click();
      }
      if (name === 'speaking' && width <= 1023) {
        await page.locator('.lx-compact-chip').click();
        await page.getByRole('button', { name: '先说再看', exact: true }).click();
        assert.equal(await page.locator('#method-select').inputValue(), 'speak');
      }
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(output, `${name}-${width}.png`) });
      assert.deepEqual(errors, [], 'no uncaught errors in the real page');
    });
  }
}

test('continue from the real phone homepage restores the saved video position', { timeout: 15000 }, async (t) => {
  const context = await contextFor(t, 393, 852);
  await context.addInitScript(() => {
    localStorage.setItem('linglish.study.recent.v1', JSON.stringify([{ id: '1', title: 'My saved lesson', seconds: 6, percent: 50, updatedAt: Date.now() }]));
  });
  const page = await context.newPage();
  await page.goto(origin + '/index-desktop.html');
  await page.locator('.lx-home-continue').click();
  await page.waitForURL('**/video-reader.html?*');
  assert.equal(new URL(page.url()).searchParams.get('startSec'), '6', 'continue must carry the saved position into the mobile route');
  await page.waitForFunction(() => {
    const video = document.getElementById('video-player');
    return video && video.currentTime >= 5.5;
  }, null, { timeout: 4000 }).catch(async () => {
    const actual = await page.evaluate(() => ({ time: videoPlayer.currentTime, duration: videoPlayer.duration, readyState: videoPlayer.readyState, pending: pendingResumeSeek }));
    assert.fail('saved position was not restored: ' + JSON.stringify(actual));
  });
  assert.equal(new URL(page.url()).searchParams.get('videoId'), '1');
});
