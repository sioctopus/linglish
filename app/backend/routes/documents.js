const cacheService = require('../services/cache');
const dataStore = require('../data-store');
const { importLearningDocument, rebuildReadingSubtitles } = require('../services/document-import');
const { createClassNote } = require('../services/class-note');
const { handleFileUpload, cleanupFile } = require('../upload-handler');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function uploadedFile(files) {
  const file = files?.file || files?.pdf || null;
  if (!file || !file.path) return null;
  const name = file.originalname || file.originalFilename || file.filename || '';
  if (!name) return null;
  return {
    path: file.path,
    originalFilename: name,
    size: file.size || 0,
  };
}

async function registerDocumentRoutes(pathname, req, res) {
  const subtitleMatch = pathname.match(/^\/documents\/(\d+)\/subtitles$/);
  if (subtitleMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const article = await dataStore.getArticleById(Number(subtitleMatch[1]), user);
      if (!article) return sendError(res, 404, '找不到这份文档');
      const result = await rebuildReadingSubtitles(article, { user });
      await cacheService.del('content:articles');
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.statusCode || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '提取失败');
    }
  }

  if (pathname === '/class-notes' && req.method === 'POST') {
    let tempPath = null;
    try {
      const user = await authenticate(req);
      const { files, fields } = await handleFileUpload(req, { maxTotalBytes: 12 * 1024 * 1024 });
      const file = uploadedFile(files);
      if (file) tempPath = file.path;
      let lines = [];
      try { lines = JSON.parse(fields.lines || '[]'); } catch (_) { lines = []; }
      const result = await createClassNote({ ownerUserId: user.id, word: fields.word, lines, image: file });
      await cacheService.del('content:articles');
      return sendJson(res, 201, result);
    } catch (err) {
      const status = err.statusCode || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '笔记没有生成');
    } finally {
      if (tempPath) await cleanupFile(tempPath);
    }
  }

  if (pathname !== '/documents/import' || req.method !== 'POST') return false;

  let tempPath = null;
  try {
    const user = await authenticate(req);
    const { files, fields } = await handleFileUpload(req, { maxTotalBytes: 32 * 1024 * 1024 });
    const file = uploadedFile(files);
    if (file) tempPath = file.path;

    const result = await importLearningDocument({
      ownerUserId: user.id,
      title: fields.title,
      text: fields.text,
      file,
    });
    await cacheService.del('content:articles');
    return sendJson(res, 201, result);
  } catch (err) {
    const status = err.statusCode || mapErrorToStatus(err, 400);
    return sendError(res, status, err.message || '导入失败');
  } finally {
    if (tempPath) await cleanupFile(tempPath);
  }
}

module.exports = { registerDocumentRoutes };
