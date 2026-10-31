const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPage } = require('./helpers/page-source');
const {
  annotateText,
  createDocument,
  updateDocument,
  listDocuments,
  deleteDocument,
  createPracticeLink,
  getDocumentByShare,
  listTemplates,
  estimateCefr,
  TEMPLATES,
} = require('../services/workbench');

test('annotateText splits sentences and grades words', () => {
  const annotated = annotateText(
    'Good morning class. Please open your books and read the first sentence aloud.'
  );
  assert.equal(annotated.kind, 'workbench-annotation');
  assert.ok(annotated.sentences.length >= 2);
  assert.ok(annotated.words.please);
  assert.equal(estimateCefr('the'), 'A1');
  assert.ok(annotated.vocabList.length >= 1);
  assert.ok(annotated.keyExpressions.length >= 1);
  assert.ok(annotated.shadowingTasks.length >= 1);
});

test('annotateText fills POS for closed-class words', () => {
  const annotated = annotateText('I like to eat fresh apples every morning.');
  assert.equal(annotated.words.i.partOfSpeech, 'pronoun');
  assert.equal(annotated.words.like.partOfSpeech, 'verb');
  assert.equal(annotated.words.to.partOfSpeech, 'particle');
  assert.ok(annotated.words.fresh.partOfSpeech);
});

test('annotateText rejects empty English', () => {
  assert.throws(() => annotateText('你好'), /没有识别到|至少一句/);
});

test('template catalog covers teacher and blogger cores', () => {
  assert.ok(TEMPLATES.length >= 8);
  assert.equal(listTemplates('teacher').length, 4);
  assert.equal(listTemplates('blogger').length, 4);
});

test('create/update/list/delete workbench document with injected query', async () => {
  const store = new Map();
  let seq = 1;
  const query = async (sql, params) => {
    if (/INSERT INTO workbench_documents/i.test(sql)) {
      const id = seq++;
      const row = {
        id,
        user_id: params[0],
        title: params[1],
        role: params[2],
        template_id: params[3],
        source_text: params[4],
        annotated: JSON.parse(params[5]),
        styles: JSON.parse(params[6]),
        share_token: params[7],
        share_expires_at: null,
        practice_article_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.set(id, row);
      return { rows: [row] };
    }
    if (/SELECT \* FROM workbench_documents WHERE id = \$1 AND user_id = \$2/i.test(sql)) {
      const row = store.get(Number(params[0]));
      if (!row || row.user_id !== params[1]) return { rows: [] };
      return { rows: [row] };
    }
    if (/UPDATE workbench_documents\s+SET title/i.test(sql)) {
      const row = store.get(Number(params[0]));
      if (!row || row.user_id !== params[7]) return { rows: [] };
      Object.assign(row, {
        title: params[1],
        role: params[2],
        template_id: params[3],
        source_text: params[4],
        annotated: JSON.parse(params[5]),
        styles: JSON.parse(params[6]),
        updated_at: new Date().toISOString(),
      });
      return { rows: [row] };
    }
    if (/FROM workbench_documents\s+WHERE user_id = \$1/i.test(sql)) {
      return {
        rows: [...store.values()]
          .filter((row) => row.user_id === params[0])
          .map((row) => ({
            id: row.id,
            title: row.title,
            role: row.role,
            template_id: row.template_id,
            share_token: row.share_token,
            practice_article_id: row.practice_article_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
          })),
      };
    }
    if (/DELETE FROM workbench_documents/i.test(sql)) {
      const row = store.get(Number(params[0]));
      if (!row || row.user_id !== params[1]) return { rows: [] };
      store.delete(row.id);
      return { rows: [{ id: row.id }] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };

  const created = await createDocument({
    title: 'Cafe dialogue',
    role: 'teacher',
    templateId: 'homework',
    text: 'May I have a coffee please? Here you are.',
  }, 42, { query });
  assert.equal(created.document.role, 'teacher');
  assert.equal(created.document.templateId, 'homework');
  assert.match(created.document.openUrl, /workbench\.html\?id=/);
  assert.equal(created.document.shareToken, null);

  const updated = await updateDocument(created.document.id, {
    title: 'Cafe dialogue v2',
    templateId: 'intensive-note',
  }, 42, { query });
  assert.equal(updated.document.title, 'Cafe dialogue v2');
  assert.equal(updated.document.templateId, 'intensive-note');

  const listed = await listDocuments(42, { query });
  assert.equal(listed.items.length, 1);

  const removed = await deleteDocument(created.document.id, 42, { query });
  assert.equal(removed.id, created.document.id);
  assert.equal((await listDocuments(42, { query })).items.length, 0);
});

test('practice link creates or updates a reading article', async () => {
  const doc = {
    id: 9,
    user_id: 7,
    title: 'Practice me',
    role: 'blogger',
    template_id: 'xhs-long',
    source_text: 'Hello everyone. Welcome to my English channel.',
    annotated: { level: 'A2', sourceText: 'Hello everyone. Welcome to my English channel.' },
    styles: {},
    share_token: 'abc123share',
    share_expires_at: null,
    practice_article_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const query = async (sql, params) => {
    if (/SELECT \* FROM workbench_documents WHERE id/i.test(sql)) {
      return { rows: [doc] };
    }
    if (/INSERT INTO articles/i.test(sql)) {
      assert.match(params[1], /Hello everyone/);
      return { rows: [{ id: 55 }] };
    }
    if (/UPDATE workbench_documents\s+SET practice_article_id/i.test(sql)) {
      doc.practice_article_id = params[1];
      return { rows: [doc] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  const result = await createPracticeLink(9, 7, {}, { query });
  assert.equal(result.practiceUrl, './reader.html?id=55');
  assert.match(result.shareUrl, /share=abc123share/);
});

test('share lookup respects expiry', async () => {
  const query = async () => ({ rows: [] });
  await assert.rejects(
    () => getDocumentByShare('missing', { query }),
    /不存在或已过期/
  );
});

test('frontend entry and route wiring stay connected', () => {
  const root = path.resolve(__dirname, '../..');
  const home = fs.readFileSync(path.join(root, 'frontend/index-desktop.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/workbench.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'frontend/js/workbench/app.js'), 'utf8');
  const templates = fs.readFileSync(path.join(root, 'frontend/js/workbench/templates.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'backend/routes/workbench.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
  const staticRoutes = fs.readFileSync(path.join(root, 'backend/routes/static.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'backend/data-store/schema.js'), 'utf8');

  assert.doesNotMatch(home, /hero-guest-workbench/);
  assert.doesNotMatch(home, /hero-user-workbench/);
  assert.match(home, /href="\.\/workbench\.html"[^>]*id="nav-workbench-link"/);
  assert.match(page, /老师模式/);
  assert.match(page, /博主模式/);
  assert.match(page, /课后微信笔记/);
  assert.match(page, /wb-tool-class-note/);
  assert.match(page, /AI 标注/);
  assert.match(page, /生成链接/);
  assert.match(page, /html2canvas/);
  assert.match(app, /\/api\/workbench\/annotate/);
  assert.match(app, /\/api\/workbench\/\$\{state\.documentId\}\/practice-link/);
  assert.match(app, /setTool\('class-note'/);
  assert.match(templates, /intensive-note/);
  assert.match(templates, /wb-word-col/);
  assert.match(templates, /wb-pos/);
  assert.match(templates, /STYLE_THEMES/);
  assert.match(templates, /teal-day/);
  assert.match(templates, /chalkboard/);
  assert.match(templates, /grok-night/);
  assert.match(templates, /usa-poster/);
  assert.match(templates, /broadway-bill/);
  assert.match(templates, /DEFAULT_KICKERS/);
  assert.match(templates, /INTENSIVE READING/);
  assert.match(templates, /data-editable="kicker"/);
  assert.match(templates, /draftFromText/);
  assert.match(app, /previewData|draftFromText/);
  assert.match(page, /id="wb-kicker"/);
  assert.match(page, /id="wb-show-pos"/);
  assert.match(app, /readKickerFromUi|syncKickerInput/);
  assert.match(page, /id="wb-orient"/);
  assert.match(page, /id="wb-density"/);
  assert.match(page, /id="wb-align"/);
  assert.match(page, /id="wb-theme-list"/);
  assert.match(page, /id="wb-show-meta"/);
  assert.match(page, /竖屏 3:4/);
  assert.match(page, /竖屏 9:16/);
  assert.match(page, /横屏 16:9/);
  assert.match(page, /import-bridge\.js/);
  assert.match(app, /orientation/);
  assert.match(app, /normalizeOrient|story/);
  assert.match(app, /applyExternalImport|WorkbenchImport/);
  assert.match(app, /applyTheme/);
  assert.match(app, /density/);
  const importBridge = fs.readFileSync(path.join(root, 'frontend/js/workbench/import-bridge.js'), 'utf8');
  assert.match(importBridge, /openIntensiveNote/);
  assert.match(importBridge, /linglish-workbench-import/);
  assert.match(importBridge, /sessionStorage/);
  assert.doesNotMatch(importBridge, /localStorage\.setItem/);
  assert.match(importBridge, /backHrefForSource/);
  assert.match(app, /wireBackLink/);
  const dailySpeaking = fs.readFileSync(path.join(root, 'frontend/daily-speaking.html'), 'utf8');
  assert.match(dailySpeaking, /note-scene-btn|整段精读/);
  assert.match(dailySpeaking, /WorkbenchImport/);
  assert.match(dailySpeaking, /sameTab:\s*true/);
  const practicePage = readPage('practice-session-desktop.html');
  assert.match(practicePage, /practice-intensive-note/);
  assert.match(practicePage, /WorkbenchImport/);
  assert.match(templates, /wb-block/);
  assert.match(templates, /wb-card-head-hero/);
  assert.match(templates, /wb-task-card/);
  assert.match(templates, /wb-dictation-list/);
  assert.match(templates, /wb-expr-board/);
  assert.match(templates, /wb-sheet-/);
  assert.match(templates, /wb-vocab-deck/);
  assert.match(templates, /wb-vocab-ipa/);
  assert.match(templates, /xhs-long/);
  const classNoteMod = fs.readFileSync(path.join(root, 'frontend/js/workbench/class-note.js'), 'utf8');
  assert.match(classNoteMod, /WorkbenchClassNote/);
  assert.match(classNoteMod, /\/class-notes/);
  assert.match(routes, /\/api\/workbench\/annotate/);
  assert.match(server, /registerWorkbenchRoutes/);
  assert.match(staticRoutes, /\['\/workbench', 'workbench\.html'\]/);
  assert.match(staticRoutes, /\['\/teacher', 'workbench\.html'\]/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS workbench_documents/);
});
