const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ROOT = path.resolve(__dirname, '../..');
const FRONTEND_ROOT = path.join(APP_ROOT, 'frontend');
const BACKEND_ROOT = path.join(APP_ROOT, 'backend');

function productionSources(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionSources(absolute));
    else if (/\.(?:js|html)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function read(relativePath) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8');
}

test('production OAuth and group-chat URL producers never place account JWTs in URLs', () => {
  const sources = [...productionSources(FRONTEND_ROOT), ...productionSources(BACKEND_ROOT)];
  const violations = [];

  for (const filename of sources) {
    const source = fs.readFileSync(filename, 'utf8');
    const relative = path.relative(APP_ROOT, filename);
    if (/#token=\$\{|#token=.*encodeURIComponent\s*\(\s*token/i.test(source)) {
      violations.push(`${relative}: OAuth account-token fragment producer`);
    }
    if (/\/ws\/group-chat[^\n]{0,300}[?&]token=/i.test(source)) {
      violations.push(`${relative}: group-chat account-token URL producer`);
    }
  }

  assert.deepEqual(violations, []);
});

test('admin pages never source account authentication from location query parameters', () => {
  const adminFiles = productionSources(FRONTEND_ROOT)
    .filter(filename => /^admin(?:-|\.)/.test(path.basename(filename)));
  const violations = [];

  for (const filename of adminFiles) {
    const source = fs.readFileSync(filename, 'utf8');
    if (/new URLSearchParams\s*\(\s*(?:window\.)?location\.search\s*\)[\s\S]{0,180}?\.get\s*\(\s*['"]token['"]\s*\)/i.test(source)) {
      violations.push(path.relative(APP_ROOT, filename));
    }
    if (/params\.get\s*\(\s*['"]token['"]\s*\)/i.test(source) && /URLSearchParams\s*\(\s*(?:window\.)?location\.search/i.test(source)) {
      violations.push(path.relative(APP_ROOT, filename));
    }
  }

  assert.deepEqual([...new Set(violations)], []);
});

test('backend generic and admin authentication leave legacy query JWTs only to explicit static media routes', () => {
  const violations = [];
  for (const filename of productionSources(BACKEND_ROOT)) {
    const relative = path.relative(APP_ROOT, filename);
    if (relative === 'backend/routes/static.js') continue;
    const source = fs.readFileSync(filename, 'utf8');
    if (/searchParams\.get\s*\(\s*['"]token['"]\s*\)/i.test(source)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test('purpose-scoped reset, verify, share, and group-chat ticket URL parameters remain explicit', () => {
  const auth = read('backend/services/auth.js');
  const desktopPractice = read('frontend/practice-session-desktop.html');
  const groupDetail = read('frontend/group-detail.html');

  assert.match(auth, /reset-password\.html\?token=/);
  assert.match(auth, /verify-email\.html\?token=/);
  assert.match(desktopPractice, /practice-shares\/\$\{encodeURIComponent\(token\)\}/);
  assert.match(groupDetail, /\/auth\/ws-ticket/);
  assert.match(groupDetail, /[?&]ticket=\$\{encodeURIComponent\(ticket\)\}/);
  assert.doesNotMatch(groupDetail, /\/ws\/group-chat[^\n]{0,300}[?&]token=/i);
});

test('OAuth bootstrap is shared by all callback pages and keeps the established storage keys', () => {
  const bootstrap = read('frontend/js/oauth-bootstrap.js');
  for (const page of ['frontend/index-desktop.html', 'frontend/mobile-auth.html', 'frontend/welcome.html']) {
    assert.match(read(page), /js\/oauth-bootstrap\.js/, `${page} must load the shared OAuth bootstrap`);
  }
  assert.match(bootstrap, /\/auth\/oauth\/session/);
  assert.match(bootstrap, /AuthManager\.setToken\s*\(\s*token\s*,\s*true\s*\)/);
  assert.match(bootstrap, /['"]linglish_token['"]/);
  assert.match(bootstrap, /['"]authToken['"]/);
  assert.doesNotMatch(bootstrap, /location\.(?:hash|search).*get\s*\(\s*['"]token['"]/i);
});

test('new OAuth assets explicitly request cookie_v1 and never consume legacy token fragments', () => {
  const desktop = read('frontend/index-desktop.html');
  const mobile = read('frontend/mobile-auth.html');
  const welcome = read('frontend/welcome.html');

  assert.match(desktop, /auth\/oauth\/google[^`"']*flow=cookie_v1/);
  assert.match(mobile, /auth\/google[^`"']*flow=cookie_v1/);
  assert.match(mobile, /scopedResult\.redirect_url[\s\S]{0,300}?window\.location\.(?:href|replace)/,
    'mobile must navigate from the signed redirect intent after exchange');
  for (const [name, source] of Object.entries({ desktop, mobile, welcome })) {
    assert.doesNotMatch(source, /location\.hash[\s\S]{0,500}?\.get\s*\(\s*['"]token['"]\s*\)/i,
      `${name} must not read an account token from a fragment`);
    assert.doesNotMatch(source, /hash\.includes\s*\(\s*['"]token=/i,
      `${name} must not detect the legacy account-token fragment`);
  }
});

test('cookie-flow bootstrap visibly fails and its ready barrier protects a cached mobile session', async () => {
  const source = read('frontend/js/oauth-bootstrap.js');
  const mobile = read('frontend/mobile-auth.html');
  let resolveFetch;
  let storedToken = 'old-account-token';
  const banner = {
    children: [],
    classList: { add() {} },
    replaceChildren(...children) { this.children = children; },
  };
  const document = {
    dispatched: [],
    getElementById(id) { return id === 'oauthErrorBanner' ? banner : null; },
    createElement(tag) {
      return {
        tag,
        children: [],
        style: {},
        addEventListener(name, handler) { this[name] = handler; },
        append(...children) { this.children.push(...children); },
      };
    },
    dispatchEvent(event) { this.dispatched.push(event); },
    body: { prepend() {} },
  };
  const location = {
    href: 'https://linglish.test/mobile-auth.html?oauth=cookie_v1&next=%2Fmobile-today.html',
    pathname: '/mobile-auth.html',
    search: '?oauth=cookie_v1&next=%2Fmobile-today.html',
    hash: '',
    origin: 'https://linglish.test',
  };
  const context = {
    URL,
    URLSearchParams,
    Promise,
    CustomEvent: function CustomEvent(name, init) { this.type = name; this.detail = init.detail; },
    document,
    history: { replaceState() {} },
    location,
    localStorage: { setItem() {}, removeItem() {} },
    sessionStorage: { removeItem() {} },
    AuthManager: {
      getToken: () => storedToken,
      async setToken(token) { storedToken = token; },
    },
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'oauth-bootstrap.js' });

  let cachedRedirects = 0;
  const cachedSessionGate = (async () => {
    if (context.LinglishOAuthBootstrap.isCookieFlow()) {
      await context.LinglishOAuthBootstrap.ready;
      return;
    }
    cachedRedirects += 1;
  })();
  await Promise.resolve();
  assert.equal(cachedRedirects, 0);
  assert.equal(storedToken, 'old-account-token');

  resolveFetch({
    ok: false,
    json: async () => ({ message: 'temporary failure' }),
  });
  const result = await context.LinglishOAuthBootstrap.ready;
  await cachedSessionGate;
  assert.equal(result.error, 'OAUTH_SESSION_FAILED');
  assert.equal(cachedRedirects, 0);
  assert.ok(banner.children.length > 0, 'a visible retry terminal must be rendered');
  assert.ok(document.dispatched.some(event => event.type === 'linglish:oauth-session-error'));

  assert.match(mobile, /LinglishOAuthBootstrap\.isCookieFlow\(\)[\s\S]{0,180}?await\s+window\.LinglishOAuthBootstrap\.ready/);
});

test('cookie-flow bootstrap renders a retryable error after an early head-load failure', async () => {
  const source = read('frontend/js/oauth-bootstrap.js');
  const mobile = read('frontend/mobile-auth.html');
  let domContentLoadedHandler = null;
  let fetchSettled = false;
  let replacedUrl = null;
  let assignedUrl = null;
  const prepended = [];
  const document = {
    body: null,
    getElementById() { return null; },
    addEventListener(name, handler) {
      if (name === 'DOMContentLoaded') domContentLoadedHandler = handler;
    },
    createElement(tag) {
      return {
        tag,
        children: [],
        handlers: {},
        style: {},
        classes: new Set(),
        classList: { add(name) { this.owner.classes.add(name); }, owner: null },
        addEventListener(name, handler) { this.handlers[name] = handler; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
      };
    },
    dispatchEvent() {},
  };
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = originalCreateElement(tag);
    node.classList.owner = node;
    return node;
  };
  const location = {
    href: 'https://linglish.test/mobile-auth.html?oauth=cookie_v1&next=%2Fmobile-today.html',
    pathname: '/mobile-auth.html',
    search: '?oauth=cookie_v1&next=%2Fmobile-today.html',
    hash: '',
    assign(url) { assignedUrl = url; },
  };
  const context = {
    URL,
    URLSearchParams,
    Promise,
    document,
    history: { replaceState(_state, _title, url) { replacedUrl = url; } },
    location,
    localStorage: { setItem() {}, removeItem() {} },
    sessionStorage: { removeItem() {} },
    fetch: async () => {
      fetchSettled = true;
      return { ok: false, json: async () => ({ message: 'internal detail' }) };
    },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'oauth-bootstrap.js' });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchSettled, true, 'the exchange must be allowed to fail while the head is loading');
  document.body = { prepend(node) { prepended.push(node); } };
  if (domContentLoadedHandler) domContentLoadedHandler();

  const result = await context.LinglishOAuthBootstrap.ready;
  assert.equal(result.error, 'OAUTH_SESSION_FAILED');
  assert.equal(replacedUrl, '/mobile-auth.html?next=%2Fmobile-today.html');
  assert.equal(prepended.length, 1, 'a generic retry terminal must appear once the DOM is ready');
  const terminal = prepended[0];
  assert.equal(terminal.id, 'oauth-session-error');
  assert.ok(terminal.classes.has('show'));
  assert.equal(terminal.children[0].textContent, '登录会话未完成，请重试。');
  assert.equal(terminal.children[1].textContent, '重试 Google 登录');
  terminal.children[1].handlers.click();
  assert.match(assignedUrl, /^\/auth\/oauth\/google\?/);
  assert.match(assignedUrl, /(?:^|[?&])flow=cookie_v1(?:&|$)/);
  assert.match(assignedUrl, /(?:^|[?&])mobile=1(?:&|$)/);
  assert.doesNotMatch(assignedUrl, /oauth=cookie_v1/);
  assert.match(
    mobile,
    /scopedResult\s*&&\s*scopedResult\.error[\s\S]{0,180}?showToast\s*\(/,
    'mobile callback handling must explicitly surface scoped exchange errors',
  );
});

test('diagnostic pages expose useful state but no token previews or full authentication responses', () => {
  const quickFix = read('frontend/quick-fix.html');
  const testAuth = read('frontend/test-auth.html');
  const combined = `${quickFix}\n${testAuth}`;

  assert.doesNotMatch(combined, /token\s*\.\s*(?:substring|slice)\s*\(/i);
  assert.doesNotMatch(combined, /Token Preview|预览\s*:/i);
  assert.doesNotMatch(combined, /console\.log\s*\(\s*['"](?:Response data|Login response|Token received)/i);
  assert.doesNotMatch(testAuth, /localStorage\.getItem\s*\(\s*key\s*\)/);
  assert.match(combined, /localStorage/i);
  assert.match(combined, /Cookies Enabled|Cookies 启用/i);
});
