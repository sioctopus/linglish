const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '../../frontend');
const pagePath = path.join(frontendRoot, 'video-reader.html');
const stylePath = path.join(frontendRoot, 'styles/mobile/pages/video-reader-focus.css');

test('mobile reader uses the focused page shell without removing learning hooks', () => {
  const html = fs.readFileSync(pagePath, 'utf8');

  assert.match(html, /<body[^>]*class="[^"]*video-reader-mobile-focus[^"]*"/);
  assert.match(html, /styles\/mobile\/pages\/video-reader-focus\.css/);
  assert.doesNotMatch(html, /video-reader-minimal/);
  assert.match(html, /class="[^"]*video-sidebar[^"]*hidden[^"]*"[^>]*id="video-sidebar"/);
  assert.match(html, /id="video-wrapper"/);
  assert.match(html, /id="mobile-transcript"/);
  assert.match(html, /id="mobile-player-controls"/);
  assert.match(html, /id="toggle-sidebar-btn"[^>]*aria-controls="video-sidebar"/);
});

test('mobile focus stylesheet protects the viewport and prioritizes learning content', () => {
  assert.equal(fs.existsSync(stylePath), true, 'focused mobile stylesheet should exist');
  const css = fs.readFileSync(stylePath, 'utf8');

  assert.match(css, /@media\s*\(\s*max-width:\s*1023px\s*\)/);
  assert.match(css, /\(max-height:\s*500px\)\s*and\s*\(hover:\s*none\)/);
  assert.match(css, /body\.video-reader-mobile-focus/);
  assert.match(css, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.mobile-transcript-view/);
  assert.match(css, /\.mobile-player-controls/);
  assert.match(css, /overflow-x:\s*(?:hidden|clip)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(
    css,
    /body\.video-reader-mobile-focus \.speed-control-overlay\s*\{[^}]*position:\s*absolute/s
  );
  assert.match(
    css,
    /body\.video-reader-mobile-focus \.speed-floating-menu\s*\{[^}]*display:\s*none/s
  );
});
