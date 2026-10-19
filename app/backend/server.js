// Polyfill for Node.js 18 compatibility (adds File class required by undici)
require('./node18-polyfill');

require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const { URL } = require('url');
const ffmpeg = require('fluent-ffmpeg');
let ffmpegAvailable = false;
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller?.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    ffmpegAvailable = true;
  }
  // Try to configure ffprobe as well (required by fluent-ffmpeg for screenshots/metadata)
  try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller?.path) {
      ffmpeg.setFfprobePath(ffprobeInstaller.path);
    }
  } catch (e) {
    // allow running with system ffprobe or env var
    if (process.env.FFPROBE_PATH) {
      try { ffmpeg.setFfprobePath(process.env.FFPROBE_PATH); } catch (_) {}
    } else {
      console.warn('FFprobe installer not available. If thumbnails fail, install @ffprobe-installer/ffprobe or set FFPROBE_PATH.');
    }
  }
} catch (err) {
  console.warn('FFmpeg installer not available, audio transcoding disabled.', err?.message || err);
}

const dataStore = require('./data-store');
const aiConfig = require('./config/ai-config');
const authService = require('./services/auth');
const trainingService = require('./services/training');
const roleplayService = require('./services/roleplay');
const aiService = require('./services/ai');
// Temporarily disabled due to pdf-parse module issues
// const pdfImportService = require('./services/pdf-import');
const { handleFileUpload, cleanupFile } = require('./upload-handler');
const ttsService = require('./services/tts');
// Temporarily disabled due to pdf-parse module issues
// const ocrService = require('./services/ocr');
const dictionaryService = require('./services/dictionary');
const translationService = require('./services/translation');
const videoTranscriptionService = require('./services/video-transcription');
const pronunciationService = require('./services/pronunciation');
const spacedRepetition = require('./services/spaced-repetition');
const reviewScheduler = require('./services/review-scheduler');
const { setupGroupChatWebSocket } = require('./ws/group-chat');
const { getCorsHeaders } = require('./utils/cors');

// Performance middleware
const compressionMiddleware = require('./middleware/compression');
const cacheHeadersMiddleware = require('./middleware/cache-headers');

const PORT = process.env.PORT || 4000;
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'ssl', 'server.key');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, 'ssl', 'combined.crt');

const FRONTEND_DIR = path.join(__dirname, '../frontend');
const STATIC_DIR = path.join(__dirname, 'public');
const VIDEO_DIR = path.join(STATIC_DIR, 'videos');
const RECORDINGS_DIR = path.join(STATIC_DIR, 'recordings');
const THUMBS_DIR = path.join(STATIC_DIR, 'thumbnails');

(async () => {
  try {
    await fsp.mkdir(VIDEO_DIR, { recursive: true });
    await fsp.mkdir(RECORDINGS_DIR, { recursive: true });
    await fsp.mkdir(THUMBS_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to ensure video directory:', err);
  }
})();

// Security headers (Content Security Policy and others)
const SECURITY_HEADERS = {
  // Content Security Policy - allows inline scripts/styles but restricts sources
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net https://www.youtube.com https://*.invidious.io https://invidious.jing.rocks https://invidious.private.coffee https://inv.nadeko.net https://invidious.io.lol https://yt.artemislena.eu https://invidious.nerdvpn.de https://inv.perditum.com https://invidious.f5.si https://yewtu.be https://static.cloudflareinsights.com",
    "script-src-elem 'self' https: 'unsafe-inline' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' data: blob: ws: wss: https://api.openai.com https://api.openai.com http://ip-api.com",
    "media-src 'self' blob: data: https://www.youtube.com https://i.ytimg.com https://*.googlevideo.com https://*.invidious.io https://invidious.jing.rocks https://invidious.private.coffee https://inv.nadeko.net https://invidious.io.lol https://yt.artemislena.eu https://invidious.nerdvpn.de https://inv.perditum.com https://invidious.f5.si https://yewtu.be",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://*.invidious.io https://invidious.jing.rocks https://invidious.private.coffee https://inv.nadeko.net https://invidious.io.lol https://yt.artemislena.eu https://invidious.nerdvpn.de https://inv.perditum.com https://invidious.f5.si https://yewtu.be",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests"
  ].join('; '),
  // Prevent MIME type sniffing
  'X-Content-Type-Options': 'nosniff',
  // Prevent clickjacking
  'X-Frame-Options': 'SAMEORIGIN',
  // XSS Protection (legacy but still useful)
  'X-XSS-Protection': '1; mode=block',
  // Referrer policy
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Permissions policy (limit browser features)
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(self)',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Linglish-Device',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

const VIDEO_TRANSCRIPTION_ENABLED = aiConfig.features?.videoTranscription !== false;

// Import rate limiter
const { createRateLimiter, presets: rateLimitPresets } = require('./middleware/rate-limiter');

// Create rate limiters for different endpoint types
const generalRateLimiter = rateLimitPresets.api;
const authRateLimiter = rateLimitPresets.auth;
const uploadRateLimiter = rateLimitPresets.upload;
const expensiveRateLimiter = rateLimitPresets.expensive;

// Create a very lenient rate limiter for pronunciation practice
// Users need to practice repeatedly, so allow very frequent requests
const pronunciationRateLimiter = createRateLimiter({
  windowMs: 3600000, // 1 hour
  max: 5000,         // 5000 requests per hour (very lenient for intensive practice)
  message: 'Too many pronunciation requests. Please take a short break and try again.',
});

// TTS 单独限流:磁盘缓存 + 免费 edge-tts,重复词都是 cache hit,不属于「昂贵操作」。
// 游戏一关就要几十次发音(词卡自动读 + 连连看配对读),塞进 expensive 的 20 次/小时
// 会在学到第 6 个词时就静默断声。
const ttsRateLimiter = createRateLimiter({
  windowMs: 3600000, // 1 hour
  max: 2000,
  message: 'Too many TTS requests. Please take a short break and try again.',
});

// Import route modules
const { registerAuthRoutes } = require('./routes/auth');
const { registerOAuthRoutes } = require('./routes/oauth');
const { registerContentRoutes } = require('./routes/content');
const { registerVocabularyRoutes } = require('./routes/vocabulary');
const { registerVocabularyV2Routes } = require('./routes/vocabulary-v2');  // 新增：全局唯一词汇系统
const { registerAiVocabRoutes } = require('./routes/ai-vocab');
const { shouldBypassExpensiveRateLimit } = require('./middleware/ai-auth');
const { registerVideoRoutes } = require('./routes/videos');
const { registerYouTubeRoutes } = require('./routes/youtube');
const { registerMediaLibraryRoutes } = require('./routes/media-library');
const { registerYouTubeProxyRoutes } = require('./routes/youtube-proxy');
const { registerAdminUsersRoutes } = require('./routes/admin/users');
const { registerAdminTranslationsRoutes, registerAdminWordsRoutes } = require('./routes/admin/translations');
const { registerAdminAnalyticsRoutes } = require('./routes/admin/analytics');
const { registerSuspiciousTranslationsRoutes } = require('./routes/admin/suspicious-translations');
const { registerDictionaryQualityRoutes } = require('./routes/admin/dictionary-quality');
const { handleFixDefinitions } = require('./routes/admin/fix-definitions');
const { registerTrainingRoutes } = require('./routes/training');
const { registerPronunciationRoutes } = require('./routes/pronunciation');
const { registerAiRoutes } = require('./routes/ai');
const { registerAIRoleplayRoutes } = require('./routes/ai-roleplay');
const { registerTtsRoutes } = require('./routes/tts');
const { registerDictionaryRoutes } = require('./routes/dictionary-api');
const { registerFeedbackRoutes } = require('./routes/feedback');
const { registerTagRoutes } = require('./routes/tags');
const { registerDocumentRoutes } = require('./routes/documents');
const { registerWorkbenchRoutes } = require('./routes/workbench');
const { registerQuestsRoutes } = require('./routes/quests');
const { registerRetentionRoutes } = require('./routes/retention');
const { registerCommunityRoutes } = require('./routes/community');
const { registerStaticRoutes } = require('./routes/static');
const { registerLearningPlanRoutes } = require('./routes/learning-plan');
const { registerStreakRoutes } = require('./routes/streak');
const { registerLeagueRoutes } = require('./routes/league');
const { registerWordDeepRoutes } = require('./routes/word-deep');
const { registerCoachingRoutes } = require('./routes/coaching');
const { registerSeoRoutes } = require('./routes/seo');
const { registerSubscriptionRoutes } = require('./routes/subscription');
const { registerHealthRoutes } = require('./routes/health');
const { registerTrackingRoutes } = require('./routes/tracking');
const { registerLearningStatsRoutes } = require('./routes/learning-stats');
const { registerTeamLeadRoutes } = require('./routes/team-leads');
const gamificationCron = require('./cron/gamification-cron');

async function handleRequest(req, res) {
  // Get origin from request
  const origin = req.headers.origin;

  // Apply security headers to all responses
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Apply CORS headers
  const corsHeaders = getCorsHeaders(origin);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Apply compression middleware (wraps response for automatic compression)
  compressionMiddleware(req, res, () => {});

  // Apply cache headers middleware for static assets
  cacheHeadersMiddleware(req, res, () => {});

  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Health check - skip rate limiting for health checks
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, JSON_HEADERS);
    return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  // Apply rate limiting based on endpoint type. Static media is intentionally
  // excluded because video/range requests can be frequent during normal playback.
  let rateLimitPassed = true;

  if (pathname.startsWith('/auth/') || pathname === '/auth/register' || pathname === '/auth/login') {
    rateLimitPassed = authRateLimiter(req, res);
  } else if (
    pathname === '/video-resources/upload' ||
    pathname === '/video-resources/youtube' ||
    pathname === '/feedback/upload' ||
    pathname === '/documents/import' ||
    pathname === '/class-notes' ||
    /^\/documents\/\d+\/subtitles$/.test(pathname) ||
    pathname === '/ocr/extract' ||
    pathname.startsWith('/pdf/') ||
    pathname === '/api/workbench' ||
    pathname === '/api/workbench/annotate'
  ) {
    rateLimitPassed = uploadRateLimiter(req, res);
  } else if (pathname.startsWith('/pronunciation/')) {
    rateLimitPassed = pronunciationRateLimiter(req, res);
  } else if (pathname.startsWith('/tts/')) {
    rateLimitPassed = ttsRateLimiter(req, res);
  } else if (
    pathname.startsWith('/ai/') ||
    pathname.startsWith('/ai-roleplay/') ||
    pathname.match(/^\/video-resources\/\d+\/(retranscribe|reprocess-segments|import-transcript)$/)
  ) {
    rateLimitPassed = shouldBypassExpensiveRateLimit(req, pathname)
      ? true
      : expensiveRateLimiter(req, res);
  } else if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/vocabulary/') ||
    pathname.startsWith('/vocab') ||
    pathname.startsWith('/training/') ||
    pathname === '/events' ||
    pathname.startsWith('/video-resources') ||
    pathname.startsWith('/media/') ||
    pathname.startsWith('/practice/') ||
    pathname.startsWith('/admin/')
  ) {
    rateLimitPassed = generalRateLimiter(req, res);
  }

  // If rate limit exceeded, return early (response already sent by rate limiter)
  if (!rateLimitPassed) {
    return;
  }

  // Pre-compute regex matches for quest routes
  const questRouteMatch = pathname.match(/^\/videos\/(\d+)\/quests$/);
  const questRunsRouteMatch = pathname.match(/^\/quests\/(\d+)\/runs$/);

  // Try each route module in order
  try {
    if (await registerHealthRoutes(pathname, req, res)) return;
    if (await registerTrackingRoutes(pathname, req, res, url)) return;
    if (await registerLearningStatsRoutes(pathname, req, res, url)) return;
    if (await registerTeamLeadRoutes(pathname, req, res, url)) return;
    if (await registerAuthRoutes(pathname, req, res, url)) return;
    if (await registerOAuthRoutes(pathname, req, res, url)) return;
    if (await registerContentRoutes(pathname, req, res, url)) return;
    if (await registerVocabularyV2Routes(pathname, req, res, url)) return;  // 新增：V2词汇路由（优先级高）
    if (await registerVocabularyRoutes(pathname, req, res, url)) return;
    if (await registerAiVocabRoutes(pathname, req, res, url)) return;
    if (await registerVideoRoutes(pathname, req, res, url)) return;
    if (await registerMediaLibraryRoutes(pathname, req, res, url)) return;
    if (await registerYouTubeRoutes(pathname, req, res, url)) return;
    if (await registerYouTubeProxyRoutes(pathname, req, res, url)) return;
    if (await registerAdminUsersRoutes(pathname, req, res, url)) return;
    if (await registerAdminTranslationsRoutes(pathname, req, res, url)) return;
    if (await registerAdminWordsRoutes(pathname, req, res, url)) return;
    if (await registerAdminAnalyticsRoutes(pathname, req, res, url)) return;
    if (await registerSuspiciousTranslationsRoutes(pathname, req, res, url)) return;
    if (await registerDictionaryQualityRoutes(pathname, req, res, url)) return;
    // Admin fix definitions endpoint
    if (pathname === '/admin/fix-definitions' && req.method === 'POST') {
      await handleFixDefinitions(req, res);
      return;
    }
    if (await registerTrainingRoutes(pathname, req, res, url)) return;
    if (await registerPronunciationRoutes(pathname, req, res, url)) return;
    if (await registerAiRoutes(pathname, req, res, url)) return;
    if (await registerAIRoleplayRoutes(pathname, req, res, url)) return;
    if (await registerTtsRoutes(pathname, req, res, url)) return;
    if (await registerDictionaryRoutes(pathname, req, res, url)) return;
    if (await registerFeedbackRoutes(pathname, req, res, url)) return;
    if (await registerTagRoutes(pathname, req, res, url)) return;
    if (await registerDocumentRoutes(pathname, req, res)) return;
    if (await registerWorkbenchRoutes(pathname, req, res)) return;
    if (pathname === '/ocr/extract') {
      const { registerPdfRoutes } = require('./routes/pdf');
      if (await registerPdfRoutes(pathname, req, res, url)) return;
    }
    if (await registerQuestsRoutes(pathname, req, res, url, { questRouteMatch, questRunsRouteMatch })) return;
    if (await registerRetentionRoutes(pathname, req, res, url)) return;
    if (await registerCommunityRoutes(pathname, req, res, url)) return;
    if (await registerLearningPlanRoutes(pathname, req, res, url)) return;
    if (await registerStreakRoutes(pathname, req, res, url)) return;
    if (await registerLeagueRoutes(pathname, req, res, url)) return;
    if (await registerWordDeepRoutes(pathname, req, res, url)) return;
    if (await registerCoachingRoutes(pathname, req, res, url)) return;
    if (await registerSeoRoutes(pathname, req, res, url)) return;
    if (await registerSubscriptionRoutes(pathname, req, res, url)) return;
    if (await registerStaticRoutes(pathname, req, res, url)) return;
  } catch (err) {
    console.error('Unhandled route error:', err);
    if (!res.headersSent) {
      res.writeHead(500, JSON_HEADERS);
      return res.end(JSON.stringify({ code: 500, message: 'Internal Server Error' }));
    }
    return;
  }

  // No route matched - 404
  if (!res.headersSent) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
  }
}

async function start() {
  await dataStore.init();

  // Start gamification cron jobs
  gamificationCron.start();

  const requestHandler = (req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Unhandled error', err);
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ code: 500, message: 'Internal Server Error' }));
      }
    });
  };

  // HTTP Server
  const httpServer = http.createServer(requestHandler);
  // Set timeout to 10 minutes for large file uploads
  httpServer.timeout = 600000; // 10 minutes
  httpServer.headersTimeout = 610000; // slightly higher than timeout
  httpServer.requestTimeout = 600000;
  setupGroupChatWebSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`linglish backend (HTTP) listening on http://localhost:${PORT}`);
    console.log(`Server timeout set to: ${httpServer.timeout}ms`);
  });

  // HTTPS Server (if enabled)
  if (ENABLE_HTTPS) {
    try {
      const httpsOptions = {
        key: fs.readFileSync(SSL_KEY_PATH),
        cert: fs.readFileSync(SSL_CERT_PATH)
      };

      const httpsServer = https.createServer(httpsOptions, requestHandler);
      // Set timeout to 10 minutes for large file uploads
      httpsServer.timeout = 600000; // 10 minutes
      httpsServer.headersTimeout = 610000; // slightly higher than timeout
      httpsServer.requestTimeout = 600000;
      setupGroupChatWebSocket(httpsServer);

      httpsServer.listen(HTTPS_PORT, () => {
        console.log(`linglish backend (HTTPS) listening on https://localhost:${HTTPS_PORT}`);
        console.log(`HTTPS server timeout set to: ${httpsServer.timeout}ms`);
      });
    } catch (err) {
      console.error('Failed to start HTTPS server:', err.message);
      console.error('Make sure SSL certificates exist at:');
      console.error('  Key:', SSL_KEY_PATH);
      console.error('  Cert:', SSL_CERT_PATH);
    }
  }
}

if (require.main === module) {
  start();
}

module.exports = {
  handleRequest,
  start,
};
