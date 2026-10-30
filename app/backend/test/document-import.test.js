const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importLearningDocument, rebuildReadingSubtitles } = require('../services/document-import');
const { extractDocxText, storeZip, buildReadingSubtitles } = require('../services/reading-subtitles');

function queryStub(recorder, row) {
  return async (sql, params) => {
    recorder.push({ sql, params });
    return { rows: [row] };
  };
}

test('pasted lesson text becomes one readable article', async () => {
  const recorder = [];
  const result = await importLearningDocument({
    title: 'Unit 3 Dialogue',
    text: 'Good morning. How are you today? I am fine, thank you.',
  }, {
    query: queryStub(recorder, {
      id: 9,
      title: 'Unit 3 Dialogue',
      word_count: 11,
      level: 'A1',
      source_type: 'text',
      pdf_path: null,
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.document.openUrl, './daily-speaking.html?material=9');
  assert.equal(result.document.sourceType, 'text');
  assert.match(recorder[0].sql, /INSERT INTO articles/);
  assert.equal(recorder[0].params[6], 'text');
  assert.equal(recorder[0].params[7], null);
});

test('a text file is read from disk and stored as the lesson', async () => {
  const recorder = [];
  const result = await importLearningDocument({
    title: '',
    file: { path: '/tmp/lesson.txt', originalFilename: 'lesson.txt', size: 40 },
  }, {
    readFile: async () => 'Read this sentence aloud in class today.',
    query: queryStub(recorder, {
      id: 4,
      title: 'lesson',
      word_count: 7,
      level: 'A2',
      source_type: 'text',
      pdf_path: null,
    }),
  });

  assert.equal(recorder[0].params[0], 'lesson');
  assert.equal(result.document.openUrl, './daily-speaking.html?material=4');
});

test('pdf import keeps the original file and opens the page reader', async () => {
  const recorder = [];
  const copied = [];
  const result = await importLearningDocument({
    title: '课本第一课',
    file: { path: '/tmp/book.pdf', originalFilename: 'book.pdf', size: 1200 },
  }, {
    extractText: async () => 'Chapter one. The cat sat on the mat and looked at the bird.',
    copyFile: async (from, to) => { copied.push({ from, to }); },
    mkdir: async () => {},
    query: queryStub(recorder, {
      id: 12,
      title: '课本第一课',
      word_count: 13,
      level: 'A2',
      source_type: 'pdf',
      pdf_path: '/pdfs/1-book.pdf',
    }),
  });

  assert.equal(copied.length, 1);
  assert.equal(recorder[0].params[6], 'pdf');
  assert.match(recorder[0].params[7], /^\/pdfs\//);
  assert.match(recorder[0].params[1], /The cat sat on the mat/);
  assert.match(result.document.openUrl, /^\.\/daily-speaking\.html\?material=12$/);
  assert.equal(result.scanned, false);
});

test('a scanned pdf is still saved so the class can open the pages', async () => {
  const recorder = [];
  const result = await importLearningDocument({
    title: '期中试卷',
    file: { path: '/tmp/exam.pdf', originalFilename: 'exam.pdf', size: 2000 },
  }, {
    extractText: async () => '',
    ocrText: async () => '',
    copyFile: async () => {},
    mkdir: async () => {},
    query: queryStub(recorder, {
      id: 15,
      title: '期中试卷',
      word_count: 0,
      level: 'A2',
      source_type: 'pdf',
      pdf_path: '/pdfs/1-exam.pdf',
    }),
  });

  assert.equal(result.scanned, true);
  assert.equal(recorder[0].params[6], 'pdf');
  assert.match(result.document.openUrl, /pdf-reader\.html/);
});

test('ppt and empty imports are rejected with a teacher-facing reason', async () => {
  await assert.rejects(
    () => importLearningDocument({
      file: { path: '/tmp/slides.pptx', originalFilename: 'slides.pptx', size: 10 },
    }),
    /PPT 和旧版 doc 请先另存成 PDF 或 docx/
  );
  await assert.rejects(
    () => importLearningDocument({ text: '   ' }),
    /请上传英语图片、PDF、Word、电子书，或粘贴课文/
  );
  await assert.rejects(
    () => importLearningDocument({ text: 'hi' }),
    /文档内容太短/
  );
});

test('desktop home links document import and the page posts lessons to the import route', () => {
  const frontend = path.resolve(__dirname, '../../frontend');
  const home = fs.readFileSync(path.join(frontend, 'index-desktop.html'), 'utf8');
  const page = fs.readFileSync(path.join(frontend, 'document-import.html'), 'utf8');
  const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const documents = fs.readFileSync(path.resolve(__dirname, '../routes/documents.js'), 'utf8');

  assert.match(home, /id="hero-guest-document"[^>]*href="\.\/document-import\.html"/);
  assert.match(home, /id="hero-user-document"[^>]*href="\.\/document-import\.html"/);
  assert.match(page, /\/documents\/import/);
  assert.match(page, /accept="\.pdf,\.txt,\.md,\.markdown,\.docx,\.epub,\.html,\.htm,\.png,\.jpg,\.jpeg,\.webp"/);
  assert.match(page, /daily-speaking\.html\?material=/);
  assert.match(server, /registerDocumentRoutes/);
  assert.match(server, /pathname === '\/ocr\/extract'/);
  assert.match(documents, /rebuildReadingSubtitles/);
  assert.match(documents, /subtitleMatch/);
});

test('page-marker pdf text is replaced by recognized English subtitles', async () => {
  const recorder = [];
  const result = await importLearningDocument({
    title: '期中试卷',
    file: { path: '/tmp/exam.pdf', originalFilename: 'exam.pdf', size: 2000 },
  }, {
    extractText: async () => '-- 1 of 10 -- -- 2 of 10 --',
    ocrText: async () => 'What animal does Amy think is playful? The panda likes the ball.',
    copyFile: async () => {},
    mkdir: async () => {},
    query: queryStub(recorder, {
      id: 21,
      title: '期中试卷',
      word_count: 12,
      level: 'A2',
      source_type: 'pdf',
      pdf_path: '/pdfs/1-exam.pdf',
    }),
  });

  assert.match(recorder[0].params[1], /What animal does Amy think is playful\?/);
  assert.match(recorder[0].params[1], /The panda likes the ball\./);
  assert.equal(result.document.openUrl, './daily-speaking.html?material=21');
});

test('a word document and an image become English reading cues', async () => {
  const docx = storeZip([
    ['word/document.xml', '<w:document><w:p><w:r><w:t>Good morning class.</w:t></w:r></w:p><w:p><w:r><w:t>Please read the first sentence aloud.</w:t></w:r></w:p></w:document>'],
  ]);
  assert.match(extractDocxText(docx), /Good morning class/);
  assert.deepEqual(
    buildReadingSubtitles('Good morning class. Please read the first sentence aloud.'),
    ['Good morning class.', 'Please read the first sentence aloud.']
  );

  const recorder = [];
  const word = await importLearningDocument({
    title: '课堂对话',
    file: { path: '/tmp/lesson.docx', originalFilename: 'lesson.docx', size: docx.length },
  }, {
    readFile: async () => docx,
    query: queryStub(recorder, {
      id: 31,
      title: '课堂对话',
      word_count: 10,
      level: 'A2',
      source_type: 'docx',
      pdf_path: null,
    }),
  });
  assert.match(recorder[0].params[1], /Good morning class\./);
  assert.equal(word.document.openUrl, './daily-speaking.html?material=31');

  const image = await importLearningDocument({
    title: '图片课文',
    file: { path: '/tmp/page.png', originalFilename: 'page.png', size: 100 },
  }, {
    recognizeImage: async () => 'The monkey is playful. Amy likes the panda.',
    query: queryStub(recorder, {
      id: 32,
      title: '图片课文',
      word_count: 8,
      level: 'A1',
      source_type: 'image',
      pdf_path: null,
    }),
  });
  assert.equal(image.document.openUrl, './daily-speaking.html?material=32');
});

test('rebuilding subtitles updates an imported exam', async () => {
  const recorder = [];
  const result = await rebuildReadingSubtitles({
    id: 4,
    title: '2026附中七下期中英语（含答案）',
    pdf_path: '/pdfs/exam.pdf',
  }, {
    extractText: async () => '-- 1 of 10 --',
    ocrText: async () => 'What time does Ann usually go to bed in the evening?',
    query: queryStub(recorder, {
      id: 4,
      title: '2026附中七下期中英语（含答案）',
      word_count: 11,
      level: 'A2',
      source_type: 'pdf',
      pdf_path: '/pdfs/exam.pdf',
    }),
  });
  assert.match(recorder[0].sql, /UPDATE articles/);
  assert.match(recorder[0].params[1], /What time does Ann usually go to bed/);
  assert.equal(result.document.openUrl, './daily-speaking.html?material=4');
});

test('an exam web page becomes a readable paper instead of loose sentences', async () => {
  const html = `<div class="paper"><h1>期中试卷</h1>
    <h2>第一部分 听力</h2>
    <div class="question"><div><span class="q-num">1.</span> What animal does Amy think is playful?</div>
      <div class="options"><div>A. The panda.</div><div>B. The monkey.</div><div>C. The tiger.</div></div></div>
    <div class="question"><div><span class="q-num">2.</span> What time does Ann go to bed?</div>
      <div class="options"><div>A. At 9.</div><div>B. At 10.</div><div>C. At 11.</div></div></div>
    <div class="question"><div><span class="q-num">3.</span> What is Mrs. Hu's job?</div>
      <div class="options"><div>A. Chinese.</div><div>B. English.</div><div>C. Math.</div></div></div>
    <div class="answer-key"><h2>参考答案</h2><p>1-3 BAC</p></div></div>`;
  const recorder = [];
  const result = await importLearningDocument({
    title: '期中试卷',
    file: { path: '/tmp/exam.html', originalFilename: 'exam.html', size: html.length },
  }, {
    readFile: async () => html,
    query: queryStub(recorder, {
      id: 41,
      title: '期中试卷',
      word_count: 20,
      level: 'A2',
      source_type: 'html',
      pdf_path: null,
    }),
  });
  const paper = JSON.parse(recorder[0].params[1]);
  assert.equal(paper.kind, 'exam-paper');
  assert.equal(paper.blocks.filter((block) => block.type === 'question').length, 3);
  assert.match(paper.blocks.find((block) => block.type === 'answer').lines[0].speak, /第1到第3题的答案是 B，A，C/);
  assert.ok(recorder[0].params[3].includes('exam'));
  assert.equal(result.document.openUrl, './daily-speaking.html?material=41');
});
