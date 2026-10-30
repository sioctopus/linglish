const path = require('path');
const ttsService = require('../services/tts');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { serveStatic } = require('../middleware/file-server');

const PRACTICE_VOICES = new Set([
  'en-US-AriaNeural',
  'en-US-GuyNeural',
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-JennyNeural',
  'en-US-RogerNeural',
  'en-GB-LibbyNeural',
  'en-GB-MaisieNeural',
  'en-GB-RyanNeural',
  'en-GB-ThomasNeural',
  'en-GB-SoniaNeural',
]);

function practiceRequest(body) {
  const text = String((body && body.text) || '').trim();
  if (!text) {
    const error = new Error('text is required');
    error.statusCode = 400;
    throw error;
  }
  if (text.length > 180) {
    const error = new Error('text is too long');
    error.statusCode = 400;
    throw error;
  }
  const voice = PRACTICE_VOICES.has(body && body.voice) ? body.voice : 'en-US-AvaMultilingualNeural';
  return { text, voice };
}

/**
 * Register and handle text-to-speech routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerTtsRoutes(pathname, req, res, url) {
  // POST /tts/practice — short English lines for the daily speaking page, no login
  if (pathname === '/tts/practice' && req.method === 'POST') {
    try {
      const practice = practiceRequest(await parseBody(req));
      const audioFile = await ttsService.textToSpeech(practice.text, {
        lang: 'en',
        provider: 'edge',
        voice: practice.voice,
        format: 'mp3',
      });
      const relativePath = `/tts-audio/${path.basename(audioFile)}`;
      return sendJson(res, 200, { audioUrl: relativePath });
    } catch (err) {
      const status = err.statusCode || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /tts/generate
  if (pathname === '/tts/generate' && req.method === 'POST') {
    try {
      await authenticate(req);
      const body = await parseBody(req);

      if (!body.text) {
        return sendError(res, 400, 'text is required');
      }

      const audioFile = await ttsService.textToSpeech(body.text, {
        lang: body.lang || 'en',
        slow: body.slow || false,
        provider: body.provider || ttsService.TTS_CONFIG.provider,
        voice: body.voice || ttsService.TTS_CONFIG.edgeVoice,
        format: body.format || 'mp3',
      });

      // Return relative path for frontend
      const relativePath = `/tts-audio/${path.basename(audioFile)}`;
      return sendJson(res, 200, { audioUrl: relativePath });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /tts/voices
  if (pathname === '/tts/voices' && req.method === 'GET') {
    try {
      await authenticate(req);
      const voices = await ttsService.getAvailableVoices();
      return sendJson(res, 200, { voices });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // GET /tts-audio/:filename (serve TTS audio files)
  if (pathname.startsWith('/tts-audio/') && req.method === 'GET') {
    try {
      const filename = pathname.replace('/tts-audio/', '');
      const filePath = path.join(__dirname, '../tts_cache', filename);
      const served = await serveStatic(res, filePath, req);
      if (!served) {
        return sendError(res, 404, 'Audio file not found');
      }
      return true;
    } catch (err) {
      return sendError(res, 404, 'Audio file not found');
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerTtsRoutes, practiceRequest };
