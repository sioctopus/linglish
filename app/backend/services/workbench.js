const crypto = require('crypto');
const { buildReadingSubtitles, subtitleContent } = require('./reading-subtitles');
const { getCuratedEntry } = require('./dictionary/curated-entries');

const MAX_TEXT = 12000;
const MAX_ANNOTATE_WORDS = 80;
const SOURCE_TYPE = 'workbench';
const PRACTICE_SOURCE = 'workbench-practice';

const A1_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'to',
  'up', 'it', 'is', 'be', 'am', 'are', 'was', 'were', 'i', 'you', 'he', 'she', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'from',
  'with', 'into', 'can', 'will', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'yes',
  'me', 'him', 'them', 'us', 'what', 'when', 'where', 'who', 'why', 'how', 'all', 'some', 'any',
  'good', 'bad', 'big', 'small', 'new', 'old', 'day', 'time', 'people', 'thing', 'go', 'come',
  'get', 'make', 'see', 'know', 'want', 'need', 'like', 'say', 'tell', 'think', 'look', 'use',
  'work', 'take', 'give', 'find', 'help', 'please', 'thank', 'hello', 'hi', 'bye', 'ok', 'okay',
]);

const TEMPLATES = Object.freeze([
  { id: 'intensive-note', role: 'teacher', name: '精读笔记', desc: '逐句精读 + 单词标注' },
  { id: 'homework', role: 'teacher', name: '作业单', desc: '跟读任务 + 默写清单' },
  { id: 'lesson-handout', role: 'teacher', name: '课堂讲义', desc: '标题 + 重点表达' },
  { id: 'word-cards', role: 'teacher', name: '单词卡组', desc: '词汇卡片网格' },
  { id: 'xhs-long', role: 'blogger', name: '小红书长图', desc: '适合竖版长图发布' },
  { id: 'quote-card', role: 'blogger', name: '金句卡片', desc: '一句金句主视觉' },
  { id: 'video-script', role: 'blogger', name: '视频脚本页', desc: '口播脚本分镜' },
  { id: 'traffic-cover', role: 'blogger', name: '引流封面', desc: '带练习入口引导' },
]);

const DEFAULT_STYLES = Object.freeze({
  fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 18,
  textColor: '#0f172a',
  accentColor: '#0f766e',
  background: '#ffffff',
  highlightColor: '#ccfbf1',
  lineGap: 1.7,
  showPhonetic: true,
  showPos: true,
  showCefr: true,
  showGloss: true,
  orientation: 'portrait',
  themeId: 'teal-day',
  kicker: '',
  density: 'normal',
  align: 'left',
  showMeta: true,
});

const FALLBACK_POS = Object.freeze({
  i: 'pronoun', me: 'pronoun', you: 'pronoun', he: 'pronoun', she: 'pronoun', we: 'pronoun',
  they: 'pronoun', it: 'pronoun', my: 'pronoun', your: 'pronoun', his: 'pronoun', her: 'pronoun',
  its: 'pronoun', our: 'pronoun', their: 'pronoun', him: 'pronoun', them: 'pronoun', us: 'pronoun',
  this: 'determiner', that: 'determiner', these: 'determiner', those: 'determiner',
  a: 'determiner', an: 'determiner', the: 'determiner', some: 'determiner', any: 'determiner',
  every: 'determiner', each: 'determiner', all: 'determiner',
  and: 'conjunction', or: 'conjunction', but: 'conjunction',
  in: 'preposition', on: 'preposition', at: 'preposition', to: 'particle', for: 'preposition',
  of: 'preposition', with: 'preposition', from: 'preposition', by: 'preposition',
  is: 'verb', am: 'verb', are: 'verb', was: 'verb', were: 'verb', be: 'verb',
  have: 'verb', has: 'verb', had: 'verb', do: 'verb', does: 'verb', did: 'verb',
  can: 'modal', could: 'modal', will: 'modal', would: 'modal', should: 'modal', must: 'modal',
  like: 'verb', want: 'verb', need: 'verb', go: 'verb', come: 'verb', get: 'verb',
  make: 'verb', take: 'verb', see: 'verb', eat: 'verb', drink: 'verb',
  fresh: 'adjective', good: 'adjective', bad: 'adjective', big: 'adjective', small: 'adjective',
  very: 'adverb', really: 'adverb', today: 'adverb', tomorrow: 'adverb', yesterday: 'adverb',
});

function reject(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function cleanText(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/\r/g, '\n').trim();
}

function cleanTitle(title, fallback) {
  const value = String(title || fallback || '工作台内容').replace(/\s+/g, ' ').trim();
  return (value || '工作台内容').slice(0, 200);
}

function estimateCefr(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return 'A1';
  if (A1_WORDS.has(w) || w.length <= 3) return 'A1';
  if (w.length <= 5) return 'A2';
  if (w.length <= 7) return 'B1';
  if (w.length <= 9) return 'B2';
  if (w.length <= 12) return 'C1';
  return 'C2';
}

function extractTokens(sentence) {
  const tokens = [];
  const re = /([A-Za-z][A-Za-z']*)|([^A-Za-z]+)/g;
  let match;
  while ((match = re.exec(String(sentence || ''))) !== null) {
    if (match[1]) {
      tokens.push({ type: 'word', text: match[1], key: match[1].toLowerCase() });
    } else if (match[2]) {
      tokens.push({ type: 'other', text: match[2] });
    }
  }
  return tokens;
}

function pickKeyExpressions(sentences) {
  const scored = [];
  for (const sentence of sentences) {
    const words = String(sentence).match(/[A-Za-z][A-Za-z']*/g) || [];
    if (words.length < 3 || words.length > 18) continue;
    const rare = words.filter((w) => !A1_WORDS.has(w.toLowerCase())).length;
    scored.push({ text: sentence, score: rare + Math.min(words.length, 10) / 10 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.text);
}

function glossFromCurated(word) {
  const curated = getCuratedEntry(word);
  if (!curated) return null;
  const meaning = curated.meanings?.[0]?.definitions?.[0];
  return {
    phonetic: curated.phonetic ? `/${String(curated.phonetic).replace(/^\/|\/$/g, '')}/` : '',
    partOfSpeech: curated.partOfSpeech || '',
    definition: meaning?.definition || '',
    zh: meaning?.zh || '',
  };
}

function annotateText(rawText, options = {}) {
  const text = cleanText(rawText);
  if (text.length < 8) throw reject('请粘贴至少一句完整英文');
  if (text.length > MAX_TEXT) throw reject(`文本过长，请控制在 ${MAX_TEXT} 字以内`);

  const sentences = buildReadingSubtitles(text);
  if (!sentences.length) throw reject('没有识别到可用的英文句子');

  const uniqueKeys = [];
  const seen = new Set();
  for (const sentence of sentences) {
    for (const token of extractTokens(sentence)) {
      if (token.type !== 'word') continue;
      if (seen.has(token.key)) continue;
      seen.add(token.key);
      uniqueKeys.push(token.key);
      if (uniqueKeys.length >= MAX_ANNOTATE_WORDS) break;
    }
    if (uniqueKeys.length >= MAX_ANNOTATE_WORDS) break;
  }

  const words = {};
  for (const key of uniqueKeys) {
    const gloss = glossFromCurated(key);
    words[key] = {
      word: key,
      cefr: estimateCefr(key),
      phonetic: gloss?.phonetic || '',
      partOfSpeech: gloss?.partOfSpeech || FALLBACK_POS[key] || '',
      definition: gloss?.definition || '',
      zh: gloss?.zh || '',
      common: A1_WORDS.has(key),
    };
  }

  const sentenceBlocks = sentences.map((sentence, index) => ({
    id: `s${index + 1}`,
    text: sentence,
    tokens: extractTokens(sentence),
  }));

  const vocab = Object.values(words)
    .filter((item) => !item.common)
    .sort((a, b) => a.word.localeCompare(b.word));

  return {
    kind: 'workbench-annotation',
    title: cleanTitle(options.title, sentences[0].slice(0, 48)),
    sourceText: text,
    level: estimatePassageLevel(vocab, sentences),
    sentences: sentenceBlocks,
    words,
    keyExpressions: pickKeyExpressions(sentences),
    vocabList: vocab.slice(0, 40),
    dictationList: vocab.slice(0, 20).map((item) => item.word),
    shadowingTasks: sentences.slice(0, 12).map((sentence, index) => ({
      id: `task-${index + 1}`,
      text: sentence,
    })),
  };
}

function estimatePassageLevel(vocab, sentences) {
  if (!vocab.length) return 'A2';
  const ranks = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
  const avg = vocab.reduce((sum, item) => sum + (ranks[item.cefr] || 2), 0) / vocab.length;
  if (avg < 1.8) return 'A1';
  if (avg < 2.6) return 'A2';
  if (avg < 3.4) return 'B1';
  if (avg < 4.2) return 'B2';
  if (avg < 5) return 'C1';
  return 'C2';
}

function normalizeRole(role) {
  return role === 'blogger' ? 'blogger' : 'teacher';
}

function normalizeTemplateId(templateId, role) {
  const found = TEMPLATES.find((item) => item.id === templateId);
  if (found) return found.id;
  return role === 'blogger' ? 'xhs-long' : 'intensive-note';
}

function normalizeStyles(styles) {
  const input = styles && typeof styles === 'object' ? styles : {};
  return {
    ...DEFAULT_STYLES,
    ...Object.fromEntries(
      Object.keys(DEFAULT_STYLES).map((key) => [key, input[key] !== undefined ? input[key] : DEFAULT_STYLES[key]])
    ),
  };
}

function makeShareToken() {
  return crypto.randomBytes(12).toString('hex');
}

function rowToDocument(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    role: row.role,
    templateId: row.template_id,
    sourceText: row.source_text,
    annotated: typeof row.annotated === 'string' ? JSON.parse(row.annotated) : (row.annotated || {}),
    styles: typeof row.styles === 'string' ? JSON.parse(row.styles) : (row.styles || DEFAULT_STYLES),
    shareToken: row.share_token || null,
    shareExpiresAt: row.share_expires_at || null,
    practiceArticleId: row.practice_article_id ? Number(row.practice_article_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openUrl: `./workbench.html?id=${encodeURIComponent(row.id)}`,
    shareUrl: row.share_token ? `./workbench.html?share=${encodeURIComponent(row.share_token)}` : null,
    practiceUrl: row.practice_article_id
      ? `./reader.html?id=${encodeURIComponent(row.practice_article_id)}`
      : null,
  };
}

async function defaultQuery(sql, params) {
  const dataStore = require('../data-store');
  await dataStore.init();
  return dataStore.pool.query(sql, params);
}

async function createDocument(input = {}, userId, deps = {}) {
  if (!userId) throw reject('请先登录', 401);
  const role = normalizeRole(input.role);
  const templateId = normalizeTemplateId(input.templateId, role);
  const annotated = input.annotated && typeof input.annotated === 'object'
    ? input.annotated
    : annotateText(input.sourceText || input.text, { title: input.title });
  const sourceText = cleanText(input.sourceText || input.text || annotated.sourceText);
  if (!sourceText) throw reject('缺少正文内容');
  const title = cleanTitle(input.title || annotated.title, sourceText.slice(0, 40));
  const styles = normalizeStyles(input.styles);
  const shareToken = makeShareToken();
  const query = deps.query || defaultQuery;
  const { rows } = await query(
    `INSERT INTO workbench_documents
     (user_id, title, role, template_id, source_text, annotated, styles, share_token, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW(), NOW())
     RETURNING *`,
    [
      userId,
      title,
      role,
      templateId,
      sourceText,
      JSON.stringify(annotated),
      JSON.stringify(styles),
      shareToken,
    ]
  );
  return { success: true, document: rowToDocument(rows[0]) };
}

async function updateDocument(id, input = {}, userId, deps = {}) {
  if (!userId) throw reject('请先登录', 401);
  const query = deps.query || defaultQuery;
  const existing = await getOwnedDocument(id, userId, query);
  const role = normalizeRole(input.role || existing.role);
  const templateId = normalizeTemplateId(input.templateId || existing.template_id, role);
  const annotated = input.annotated && typeof input.annotated === 'object'
    ? input.annotated
    : (typeof existing.annotated === 'string' ? JSON.parse(existing.annotated) : existing.annotated);
  const sourceText = cleanText(input.sourceText || input.text || existing.source_text || annotated.sourceText);
  const title = cleanTitle(input.title || existing.title, sourceText.slice(0, 40));
  const styles = normalizeStyles(input.styles || existing.styles);
  const { rows } = await query(
    `UPDATE workbench_documents
     SET title = $2,
         role = $3,
         template_id = $4,
         source_text = $5,
         annotated = $6::jsonb,
         styles = $7::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $8
     RETURNING *`,
    [
      id,
      title,
      role,
      templateId,
      sourceText,
      JSON.stringify(annotated),
      JSON.stringify(styles),
      userId,
    ]
  );
  if (!rows[0]) throw reject('找不到这份内容', 404);
  return { success: true, document: rowToDocument(rows[0]) };
}

async function getOwnedDocument(id, userId, query) {
  const { rows } = await query(
    `SELECT * FROM workbench_documents WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId]
  );
  if (!rows[0]) throw reject('找不到这份内容', 404);
  return rows[0];
}

async function getDocument(id, userId, deps = {}) {
  const query = deps.query || defaultQuery;
  const row = await getOwnedDocument(Number(id), userId, query);
  return { document: rowToDocument(row) };
}

async function getDocumentByShare(token, deps = {}) {
  const shareToken = String(token || '').trim();
  if (!shareToken) throw reject('无效的分享链接', 404);
  const query = deps.query || defaultQuery;
  const { rows } = await query(
    `SELECT * FROM workbench_documents
     WHERE share_token = $1
       AND (share_expires_at IS NULL OR share_expires_at > NOW())
     LIMIT 1`,
    [shareToken]
  );
  if (!rows[0]) throw reject('分享链接不存在或已过期', 404);
  return { document: rowToDocument(rows[0]) };
}

async function listDocuments(userId, deps = {}) {
  if (!userId) throw reject('请先登录', 401);
  const query = deps.query || defaultQuery;
  const { rows } = await query(
    `SELECT id, title, role, template_id, share_token, practice_article_id, created_at, updated_at
     FROM workbench_documents
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [userId]
  );
  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      role: row.role,
      templateId: row.template_id,
      updatedAt: row.updated_at,
      openUrl: `./workbench.html?id=${encodeURIComponent(row.id)}`,
      shareUrl: row.share_token ? `./workbench.html?share=${encodeURIComponent(row.share_token)}` : null,
      practiceUrl: row.practice_article_id
        ? `./reader.html?id=${encodeURIComponent(row.practice_article_id)}`
        : null,
    })),
  };
}

async function deleteDocument(id, userId, deps = {}) {
  if (!userId) throw reject('请先登录', 401);
  const query = deps.query || defaultQuery;
  const { rows } = await query(
    `DELETE FROM workbench_documents WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  if (!rows[0]) throw reject('找不到这份内容', 404);
  return { success: true, id: Number(rows[0].id) };
}

async function createPracticeLink(id, userId, options = {}, deps = {}) {
  if (!userId) throw reject('请先登录', 401);
  const query = deps.query || defaultQuery;
  const row = await getOwnedDocument(Number(id), userId, query);
  const annotated = typeof row.annotated === 'string' ? JSON.parse(row.annotated) : (row.annotated || {});
  const text = cleanText(row.source_text || annotated.sourceText);
  const cues = buildReadingSubtitles(text);
  if (!cues.length) throw reject('没有可练习的句子');
  const content = subtitleContent(cues);
  const level = annotated.level || 'A2';
  const title = cleanTitle(row.title, cues[0].slice(0, 40));
  let articleId = row.practice_article_id ? Number(row.practice_article_id) : null;

  if (articleId) {
    await query(
      `UPDATE articles
       SET title = $2, content = $3, level = $4, word_count = $5, tags = $6, updated_at = NOW()
       WHERE id = $1`,
      [articleId, title, content, level, content.split(/\s+/).length, ['workbench', 'subtitles', 'practice']]
    );
  } else {
    const inserted = await query(
      `INSERT INTO articles
       (title, content, level, tags, word_count, difficulty_score, status, source_type, pdf_path, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, $5, 0.3, 'published', $6, NULL, NOW(), NOW(), NOW())
       RETURNING id`,
      [title, content, level, ['workbench', 'subtitles', 'practice'], content.split(/\s+/).length, PRACTICE_SOURCE]
    );
    articleId = Number(inserted.rows[0].id);
  }

  let shareExpiresAt = null;
  if (options.expiresInDays) {
    const days = Math.min(Math.max(Number(options.expiresInDays) || 0, 1), 365);
    shareExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const shareToken = row.share_token || makeShareToken();
  const { rows } = await query(
    `UPDATE workbench_documents
     SET practice_article_id = $2,
         share_token = COALESCE(share_token, $3),
         share_expires_at = $4,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $5
     RETURNING *`,
    [id, articleId, shareToken, shareExpiresAt, userId]
  );

  const document = rowToDocument(rows[0]);
  return {
    success: true,
    document,
    practiceUrl: document.practiceUrl,
    shareUrl: document.shareUrl,
  };
}

function listTemplates(role) {
  const normalized = role ? normalizeRole(role) : null;
  return TEMPLATES.filter((item) => !normalized || item.role === normalized);
}

module.exports = {
  annotateText,
  createDocument,
  updateDocument,
  getDocument,
  getDocumentByShare,
  listDocuments,
  deleteDocument,
  createPracticeLink,
  listTemplates,
  TEMPLATES,
  DEFAULT_STYLES,
  SOURCE_TYPE,
  PRACTICE_SOURCE,
  estimateCefr,
  extractTokens,
};
