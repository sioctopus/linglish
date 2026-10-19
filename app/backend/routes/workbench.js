const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate, optionalAuth } = require('../middleware/auth');
const workbench = require('../services/workbench');

function statusOf(err, fallback = 400) {
  if (err?.message === 'UNAUTHORIZED') return 401;
  return err.statusCode || mapErrorToStatus(err, fallback);
}

async function registerWorkbenchRoutes(pathname, req, res) {
  // GET /api/workbench/templates?role=teacher|blogger
  if (pathname === '/api/workbench/templates' && req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const role = url.searchParams.get('role');
      return sendJson(res, 200, { items: workbench.listTemplates(role) });
    } catch (err) {
      return sendError(res, statusOf(err), err.message || '读取模板失败');
    }
  }

  // POST /api/workbench/annotate
  if (pathname === '/api/workbench/annotate' && req.method === 'POST') {
    try {
      await authenticate(req);
      const body = await parseBody(req);
      const annotated = workbench.annotateText(body.text || body.sourceText, { title: body.title });
      return sendJson(res, 200, { annotated });
    } catch (err) {
      return sendError(res, statusOf(err), err.message || '标注失败');
    }
  }

  // GET /api/workbench/share/:token  (public)
  const shareMatch = pathname.match(/^\/api\/workbench\/share\/([A-Za-z0-9_-]+)$/);
  if (shareMatch && req.method === 'GET') {
    try {
      const result = await workbench.getDocumentByShare(shareMatch[1]);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, statusOf(err, 404), err.message || '分享不存在');
    }
  }

  // Collection: GET/POST /api/workbench
  if (pathname === '/api/workbench') {
    if (req.method === 'GET') {
      try {
        const user = await authenticate(req);
        const result = await workbench.listDocuments(user.id);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendError(res, statusOf(err), err.message || '读取失败');
      }
    }
    if (req.method === 'POST') {
      try {
        const user = await authenticate(req);
        const body = await parseBody(req);
        const result = await workbench.createDocument(body, user.id);
        return sendJson(res, 201, result);
      } catch (err) {
        return sendError(res, statusOf(err), err.message || '保存失败');
      }
    }
    return false;
  }

  // Item routes: /api/workbench/:id[...]
  const itemMatch = pathname.match(/^\/api\/workbench\/(\d+)(\/practice-link)?$/);
  if (!itemMatch) return false;

  const id = Number(itemMatch[1]);
  const isPractice = Boolean(itemMatch[2]);

  if (isPractice && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      let body = {};
      try {
        body = await parseBody(req);
      } catch (_) {
        body = {};
      }
      const result = await workbench.createPracticeLink(id, user.id, body || {});
      return sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, statusOf(err), err.message || '生成练习链接失败');
    }
  }

  if (isPractice) return false;

  if (req.method === 'GET') {
    try {
      const user = await optionalAuth(req);
      if (!user) return sendError(res, 401, '请先登录');
      const result = await workbench.getDocument(id, user.id);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, statusOf(err, 404), err.message || '读取失败');
    }
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const result = await workbench.updateDocument(id, body, user.id);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, statusOf(err), err.message || '更新失败');
    }
  }

  if (req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const result = await workbench.deleteDocument(id, user.id);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, statusOf(err), err.message || '删除失败');
    }
  }

  return false;
}

module.exports = { registerWorkbenchRoutes };
