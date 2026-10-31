const fs = require('fs/promises');
const path = require('path');

const NOTE_DIR = path.join(__dirname, '..', 'note-images');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function reject(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function cleanWord(word) {
  return String(word || '').replace(/\s+/g, ' ').trim();
}

function buildClassNote(word, customLines) {
  const spoken = cleanWord(word);
  if (!/^[A-Za-z][A-Za-z\s'-]{0,40}$/.test(spoken)) {
    throw reject('请填写今天教的英语单词，例如 cola');
  }
  const lower = spoken.toLowerCase();
  const titleWord = lower.charAt(0).toUpperCase() + lower.slice(1);
  const defaults = [
    lower,
    `${titleWord} please`,
    `May I have ${lower} please?`,
    'Here you are',
    'Thank you',
  ];
  const lines = Array.isArray(customLines)
    ? customLines.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    kind: 'class-note',
    word: lower,
    title: `${titleWord} please`,
    lines: lines.length ? lines : defaults,
  };
}

function imageExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return IMAGE_EXT.has(ext) ? ext : '';
}

async function defaultQuery(sql, params) {
  const dataStore = require('../data-store');
  await dataStore.init();
  return dataStore.pool.query(sql, params);
}

async function createClassNote(input = {}, deps = {}) {
  const note = buildClassNote(input.word, input.lines);
  const image = input.image;
  if (!image?.path) throw reject('请拍下今天教的单词卡片');
  if (Number(image.size) > MAX_IMAGE_BYTES) throw reject('图片超过 8MB，请换一张小一点的');
  const ext = imageExtension(image.originalFilename);
  if (!ext) throw reject('单词卡片请用 jpg、png 或 webp');
  const filename = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const savedPath = path.join(NOTE_DIR, filename);
  const query = deps.query || defaultQuery;
  const stat = deps.stat || fs.stat;
  const sourceStat = await stat(image.path).catch(() => null);
  const sourceBytes = Number(sourceStat?.size || image.size || 0);
  if (!sourceBytes) throw reject('图片没有上传完整，请重新选择照片');
  await (deps.mkdir || fs.mkdir)(NOTE_DIR, { recursive: true });
  await (deps.copyFile || fs.copyFile)(image.path, savedPath);
  const savedStat = await stat(savedPath).catch(() => null);
  if (!savedStat?.size) {
    await (deps.unlink || fs.unlink)(savedPath).catch(() => {});
    throw reject('图片没有保存成功，请重试');
  }
  note.image = `/note-images/${filename}`;
  try {
    const { rows } = await query(
      `INSERT INTO articles
       (title, content, level, tags, word_count, difficulty_score, status, source_type, pdf_path, created_at, updated_at, published_at)
       VALUES ($1, $2, 'A1', $3, $4, 0.1, 'published', 'class-note', NULL, NOW(), NOW(), NOW())
       RETURNING id, title`,
      [note.title, JSON.stringify(note), ['class-note'], note.lines.join(' ').split(/\s+/).length]
    );
    const id = rows[0].id;
    return {
      success: true,
      note: {
        id,
        title: note.title,
        word: note.word,
        image: note.image,
        openUrl: `./class-note.html?id=${encodeURIComponent(id)}`,
      },
    };
  } catch (err) {
    await (deps.unlink || fs.unlink)(savedPath).catch(() => {});
    throw err;
  }
}

module.exports = {
  buildClassNote,
  createClassNote,
  NOTE_DIR,
  MAX_IMAGE_BYTES,
};
