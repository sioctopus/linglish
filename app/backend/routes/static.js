const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const dataStore = require('../data-store');
const { sendError } = require('../middleware/error-handler');
const authService = require('../services/auth');
const mediaSession = require('../services/media-session');
const { getCorsHeaders, appendVary } = require('../utils/cors');
const performanceConfig = require('../config/performance');

const FRONTEND_DIR = path.join(__dirname, '../../frontend');
const STATIC_DIR = path.join(__dirname, '../public');
const VIDEO_DIR = path.join(STATIC_DIR, 'videos');
const RECORDINGS_DIR = path.join(STATIC_DIR, 'recordings');
const FEEDBACK_UPLOAD_DIR = path.join(__dirname, '../uploads/feedback');
const CHAT_UPLOAD_DIR = path.join(__dirname, '../uploads/chat');
const { getPublicSiteUrl } = require('../utils/public-site-url');
const PUBLIC_SITE_URL = getPublicSiteUrl();
const { getSupportEmail } = require('../utils/support-email');
const SUPPORT_EMAIL = getSupportEmail();
const INDEXABLE_FRONTEND_PAGES = new Set([
  'landing.html',
  'pricing.html',
  'privacy.html',
  'terms.html',
]);
const CLEAN_PUBLIC_PAGES = new Map([
  ['/interview', 'interview.html'],
  ['/workplace', 'workplace.html'],
  ['/shadowing', 'shadowing.html'],
  ['/workbench', 'workbench.html'],
  ['/teacher', 'workbench.html'],
]);

function safePdfFilename(pathname) {
  const raw = String(pathname || '').replace(/^\/pdfs\//, '');
  let filename = raw;
  try {
    filename = decodeURIComponent(raw);
  } catch (_) {
    return null;
  }
  if (!filename || filename !== path.basename(filename) || filename.includes('\0')) return null;
  return filename;
}

/**
 * Get MIME type for a file based on extension
 * @param {string} filePath - File path
 * @returns {string} MIME type
 */
function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.gif')) return 'image/gif';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  if (filePath.endsWith('.wav')) return 'audio/wav';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  if (filePath.endsWith('.ogg')) return 'audio/ogg';
  if (filePath.endsWith('.pdf')) return 'application/pdf';
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.webm')) return 'video/webm';
  if (filePath.endsWith('.mov')) return 'video/quicktime';
  if (filePath.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
}

function readCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_) {
      return null;
    }
  }
  return null;
}

function extractBearerToken(req) {
  const value = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function shareIsCurrent(share) {
  if (!share) return false;
  if (!share.expires_at) return true;
  const expiresAt = new Date(share.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

async function authorizeMediaRequest(req, url, validateShare) {
  const shareToken = url.searchParams.get('share');
  if (shareToken) {
    const share = await dataStore.getPracticeRecordingShareByToken(shareToken);
    if (shareIsCurrent(share) && await validateShare(share)) {
      return { mode: 'share', share, user: null };
    }
  }

  const cookieName = mediaSession.getMediaSessionCookieName();
  const cookieToken = readCookie(req, cookieName);
  if (cookieToken) {
    try {
      const user = await mediaSession.requireMediaSession(cookieToken);
      return { mode: 'cookie', share: null, user };
    } catch (err) {
      if (err?.status === 503) throw err;
      /* try compatible account credentials */
    }
  }

  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    try {
      const user = await authService.requireUser(bearerToken);
      return { mode: 'bearer', share: null, user };
    } catch (_) { /* try the legacy query credential when enabled */ }
  }

  if (process.env.MEDIA_ALLOW_LEGACY_QUERY_TOKEN !== 'false') {
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      try {
        const user = await authService.requireUser(queryToken);
        return { mode: 'query', share: null, user };
      } catch (_) { /* handled below */ }
    }
  }

  return { mode: null, share: null, user: null, deniedShare: Boolean(shareToken) };
}

function parseSingleRange(value, size) {
  if (typeof value !== 'string' || !value.startsWith('bytes=') || value.includes(',')) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      return null;
    }
    end = Math.min(end, size - 1);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    return null;
  }
  return { start, end };
}

function ifRangeMatches(value, etag, modifiedAtMs) {
  if (!value) return true;
  if (value === etag) return true;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.floor(modifiedAtMs / 1_000) <= Math.floor(parsed / 1_000);
}

/**
 * Serve static file with Range request support for videos
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} filePath - File path to serve
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<boolean>} True if file was served, false otherwise
 */
async function serveStatic(res, filePath, req, options = {}) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }

    const contentType = getContentType(filePath);
    const htmlBody = contentType.startsWith('text/html')
      ? Buffer.from((await fsp.readFile(filePath, 'utf8'))
        .replace(/https:\/\/(?:www\.)?example\.com/g, () => PUBLIC_SITE_URL)
        .replace(/(?:hello|support)@example\.com/g, () => SUPPORT_EMAIL))
      : null;
    const fileSize = htmlBody ? htmlBody.length : stat.size;

    const isVideo = contentType.startsWith('video/');
    const isAudio = contentType.startsWith('audio/');
    const rangeCapable = isVideo || isAudio;
    const requestedRange = rangeCapable ? req?.headers?.range : null;
    const corsHeaders = getCorsHeaders(req?.headers?.origin, { logUnknown: false });
    const vary = appendVary(res.getHeader('Vary'), corsHeaders.Vary);
    delete corsHeaders.Vary;
    const etag = `"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const commonHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': rangeCapable ? 'bytes' : undefined,
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      Vary: vary,
      ...corsHeaders,
    };
    for (const key of Object.keys(commonHeaders)) {
      if (commonHeaders[key] == null) delete commonHeaders[key];
    }

    if (rangeCapable) {
      res.disableCompression = true;
    }

    const useRange = requestedRange && ifRangeMatches(req?.headers?.['if-range'], etag, stat.mtimeMs);
    const range = useRange ? parseSingleRange(requestedRange, fileSize) : null;
    if (useRange && !range) {
      res.writeHead(416, {
        ...commonHeaders,
        'Content-Range': `bytes */${fileSize}`,
        'Content-Length': 0,
      });
      res.end();
      return true;
    }

    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...commonHeaders,
        ...(options.cacheControl ? { 'Cache-Control': options.cacheControl } : {}),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunkSize,
      });

      if (req?.method === 'HEAD') {
        res.end();
        return true;
      }

      const readStream = fs.createReadStream(filePath, { start, end });
      await new Promise((resolve, reject) => {
        readStream.pipe(res);
        readStream.on('end', resolve);
        readStream.on('error', reject);
        res.on('error', reject);
      });
    } else {
      const headers = {
        ...commonHeaders,
        ...(options.cacheControl ? { 'Cache-Control': options.cacheControl } : {}),
        'Content-Length': fileSize,
      };

      // Versioned assets are content-addressed by their ?v= value. Let both the
      // browser and the CDN keep them instead of revalidating every game visit.
      const lower = filePath.toLowerCase();
      const versionedAsset = /[?&]v=[^&]+/.test(req?.url || '')
        && /\.(?:css|js|json|jpe?g|png|gif|svg|ico|woff2?|ttf|eot)$/.test(lower);
      if (options.cacheControl) {
        headers['Cache-Control'] = options.cacheControl;
      } else if (versionedAsset) {
        headers['Cache-Control'] = `public, max-age=${performanceConfig.staticAssets.maxAge}, immutable`;
        delete headers.Pragma;
        delete headers.Expires;
      } else if (lower.endsWith('.html')) {
        // HTML files: Never cache to ensure users get latest version
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
      } else if (lower.endsWith('.js') || lower.endsWith('.css')) {
        // JS/CSS files: Revalidate every time
        headers['Cache-Control'] = 'no-cache, must-revalidate';
        headers['Pragma'] = 'no-cache';
      } else if (/(favicon\.ico|linglish-favicon\.svg|linglish-favicon\.png)$/.test(lower)) {
        // Favicons: No cache
        headers['Cache-Control'] = 'no-cache';
      } else if (lower.match(/\.(jpg|jpeg|png|gif|svg|ico)$/)) {
        // Images: Can cache for a short time (5 minutes)
        headers['Cache-Control'] = 'public, max-age=300';
      } else if (lower.match(/\.(woff|woff2|ttf|eot)$/)) {
        // Fonts: Can cache longer (1 day)
        headers['Cache-Control'] = 'public, max-age=86400';
      }

      res.writeHead(200, headers);

      if (req?.method === 'HEAD') {
        res.end();
        return true;
      }

      if (htmlBody) {
        res.end(htmlBody);
        return true;
      }

      const readStream = fs.createReadStream(filePath);
      await new Promise((resolve, reject) => {
        readStream.pipe(res);
        readStream.on('end', resolve);
        readStream.on('error', reject);
        res.on('error', reject);
      });
    }

    return true;
  } catch (err) {
    // Avoid noisy logs for normal 404s on random crawler paths
    if (err && err.code !== 'ENOENT') {
      console.error('Error serving static file:', err);
    }
    return false;
  }
}

/**
 * Register and handle static file serving routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerStaticRoutes(pathname, req, res, url) {
  // GET /env.js (runtime frontend configuration)
  if (req.method === 'GET' && pathname === '/env.js') {
    const envNumber = (key) => {
      const raw = process.env[key];
      if (raw == null || raw === '') return undefined;
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    };
    const envBool = (key) => {
      const raw = process.env[key];
      if (raw == null || raw === '') return undefined;
      return raw !== 'false';
    };
    const config = {
      showIcp: process.env.FRONTEND_SHOW_ICP === 'true',
      icpText: (process.env.FRONTEND_ICP_TEXT || '').trim(),
      enableNetworkUpload: process.env.FRONTEND_ENABLE_NETWORK_UPLOAD !== 'false',
      enableGoogleOAuth: process.env.FRONTEND_ENABLE_GOOGLE_OAUTH !== 'false',
      enableWechatOAuth: process.env.FRONTEND_ENABLE_WECHAT_OAUTH === 'true',
      waveformSegmentationEnabled: envBool('FRONTEND_WAVEFORM_SEGMENTATION_ENABLED'),
      waveformSegmentationMinDurationSec: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_DURATION_SEC'),
      waveformSegmentationMinWords: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_WORDS'),
      waveformSegmentationMinSilenceSec: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_SILENCE_SEC'),
      waveformSegmentationThresholdRatio: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_THRESHOLD_RATIO'),
      waveformSegmentationMinThreshold: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_THRESHOLD'),
      waveformSegmentationMinEdgeSec: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_EDGE_SEC'),
      waveformSegmentationMinChunkSec: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MIN_CHUNK_SEC'),
      waveformSegmentationMaxSplits: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MAX_SPLITS'),
      waveformSegmentationMaxSplitsPerSegment: envNumber('FRONTEND_WAVEFORM_SEGMENTATION_MAX_SPLITS_PER_SEGMENT'),
    };
    const payload = `window.__LINGLISH_ENV__=${JSON.stringify(config)};`;
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
    });
    res.end(payload);
    return true;
  }
  // GET /static/*
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/static/')) {
    const relPath = pathname.replace(/^\/static\//, '');
    const target = path.resolve(STATIC_DIR, relPath);
    if (!target.startsWith(`${STATIC_DIR}${path.sep}`)) return sendError(res, 404, 'Not Found');
    // Protected media must use its authenticated route, never an alternate static URL.
    const topDirectory = path.relative(STATIC_DIR, target).split(path.sep)[0];
    if (['videos', 'recordings'].includes(topDirectory)) return sendError(res, 404, 'Not Found');
    const served = await serveStatic(res, target, req);
    if (!served) {
      return sendError(res, 404, 'Not Found');
    }
    return true;
  }

  // Serve public topic pages on stable, extension-free URLs.
  if ((req.method === 'GET' || req.method === 'HEAD') && CLEAN_PUBLIC_PAGES.has(pathname)) {
    const served = await serveStatic(res, path.join(FRONTEND_DIR, CLEAN_PUBLIC_PAGES.get(pathname)), req);
    if (!served) return sendError(res, 404, 'Not Found');
    return true;
  }

  // Consolidate duplicate entry URLs so search engines see one canonical URL per page.
  const legacyRedirects = new Map([
    ['/landing.html', '/'],
    ['/index.html', '/'],
    ['/interview.html', '/interview'],
    ['/workplace.html', '/workplace'],
    ['/shadowing.html', '/shadowing'],
    ['/workbench.html', '/workbench'],
  ]);
  if ((req.method === 'GET' || req.method === 'HEAD') && legacyRedirects.has(pathname)) {
    const query = url.search || '';
    res.writeHead(301, {
      Location: `${legacyRedirects.get(pathname)}${query}`,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end();
    return true;
  }

  // GET/HEAD /robots.txt
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/robots.txt') {
    const body = [
      '# Linglish - AI-Powered Immersive English Learning Platform',
      `# ${PUBLIC_SITE_URL}`,
      '',
      '# Allow all major search engines',
      'User-agent: *',
      'Allow: /',
      '',
      '# Disallow private/dynamic content',
      'Disallow: /recordings/',
      'Disallow: /tts-audio/',
      'Disallow: /admin',
      'Disallow: /admin-*',
      'Disallow: /test-*',
      'Disallow: /quick-fix.html',
      'Disallow: /clean-invalid-words.html',
      '',
      '# Sitemap location',
      `Sitemap: ${PUBLIC_SITE_URL}/sitemap.xml`,
      `# AI content guide: ${PUBLIC_SITE_URL}/llms.txt`,
      '',
      '# Crawl-delay for politeness',
      'Crawl-delay: 1',
      '',
      '# Specific bots optimization',
      'User-agent: Googlebot',
      'Allow: /',
      'Crawl-delay: 0',
      '',
      'User-agent: Bingbot',
      'Allow: /',
      'Crawl-delay: 1',
      '',
      'User-agent: GPTBot',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      'User-agent: ChatGPT-User',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      'User-agent: OAI-SearchBot',
      'Allow: /',
      'Disallow: /recordings/',
      'Disallow: /tts-audio/',
      'Disallow: /admin',
      'Disallow: /admin-*',
      'Disallow: /test-*',
      'Disallow: /quick-fix.html',
      'Disallow: /clean-invalid-words.html',
      'Crawl-delay: 2',
      '',
      'User-agent: CCBot',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      'User-agent: anthropic-ai',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      'User-agent: Claude-Web',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      '# AI Search Crawlers',
      'User-agent: PerplexityBot',
      'Allow: /',
      'Crawl-delay: 2',
      '',
      'User-agent: YouBot',
      'Allow: /',
      'Crawl-delay: 2',
      ''
    ].join('\n');
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  // GET /favicon.ico
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/favicon.ico') {
    // Prefer real ICO for maximum compatibility; fall back to SVG/PNG
    const ico = path.join(FRONTEND_DIR, 'favicon.ico');
    const svg = path.join(FRONTEND_DIR, 'linglish-favicon.svg');
    const png32 = path.join(FRONTEND_DIR, 'favicon-32.png');
    if (await serveStatic(res, ico, req)) return true;
    if (await serveStatic(res, svg, req)) return true;
    if (await serveStatic(res, png32, req)) return true;
    // Fallback to no content if not present
    res.writeHead(204, { 'Content-Type': 'image/x-icon' });
    res.end();
    return true;
  }

  // GET/HEAD /videos/* (video streaming)
  if (pathname.startsWith('/videos/') && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const filename = pathname.replace('/videos/', '');
      const filePath = path.join(VIDEO_DIR, filename);
      const access = await authorizeMediaRequest(req, url, async (share) => {
        const resource = await dataStore.getVideoResourceById(share.video_resource_id);
        const relPath = `/videos/${filename}`;
        const matchesVideoPath = resource?.video_path === relPath;
        const matchesLocalPath = resource?.local_video_path === relPath;
        return Boolean(resource && (matchesVideoPath || matchesLocalPath));
      });
      if (!access.mode) {
        return sendError(res, access.deniedShare ? 403 : 401, 'Unauthorized');
      }

      const cacheControl = access.mode === 'share' || access.mode === 'query'
        ? 'private, no-store'
        : 'private, max-age=300';
      const served = await serveStatic(res, filePath, req, { cacheControl });
      if (!served) {
        return sendError(res, 404, 'Video not found');
      }
      return true;
    } catch (err) {
      if (err?.status === 503) {
        return sendError(res, 503, 'Service unavailable');
      }
      return sendError(res, 401, err.message);
    }
  }

  // GET/HEAD /recordings/* (user recording files)
  if (pathname.startsWith('/recordings/') && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const relPath = pathname.replace('/recordings/', '');
      const userMatch = relPath.match(/video-(\d+)\/user-(\d+)\//);
      if (!userMatch) {
        return sendError(res, 400, 'Invalid recording path');
      }
      const videoId = Number(userMatch[1]);
      const ownerId = Number(userMatch[2]);
      const access = await authorizeMediaRequest(req, url, async (share) => {
        const shareUserId = Number(share.user_id);
        const shareVideoId = Number(share.video_resource_id);
        if (shareUserId !== ownerId || shareVideoId !== videoId || !share.speaker) return false;
        const recordings = await dataStore.listPracticeRecordingsForUser(
          share.video_resource_id,
          share.user_id,
          share.speaker,
        );
        return recordings.some(recording => recording.audio_path === pathname);
      });

      if (!access.mode) {
        return sendError(res, access.deniedShare ? 403 : 401, 'Unauthorized');
      }
      if (access.mode !== 'share') {
        const currentUserId = Number(access.user.id);
        if (!Number.isFinite(ownerId) || !Number.isFinite(currentUserId) || ownerId !== currentUserId) {
          return sendError(res, 403, 'Access denied');
        }
      }

      const filePath = path.join(RECORDINGS_DIR, relPath);
      const served = await serveStatic(res, filePath, req, { cacheControl: 'private, no-store' });
      if (!served) {
        return sendError(res, 404, 'Recording not found');
      }
      return true;
    } catch (err) {
      const status = err.status || 400;
      return sendError(res, status, status === 503 ? 'Service unavailable' : err.message);
    }
  }

  // GET /feedback-uploads/* (feedback attachments)
  if (pathname.startsWith('/feedback-uploads/') && req.method === 'GET') {
    const relPath = pathname.replace('/feedback-uploads/', '');
    const filePath = path.join(FEEDBACK_UPLOAD_DIR, relPath);
    const served = await serveStatic(res, filePath, req);
    if (!served) {
      return sendError(res, 404, 'Feedback file not found');
    }
    return true;
  }

  // GET /chat-uploads/* (group chat attachments)
  if (pathname.startsWith('/chat-uploads/') && req.method === 'GET') {
    const relPath = pathname.replace('/chat-uploads/', '');
    const filePath = path.join(CHAT_UPLOAD_DIR, relPath);
    const served = await serveStatic(res, filePath, req);
    if (!served) {
      return sendError(res, 404, 'Chat file not found');
    }
    return true;
  }

  // Uploaded class-note images are private and use the same owner checks as their article.
  if (pathname.startsWith('/note-images/') && (req.method === 'GET' || req.method === 'HEAD')) {
    res.setHeader('Cache-Control', 'private, no-store');
    const raw = pathname.replace(/^\/note-images\//, '');
    let filename = raw;
    try { filename = decodeURIComponent(raw); } catch (_) { filename = ''; }
    if (!/^note-[a-z0-9.-]+$/i.test(filename) || filename !== path.basename(filename)) {
      return sendError(res, 404, 'Not Found');
    }
    const ext = path.extname(filename).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return sendError(res, 404, 'Not Found');
    try {
      const access = await authorizeMediaRequest(req, url, async () => false);
      if (!access.mode) return sendError(res, access.deniedShare ? 403 : 401, 'Unauthorized');
      const articles = await dataStore.getArticles(access.user);
      if (!articles.some(article => article.note_image_path === `/note-images/${filename}`)) {
        return sendError(res, 404, 'Not Found');
      }
      const filePath = path.join(__dirname, '../note-images', filename);
      const served = await serveStatic(res, filePath, req, { cacheControl: 'private, no-store' });
      if (!served) return sendError(res, 404, 'Not Found');
      return true;
    } catch (err) {
      const status = err?.status === 503 ? 503 : 401;
      return sendError(res, status, status === 503 ? 'Service unavailable' : 'Unauthorized');
    }
  }

  // GET /pdfs/* (PDF file serving)
  if (pathname.startsWith('/pdfs/') && (req.method === 'GET' || req.method === 'HEAD')) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const access = await authorizeMediaRequest(req, url, async () => false);
      if (!access.mode) return sendError(res, access.deniedShare ? 403 : 401, 'Unauthorized');

      const filename = safePdfFilename(pathname);
      if (!filename) {
        return sendError(res, 403, 'Access denied - PDF not in database');
      }

      // Verify PDF exists in database (security check)
      const articles = await dataStore.getArticles(access.user);
      const pdfExists = articles.some(article =>
        article.pdf_path && article.pdf_path === `/pdfs/${filename}`
      );

      if (!pdfExists) {
        console.warn('PDF access denied:', { path: `/pdfs/${filename}` });
        return sendError(res, 403, 'Access denied - PDF not in database');
      }

      const filePath = path.join(__dirname, '../pdfs', filename);
      const served = await serveStatic(res, filePath, req, { cacheControl: 'private, no-store' });
      if (!served) {
        console.warn('PDF unavailable:', { path: `/pdfs/${filename}` });
        return sendError(res, 404, 'PDF not found');
      }
      return true;
    } catch (err) {
      const status = err?.status === 503 ? 503 : 401;
      console.error('PDF serving error:', { code: err?.code || `HTTP_${status}` });
      return sendError(res, status, status === 503 ? 'Service unavailable' : 'Unauthorized');
    }
  }

  // GET/HEAD /* (frontend fallback - HTML pages and assets)
  if (req.method === 'GET' || req.method === 'HEAD') {
    // Normalize to prevent absolute path from escaping FRONTEND_DIR
    const rel = pathname === '/' ? 'landing.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(FRONTEND_DIR, rel);
    if (!filePath.startsWith(`${FRONTEND_DIR}${path.sep}`)) return sendError(res, 404, 'Not Found');
    if (rel.toLowerCase().endsWith('.html') && !INDEXABLE_FRONTEND_PAGES.has(rel)) {
      res.setHeader('X-Robots-Tag', 'noindex, follow');
    }
    const served = await serveStatic(res, filePath, req);
    if (!served) {
      // For non-HTML requests (JS, CSS, etc), send proper 404 without JSON
      const isAsset = pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i);
      if (isAsset) {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
        return true;
      }
      return sendError(res, 404, 'Not Found');
    }
    return true;
  }

  // Route not handled
  return false;
}

module.exports = { registerStaticRoutes, serveStatic };
