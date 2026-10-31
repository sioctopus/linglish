const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('signed-in pricing training entry opens the video reader, not the today page', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/pricing.html'), 'utf8');
  const entry = source.slice(source.indexOf('function trainingUrl'), source.indexOf('const loginLink'));
  assert.match(entry, /video-reader\.html/);
  assert.match(entry, /video-reader-desktop\.html/);
  assert.match(entry, /from=pricing_nav/);
  assert.doesNotMatch(entry, /today\.html/);
  assert.match(source, /loginLink\.href = trainingUrl\(\)/);
});
