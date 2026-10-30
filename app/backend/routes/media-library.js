const mediaLibrary = require('../services/media-library');
const { authenticate } = require('../middleware/auth');
const { hasActivePaidEntitlement } = require('../services/entitlements');

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return false;
  // Keep any CORS headers already applied by server.js; only set content-type here.
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
  return true;
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (_) {
    return {};
  }
}

async function readRawBody(req, maxBytes = 40 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('这一集音频太大，暂时无法生成字幕');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(res, work) {
  try {
    const payload = await work();
    return sendJson(res, 200, { success: true, ...payload });
  } catch (error) {
    const message = error && error.message ? error.message : '请求失败';
    let status = 400;
    if (message === 'UNAUTHORIZED') status = 401;
    else if (/会员|premium|upgrade/i.test(message)) status = 403;
    else if (/拉取失败|网络请求失败|请求超时|内容过大|字幕生成服务|音频太大/.test(message)) status = 502;
    return sendJson(res, status, { success: false, error: message });
  }
}

async function registerMediaLibraryRoutes(pathname, req, res) {
  if (!pathname.startsWith('/media/')) return false;
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;

  if (pathname === '/media/channels/preview') {
    const body = await parseBody(req);
    return handle(res, async () => ({ channel: await mediaLibrary.loadYouTubeChannel(body.url || body.input) }));
  }
  if (pathname === '/media/podcasts/search') {
    const body = await parseBody(req);
    return handle(res, async () => ({ podcasts: await mediaLibrary.searchPodcasts(body.query) }));
  }
  if (pathname === '/media/podcasts/preview') {
    const body = await parseBody(req);
    return handle(res, async () => ({
      podcast: await mediaLibrary.loadPodcastFeed(body.url, {
        collectionId: body.collectionId,
        query: body.query,
      }),
    }));
  }
  if (pathname === '/media/cues') {
    const body = await parseBody(req);
    return handle(res, async () => ({ cues: await mediaLibrary.loadTranscriptCues(body.url) }));
  }
  if (pathname === '/media/resolve-cues') {
    const body = await parseBody(req);
    return handle(res, async () => {
      // Authenticated users can resolve/generate cues for any playable media.
      // Local Whisper makes this free; cloud STT still works when credits exist.
      await authenticate(req);
      const result = await mediaLibrary.resolveMediaCues({
        transcriptUrl: body.transcriptUrl || body.url || '',
        audioUrl: body.audioUrl || '',
        youtubeVideoId: body.youtubeVideoId || body.youtube_video_id || '',
        title: body.title || '',
        language: body.language || 'en',
        allowYoutubeSearch: body.allowYoutubeSearch !== false,
        allowAudioStt: body.allowAudioStt !== false,
      });
      return result;
    });
  }
  if (pathname === '/media/transcribe') {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const isBinary = contentType.includes('octet-stream')
      || contentType.startsWith('audio/')
      || contentType.startsWith('application/ogg');
    if (isBinary) {
      return handle(res, async () => {
        const user = await authenticate(req);
        const videoTranscription = require('../services/video-transcription');
        if (!hasActivePaidEntitlement(user) && !(await videoTranscription.hasLocalWhisper())) {
          throw new Error('生成播客字幕需要会员');
        }
        const buf = await readRawBody(req);
        const language = String(req.headers['x-audio-language'] || 'en');
        const ext = String(req.headers['x-audio-ext'] || '.mp3');
        const cues = await mediaLibrary.transcribePodcastBuffer(buf, { language, ext });
        return { cues };
      });
    }
    const body = await parseBody(req);
    return handle(res, async () => {
      const user = await authenticate(req);
      const videoTranscription = require('../services/video-transcription');
      if (!hasActivePaidEntitlement(user) && !(await videoTranscription.hasLocalWhisper())) {
        throw new Error('生成播客字幕需要会员');
      }
      const resolved = await mediaLibrary.resolveMediaCues({
        transcriptUrl: body.transcriptUrl || '',
        audioUrl: body.audioUrl || body.url || '',
        youtubeVideoId: body.youtubeVideoId || body.youtube_video_id || '',
        title: body.title || '',
        language: body.language || 'en',
      });
      return { cues: resolved.cues, source: resolved.source };
    });
  }
  if (pathname === '/media/covers/resolve') {
    const body = await parseBody(req);
    return handle(res, async () => ({
      images: await mediaLibrary.resolveCoverImages(body.items || []),
    }));
  }
  return false;
}

module.exports = { registerMediaLibraryRoutes };
