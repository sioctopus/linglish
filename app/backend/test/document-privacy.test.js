const test = require('node:test');
const assert = require('node:assert/strict');
const { importLearningDocument, rebuildReadingSubtitles } = require('../services/document-import');
const { createClassNote } = require('../services/class-note');
const workbench = require('../services/workbench');
const owner = { id: 7 };
test('document import requires an owner before storing private content', async () => {
  let queried = false;
  await assert.rejects(() => importLearningDocument({ text: 'This is a private lesson.' }, {
    query: async () => { queried = true; return { rows: [{ id: 1 }] }; },
  }), err => err.statusCode === 401);
  assert.equal(queried, false);
});
test('imported text stores its owner and private visibility', async () => {
  await importLearningDocument({ ownerUserId: owner.id, text: 'This is a private lesson.' }, {
    query: async (sql, params) => {
      assert.match(sql, /owner_user_id/); assert.match(sql, /'private'/); assert.equal(params.at(-1), owner.id);
      return { rows: [{ id: 1, title: 'Private lesson' }] };
    },
  });
});
test('class note stores ownership and an exact protected image path', async () => {
  await createClassNote({ ownerUserId: owner.id, word: 'milk', image: { path: '/tmp/card.png', originalFilename: 'card.png', size: 4 } }, {
    mkdir: async () => {}, copyFile: async () => {}, stat: async () => ({ size: 4 }), unlink: async () => {},
    query: async (sql, params) => {
      assert.match(sql, /owner_user_id/); assert.match(sql, /note_image_path/); assert.match(sql, /'private'/);
      assert.equal(params.at(-2), owner.id); assert.match(params.at(-1), /^\/note-images\/note-/);
      return { rows: [{ id: 1 }] };
    },
  });
});
test('subtitle rebuild rejects another user before OCR or writing', async () => {
  let read = false;
  await assert.rejects(() => rebuildReadingSubtitles({ id: 1, owner_user_id: owner.id, pdf_path: '/pdfs/private.pdf' }, {
    user: { id: 8 }, extractText: async () => { read = true; return 'Private sentence.'; }, query: async () => ({ rows: [{ id: 1 }] }),
  }), err => err.statusCode === 403);
  assert.equal(read, false);
});
test('workbench drafts have no active share until explicitly published', async () => {
  const saved = await workbench.createDocument({ text: 'Please read this private lesson.' }, owner.id, {
    query: async (sql, params) => ({ rows: [{ id: 1, user_id: owner.id, share_token: params[7] }] }),
  });
  assert.equal(saved.document.shareToken, null); assert.equal(saved.document.shareUrl, null);
});
test('practice publishing cannot overwrite an article owned by another user', async () => {
  let articleWrite = false;
  await assert.rejects(() => workbench.createPracticeLink(1, owner.id, {}, {
    query: async (sql, params) => {
      if (/SELECT \* FROM workbench_documents/.test(sql)) return { rows: [{ id: 1, user_id: owner.id, source_text: 'Read this sentence aloud.', practice_article_id: 55 }] };
      if (/UPDATE articles/.test(sql)) { articleWrite = true; assert.match(sql, /owner_user_id/); assert.equal(params.at(-1), owner.id); return { rows: [], rowCount: 0 }; }
      throw new Error('must not publish an unowned article');
    },
  }), err => err.statusCode === 404);
  assert.equal(articleWrite, true);
});

test('simultaneous imports with the same source name never reuse a private PDF path', async t => {
  t.mock.method(Date, 'now', () => 123456789);
  const destinations = [];
  const deps = {
    extractText: async () => 'This is the private PDF lesson.',
    mkdir: async () => {}, copyFile: async (from, to) => destinations.push(to),
    query: async () => ({ rows: [{ id: 1 }] }),
  };
  const input = { ownerUserId: 7, file: { path: '/tmp/lesson.pdf', originalFilename: 'lesson.pdf', size: 10 } };
  await Promise.all([importLearningDocument(input, deps), importLearningDocument({ ...input, ownerUserId: 8 }, deps)]);
  assert.notEqual(destinations[0], destinations[1]);
});
