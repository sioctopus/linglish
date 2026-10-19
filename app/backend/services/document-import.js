const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  buildReadingSubtitles,
  subtitleContent,
  extractDocxText,
  extractEpubText,
} = require('./reading-subtitles');
const { buildExamPaper } = require('./exam-paper');

const PDFS_DIR = path.join(__dirname, '..', 'pdfs');
const MAX_BYTES = 30 * 1024 * 1024;
const MIN_TEXT = 8;
const MAX_OCR_PAGES = 8;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function detectDocumentKind(filename = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt' || ext === '.text' || ext === '.md') return 'text';
  if (ext === '.docx') return 'docx';
  if (ext === '.epub') return 'epub';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.doc') return 'doc';
  return null;
}

function countWords(text) {
  const latin = String(text || '').match(/[A-Za-z0-9']+/g) || [];
  const cjk = String(text || '').match(/[\u4e00-\u9fff]/g) || [];
  return latin.length + cjk.length;
}

function calculateDifficulty(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return 20;
  const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / words.length;
  const sentenceCount = (String(text).match(/[.!?。！？]+/g) || []).length;
  const avgSentenceLength = words.length / Math.max(sentenceCount, 1);
  return Math.round(Math.min(avgWordLength * 8, 50) + Math.min(avgSentenceLength * 2, 50));
}

function mapToCEFRLevel(score) {
  if (score < 20) return 'A1';
  if (score < 35) return 'A2';
  if (score < 50) return 'B1';
  if (score < 65) return 'B2';
  if (score < 80) return 'C1';
  return 'C2';
}

function cleanTitle(title, fallback) {
  const value = String(title || fallback || '学习文档').replace(/\s+/g, ' ').trim();
  return (value || '学习文档').slice(0, 200);
}

function reject(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function unsupportedMessage() {
  return '可以上传英语图片、PDF、Word（docx）、电子书（epub）或 TXT。PPT 和旧版 doc 请先另存成 PDF 或 docx';
}

function draftFromEnglish({ title, text, filename, sourceType, pdfPath, tags }) {
  const cues = buildReadingSubtitles(text);
  if (!cues.length) return null;
  const content = subtitleContent(cues);
  const difficulty = calculateDifficulty(content);
  const fallback = filename
    ? path.basename(filename, path.extname(filename))
    : cues[0].slice(0, 40);
  return {
    title: cleanTitle(title, fallback),
    content,
    level: mapToCEFRLevel(difficulty),
    tags,
    wordCount: countWords(content),
    difficultyScore: Math.round(difficulty) / 100,
    sourceType,
    pdfPath: pdfPath || null,
    cueCount: cues.length,
  };
}

function prepareTextDocument({ title, text, filename }) {
  const content = String(text || '').replace(/\u0000/g, '').trim();
  if (content.length < MIN_TEXT) {
    throw reject('文档内容太短，请粘贴完整课文或上传有文字的文件');
  }
  const draft = draftForText({
    title,
    text: content,
    filename,
    sourceType: 'text',
    tags: ['imported', 'document', 'text', 'subtitles'],
  });
  if (!draft) throw reject('没有提取到可朗读的英语句子');
  return draft;
}

function draftForText({ title, text, filename, sourceType, pdfPath, tags }) {
  const paper = buildExamPaper(text, title || filename);
  if (paper) {
    const difficulty = calculateDifficulty(paper.blocks.map((block) => block.speak || block.text || '').join(' '));
    return {
      title: cleanTitle(title, paper.title),
      content: JSON.stringify(paper),
      level: mapToCEFRLevel(difficulty),
      tags: [...new Set([...(tags || []).filter((tag) => tag !== 'subtitles' && tag !== 'scan'), 'exam'])],
      wordCount: paper.wordCount,
      difficultyScore: Math.round(difficulty) / 100,
      sourceType,
      pdfPath: pdfPath || null,
      cueCount: paper.speakCount,
      exam: true,
    };
  }
  return draftFromEnglish({ title, text, filename, sourceType, pdfPath, tags });
}

function openUrlFor(row, extra = {}) {
  if (extra.scanned && row.pdf_path) {
    return `./pdf-reader.html?path=${encodeURIComponent(row.pdf_path)}`;
  }
  return `./daily-speaking.html?material=${encodeURIComponent(row.id)}`;
}

function present(row, extra = {}) {
  return {
    success: true,
    scanned: Boolean(extra.scanned),
    document: {
      id: row.id,
      title: row.title,
      sourceType: row.source_type,
      pdfPath: row.pdf_path || null,
      wordCount: row.word_count,
      level: row.level,
      cueCount: extra.cueCount || 0,
      openUrl: openUrlFor(row, extra),
    },
  };
}

async function defaultQuery(sql, params) {
  const dataStore = require('../data-store');
  await dataStore.init();
  return dataStore.pool.query(sql, params);
}

async function insertArticle(draft, query, ownerUserId) {
  const { rows } = await query(
    `INSERT INTO articles
     (title, content, level, tags, word_count, difficulty_score, status, source_type, pdf_path, created_at, updated_at, published_at, owner_user_id, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, $8, NOW(), NOW(), NOW(), $9, 'private')
     RETURNING id, title, word_count, level, source_type, pdf_path`,
    [
      draft.title,
      draft.content,
      draft.level,
      draft.tags,
      draft.wordCount,
      draft.difficultyScore,
      draft.sourceType,
      draft.pdfPath,
      ownerUserId,
    ]
  );
  return rows[0];
}

async function updateArticleReading(id, draft, query, user) {
  const { rows } = await query(
    `UPDATE articles
     SET content = $2,
         level = $3,
         tags = $4,
         word_count = $5,
         difficulty_score = $6,
         updated_at = NOW()
     WHERE id = $1 AND (owner_user_id = $7 OR $8::boolean)
     RETURNING id, title, word_count, level, source_type, pdf_path`,
    [
      id,
      draft.content,
      draft.level,
      draft.tags,
      draft.wordCount,
      draft.difficultyScore,
      user.id,
      user.is_admin === true,
    ]
  );
  return rows[0] || null;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'document.pdf'));
  return base.replace(/[^a-zA-Z0-9.\u4e00-\u9fff-]/g, '_');
}

async function extractPdfText(pdfPath) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ url: pathToFileURL(pdfPath).href });
  try {
    const result = await parser.getText();
    return result?.text || '';
  } finally {
    if (typeof parser.destroy === 'function') {
      await parser.destroy().catch(() => {});
    }
  }
}

async function ocrPdfToText(pdfPath) {
  const { PDFParse } = require('pdf-parse');
  const ocr = require('./ocr');
  const parser = new PDFParse({ url: pathToFileURL(pdfPath).href });
  try {
    const info = await parser.getInfo();
    const total = Math.min(Number(info?.total || info?.numPages || 1) || 1, MAX_OCR_PAGES);
    const parts = [];
    for (let page = 1; page <= total; page += 1) {
      const shot = await parser.getScreenshot({ pageNumber: page, format: 'png', scale: 1.5 });
      const image = shot?.images?.[0]?.buffer || shot?.data;
      if (!image) continue;
      const tmp = path.join(os.tmpdir(), `linglish-ocr-${Date.now()}-${page}.png`);
      await fs.writeFile(tmp, Buffer.from(image));
      try {
        const result = await ocr.extractTextFromImage(tmp, 'eng', false);
        if (result?.text) parts.push(result.text);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    return parts.join('\n');
  } finally {
    if (typeof parser.destroy === 'function') {
      await parser.destroy().catch(() => {});
    }
  }
}

async function recognizeImageFile(filePath) {
  const ocr = require('./ocr');
  const result = await ocr.extractTextFromImage(filePath, 'eng', false);
  return result?.text || '';
}

async function readSourceText(file, kind, deps) {
  if (kind === 'text') return deps.readFile(file.path, 'utf8');
  if (kind === 'docx') return extractDocxText(await deps.readFile(file.path));
  if (kind === 'epub') return extractEpubText(await deps.readFile(file.path));
  if (kind === 'image') return deps.recognizeImage(file.path);
  if (kind === 'html') return deps.readFile(file.path, 'utf8');
  return '';
}

async function importPdf(file, title, deps) {
  const savedFilename = `${randomUUID()}-${sanitizeFilename(file.originalFilename)}`;
  const savedPath = path.join(PDFS_DIR, savedFilename);
  const relativePdfPath = `/pdfs/${savedFilename}`;
  await deps.mkdir(PDFS_DIR, { recursive: true });
  await deps.copyFile(file.path, savedPath);

  let text = '';
  try {
    text = String(await deps.extractText(file.path) || '').trim();
  } catch (_) {
    text = '';
  }
  let draft = draftForText({
    title,
    text,
    filename: file.originalFilename,
    sourceType: 'pdf',
    pdfPath: relativePdfPath,
    tags: ['imported', 'document', 'pdf', 'subtitles'],
  });
  let scanned = false;
  if (!draft && deps.ocrText) {
    try {
      const ocrText = String(await deps.ocrText(file.path) || '');
      draft = draftForText({
        title,
        text: ocrText,
        filename: file.originalFilename,
        sourceType: 'pdf',
        pdfPath: relativePdfPath,
        tags: ['imported', 'document', 'pdf', 'subtitles', 'ocr'],
      });
      scanned = Boolean(draft);
    } catch (_) {
      draft = null;
    }
  }
  if (!draft) {
    scanned = true;
    draft = {
      title: cleanTitle(title, path.basename(file.originalFilename, path.extname(file.originalFilename))),
      content: '这份文档以页面形式保存。打开后可以翻页查看；扫描页可以提取英语朗读字幕。',
      level: 'A2',
      tags: ['imported', 'document', 'pdf', 'scan'],
      wordCount: 0,
      difficultyScore: 0.2,
      sourceType: 'pdf',
      pdfPath: relativePdfPath,
      cueCount: 0,
    };
  }

  try {
    const row = await insertArticle(draft, deps.query, deps.ownerUserId);
    return present(row, {
      scanned: scanned && !draft.cueCount && !draft.exam,
      cueCount: draft.cueCount,
      hasSubtitles: draft.cueCount > 0 && !draft.exam,
      exam: Boolean(draft.exam),
    });
  } catch (err) {
    await deps.unlink(savedPath).catch(() => {});
    throw err;
  }
}

async function importLearningDocument(input = {}, deps = {}) {
  const ownerUserId = Number(input.ownerUserId);
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
    const err = reject('请先登录');
    err.statusCode = 401;
    throw err;
  }
  const query = deps.query || defaultQuery;
  const file = input.file || null;
  const tools = {
    query,
    ownerUserId,
    copyFile: deps.copyFile || fs.copyFile,
    readFile: deps.readFile || fs.readFile,
    mkdir: deps.mkdir || fs.mkdir,
    unlink: deps.unlink || fs.unlink,
    extractText: deps.extractText || extractPdfText,
    ocrText: deps.ocrText === undefined ? ocrPdfToText : deps.ocrText,
    recognizeImage: deps.recognizeImage || recognizeImageFile,
  };

  if (file) {
    if (Number(file.size) > MAX_BYTES) {
      throw reject('文件超过 30MB，请拆分后再导入');
    }
    const kind = detectDocumentKind(file.originalFilename);
    if (kind === 'doc' || !kind) throw reject(unsupportedMessage());
    if (kind === 'pdf') return importPdf(file, input.title, tools);

    let raw = '';
    try {
      raw = await readSourceText(file, kind, tools);
    } catch (err) {
      throw reject(err.message || '没能读取这份文档');
    }
    const draft = draftForText({
      title: input.title,
      text: raw,
      filename: file.originalFilename,
      sourceType: kind === 'text' ? 'text' : kind,
      tags: ['imported', 'document', kind, 'subtitles'],
    });
    if (!draft) throw reject('没有提取到可朗读的英语句子');
    return present(await insertArticle(draft, query, ownerUserId), {
      cueCount: draft.cueCount,
      hasSubtitles: draft.cueCount > 0 && !draft.exam,
      exam: Boolean(draft.exam),
    });
  }

  if (String(input.text || '').trim()) {
    const draft = prepareTextDocument({ title: input.title, text: input.text });
    return present(await insertArticle(draft, query, ownerUserId), { cueCount: draft.cueCount, hasSubtitles: true });
  }

  throw reject('请上传英语图片、PDF、Word、电子书，或粘贴课文');
}

async function rebuildReadingSubtitles(article, deps = {}) {
  const user = deps.user;
  if (!user || (user.is_admin !== true && Number(article?.owner_user_id) !== Number(user.id))) {
    const err = reject('没有权限修改这份文档');
    err.statusCode = 403;
    throw err;
  }
  if (!article?.pdf_path) throw reject('这份文档没有原文件，无法提取朗读字幕');
  const filename = path.basename(String(article.pdf_path));
  if (!filename || filename !== path.basename(filename)) throw reject('文档路径无效');
  const filePath = path.join(PDFS_DIR, filename);
  const tools = {
    query: deps.query || defaultQuery,
    extractText: deps.extractText || extractPdfText,
    ocrText: deps.ocrText === undefined ? ocrPdfToText : deps.ocrText,
  };
  let text = '';
  try {
    text = String(await tools.extractText(filePath) || '');
  } catch (_) {
    text = '';
  }
  let draft = draftForText({
    title: article.title,
    text,
    filename,
    sourceType: 'pdf',
    pdfPath: article.pdf_path,
    tags: ['imported', 'document', 'pdf', 'subtitles'],
  });
  if (!draft && tools.ocrText) {
    const ocrText = String(await tools.ocrText(filePath) || '');
    draft = draftForText({
      title: article.title,
      text: ocrText,
      filename,
      sourceType: 'pdf',
      pdfPath: article.pdf_path,
      tags: ['imported', 'document', 'pdf', 'subtitles', 'ocr'],
    });
  }
  if (!draft) throw reject('没有提取到可朗读的英语句子');
  const row = await updateArticleReading(article.id, draft, tools.query, user);
  if (!row) throw reject('找不到这份文档');
  return present(row, {
    cueCount: draft.cueCount,
    hasSubtitles: draft.cueCount > 0 && !draft.exam,
    exam: Boolean(draft.exam),
  });
}

module.exports = {
  detectDocumentKind,
  prepareTextDocument,
  importLearningDocument,
  rebuildReadingSubtitles,
  buildReadingSubtitles,
  buildExamPaper,
  MAX_BYTES,
};
