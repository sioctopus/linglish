const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildClassNote, createClassNote } = require('../services/class-note');

test('a kindergarten word becomes a short note parents can hear', () => {
  const note = buildClassNote('cola');
  assert.equal(note.kind, 'class-note');
  assert.equal(note.word, 'cola');
  assert.deepEqual(note.lines, [
    'cola',
    'Cola please',
    'May I have cola please?',
    'Here you are',
    'Thank you',
  ]);
});

test('saving a class note keeps the card image and a parent link', async () => {
  const copied = [];
  const result = await createClassNote({ ownerUserId: 7,
    word: 'milk',
    lines: ['Milk please', 'Thank you'],
    image: { path: '/tmp/card.jpg', originalFilename: 'card.jpg', size: 1200 },
  }, {
    mkdir: async () => {},
    copyFile: async (from, to) => copied.push({ from, to }),
    unlink: async () => {},
    stat: async (target) => {
      if (String(target).includes('card.jpg') || copied.some((item) => item.to === target)) {
        return { size: 1200 };
      }
      return { size: 0 };
    },
    query: async (sql, params) => {
      assert.match(sql, /INSERT INTO articles/);
      assert.equal(params[0], 'Milk please');
      const stored = JSON.parse(params[1]);
      assert.equal(stored.kind, 'class-note');
      assert.match(stored.image, /^\/note-images\/note-/);
      assert.deepEqual(stored.lines, ['Milk please', 'Thank you']);
      return { rows: [{ id: 8, title: 'Milk please' }] };
    },
  });
  assert.equal(copied.length, 1);
  assert.equal(result.note.openUrl, './class-note.html?id=8');
});

test('empty uploaded images are rejected before saving a note', async () => {
  await assert.rejects(
    () => createClassNote({ ownerUserId: 7,
      word: 'milk',
      image: { path: '/tmp/empty.jpg', originalFilename: 'empty.jpg', size: 0 },
    }, {
      mkdir: async () => {},
      copyFile: async () => { throw new Error('should not copy'); },
      stat: async () => ({ size: 0 }),
    }),
    /没有上传完整/
  );
});

test('route save uses the database when no query dep is passed', async () => {
  const service = fs.readFileSync(path.join(__dirname, '../services/class-note.js'), 'utf8');
  assert.match(service, /deps\.query \|\| defaultQuery/);
  assert.match(service, /dataStore\.pool\.query/);
});

test('the home page links the class note and the picture route is protected', () => {
  const root = path.resolve(__dirname, '../..');
  const home = fs.readFileSync(path.join(root, 'frontend/index-desktop.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/class-note.html'), 'utf8');
  const documents = fs.readFileSync(path.join(root, 'backend/routes/documents.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
  const staticRoutes = fs.readFileSync(path.join(root, 'backend/routes/static.js'), 'utf8');
  assert.doesNotMatch(home, /hero-guest-class-note/);
  assert.doesNotMatch(home, /hero-user-class-note/);
  assert.doesNotMatch(home, /hero-guest-workbench/);
  assert.doesNotMatch(home, /hero-user-workbench/);
  assert.match(home, /id="nav-workbench-link"[^>]*href="\.\/workbench\.html"|href="\.\/workbench\.html"[^>]*id="nav-workbench-link"/);
  assert.match(page, /复制私有链接/);
  assert.match(page, /仅本人或管理员.*可查看/);
  assert.doesNotMatch(page, /家长点开|发到微信群|发给家长/);
  assert.match(page, /返回修改/);
  assert.match(page, /showComposer/);
  assert.match(page, /max-height:\s*min\(42vh,\s*360px\)/);
  assert.match(page, /safe-area-inset-bottom/);
  assert.match(page, /\/articles\/\$\{encodeURIComponent\(noteId\)\}/);
  assert.match(page, /\/tts\/practice/);
  assert.match(page, /data-speak/);
  assert.match(page, /showShare\(true\)/);
  assert.match(page, /unlockAudio/);
  assert.match(page, /copy-btn.*addEventListener/s);
  assert.match(page, /workbench\.html\?mode=class-note/);
  const workbench = fs.readFileSync(path.join(root, 'frontend/workbench.html'), 'utf8');
  const workbenchNote = fs.readFileSync(path.join(root, 'frontend/js/workbench/class-note.js'), 'utf8');
  assert.match(workbench, /课后微信笔记/);
  assert.match(workbench, /wb-tool-class-note/);
  assert.match(workbenchNote, /\/class-notes/);
  assert.match(workbenchNote, /class-note\.html\?id=/);
  assert.match(workbench, /复制私有链接/);
  assert.match(workbenchNote, /仅本人或管理员.*可查看/);
  assert.doesNotMatch(workbenchNote, /家长点开|发到微信群|发给家长/);
  assert.match(documents, /pathname === '\/class-notes'/);
  assert.match(server, /pathname === '\/class-notes'/);
  assert.match(staticRoutes, /\/note-images\//);
  const sw = fs.readFileSync(path.join(root, 'frontend/sw.js'), 'utf8');
  assert.match(sw, /\/articles/);
  assert.match(sw, /NETWORK_ONLY_PREFIXES/);
});
