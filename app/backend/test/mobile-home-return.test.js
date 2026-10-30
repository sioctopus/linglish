const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.join(__dirname, '../../frontend');

function read(name) {
  return fs.readFileSync(path.join(frontend, name), 'utf8');
}

test('mobile section headers follow clean title + actions shell', () => {
  const today = read('mobile-today.html');
  assert.match(today, /class="page-title">今日</);
  assert.match(today, /class="header-link"[^>]*href="\.\/index-desktop\.html\?from=mobile_today"/);

  const pages = [
    ['mobile-explore.html', '探索世界'],
    ['mobile-power.html', '能量站'],
    ['mobile-arena.html', '实战场'],
    ['mobile-treasure.html', '成长中心'],
  ];

  for (const [name, title] of pages) {
    const source = read(name);
    assert.match(source, new RegExp(`class="page-title">${title}<`), name);
    assert.match(source, /class="bottom-nav"/, name);
    assert.match(source, /mobile-today\.html/, name);
  }
});
