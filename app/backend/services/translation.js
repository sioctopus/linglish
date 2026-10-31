// Import modules
const { builtInDict, properNameDict, technicalTermsDict } = require('./translation/built-in-dictionary');
const { getFromCache, setInCache, deleteFromCache } = require('./translation/cache');
const dataStore = require('../data-store');
const { translateWithOpenAI } = require('./translation/providers/openai');
const { translateWithDeepL } = require('./translation/providers/deepl');
const { translateWithGoogle, translateViaGoogle } = require('./translation/providers/google');
const { translateWithLibreTranslate } = require('./translation/providers/libretranslate');
const { translateWithMyMemory, translateViaMyMemory } = require('./translation/providers/mymemory');
const rateLimiter = require('./translation/rate-limiter');
const { postEditZh } = require('./translation/post-edit');
const {
  isPlaceholderTranslation,
  cleanTranslation,
  detectProperNoun,
  isValidTranslation,
  scoreTranslation,
} = require('./translation/validation');

const DEFAULT_SOURCE_SCORES = Object.freeze({
  legacy: 40,
  mymemory: 55,
  deepl: 70,
  libretranslate: 75,
  google: 90,
  dictionary: 100,
  'proper-noun-detection': 95,
  'openai-correction': 95,
});
const TRUSTED_TRANSLATION_SOURCES = new Set(['dictionary', 'proper-noun-detection', 'openai-correction', 'google']);

function translationResult(translation, source, options = {}) {
  const normalizedSource = String(source || '').trim().toLowerCase() || 'legacy';
  const suppliedScore = Number(options.score);
  const score = Number.isFinite(suppliedScore)
    ? suppliedScore
    : (DEFAULT_SOURCE_SCORES[normalizedSource] ?? 50);
  const needsReview = options.needsReview === true || !TRUSTED_TRANSLATION_SOURCES.has(normalizedSource);
  return {
    translation,
    fromCache: options.fromCache === true,
    source: normalizedSource,
    score,
    needsReview,
    ...(options.isProperNoun ? { isProperNoun: true } : {}),
  };
}

// Simple retry helper with backoff. Stops early on rate-limit to avoid hammering.
async function runWithRetries(fn, attempts = 2, delayMs = 1200, label = 'translate') {
  let lastErr = null;
  const isRateLimit = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit');
  };
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const rateLimited = isRateLimit(err);
      if (i >= attempts - 1 || rateLimited) {
        // stop early on rate-limit or max attempts
        break;
      }
      const wait = delayMs * Math.pow(2, i); // exponential: 1.2s, 2.4s...
      console.warn(`[Translation Retry] ${label} attempt ${i + 1} failed${rateLimited ? ' (rate limit)' : ''}: ${err?.message || err}. Retrying in ${wait}ms`);
      await new Promise(res => setTimeout(res, wait));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function singularizeEnglishWord(word) {
  if (!word || typeof word !== 'string') return word;
  if (!/^[a-z]+$/.test(word)) return word;
  if (word.length <= 3) return word;
  if (word.endsWith('ss')) return word;

  const irregular = {
    children: 'child',
    people: 'person',
    men: 'man',
    women: 'woman',
    mice: 'mouse',
    geese: 'goose',
    feet: 'foot',
    teeth: 'tooth',
  };
  if (irregular[word]) return irregular[word];

  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;

  // boxes, classes, brushes, watches...
  const esEndings = ['ses', 'xes', 'zes', 'ches', 'shes'];
  if (esEndings.some(suffix => word.endsWith(suffix))) return word.slice(0, -2);

  if (word.endsWith('ves') && word.length > 4) return `${word.slice(0, -3)}f`;

  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function buildLookupCandidates(normalizedWord) {
  const candidates = [];
  const push = (v) => {
    if (v && !candidates.includes(v)) candidates.push(v);
  };

  push(normalizedWord);

  const withoutApostrophe = normalizedWord.replace(/'/g, '');
  push(withoutApostrophe);

  // plural/base form (dictionary/cache friendly)
  push(singularizeEnglishWord(normalizedWord));
  push(singularizeEnglishWord(withoutApostrophe));

  return candidates;
}

/**
 * Translate English word to Chinese using multiple translation providers
 * Falls back to built-in dictionary if APIs fail
 *
 * Translation flow:
 * 1. Check cache
 * 2. Check built-in dictionary (builtInDict, properNameDict, technicalTermsDict)
 * 3. Try LibreTranslate API with retry logic
 * 4. Fallback to MyMemory API with retry logic
 * 5. Validate and score translations
 * 6. Return best translation or intelligent fallback
 */
async function translateWord(word, options = {}) {
  if (!word) {
    throw new Error('INVALID_WORD');
  }

  // Normalize the word: handle different apostrophe types
  const normalizedWord = word.toLowerCase().trim().replace(/[']/g, "'");
  const lookupCandidates = buildLookupCandidates(normalizedWord);
  const singularCandidate = singularizeEnglishWord(normalizedWord);
  const lemmaCandidate = singularCandidate && singularCandidate !== normalizedWord ? singularCandidate : null;

  const userLabel = options?.userLabel || 'unknown';
  const persist = options?.persist !== false;
  const logTs = () => new Date().toISOString();

  const cacheTranslation = async (translation, source, { database = true } = {}) => {
    if (!persist) return;
    setInCache(normalizedWord, translation, source);
    if (!database) return;
    try {
      if (dataStore?.isDatabaseAvailable?.()) {
        await dataStore.upsertTranslationCache(normalizedWord, translation, source);
      }
    } catch (_) { }
  };

  const evictTranslation = async ({ database = false } = {}) => {
    if (!persist) return;
    deleteFromCache(normalizedWord);
    if (!database) return;
    try {
      if (dataStore?.isDatabaseAvailable?.()) {
        await dataStore.query('DELETE FROM translation_cache WHERE word = $1', [normalizedWord]);
      }
    } catch (_) { }
  };

  console.log(`[${logTs()}] [Translation Service] user=${userLabel} Original word: ${word}`);
  console.log(`[${logTs()}] [Translation Service] user=${userLabel} Normalized word: ${normalizedWord}`);

  let lowConfidenceCached = null;

  // Step 1: Check caches first (DB → memory)
  try {
    if (dataStore && dataStore.isDatabaseAvailable && dataStore.isDatabaseAvailable()) {
      const row = await dataStore.getTranslationCache(normalizedWord);
      if (row && row.translation && !isPlaceholderTranslation(row.translation)) {
        // 检查缓存的翻译是否等于原词（说明之前翻译失败了）
        if (row.translation.toLowerCase() === normalizedWord.toLowerCase()) {
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} DB cache has failed translation (original word), skipping: ${row.translation}`);
          // 不返回，继续尝试重新翻译
        } else if (row.source === 'mymemory') {
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} DB cache hit from MyMemory (low confidence), will try to improve: ${row.translation}`);
          lowConfidenceCached = lowConfidenceCached || { translation: row.translation, source: row.source, fromCache: true };
        } else {
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} DB cache hit: ${row.translation}`);
          return translationResult(postEditZh(word, row.translation), row.source, { fromCache: true });
        }
      }
    }
  } catch (_) { }

  // If exact cache miss, try base/lemma cache (e.g. "pots" -> "pot") and reuse it.
  if (lemmaCandidate) {
    try {
      if (dataStore && dataStore.isDatabaseAvailable && dataStore.isDatabaseAvailable()) {
        const row = await dataStore.getTranslationCache(lemmaCandidate);
        if (row && row.translation && !isPlaceholderTranslation(row.translation)) {
          if (row.translation.toLowerCase() !== lemmaCandidate.toLowerCase()) {
            console.log(`[${logTs()}] [Translation Service] user=${userLabel} DB cache lemma hit (${lemmaCandidate}): ${row.translation}`);
            if (row.source === 'mymemory') {
              console.log(`[${logTs()}] [Translation Service] user=${userLabel} Lemma cache is from MyMemory (low confidence), will try to improve`);
              lowConfidenceCached = lowConfidenceCached || { translation: row.translation, source: row.source, fromCache: true };
            } else {
              const source = row.source || 'cache-lemma';
              await cacheTranslation(row.translation, source);
              const edited = postEditZh(word, row.translation);
              return translationResult(edited, source, { fromCache: true });
            }
          }
        }
      }
    } catch (_) { }
  }

  const cached = getFromCache(normalizedWord);
  if (cached) {
    if (isPlaceholderTranslation(cached.translation)) {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Ignoring cached placeholder for ${normalizedWord}`);
      await evictTranslation();
    } else if (cached.translation.toLowerCase() === normalizedWord.toLowerCase()) {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Memory cache has failed translation (original word), skipping: ${cached.translation}`);
      await evictTranslation();
      // 不返回，继续尝试重新翻译
    } else if (cached.source === 'mymemory') {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Memory cache hit from MyMemory (low confidence), will try to improve: ${cached.translation}`);
      lowConfidenceCached = lowConfidenceCached || { translation: cached.translation, source: cached.source, fromCache: true };
    } else {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Cache hit: ${cached.translation}`);
      const edited = postEditZh(word, cached.translation);
      return translationResult(edited, cached.source, { fromCache: true });
    }
  }

  if (lemmaCandidate) {
    const cachedLemma = getFromCache(lemmaCandidate);
    if (cachedLemma) {
      if (isPlaceholderTranslation(cachedLemma.translation)) {
        // ignore
      } else if (cachedLemma.translation.toLowerCase() !== lemmaCandidate.toLowerCase()) {
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} Memory cache lemma hit (${lemmaCandidate}): ${cachedLemma.translation}`);
        if (cachedLemma.source === 'mymemory') {
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} Lemma cache is from MyMemory (low confidence), will try to improve`);
          lowConfidenceCached = lowConfidenceCached || { translation: cachedLemma.translation, source: cachedLemma.source, fromCache: true };
        } else {
          const source = cachedLemma.source || 'cache-lemma';
          await cacheTranslation(cachedLemma.translation, source);
          const edited = postEditZh(word, cachedLemma.translation);
          return translationResult(edited, source, { fromCache: true });
        }
      }
    }
  }

  // Step 2: Check built-in dictionaries
  let translation = null;

  // Try builtInDict for multiple candidates (apostrophes + plural/base forms)
  for (const candidate of lookupCandidates) {
    translation = builtInDict[candidate];
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} Dictionary lookup: ${candidate} -> ${translation}`);
    if (translation) break;
  }

  // Try properNameDict
  if (!translation) {
    translation = properNameDict[normalizedWord];
    if (translation) {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Proper name lookup hit: ${translation}`);
    }
  }

  // Try technicalTermsDict
  if (!translation) {
    translation = technicalTermsDict[normalizedWord];
    if (translation) {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Technical term lookup hit: ${translation}`);
    }
  }

  // If found in dictionary, cache and return
  if (translation) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} Found in dictionary: ${translation}`);
    const edited = postEditZh(word, translation);
    await cacheTranslation(edited, 'dictionary');
    return translationResult(edited, 'dictionary');
  }

  // Step 3: Try FREE translation APIs (DeepL has priority, then Google, then LibreTranslate and MyMemory)
  // OpenAI is only used when user manually requests correction
  const translationAttempts = [];
  const sentenceMode = options?.mode === 'sentence' || /\s/.test(String(word || '').trim()) || normalizedWord.length > 48;
  const sentenceText = String(word || '').replace(/\s+/g, ' ').trim();

  // Exam/caption sentence UI: prefer MyMemory first (works when Google times out),
  // then one short Google attempt. Skip DeepL/Libre to stay inside the route budget.
  if (sentenceMode) {
    if (!rateLimiter.isDisabled('mymemory')) {
      try {
        const myMemoryResult = await translateViaMyMemory(sentenceText);
        const cleanedMyMemory = cleanTranslation(myMemoryResult);
        if (cleanedMyMemory && isValidTranslation(cleanedMyMemory, sentenceText)) {
          const edited = postEditZh(word, cleanedMyMemory);
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} Sentence MyMemory Success: "${edited}"`);
          rateLimiter.recordSuccess('mymemory');
          await cacheTranslation(edited, 'mymemory');
          return translationResult(edited, 'mymemory', { score: scoreTranslation(edited, sentenceText) });
        }
      } catch (apiErr) {
        console.error(`[${logTs()}] [Translation Service] user=${userLabel} Sentence MyMemory failed: ${apiErr.message}`);
        rateLimiter.recordFailure('mymemory', apiErr);
      }
    }
    if (!rateLimiter.isDisabled('google')) {
      try {
        const googleResult = await translateViaGoogle(sentenceText, 'zh-CN', false);
        const cleanedGoogle = cleanTranslation(googleResult);
        if (cleanedGoogle && isValidTranslation(cleanedGoogle, sentenceText)) {
          const edited = postEditZh(word, cleanedGoogle);
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} Sentence Google Success: "${edited}"`);
          rateLimiter.recordSuccess('google');
          await cacheTranslation(edited, 'google');
          return translationResult(edited, 'google', { score: scoreTranslation(edited, sentenceText) });
        }
      } catch (apiErr) {
        console.error(`[${logTs()}] [Translation Service] user=${userLabel} Sentence Google failed: ${apiErr.message}`);
        rateLimiter.recordFailure('google', apiErr);
      }
    }
  }

  // Try DeepL FIRST (FREE tier: 500k chars/month, high quality, lenient rate limits)
  // DeepL results remain usable for compatibility, but are explicitly marked for review.
  // Check if DeepL is temporarily disabled due to rate limiting
  if (!sentenceMode && !rateLimiter.isDisabled('deepl')) {
    try {
      const deeplResult = await runWithRetries(
        () => translateWithDeepL(normalizedWord, 'ZH'),
        2,
        1200,
        'deepl'
      );
      const cleanedDeepL = cleanTranslation(deeplResult);

      if (cleanedDeepL && cleanedDeepL.trim()) {
        const edited = postEditZh(word, cleanedDeepL);
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} DeepL Success: "${edited}" (review required)`);

        // Record success
        rateLimiter.recordSuccess('deepl');

        await cacheTranslation(edited, 'deepl');
        return translationResult(edited, 'deepl');
      } else if (deeplResult) {
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} DeepL returned empty result after cleaning: original="${deeplResult}"`);
      }
    } catch (apiErr) {
      console.error(`[${logTs()}] [Translation Service] user=${userLabel} DeepL failed: ${apiErr.message}`);
      // Record failure (especially rate limit errors)
      rateLimiter.recordFailure('deepl', apiErr);
    }
  } else if (!sentenceMode) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} DeepL is temporarily disabled due to rate limiting, skipping`);
  }

  // Try Google Translate SECOND (FREE, high quality) - respect rate limits via runWithRetries
  // Check if Google Translate is temporarily disabled due to rate limiting
  if (!sentenceMode && !rateLimiter.isDisabled('google')) {
    try {
      const googleResult = await runWithRetries(
        () => translateWithGoogle(normalizedWord),
        2,
        1200,
        'google'
      );
      const cleanedGoogle = cleanTranslation(googleResult);
      if (cleanedGoogle && isValidTranslation(cleanedGoogle, normalizedWord)) {
        // Special handling for proper nouns: if Google returns the same word (case-insensitive),
        // try to add context using detectProperNoun() if it's not already annotated
        let finalTranslation = cleanedGoogle;
        if (cleanedGoogle.toLowerCase() === normalizedWord.toLowerCase() && !cleanedGoogle.includes('（')) {
          const properNounTranslation = detectProperNoun(word);
          if (properNounTranslation && properNounTranslation !== word) {
            finalTranslation = properNounTranslation;
            console.log(`[${logTs()}] [Translation Service] user=${userLabel} Enhanced proper noun translation: "${cleanedGoogle}" → "${finalTranslation}"`);
          }
        }

        finalTranslation = postEditZh(word, finalTranslation);
        const score = scoreTranslation(finalTranslation, normalizedWord);
        translationAttempts.push({ translation: finalTranslation, source: 'google', score });
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} Google Translate response (cleaned, score: ${score}): ${finalTranslation}`);

        // Record success
        rateLimiter.recordSuccess('google');

        // If Google Translate succeeded with good quality (score >= 100), use it directly
        // No need to call other APIs (saves time and avoids rate limiting)
        if (score >= 100) {
          console.log(`[${logTs()}] [Translation Service] user=${userLabel} Google Translate quality is good (score: ${score}), using it directly`);
          await cacheTranslation(finalTranslation, 'google');
          return translationResult(finalTranslation, 'google', { score });
        }
      } else if (googleResult) {
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} Google Translate returned invalid translation: ${googleResult}`);
      }
    } catch (apiErr) {
      console.error(`[${logTs()}] [Translation Service] user=${userLabel} Google Translate failed: ${apiErr.message}`);
      // Record failure (especially rate limit errors)
      rateLimiter.recordFailure('google', apiErr);
    }
  } else if (!sentenceMode) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} Google Translate is temporarily disabled due to rate limiting, skipping`);
  }

  // Try LibreTranslate as backup (FREE) - respect rate limits via runWithRetries (2 attempts, backoff)
  if (!sentenceMode && !rateLimiter.isDisabled('libretranslate')) {
    try {
      const libreResult = await runWithRetries(
        () => translateWithLibreTranslate(normalizedWord),
        2,
        1200,
        'libretranslate'
      );
      const cleanedLibre = cleanTranslation(libreResult);
      if (cleanedLibre && isValidTranslation(cleanedLibre, normalizedWord)) {
        const edited = postEditZh(word, cleanedLibre);
        const score = scoreTranslation(edited, normalizedWord);
        translationAttempts.push({ translation: edited, source: 'libretranslate', score });
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} LibreTranslate response (cleaned, score: ${score}): ${edited}`);
        rateLimiter.recordSuccess('libretranslate');
      } else if (libreResult) {
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} LibreTranslate returned invalid translation: ${libreResult}`);
      }
    } catch (apiErr) {
      console.error(`[${logTs()}] [Translation Service] user=${userLabel} LibreTranslate failed: ${apiErr.message}`);
      rateLimiter.recordFailure('libretranslate', apiErr);
    }
  }

  // Try MyMemory as backup (FREE) - but with shorter timeout and no retries due to frequent timeouts
  if (!sentenceMode && !rateLimiter.isDisabled('mymemory')) {
    try {
      const myMemoryResult = await runWithRetries(
        () => translateWithMyMemory(normalizedWord),
        1,  // No retries (was 2)
        500, // Shorter delay (was 1200ms)
        'mymemory'
      );
      const cleanedMyMemory = cleanTranslation(myMemoryResult);
      if (cleanedMyMemory && isValidTranslation(cleanedMyMemory, normalizedWord)) {
        const edited = postEditZh(word, cleanedMyMemory);
        const score = scoreTranslation(edited, normalizedWord);
        translationAttempts.push({ translation: edited, source: 'mymemory', score });
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} MyMemory response (cleaned, score: ${score}): ${edited}`);
        rateLimiter.recordSuccess('mymemory');
      } else if (myMemoryResult) {
        console.log(`[${logTs()}] [Translation Service] user=${userLabel} MyMemory returned invalid translation: ${myMemoryResult}`);
      }
    } catch (apiErr) {
      console.error(`[${logTs()}] [Translation Service] user=${userLabel} MyMemory failed: ${apiErr.message}`);
      rateLimiter.recordFailure('mymemory', apiErr);
    }
  } else if (!sentenceMode) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} MyMemory is temporarily disabled, skipping`);
  }

  // NOTE: OpenAI is NOT used here automatically
  // It's only called when user clicks "Fix Translation" button (see correctTranslation function below)

  // Step 4: Select best translation based on score
  if (translationAttempts.length > 0) {
    translationAttempts.sort((a, b) => b.score - a.score);
    const best = translationAttempts[0];

    // Set quality threshold: translations below 50 score are rejected
    // Lower threshold for common words (40 score), as some translation is better than none
    // Even lower threshold for long definitions (30 score), as they naturally score lower
    const isCommonWord = normalizedWord.length <= 6 && /^[a-z]+$/.test(normalizedWord);
    const isLongDefinition = normalizedWord.length > 50; // Definitions are usually long sentences
    const QUALITY_THRESHOLD = isLongDefinition ? 30 : (isCommonWord ? 40 : 50);

    if (best.score < QUALITY_THRESHOLD) {
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Best translation score (${best.score}) below threshold (${QUALITY_THRESHOLD}), rejecting: "${best.translation}"`);
      // Continue to intelligent fallback
    } else {
      translation = postEditZh(word, best.translation);
      console.log(`[${logTs()}] [Translation Service] user=${userLabel} Selected best translation from ${best.source} (score: ${best.score}): ${translation}`);

      await cacheTranslation(translation, best.source);
      // MyMemory is usually a low-confidence fallback (needs review)
      // BUT if the score is high (>= 80), we can trust it enough to skip mandatory review
      const needsReview = best.source === 'mymemory' && best.score < 80;
      return translationResult(translation, best.source, { score: best.score, needsReview });
    }
  }

  console.log(`[${logTs()}] [Translation Service] user=${userLabel} No reliable translation found, using intelligent fallback`);

  // Step 5: Intelligent fallback strategy
  // 1. Try to detect proper nouns (names, places, brands)
  const properNounTranslation = detectProperNoun(word);
  if (properNounTranslation) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} Detected as proper noun: ${properNounTranslation}`);
    translation = postEditZh(word, properNounTranslation);

    // Cache proper noun translation (this is a stable result)
    await cacheTranslation(translation, 'proper-noun-detection', { database: false });

    return translationResult(translation, 'proper-noun-detection', { isProperNoun: true });
  }

  // 2. If we previously had a low-confidence cached result (e.g. from MyMemory),
  // return it as a last resort, but flag it for review.
  if (lowConfidenceCached?.translation) {
    console.log(`[${logTs()}] [Translation Service] user=${userLabel} Returning low-confidence cached translation (${lowConfidenceCached.source}): ${lowConfidenceCached.translation}`);
    return translationResult(postEditZh(word, lowConfidenceCached.translation), lowConfidenceCached.source, { fromCache: true, needsReview: true });
  }

  // 2. For regular words, return the original word (user can understand from context)
  // This is more useful than '[待翻译]' as users can at least see the original word
  translation = word;
  console.log(`[${logTs()}] [Translation Service] user=${userLabel} Returning original word as fallback (translation failed)`);

  // Don't cache failed translations (neither in memory nor DB)
  // This allows us to retry translation on the next request
  await evictTranslation({ database: true });

  return translationResult(translation, 'legacy', { needsReview: true });
}

/**
 * Correct translation using OpenAI (PAID API)
 * This is ONLY called when user manually clicks "Fix Translation" button
 *
 * @param {string} word - Word to correct translation for
 * @param {string} currentTranslation - Current (incorrect) translation
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Corrected translation result
 */
async function correctTranslation(word, currentTranslation, options = {}) {
  if (!word) {
    throw new Error('INVALID_WORD');
  }

  const normalizedWord = word.toLowerCase().trim().replace(/[']/g, "'");
  const userLabel = options?.userLabel || 'unknown';
  const logTs = () => new Date().toISOString();

  console.log(`[${logTs()}] [Translation Correction] user=${userLabel} Correcting: ${word} (current: "${currentTranslation}")`);

  try {
    // Call OpenAI for high-quality correction
    const openaiResult = await translateWithOpenAI(normalizedWord);
    const cleanedOpenAI = cleanTranslation(openaiResult);

    if (!cleanedOpenAI || !isValidTranslation(cleanedOpenAI, normalizedWord)) {
      throw new Error('OpenAI returned invalid translation');
    }

    console.log(`[${logTs()}] [Translation Correction] user=${userLabel} OpenAI correction: "${currentTranslation}" → "${cleanedOpenAI}"`);

    // Update cache with high-quality translation
    setInCache(normalizedWord, cleanedOpenAI, 'openai-correction');
    try {
      if (dataStore?.isDatabaseAvailable?.()) {
        await dataStore.upsertTranslationCache(normalizedWord, cleanedOpenAI, 'openai-correction');
      }
    } catch (_) { }

    // Update all user vocabulary entries with this corrected translation
    try {
      if (dataStore?.isDatabaseAvailable?.()) {
        await dataStore.query(
          'UPDATE user_vocabulary SET translation = $1 WHERE lemma = $2',
          [cleanedOpenAI, normalizedWord]
        );
      }
    } catch (_) { }

    return {
      success: true,
      translation: cleanedOpenAI,
      oldTranslation: currentTranslation,
      source: 'openai-correction',
      score: DEFAULT_SOURCE_SCORES['openai-correction'],
      needsReview: false,
    };
  } catch (error) {
    console.error(`[${logTs()}] [Translation Correction] user=${userLabel} Failed: ${error.message}`);
    throw new Error(`Translation correction failed: ${error.message}`);
  }
}

module.exports = {
  translateWord,
  correctTranslation,
  postEditZh,
};
