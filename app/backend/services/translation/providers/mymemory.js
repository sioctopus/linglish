const http = require('http');
const https = require('https');
const { URL } = require('url');

const MYMEMORY_URL = process.env.MYMEMORY_URL || 'https://api.mymemory.translated.net/get';
const MYMEMORY_TIMEOUT_MS = Number(process.env.MYMEMORY_TIMEOUT_MS || 5000);
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const MYMEMORY_LANGPAIR = process.env.MYMEMORY_LANGPAIR || 'en|zh-CN';

/**
 * Translate text using MyMemory API
 * @param {string} text - Text to translate
 * @returns {Promise<string>} - Translated text
 */
function translateViaMyMemory(text) {
  return new Promise((resolve, reject) => {
    if (!MYMEMORY_URL) {
      return reject(new Error('MYMEMORY_URL_NOT_CONFIGURED'));
    }

    let baseUrl;
    try {
      baseUrl = new URL(MYMEMORY_URL);
    } catch (err) {
      return reject(err);
    }

    const requestUrl = new URL(baseUrl.toString());
    requestUrl.searchParams.set('q', text);
    requestUrl.searchParams.set('langpair', MYMEMORY_LANGPAIR);
    if (MYMEMORY_EMAIL) {
      requestUrl.searchParams.set('de', MYMEMORY_EMAIL);
    }

    const requestOptions = {
      hostname: requestUrl.hostname,
      port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
      path: requestUrl.pathname + requestUrl.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      timeout: MYMEMORY_TIMEOUT_MS,
    };

    const client = requestUrl.protocol === 'https:' ? https : http;
    const req = client.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`MYMEMORY_HTTP_${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const translated = payload?.responseData?.translatedText?.trim();
          if (!translated) {
            return reject(new Error('MYMEMORY_EMPTY_RESPONSE'));
          }
          resolve(translated);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('MYMEMORY_TIMEOUT'));
    });
    req.end();
  });
}

/**
 * Translate text using MyMemory with retry logic
 * @param {string} text - Text to translate
 * @returns {Promise<string>} - Translated text
 */
async function translateWithMyMemory(text) {
  const maxRetries = 3;
  const baseDelayMs = 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await translateViaMyMemory(text);
      if (result) {
        console.log(`[MyMemory] Success (attempt ${attempt + 1})`);
        return result;
      }
    } catch (err) {
      // For HTTP 429 (rate limit), retry with exponential backoff
      if (err.message.includes('HTTP_429')) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(`[MyMemory] Rate limited (attempt ${attempt + 1}/${maxRetries}), retrying after ${delayMs}ms...`);

        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }

      // For other errors or max retries reached, throw
      throw err;
    }
  }

  throw new Error('MYMEMORY_HTTP_429');
}

module.exports = {
  translateWithMyMemory,
  translateViaMyMemory,
};
