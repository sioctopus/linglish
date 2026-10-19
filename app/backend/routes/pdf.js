const dataStore = require('../data-store');
const ocrService = require('../services/ocr');
const { handleFileUpload, cleanupFile } = require('../upload-handler');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

/**
 * Register and handle PDF and OCR routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerPdfRoutes(pathname, req, res, url) {
  // Legacy PDF import routes remain disabled; use the scoped document importer.
  // POST /ocr/extract
  if (pathname === '/ocr/extract' && req.method === 'POST') {
    try {
      await authenticate(req);
      const { files, fields } = await handleFileUpload(req);

      if (!files.image) {
        return sendError(res, 400, 'Image file is required');
      }

      const imageFile = files.image;
      const pdfFingerprint = fields.pdfFingerprint || '';
      const pageNumber = parseInt(fields.pageNumber) || 0;

      console.log('OCR extract request - pdfFingerprint:', pdfFingerprint);
      console.log('OCR extract request - pageNumber:', pageNumber);

      try {
        // Check cache first
        if (pdfFingerprint && pageNumber > 0) {
          const cached = await dataStore.getOcrCache(pdfFingerprint, pageNumber);
          if (cached) {
            console.log(`OCR cache hit for ${pdfFingerprint} page ${pageNumber}`);
            console.log('Cached text preview:', cached.ocr_text.substring(0, 100));
            await cleanupFile(imageFile.path);
            return sendJson(res, 200, {
              text: cached.ocr_text,
              words: cached.word_positions,
              cached: true
            });
          }
        }

        // Perform OCR with word positions
        const result = await ocrService.extractTextFromImage(imageFile.path, 'eng', true);

        // Save to cache
        if (pdfFingerprint && pageNumber > 0) {
          await dataStore.saveOcrCache({
            pdfFingerprint,
            pageNumber,
            ocrText: result.text,
            confidence: result.confidence,
            wordPositions: result.words || []
          });
        }

        // Clean up uploaded file
        await cleanupFile(imageFile.path);

        return sendJson(res, 200, {
          text: result.text,
          words: result.words,
          confidence: result.confidence,
        });
      } catch (err) {
        await cleanupFile(imageFile.path);
        throw err;
      }
    } catch (err) {
      console.error('OCR extract error:', err);
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerPdfRoutes };
