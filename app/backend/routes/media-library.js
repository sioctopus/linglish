const mediaLibrary = require('../services/media-library');
const { authenticate } = require('../middleware/auth');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return false;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  const limit = 32 * 1024;
  if (Number(req.headers['content-length']) > limit) throw new Error('BODY_TOO_LARGE');
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (_) {
    throw new Error('INVALID_JSON');
  }
}

async function handle(res, work) {
  try {
    const payload = await work();
    return sendJson(res, 200, { success: true, ...payload });
  } catch (error) {
    const message = error && error.message ? error.message : '请求失败';
    const status = message === 'UNAUTHORIZED' || message === 'INVALID_TOKEN' || message === 'TOKEN_EXPIRED'
      ? 401 : message === 'BODY_TOO_LARGE' ? 413
        : /拉取失败|网络请求失败|请求超时|内容过大/.test(message) ? 502 : 400;
    return sendJson(res, status, { success: false, error: message });
  }
}

async function registerMediaLibraryRoutes(pathname, req, res) {
  if (!pathname.startsWith('/media/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;
  const routes = {
    '/media/channels/preview': async body => ({ channel: await mediaLibrary.loadYouTubeChannel(body.url || body.input) }),
    '/media/podcasts/search': async body => ({ podcasts: await mediaLibrary.searchPodcasts(body.query) }),
    '/media/podcasts/preview': async body => ({ podcast: await mediaLibrary.loadPodcastFeed(body.url) }),
    '/media/cues': async body => ({ cues: await mediaLibrary.loadTranscriptCues(body.url) }),
  };
  if (!Object.hasOwn(routes, pathname)) return false;
  return handle(res, async () => {
    await authenticate(req);
    const body = await parseBody(req);
    return routes[pathname](body);
  });
}

module.exports = { registerMediaLibraryRoutes };
