const googleTranslate = require('@vitalets/google-translate-api');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GOOGLE_TRANSLATE_TIMEOUT_MS = Number(process.env.GOOGLE_TRANSLATE_TIMEOUT_MS || 8000);
const PROXY_URL = process.env.OPENAI_PROXY || ''; // 使用 OpenAI 的代理配置

// 轮询策略：交替使用代理和直接连接
let useProxyNext = false;

/**
 * Translate text using Google Translate API (via @vitalets/google-translate-api)
 * This is a free library that uses Google Translate's web interface
 * Supports proxy rotation to avoid rate limiting
 *
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code (default: 'zh-CN')
 * @param {boolean} forceProxy - Force using proxy (for retry logic)
 * @returns {Promise<string>} - Translated text
 */
async function translateViaGoogle(text, targetLang = 'zh-CN', forceProxy = null) {
  if (!text || typeof text !== 'string') {
    throw new Error('GOOGLE_TRANSLATE_INVALID_INPUT');
  }

  // 决定是否使用代理
  let shouldUseProxy = forceProxy !== null ? forceProxy : useProxyNext;

  // 如果没有配置代理，则总是直连
  if (!PROXY_URL) {
    shouldUseProxy = false;
  }

  // 轮询切换：下次使用相反的方式
  if (forceProxy === null) {
    useProxyNext = !useProxyNext;
  }

  try {
    const translateOptions = { from: 'en', to: targetLang };

    // 如果使用代理，配置 fetchOptions
    if (shouldUseProxy && PROXY_URL) {
      const proxyAgent = new HttpsProxyAgent(PROXY_URL);
      translateOptions.fetchOptions = {
        agent: proxyAgent
      };
      console.log('[Google Translate] Using proxy for this request');
    } else {
      console.log('[Google Translate] Using direct connection for this request');
    }

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('GOOGLE_TRANSLATE_TIMEOUT')), GOOGLE_TRANSLATE_TIMEOUT_MS);
    });

    // Race between translation and timeout
    const result = await Promise.race([
      googleTranslate.translate(text, translateOptions),
      timeoutPromise
    ]);

    const translated = result?.text?.trim();
    if (!translated) {
      throw new Error('GOOGLE_TRANSLATE_EMPTY_RESPONSE');
    }

    return translated;
  } catch (err) {
    // Re-throw with more context
    const errorMessage = err.message || 'Unknown error';
    if (errorMessage.includes('TIMEOUT')) {
      throw new Error('GOOGLE_TRANSLATE_TIMEOUT');
    }
    if (errorMessage.includes('TooManyRequestsError') || errorMessage.includes('429')) {
      throw new Error('GOOGLE_TRANSLATE_HTTP_429');
    }
    if (errorMessage.includes('BAD_REQUEST') || errorMessage.includes('400')) {
      throw new Error('GOOGLE_TRANSLATE_HTTP_400');
    }
    throw new Error(`GOOGLE_TRANSLATE_ERROR: ${errorMessage}`);
  }
}

/**
 * Translate text using Google Translate with retry logic
 * Implements smart retry strategy: if direct connection fails, try proxy (and vice versa)
 * @param {string} text - Text to translate
 * @returns {Promise<string>} - Translated text
 */
async function translateWithGoogle(text) {
  const maxRetries = 2; // Reduced retries to fail faster
  const baseDelayMs = 2000; // Increased base delay (2 seconds)

  // Track which connection method was used in first attempt
  let firstAttemptUsedProxy = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 重试策略：如果第一次失败，第二次尝试切换代理/直连
      let forceProxy = null;
      if (attempt > 0 && firstAttemptUsedProxy !== null && PROXY_URL) {
        // 第二次尝试：使用与第一次相反的连接方式
        forceProxy = !firstAttemptUsedProxy;
        console.log(`[Google Translate] Retry with ${forceProxy ? 'proxy' : 'direct connection'} (switching from previous attempt)`);
      } else if (attempt === 0) {
        // 第一次尝试：记录使用的连接方式
        firstAttemptUsedProxy = useProxyNext;
      }

      const result = await translateViaGoogle(text, 'zh-CN', forceProxy);
      if (result) {
        console.log(`[Google Translate] Success (attempt ${attempt + 1})`);
        return result;
      }
    } catch (err) {
      const errorMessage = err.message || '';

      // For HTTP 429 (rate limit) or TooManyRequests, use longer delays
      if (errorMessage.includes('HTTP_429') || errorMessage.includes('TooManyRequests') || errorMessage.includes('Too Many Requests')) {
        // Exponential backoff: 2s, 4s, 8s
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(`[Google Translate] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${delayMs}ms before retry...`);

        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        } else {
          // Max retries reached, throw error to trigger fallback to other providers
          console.log(`[Google Translate] Rate limit: max retries reached, falling back to other providers`);
          throw err;
        }
      }

      // For timeout errors, retry with shorter timeout
      if (errorMessage.includes('TIMEOUT')) {
        console.log(`[Google Translate] Timeout (attempt ${attempt + 1}/${maxRetries})`);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, baseDelayMs));
          continue;
        }
      }

      // For other errors or max retries reached, throw
      throw err;
    }
  }

  throw new Error('GOOGLE_TRANSLATE_MAX_RETRIES_EXCEEDED');
}

module.exports = {
  translateWithGoogle,
  translateViaGoogle,
};
