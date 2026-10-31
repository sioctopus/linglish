const mediaLibrary = require('../services/media-library');
const { authenticate } = require('../middleware/auth');
const { hasActivePaidEntitlement } = require('../services/entitlements');

const ROUTES = new Set([
  '/media/channels/preview', '/media/podcasts/search', '/media/podcasts/preview',
  '/media/cues', '/media/resolve-cues', '/media/transcribe', '/media/covers/resolve',
]);

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
  return true;
}

async function readRawBody(req, maxBytes = 40 * 1024 * 1024) {
  if (Number(req.headers['content-length']) > maxBytes) throw new Error('BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function parseBody(req) {
  const buffer = await readRawBody(req, 32 * 1024);
  if (!buffer.length) return {};
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
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
    let status = 400;
    if (['UNAUTHORIZED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(message)) status = 401;
    else if (message === 'BODY_TOO_LARGE') status = 413;
    else if (error.code === 'LOCAL_WHISPER_BUSY') status = 503;
    else if (/会员|premium|upgrade/i.test(message)) status = 403;
    else if (/拉取失败|网络请求失败|请求超时|内容过大|字幕生成服务|音频太大/.test(message)) status = 502;
    return sendJson(res, status, { success: false, error: message });
  }
}

async function registerMediaLibraryRoutes(pathname, req, res) {
  if (!ROUTES.has(pathname)) return false;
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;
  return handle(res, async () => {
    const user = await authenticate(req);
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const isBinary = pathname === '/media/transcribe' && (
      contentType.includes('octet-stream') || contentType.startsWith('audio/')
      || contentType.startsWith('application/ogg')
    );
    let localOnly = false;
    let canTranscribe = false;
    if (pathname === '/media/transcribe' || pathname === '/media/resolve-cues') {
      const paid = hasActivePaidEntitlement(user);
      localOnly = !paid && await require('../services/video-transcription').hasLocalWhisper();
      canTranscribe = paid || localOnly;
      if (pathname === '/media/transcribe' && !canTranscribe) throw new Error('生成播客字幕需要会员');
    }
    if (isBinary) {
      const buf = await readRawBody(req);
      const language = String(req.headers['x-audio-language'] || 'en');
      const ext = String(req.headers['x-audio-ext'] || '.mp3');
      const cues = await mediaLibrary.transcribePodcastBuffer(buf, {
        language, ext, provider: localOnly ? 'local-whisper' : undefined,
      });
      return { cues };
    }
    const body = await parseBody(req);
    if (pathname === '/media/channels/preview') {
      return { channel: await mediaLibrary.loadYouTubeChannel(body.url || body.input) };
    }
    if (pathname === '/media/podcasts/search') {
      return { podcasts: await mediaLibrary.searchPodcasts(body.query) };
    }
    if (pathname === '/media/podcasts/preview') {
      return { podcast: await mediaLibrary.loadPodcastFeed(body.url, {
        collectionId: body.collectionId, query: body.query,
      }) };
    }
    if (pathname === '/media/cues') {
      return { cues: await mediaLibrary.loadTranscriptCues(body.url) };
    }
    if (pathname === '/media/covers/resolve') {
      return { images: await mediaLibrary.resolveCoverImages(body.items || []) };
    }
    const result = await mediaLibrary.resolveMediaCues({
      transcriptUrl: body.transcriptUrl || (pathname === '/media/resolve-cues' ? body.url : '') || '',
      audioUrl: body.audioUrl || (pathname === '/media/transcribe' ? body.url : '') || '',
      youtubeVideoId: body.youtubeVideoId || body.youtube_video_id || '',
      title: body.title || '',
      language: body.language || 'en',
      allowYoutubeSearch: body.allowYoutubeSearch !== false,
      allowAudioStt: canTranscribe && body.allowAudioStt !== false,
      provider: localOnly ? 'local-whisper' : undefined,
    });
    return result;
  });
}

module.exports = { registerMediaLibraryRoutes };
