const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const correctedAssets = new Set([
  '/js/auth-manager.js',
  '/js/first-lesson-entry.js',
  '/js/workbench/import-bridge.js',
  '/css/video-reader/components.css',
  '/js/video-reader/sentence-segments.js',
  '/js/video-reader/library-filter.js',
  '/js/video-reader/video-metadata-editor.js',
  '/js/video-reader/main.js',
  '/js/mobile-power-app.js',
  '/mobile-auth.js',
  '/i18n.js',
]);

function htmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(file) : entry.name.endsWith('.html') ? [file] : [];
  });
}

test('every HTML reference to corrected release assets expires the previously immutable URL', () => {
  const seen = new Set();
  for (const file of htmlFiles(frontend)) {
    const source = fs.readFileSync(file, 'utf8');
    const base = new URL(path.relative(frontend, file), 'https://app.example.test/');
    for (const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const url = new URL(match[1], base);
      if (url.origin !== base.origin || !correctedAssets.has(url.pathname)) continue;
      seen.add(url.pathname);
      assert.ok(
        Number(url.searchParams.get('v')) >= 20261019,
        `${path.relative(frontend, file)} must expire the previous ${url.pathname} cache`,
      );
    }
  }
  assert.deepEqual(seen, correctedAssets, 'all corrected assets must retain their page references');
});

test('reader script preloading and execution use the same corrected URL', () => {
  const source = fs.readFileSync(path.join(frontend, 'video-reader.html'), 'utf8');
  const preload = source.match(/<link\b[^>]*href=["']([^"']*\/js\/video-reader\/main\.js[^"']*)["'][^>]*>/)?.[1];
  const script = source.match(/<script\b[^>]*src=["']([^"']*\/js\/video-reader\/main\.js[^"']*)["'][^>]*>/)?.[1];
  assert.ok(preload);
  assert.equal(preload, script);
});
