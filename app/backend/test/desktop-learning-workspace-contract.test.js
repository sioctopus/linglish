const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPage } = require('./helpers/page-source');

const frontend = path.resolve(__dirname, '../../frontend');

function extractCssBlock(css, selector) {
  const selectorIndex = css.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `missing CSS selector: ${selector}`);
  const openIndex = css.indexOf('{', selectorIndex);
  assert.notEqual(openIndex, -1, `missing opening brace for: ${selector}`);

  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(openIndex + 1, index);
  }
  assert.fail(`missing closing brace for: ${selector}`);
}

test('desktop video reader keeps transcript and sticky core controls in focus mode', () => {
  const html = readPage('video-reader-desktop.html');
  const css = fs.readFileSync(path.join(frontend, 'styles/video-reader-pro.css'), 'utf8');
  const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

  assert.match(html, /js\/video-reader\/sentence-segments\.js/);
  assert.match(html, /body\.focus-mode \.transcript\s*\{[^}]*opacity:\s*1/s);
  assert.match(html, /body\.focus-mode \.shell\s*\{[^}]*minmax\(520px/s);
  assert.match(html, /body\.focus-mode \.transcript\s*\{[^}]*min-width:\s*520px/s);
  assert.match(html, /body\.focus-mode #video-meta\s*\{[^}]*display:\s*none/s);
  assert.match(html, /id="focus-toggle"[^>]*>[\s\S]*focus-toggle__icon--off[\s\S]*focus-toggle__label/);
  assert.match(css, /\.vrp-control-dock\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /--vrp-accent:\s*var\(--brand,\s*#0d9488\)/);
  assert.match(css, /body\.focus-mode \.vrp-bar\s*\{[^}]*justify-content:\s*center/s);
  assert.match(css, /body\.focus-mode \.vrp-bar > \.vrp-bar__spacer/);
  assert.match(controls, /className = 'vrp-control-dock'/);
  assert.match(html, /body\.focus-mode \.player-wrap\s*\{[^}]*align-items:\s*center/s);
  // Absolute-positioned media collapses if focus mode drops aspect-ratio without a height chain.
  assert.doesNotMatch(html, /body\.focus-mode \.player\s*\{[^}]*aspect-ratio:\s*auto/s);
  assert.match(html, /body\.focus-mode \.panel\.main\s*\{[^}]*align-self:\s*stretch/s);
  assert.match(html, /body\.focus-mode \.player\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
});

test('desktop player preserves 16:9 when viewport height limits its size', () => {
  const html = readPage('video-reader-desktop.html');
  const workspaceCss = html.match(
    /\/\* ={10,}\s*Desktop learning workspace[\s\S]*?<\/style>/
  );

  assert.ok(workspaceCss, 'desktop learning workspace CSS should exist');
  const desktopMedia = extractCssBlock(workspaceCss[0], '@media (min-width: 1180px)');
  assert.match(html, /\.player\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(
    html,
    /id="player"[^>]*style="[^"]*width:100%;\s*height:100%[^"]*"/
  );
  assert.match(
    html,
    /id="youtube-player"[^>]*style="[^"]*width:100%;\s*height:100%[^"]*"/
  );
  assert.match(
    desktopMedia,
    /\.player\s*\{[^}]*width:\s*min\(100%,\s*calc\(min\(52vh,\s*560px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*width:\s*min\(100%,\s*calc\(min\(52dvh,\s*560px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*aspect-ratio:\s*16\s*\/\s*9/s
  );
  assert.doesNotMatch(
    html,
    /body:not\(\.focus-mode\) \.main \.player\s*\{[^}]*aspect-ratio:\s*auto/s
  );
  assert.match(
    desktopMedia,
    /body\.focus-mode \.player\s*\{[^}]*--lx-focus-player-width[^}]*--lx-focus-player-max-h/s
  );
  assert.match(
    desktopMedia,
    /min\(68dvh,\s*680px,\s*calc\(100dvh\s*-\s*210px\)\)/
  );
  assert.doesNotMatch(workspaceCss[0], /\.player\s*\{[^}]*max-height:\s*min\(38dvh/s);

  const tokens = fs.readFileSync(path.join(frontend, 'styles/tokens.css'), 'utf8');
  assert.match(tokens, /--lx-focus-player-max-h:\s*min\(68dvh,\s*680px,\s*calc\(100dvh\s*-\s*210px\)\)/);
  assert.match(tokens, /--lx-focus-player-width:\s*min\(100%,\s*calc\(min\(68dvh,\s*680px,\s*calc\(100dvh\s*-\s*210px\)\)\s*\*\s*16\s*\/\s*9\)\)/);
  const practiceCss = fs.readFileSync(path.join(frontend, 'styles/practice-session-desktop.css'), 'utf8');
  assert.match(practiceCss, /body\.practice-focus-active[\s\S]*--lx-focus-player-max-h/);
  assert.match(practiceCss, /body\.practice-focus-active[\s\S]*--lx-focus-player-width/);

  const expectedPlayer = ({ viewportHeight, availableWidth, heightRatio, heightCap }) => {
    const heightLimitedWidth = Math.min(viewportHeight * heightRatio, heightCap) * 16 / 9;
    const width = Math.min(availableWidth, heightLimitedWidth);
    return { width, height: width * 9 / 16 };
  };

  for (const scenario of [
    { viewportHeight: 787, availableWidth: 1432, heightRatio: 0.52, heightCap: 560 },
    { viewportHeight: 900, availableWidth: 680, heightRatio: 0.52, heightCap: 560 },
    { viewportHeight: 1080, availableWidth: 1152, heightRatio: 0.52, heightCap: 560 },
    { viewportHeight: 900, availableWidth: 1000, heightRatio: 0.68, heightCap: 680 }
  ]) {
    const size = expectedPlayer(scenario);
    assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.02);
    assert.ok(size.width <= scenario.availableWidth);
  }
});

test('desktop practice keeps a compact top mode bar and shared replay controller', () => {
  const html = readPage('practice-session-desktop.html');
  const css = fs.readFileSync(path.join(frontend, 'styles/practice-session-desktop.css'), 'utf8');

  assert.match(html, /js\/practice\/original-audio-replay\.js/);
  assert.match(html, /class="mode-top-bar"[^>]*data-workspace-position="top"/);
  assert.match(html, /id="practice-focus-badge"/);
  assert.match(html, /id="practice-focus-exit"/);
  assert.match(html, /id="practice-focus-toggle"/);
  assert.match(html, /practice-focus-toggle__label">专注</);
  assert.doesNotMatch(html, /<header class="script-head">\s*<h2>台词<\/h2>/);
  assert.match(html, /function enterPracticeFocus\(/);
  assert.match(html, /function togglePracticeFocus\(/);
  assert.match(html, /function exitPracticeFocus\(/);
  assert.match(html, /function handlePracticeFocusEscape\(/);
  assert.match(html, /function requestPracticeFullscreen\(/);
  assert.match(html, /function exitPracticeFullscreen\(/);
  assert.match(html, /addEventListener\('fullscreenchange'/);
  assert.match(css, /body\.practice-focus-active > \.topbar\s*\{[^}]*display:\s*none/s);
  assert.match(css, /body\.practice-focus-active\s*\{[^}]*--lx-focus-inset:\s*24px/s);
  assert.match(css, /padding:\s*var\(--lx-focus-inset,\s*24px\)/);
  assert.match(css, /body\.practice-focus-active \.practice-stage-spacer\s*\{[^}]*display:\s*none/s);
  assert.match(css, /body\.practice-focus-active \.practice-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(360px/s);
  assert.doesNotMatch(css, /100dvh - \(var\(--lx-focus-inset,\s*24px\) \* 2\) - 52px/);
  const tokens = fs.readFileSync(path.join(frontend, 'styles/tokens.css'), 'utf8');
  assert.match(tokens, /--lx-focus-inset:\s*24px/);
  assert.match(tokens, /--lx-focus-gap:\s*16px/);
  const readerHtml = readPage('video-reader-desktop.html');
  assert.match(readerHtml, /body\.focus-mode \.layout\s*\{[^}]*padding:\s*var\(--lx-focus-inset,\s*24px\)/s);
  assert.match(css, /body\.practice-focus-active \.mode-top-bar/);
  assert.match(css, /\.practice-focus-badge\s*\{[^}]*#0f766e/s);
  assert.match(css, /body\.dialogue-focus-layout \.mode-top-bar/);
  assert.match(css, /body\.dialogue-focus-layout #desktop-controls-container\s*\{[^}]*display:\s*block/s);
  assert.doesNotMatch(css, /body\.dialogue-focus-layout #desktop-controls-container\s*\{\s*display:\s*none\s*!important/s);
  assert.doesNotMatch(css, /body\.dialogue-focus-layout \.mode-top-bar::before/);
});

test('desktop video reader exposes one canonical playback progress rail', () => {
  const html = readPage('video-reader-desktop.html');
  const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

  assert.match(controls, /scrub\.className = 'vrp-scrub'/);
  assert.doesNotMatch(html, /class="video-progress-row"/);
  assert.doesNotMatch(html, /id="video-progress-fill"/);
  assert.doesNotMatch(html, /id="video-progress-time"/);
  assert.match(html, /id="video-progress-label"/);
  assert.match(html, /id="extract-words-cta"/);
  assert.match(
    html,
    /function updateVideoProgress\(currentTime, duration\)[\s\S]*videoProgressLabelEl\.textContent = `已完成 \$\{percent\}%`[\s\S]*recordVideoProgress/
  );
});

test('video learning and AI practice share one workspace switch', () => {
  const reader = readPage('video-reader-desktop.html');
  const practice = readPage('practice-session-desktop.html');
  const markup = /id="study-switch"[\s\S]*data-study="video"[\s\S]*data-study="coach"[\s\S]*data-study="arena"/;

  assert.match(reader, markup);
  assert.match(practice, markup);
  assert.match(practice, /data-library="videos"[\s\S]*视频库[\s\S]*data-library="channels"[\s\S]*频道库[\s\S]*data-library="podcasts"[\s\S]*播客/);
  assert.match(reader, /id="nav-library-switch"[\s\S]*选择视频库[\s\S]*选择频道库[\s\S]*选择播客/);
  assert.doesNotMatch(reader, /id="open-channel-browser"/);
  assert.doesNotMatch(reader, /id="open-podcast-browser"/);
  assert.match(reader, /returnTo'\) === 'coach'/);
  assert.match(practice, /source'\) === 'external'/);
});

test('study menu switches without a loader delay', () => {
  const reader = readPage('video-reader-desktop.html');
  const practice = readPage('practice-session-desktop.html');
  const study = fs.readFileSync(path.join(frontend, 'js/study-switch.js'), 'utf8');

  assert.match(reader, /getElementById\('pageLoader'\)\?\.remove\(\)/);
  assert.match(practice, /getElementById\('pageLoader'\)\?\.remove\(\)/);
  assert.doesNotMatch(reader, /setTimeout\(hidePageLoader/);
  assert.doesNotMatch(practice, /setTimeout\(hidePageLoader/);
  assert.match(study, /switchPracticeMode/);
  assert.match(study, /prefetchDocument/);
  assert.match(study, /switchVideoStudyMode/);
  assert.match(study, /onVideoReader/);
  assert.match(reader, /openCoachLibraryIfRequested\(\)/);
  assert.match(reader, /js\/video-reader\/sentence-path\.js/);
  const sentencePath = fs.readFileSync(path.join(frontend, 'js/video-reader/sentence-path.js'), 'utf8');
  assert.match(sentencePath, /id="sentence-listen"/);
  assert.match(sentencePath, /id="sentence-shadow"/);
  assert.match(sentencePath, /id="sentence-review"/);
  assert.match(sentencePath, /重复播放/);
  assert.match(sentencePath, /toggleRepeatPractice|startRepeatPractice/);
  assert.match(sentencePath, /existing\.remove\(\)|sentence-path[\s\S]*remove/);
  assert.doesNotMatch(sentencePath, /复习这句的词/);
  assert.doesNotMatch(sentencePath, /#vocabulary/);
  assert.match(sentencePath, /switchVideoStudyMode/);
  assert.match(sentencePath, /shadowCurrent/);
  assert.doesNotMatch(sentencePath, /practice-session-desktop\.html/);
  const coachingDock = fs.readFileSync(path.join(frontend, 'js/video-reader/coaching-dock.js'), 'utf8');
  assert.match(coachingDock, /function shadowCurrent/);
  assert.match(coachingDock, /function listenCurrent/);
  assert.match(coachingDock, /openToolsFor\(index,\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(coachingDock, /practiceSegment/);
  assert.match(coachingDock, /LinglishShadowMic|recordShadow/);
  assert.match(coachingDock, /compareShadowWithOriginal|data-action="compare"|'compare'/);
  assert.match(reader, /js\/practice\/shadow-mic\.js/);
  const mobileReader = readPage('video-reader.html');
  assert.match(mobileReader, /js\/practice\/shadow-mic\.js/);
  assert.match(mobileReader, /id="mobile-hear-me-btn"/);
  assert.match(reader, /js\/video-reader\/desktop-x-hold\.js/);
  const desktopHold = fs.readFileSync(path.join(frontend, 'js/video-reader/desktop-x-hold.js'), 'utf8');
  assert.match(desktopHold, /hearBtn\.id = 'desk-hear-me'/);
  const coachingMode = fs.readFileSync(path.join(frontend, 'js/video-reader/coaching-mode.js'), 'utf8');
  assert.match(coachingMode, /id: 'hear-me'/);
  assert.match(coachingMode, /id: 'compare'/);
  assert.match(practice, /createOriginalAudioReplayController/);
  assert.match(practice, /\/pronunciation\/assess/);
});
