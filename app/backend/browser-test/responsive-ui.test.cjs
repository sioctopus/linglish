const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../../frontend');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function fixture(t, { width = 393, home = false, recent = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 852 } });
  t.after(() => page.close());
  await page.setContent(home ? `
    <nav class="navbar"><div class="logo">Linglish</div>
      <div id="nav-links"><a id="nav-workbench-link" href="./workbench.html">工作台</a></div>
      <div id="guest-actions" hidden><button>登录</button></div>
      <div id="user-info"><span id="user-display-name"></span><a id="vip-badge" hidden>会员</a><button id="logout-btn">退出登录</button></div>
    </nav><section class="hero">介绍</section><main><section id="daily-task">训练</section><section id="community">社区</section></main>
  ` : '<nav id="bar"><button id="back">返回</button><button id="source">设置</button></nav><main><a id="outside" href="#end">内容</a></main>');
  await page.addStyleTag({ path: path.join(frontend, 'styles/compact-nav.css') });
  await page.addScriptTag({ path: path.join(frontend, 'js/compact-nav.js') });
  if (home) {
    await page.evaluate(entry => { window.LinglishStudyRecent = { latest: () => entry }; }, recent);
    await page.addStyleTag({ path: path.join(frontend, 'styles/home-app.css') });
    await page.addScriptTag({ path: path.join(frontend, 'js/home-app.js') });
  } else {
    await page.evaluate(() => {
      window.nav = LxCompactNav.mount({ bar: '#bar', keep: ['#back'], sheet: ['#source'] });
    });
  }
  return page;
}

test('home restores login and desktop navigation after sign-out and viewport changes', async (t) => {
  const page = await fixture(t, { home: true });
  assert.equal(await page.locator('html').evaluate(n => n.classList.contains('lx-app-home')), true);
  await page.evaluate(() => {
    document.getElementById('user-info').hidden = true;
    document.getElementById('guest-actions').hidden = false;
  });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#guest-actions').isVisible(), true, 'sign-out must restore login');
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.locator('#nav-links').isVisible(), true);
  await page.setViewportSize({ width: 393, height: 852 });
  assert.equal(await page.locator('#guest-actions').isVisible(), true);
});

test('home updates its greeting when the account profile arrives later', async (t) => {
  const page = await fixture(t, { home: true });
  await page.evaluate(() => { document.getElementById('user-display-name').textContent = 'Learner'; });
  await page.waitForTimeout(50);
  assert.match(await page.locator('.lx-home-hello-title').textContent(), /Learner/);
});

test('home refreshes the saved lesson after history restoration and account changes', async (t) => {
  const page = await fixture(t, { home: true, recent: { id: '42', title: 'Earlier lesson', seconds: 6 } });
  await page.evaluate(() => {
    LinglishStudyRecent.latest = () => ({ id: '42', title: 'Current lesson', seconds: 18, percent: 50 });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.match(await page.locator('.lx-home-continue').getAttribute('href'), /startSec=18$/);
  assert.match(await page.locator('.lx-home-continue').textContent(), /Current lesson/);
  await page.evaluate(() => { document.getElementById('user-info').hidden = true; });
  await page.waitForFunction(() => !document.documentElement.classList.contains('lx-app-home'));
  await page.evaluate(() => {
    LinglishStudyRecent.latest = () => ({ id: '43', title: 'Another lesson', seconds: 30 });
    document.getElementById('user-display-name').textContent = 'Another learner';
    document.getElementById('user-info').hidden = false;
  });
  await page.waitForFunction(() => document.documentElement.classList.contains('lx-app-home'));
  assert.equal(await page.locator('.lx-home-continue').getAttribute('href'), './video-reader-desktop.html?videoId=43&startSec=30');
  assert.match(await page.locator('.lx-home-continue').textContent(), /Another lesson/);
});

test('home reads the latest resume target immediately when its card is activated', async (t) => {
  const page = await fixture(t, { home: true, recent: { id: '42', title: 'Earlier lesson', seconds: 6 } });
  await page.evaluate(() => {
    LinglishStudyRecent.latest = () => ({ id: '44', title: 'Latest lesson', seconds: 21 });
    document.querySelector('.lx-home-continue').addEventListener('click', event => event.preventDefault());
  });
  await page.locator('.lx-home-continue').click();
  assert.equal(await page.locator('.lx-home-continue').getAttribute('href'), './video-reader-desktop.html?videoId=44&startSec=21');
});

test('compact home provides four persistent destinations and hides them on desktop', async (t) => {
  const page = await fixture(t, { home: true });
  assert.equal(await page.locator('.lx-home-bottom-nav a, .lx-home-bottom-nav button').count(), 4);
  await page.getByRole('button', { name: '我的' }).click();
  assert.equal(await page.getByRole('button', { name: '退出登录', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.documentElement.classList.contains('lx-app-home'));
  assert.equal(await page.locator('.lx-home-bottom-nav').isVisible(), false);
});

for (const id of ['42', 'yt:demo_123', 'pod:episode-7']) {
  test(`home resumes supported recent media: ${id}`, async (t) => {
    const page = await fixture(t, { home: true, recent: { id, title: 'Recent lesson', percent: 42 } });
    const link = page.locator('.lx-home-continue');
    assert.match(await link.textContent(), /Recent lesson/);
    assert.equal(await link.getAttribute('href'), `./video-reader-desktop.html?videoId=${encodeURIComponent(id)}`);
  });
}

test('reopening more before its close animation ends keeps it open', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => { nav.open(); nav.close(); nav.open(); });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.lx-more-sheet').isVisible(), true);
  assert.equal(await page.locator('.lx-compact-more').getAttribute('aria-expanded'), 'true');
});

test('more traps keyboard focus, locks background scroll, then restores both', async (t) => {
  const page = await fixture(t);
  await page.locator('.lx-compact-more').click();
  assert.equal(await page.locator('body').evaluate(n => n.style.overflow), 'hidden');
  await page.locator('.lx-more-cancel').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.lx-more-panel'))), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.lx-more-sheet').isVisible(), false);
  assert.equal(await page.locator('body').evaluate(n => n.style.overflow), '');
  assert.equal(await page.locator('.lx-compact-more').evaluate(n => n === document.activeElement), true);
});

test('picker preserves the original action and prevents background interaction', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.picked = 0;
    LxCompactNav.openPicker({ title: '教材', sections: [{ rows: [{ label: '旅游口语', onSelect() { window.picked++; } }] }] });
  });
  assert.equal(await page.locator('#outside').evaluate(n => n.closest('[inert]') !== null), true);
  await page.getByRole('button', { name: '旅游口语' }).click();
  assert.equal(await page.evaluate(() => picked), 1);
  assert.equal(await page.locator('#outside').evaluate(n => n.closest('[inert]') !== null), false);
});

test('a hidden dialog does not suppress the optional onboarding invitation', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const hidden = document.createElement('div');
    hidden.hidden = true;
    hidden.innerHTML = '<div role="dialog" aria-modal="true">Hidden</div>';
    document.body.appendChild(hidden);
  });
  await page.addScriptTag({ path: path.join(frontend, 'js/onboarding-tour.js') });
  await page.evaluate(() => startLinglishTour([{ target: '#back', title: '返回' }], 'fixture-tour'));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.tour-invite').isVisible(), true);
  assert.equal(await page.locator('.tour-overlay').count(), 0, 'the invitation must not take over the screen');
});

test('email reminder waits only for visible dialogs and restores after close', async (t) => {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  t.after(() => page.close());
  await page.route('http://fixture.test/**', route => {
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<body><main>Lesson</main><div id="modal" hidden><div aria-modal="true" role="dialog">Setup</div></div></body>' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ email: 'learner@example.invalid', email_verified: false, email_delivery_configured: true }) });
  });
  await page.goto('http://fixture.test/lesson.html');
  await page.evaluate(() => localStorage.setItem('authToken', 'fixture-token'));
  await page.addScriptTag({ path: path.join(frontend, 'global-ui.js') });
  await page.evaluate(() => GlobalUI.checkEmailVerificationBanner());
  const banner = page.locator('#ll-email-verify-banner');
  await banner.waitFor({ state: 'attached' });
  assert.equal(await banner.isVisible(), true, 'hidden dialog must not hide the reminder');
  await page.evaluate(() => { document.getElementById('modal').hidden = false; });
  await page.waitForTimeout(80);
  assert.equal(await banner.isVisible(), false);
  await page.evaluate(() => { document.getElementById('modal').hidden = true; });
  await page.waitForTimeout(80);
  assert.equal(await banner.isVisible(), true);
});
