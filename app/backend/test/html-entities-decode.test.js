const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeHtmlEntities,
  buildReadingSubtitles,
  isEnglishCue,
  isChineseCue,
  extractEpubText,
  storeZip,
} = require('../services/reading-subtitles');
const { importLearningDocument } = require('../services/document-import');

test('numeric html entities decode to real Chinese and punctuation', () => {
  const decoded = decodeHtmlEntities(
    'I&#x2019;ve read history. &#x6211;&#x8bd5;&#x56fe;&#x4e86;&#x89e3;&#x6587;&#x660e;&#x7684;&#x5174;&#x8870;&#x3002;'
  );
  assert.match(decoded, /I’ve read history/);
  assert.match(decoded, /我试图了解文明的兴衰/);
});

test('undecoded Chinese entity soup is not treated as English', () => {
  assert.equal(
    isEnglishCue('&#x95ee;&#xff1a;&#x4ec0;&#x4e48;&#x9a71;&#x52a8;&#x7740;&#x4f60;&#x7684;&#x521b;&#x9020;&#x529b;&#xff1f;'),
    false
  );
  assert.equal(isChineseCue(decodeHtmlEntities('&#x6211;&#x81f4;&#x529b;&#x4e8e;&#x89e3;&#x8bfb;&#x6587;&#x660e;&#x3002;')), true);
});

test('bilingual epub text keeps Chinese lines after decode and drops entity-only cues', () => {
  const text = [
    'Q: What fuels your creativity?',
    '&#x95ee;&#xff1a;&#x4ec0;&#x4e48;&#x9a71;&#x52a8;&#x7740;&#x4f60;&#x7684;&#x521b;&#x9020;&#x529b;&#xff1f;',
    'Pressure.',
    'Necessity.',
    '381 &#x538b;&#x529b;&#x3002;&#x5fc5;&#x7136;&#x3002; 381',
    'I try to understand the rise and fall of civilizations.',
    '798 &#x6211;&#x81f4;&#x529b;&#x4e8e;&#x89e3;&#x8bfb;&#x6587;&#x660e;&#x7684;&#x5174;&#x8870;&#x89c4;&#x5f8b;&#x3002; 798',
  ].join('\n');

  const cues = buildReadingSubtitles(text);
  assert.deepEqual(cues, [
    'Q: What fuels your creativity?',
    'Pressure.',
    'Necessity.',
    'I try to understand the rise and fall of civilizations.',
  ]);
  assert.ok(!cues.some((line) => /&#x|[\u4e00-\u9fff]/.test(line)));
});

test('epub xhtml numeric entities become readable bilingual content', async () => {
  const zhBlock = Array.from({ length: 8 }, () =>
    '&#x6211;&#x8bd5;&#x56fe;&#x4e86;&#x89e3;&#x6587;&#x660e;&#x7684;&#x5174;&#x8870;&#x3002;'
  ).join('');
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>I try to understand the rise and fall of civilizations.</p>
<p>${zhBlock}</p>
<p>I&#x2019;ve read a lot of history to discern the facts.</p>
<p>&#x6211;&#x904d;&#x89c8;&#x53f2;&#x7c4d;&#x4ee5;&#x8fa8;&#x660e;&#x4eba;&#x7c7b;&#x884c;&#x4e3a;&#x7684;&#x771f;&#x5b9e;&#x8f68;&#x8ff9;&#x3002;</p>
</body></html>`;
  const epub = storeZip([
    ['META-INF/container.xml', '<container></container>'],
    ['OEBPS/chapter.xhtml', xhtml],
  ]);
  const extracted = extractEpubText(epub);
  assert.match(extracted, /我试图了解文明的兴衰/);
  assert.match(extracted, /I’ve read a lot of history/);
  assert.match(extracted, /civilizations\.\n\n我试图了解/);
  assert.match(extracted, /facts\.\n\n我遍览史籍/);

  const recorder = [];
  const result = await importLearningDocument({ ownerUserId: 7,
    title: 'Elon bilingual',
    file: { path: '/tmp/elon.epub', originalFilename: 'elon.en_zh-CN.epub', size: epub.length },
  }, {
    readFile: async () => epub,
    query: async (sql, params) => {
      recorder.push({ sql, params });
      return {
        rows: [{
          id: 88,
          title: 'Elon bilingual',
          word_count: 20,
          level: 'B1',
          source_type: 'epub',
          pdf_path: null,
        }],
      };
    },
  });

  assert.equal(result.document.openUrl, './daily-speaking.html?material=88');
  assert.match(recorder[0].params[1], /我试图了解文明的兴衰/);
  assert.match(recorder[0].params[1], /I try to understand the rise and fall of civilizations/);
  assert.match(recorder[0].params[1], /\n\n/);
  assert.ok(recorder[0].params[3].includes('bilingual'));
});

test('english-only paragraphs stay as stage units instead of one sentence per line', async () => {
  const text = [
    'Good morning class. Please open your books.',
    '',
    'Read the first paragraph aloud. Then answer the questions.',
  ].join('\n');
  const recorder = [];
  await importLearningDocument({ ownerUserId: 7,
    title: 'Paragraph lesson',
    text,
  }, {
    query: async (sql, params) => {
      recorder.push({ sql, params });
      return {
        rows: [{
          id: 89,
          title: 'Paragraph lesson',
          word_count: 18,
          level: 'A2',
          source_type: 'text',
          pdf_path: null,
        }],
      };
    },
  });
  const content = recorder[0].params[1];
  assert.match(content, /Good morning class\. Please open your books\./);
  assert.match(content, /Read the first paragraph aloud\. Then answer the questions\./);
  assert.match(content, /\n\n/);
  assert.equal(content.split(/\n{2,}/).length, 2);
});
