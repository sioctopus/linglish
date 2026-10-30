const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const knownLogSites = [
  'frontend/mobile-auth.html',
  'frontend/mobile-auth.js',
  'frontend/js/auth-manager.js',
  'frontend/js/app/main.js',
  'frontend/reader.html',
  'frontend/pdf-reader.html',
  'frontend/mobile-explore.html',
  'frontend/video-reader-desktop.html',
  'frontend/js/video-reader/main.js',
  'frontend/practice-session.html',
  'frontend/practice-session-desktop.html',
  'frontend/practice-session-refactored.html',
  'frontend/js/practice-session/api-client.js',
  'frontend/js/practice-session/audio-manager.js',
  'backend/middleware/auth.js',
  'backend/routes/videos.js',
  'backend/routes/static.js',
];

function extractConsoleCalls(source) {
  const calls = [];
  const pattern = /console\.(?:log|info|debug|warn|error)\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 1;
    let quote = null;
    let escaped = false;
    let index = pattern.lastIndex;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '/' && next === '/') {
        index = source.indexOf('\n', index);
        if (index === -1) index = source.length;
        continue;
      }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    calls.push(source.slice(match.index, index));
    pattern.lastIndex = index;
  }
  return calls;
}

test('known Task 2 logs reject multiline source payloads, token lengths, identifiers, and query URLs', () => {
  const legacyForbidden = /tokenPreview|token[^\n]*substring|substring[^\n]*token|response data|invalid token received|guest login response missing token|received token:|state\.token:|user data:|video url:|loading pdf from:|loading video:|audio url:|playing audio from:/i;
  const structuredForbidden = /\b(?:tokenLength|savedTokenLength|guest_id|guestId|currentSrc|audioSrc)\b|(?:[,{]\s*)(?:src|source)\s*:|\.src\b|,\s*(?:allUrl|candidateUrl|filePath|src|(?:video|resource)\.(?:video_path|local_video_path))\s*(?:[,)}]|$)|\$\{(?:video|resource)\.(?:video_path|local_video_path)\}|:\s*(?:video|resource)\.(?:video_path|local_video_path)\b/i;
  for (const relativePath of knownLogSites) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /tokenPreview/i, `${relativePath} contains a token preview`);
    for (const call of extractConsoleCalls(source)) {
      assert.doesNotMatch(call, legacyForbidden, `${relativePath} contains a sensitive debug log: ${call}`);
      assert.doesNotMatch(call, structuredForbidden, `${relativePath} logs structured sensitive data: ${call}`);
      if (relativePath.includes('practice-session')) {
        assert.doesNotMatch(call, /\bcacheKey\b/i, `${relativePath} logs a media-source-derived cache key: ${call}`);
      }
      assert.doesNotMatch(call, /https?:\/\/[^\s'"`]+\?[^\s'"`]*/i, `${relativePath} logs a full query URL: ${call}`);
    }
  }
});

test('backend auth failures and share feedback logs expose no credential value', () => {
  const auth = read('backend/middleware/auth.js');
  assert.doesNotMatch(auth, /token\.slice|tokenPreview|authorization[^\n]*:/i);
  assert.match(auth, /authHeaderPresent/);

  const videos = read('backend/routes/videos.js');
  const feedbackLog = videos.match(/console\.log\(['"]\[ShareFeedback\][\s\S]*?\n\s*}\);/);
  assert.ok(feedbackLog, 'share feedback should retain an anonymous operational log');
  assert.doesNotMatch(feedbackLog[0], /shareToken|comment\s*,/);
});

test('logout and account-switch paths clear the media cookie through the shared client', () => {
  const mobileManager = read('frontend/mobile-auth.js');
  assert.match(mobileManager, /logout\(\)[\s\S]*?LinglishMediaSession[\s\S]*?clear\(/);

  const authManager = read('frontend/js/auth-manager.js');
  assert.match(authManager, /setToken[\s\S]*?clearMediaSession/);
  assert.match(authManager, /clearToken[\s\S]*?clearMediaSession/);

  const appMain = read('frontend/js/app/main.js');
  assert.match(appMain, /logout-btn[\s\S]*?clearMediaSession/);
  assert.match(appMain, /catch \(err\)[\s\S]*?clearMediaSession/);

  const authPage = read('frontend/mobile-auth.html');
  assert.match(authPage, /Clearing old auth data[\s\S]*?LinglishMediaSession[\s\S]*?clear\(/);
  assert.match(authPage, /await window\.AuthManager\.clearToken\(/);
  assert.match(authPage, /await window\.AuthManager\.setToken\(/);
  assert.match(authPage, /async function handleOAuthCallback\(\)[\s\S]*?LinglishOAuthBootstrap\.ready/);
  assert.doesNotMatch(authPage, /location\.hash[\s\S]{0,500}?\.get\(['"]token['"]\)/);
  const oauthBootstrap = read('frontend/js/oauth-bootstrap.js');
  assert.match(oauthBootstrap, /AuthManager\.setToken\(token, true\)/);

  const reader = read('frontend/js/video-reader/main.js');
  assert.match(reader, /await window\.AuthManager\.clearToken\(\)/);
  assert.doesNotMatch(reader, /\/auth\/guest/);

  const practice = read('frontend/practice-session.html');
  assert.match(practice, /await window\.AuthManager\.clearToken\(\)/);
  assert.doesNotMatch(practice, /\/auth\/guest/);

  const appMainSource = read('frontend/js/app/main.js');
  assert.doesNotMatch(appMainSource, /\/auth\/guest/);
});

test('PDF route logs only query-free request paths or anonymous error codes', () => {
  const source = read('backend/routes/static.js');
  const route = source.match(/\/\/ GET \/pdfs\/\*[\s\S]*?\/\/ GET\/HEAD \/\*/)?.[0] || '';
  assert.ok(route, 'PDF route must remain present');
  assert.doesNotMatch(route, /console\.(?:log|warn|error)\([^)]*(?:filePath|err\.message)/);
  assert.doesNotMatch(route, /url\.(?:href|search)|req\.url/);
});

test('mobile practice sanitizes debug payloads before both console and DOM output', () => {
  const source = read('frontend/practice-session.html');
  const sink = source.match(/function pushDebug\(message, payload = null\)[\s\S]*?^\s{6}}/m)?.[0] || '';
  assert.ok(sink, 'pushDebug must remain present');
  assert.match(sink, /sanitizeDebugPayload\(payload\)/);
  assert.match(sink, /console\.info\([^;]*safePayload/);
  assert.match(sink, /JSON\.stringify\(safePayload/);
  assert.doesNotMatch(sink, /console\.info\([^;]*,\s*payload\)/);
  assert.doesNotMatch(sink, /JSON\.stringify\(payload/);
});
