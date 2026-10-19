const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const dictionaryService = require('../services/dictionary');
const translationService = require('../services/translation');
const { analyzeWordQuality } = require('../utils/word-quality');
const { resolveEntry } = require('../services/dictionary/quality');
const { createCurationService } = require('../services/dictionary/curation');

const curation = createCurationService();

// Track when async translation was last attempted for each word to prevent infinite retries
const asyncTranslationAttempts = new Map(); // word -> timestamp
const ASYNC_TRANSLATION_COOLDOWN_MS = 60000; // 60 seconds

/**
 * Lightweight routes for dictionary and translation lookups
 *
 * - GET /dictionary/:word -> returns { entry }
 * - GET /translate/:word  -> returns { translation }
 */
function displayPhonetic(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return text ? `/${text}/` : '';
}

function firstChineseGloss(definitions) {
  const meanings = definitions?.meanings || (Array.isArray(definitions) ? definitions : []);
  for (const meaning of meanings) {
    const items = meaning?.definitions || [];
    for (const item of items) {
      const zh = String(item?.zh || '').trim();
      if (/[\u4e00-\u9fa5]/.test(zh)) return zh;
    }
  }
  return '';
}

function extractGloss(record) {
  return {
    word: String(record?.word_lowercase || record?.word || '').toLowerCase(),
    phonetic: displayPhonetic(record?.phonetic),
    pos: String(record?.part_of_speech || '').trim(),
    zh: firstChineseGloss(record?.definitions),
  };
}

function glossWords(raw) {
  return [...new Set(String(raw || '').split(',').map((word) => word.trim().toLowerCase()).filter((word) => /^[a-z][a-z'-]{0,30}$/.test(word)))].slice(0, 24);
}

function mergeGlossItems(words, dbItems, lexicon) {
  const found = new Map((dbItems || []).map((item) => [item.word, item]));
  const book = lexicon && typeof lexicon === 'object' ? lexicon : {};
  return words.map((word) => {
    const db = found.get(word);
    const local = book[word] || {};
    const phonetic = db?.phonetic || local.ipa || '';
    const pos = db?.pos || local.pos || '';
    const zh = db?.zh || local.zh || '';
    if (!phonetic && !pos && !zh) return null;
    return { word, phonetic, pos, zh };
  }).filter(Boolean);
}

async function registerDictionaryRoutes(pathname, req, res, url) {
  // GET /dictionary/gloss?words=hi,time
  if (pathname === '/dictionary/gloss' && req.method === 'GET') {
    const words = glossWords(url.searchParams.get('words'));
    if (!words.length) return sendJson(res, 200, { items: [] });
    try {
      const dataStore = require('../data-store');
      const { rows } = await dataStore.pool.query(
        `SELECT word_lowercase, phonetic, part_of_speech, definitions
         FROM words WHERE word_lowercase = ANY($1::text[])`,
        [words]
      );
      return sendJson(res, 200, { items: mergeGlossItems(words, rows.map(extractGloss), readGlossLexicon()) });
    } catch (err) {
      console.warn('[Dictionary gloss]', err?.message || err);
      return sendJson(res, 200, { items: mergeGlossItems(words, [], readGlossLexicon()) });
    }
  }

  // GET /dictionary/:word
  if (pathname.startsWith('/dictionary/') && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const word = decodeURIComponent(pathname.split('/').pop() || '').trim();
      if (!word) return sendError(res, 400, 'Word is required');
      // Allow common words when user explicitly looks them up
      // Prefer our fallback entries for function words (avoids noisy/incorrect IPA/meanings)
      let entry = null;
      try {
        ({ entry } = await dictionaryService.lookup(word, { allowCommon: false }));
      } catch (lookupErr) {
        // If external dictionary doesn't have this word (typo/rare word),
        // fall back to DB and return a minimal entry instead of 404.
        const status = lookupErr?.statusCode || mapErrorToStatus(lookupErr);
        if (status !== 404) throw lookupErr;
        entry = null;
      }

      // Filter out inappropriate definitions for educational use
      if (entry && entry.meanings) {
        const sensitiveKeywords = [
          'make love', 'sexual', 'amorous activity', 'intercourse',
          'erotic', 'intimate relations', 'copulate', 'fornicate',
          '做爱', '性行为', '情爱活动', '性交', '交配'
        ];

        entry.meanings = entry.meanings.map(meaning => {
          if (!meaning.definitions) return meaning;

          meaning.definitions = meaning.definitions.filter(def => {
            const defText = (def.definition || '').toLowerCase();
            const zhText = (def.zh || '').toLowerCase();

            // Check if definition contains sensitive keywords
            return !sensitiveKeywords.some(keyword =>
              defText.includes(keyword.toLowerCase()) || zhText.includes(keyword)
            );
          });

          return meaning;
        }).filter(meaning => meaning.definitions && meaning.definitions.length > 0);
      }

      // Enhance entry with Chinese translations from database or translate on-demand
      const dataStore = require('../data-store');
      const userLabel = user?.username || user?.email || `user-${user?.id || 'unknown'}`;

      // Define wordTranslation outside try block to ensure it's accessible in return
      let wordTranslation = '';
      let wordTranslationQuality = {
        source: null,
        status: 'review',
        score: 0,
        reasons: ['missing_zh'],
        meta: {},
      };
      let quality = null;
      const preResolutionSourceKind = entry?.origin || null;
      const controlledRead = preResolutionSourceKind === 'linglish-fallback' || preResolutionSourceKind === 'linglish-curated';

      try {
        const { rows } = await dataStore.pool.query(
          `SELECT id, word, word_lowercase, phonetic, definitions, part_of_speech,
                  example_sentences, synonyms, content_revision, phonetic_source,
                  definitions_source, zh_source, part_of_speech_source, quality_status,
                  quality_score, quality_reasons, quality_meta, quality_checked_revision,
                  quality_checked_at, seo_indexable
           FROM words WHERE word_lowercase = $1 LIMIT 1`,
          [word.toLowerCase()]
        );

        let needsSave = false;
        let dbDefs = rows.length > 0 ? rows[0].definitions : null;
        let wordId = rows.length > 0 ? rows[0].id : null;
        const dbRecord = rows.length > 0 ? rows[0] : null;
        const hadLookupEntry = Boolean(entry);

        // External dictionary may return 404 for user-added tokens (OCR/typos/rare words).
        // If the word exists in our DB (words table), return a minimal entry from DB so clients don't see 404.
        if (!entry && rows.length > 0) {
          entry = {
            word,
            meanings: [],
            origin: 'db-only',
          };
        }

        if (entry || dbRecord) {
          const internalEntry = entry?.origin === 'linglish-curated' || entry?.origin === 'linglish-fallback';
          const resolved = resolveEntry({
            word,
            dbRecord,
            curatedEntry: internalEntry ? entry : null,
            externalEntry: internalEntry ? null : entry,
          });
          entry = resolved.entry;
          quality = resolved.quality;
        }

        // Get word-level translation from translation_cache
        try {
          const translationCache = await dataStore.getTranslationCache(word.toLowerCase());
          if (translationCache && translationCache.translation) {
            wordTranslation = translationCache.translation;
            const source = ['manual_verified', 'batch_verified', 'curated', 'external'].includes(translationCache.source)
              ? translationCache.source
              : 'legacy';
            const verified = source !== 'legacy';
            wordTranslationQuality = {
              source,
              status: verified ? 'verified' : 'review',
              score: verified ? 100 : 55,
              reasons: verified ? [] : ['unverified_legacy'],
              meta: {
                ...(translationCache.source ? { provider: String(translationCache.source).slice(0, 64) } : {}),
                ...(translationCache.updated_at ? { updated_at: translationCache.updated_at } : {}),
              },
            };
            console.log(`[Dictionary API] "${word}" Found word translation in cache: "${wordTranslation}"`);
          } else {
            console.log(`[Dictionary API] "${word}" No word translation in cache`);
          }
        } catch (err) {
          console.warn(`[Dictionary API] Failed to get word translation:`, err.message);
        }
        if (quality) quality.response = { zh: wordTranslationQuality };

        if (dbDefs) {
          console.log(`[Dictionary API] "${word}" DB query result: meanings=${dbDefs.meanings?.length || 0}, first def zh=${dbDefs.meanings?.[0]?.definitions?.[0]?.zh?.substring(0, 30) || 'N/A'}`);
        } else {
          console.log(`[Dictionary API] "${word}" No DB record found`);
        }

        // Helper function to validate Chinese translation
        const isValidChineseTranslation = (zhText, enText) => {
          if (!zhText || zhText === '[待翻译]') return false;
          // Must contain Chinese characters
          const hasChinese = /[\u4e00-\u9fa5]/.test(zhText);
          if (!hasChinese) return false;
          // Should not be identical to English text (case-insensitive)
          if (enText && zhText.toLowerCase().trim() === enText.toLowerCase().trim()) return false;
          return true;
        };

        const isMeaningCompatible = (meaning, dbMeaning) => {
          if (!meaning || !dbMeaning) return false;
          const posA = String(meaning.partOfSpeech || '').trim().toLowerCase();
          const posB = String(dbMeaning.partOfSpeech || '').trim().toLowerCase();
          if (posA && posB && posA !== posB) return false;
          const defA = String(meaning.definitions?.[0]?.definition || '').trim().toLowerCase();
          const defB = String(dbMeaning.definitions?.[0]?.definition || '').trim().toLowerCase();
          // Must match first definition text (not just POS) to avoid wrong translation mapping
          if (defA && defB && defA !== defB) return false;
          return true;
        };

        // Find the best matching DB meaning for an API meaning (not just by index)
        const findMatchingDbMeaning = (meaning, dbMeanings) => {
          if (!meaning || !dbMeanings || !Array.isArray(dbMeanings)) return null;
          const defText = String(meaning.definitions?.[0]?.definition || '').trim().toLowerCase();
          const pos = String(meaning.partOfSpeech || '').trim().toLowerCase();

          // Try to find exact match by first definition text
          for (const dbMeaning of dbMeanings) {
            const dbDefText = String(dbMeaning.definitions?.[0]?.definition || '').trim().toLowerCase();
            const dbPos = String(dbMeaning.partOfSpeech || '').trim().toLowerCase();
            if (defText && dbDefText && defText === dbDefText && pos === dbPos) {
              return dbMeaning;
            }
          }
          return null;
        };

        // Find the best matching DB definition for an API definition (by content)
        const findMatchingDbDefinition = (def, dbDefinitions) => {
          if (!def || !dbDefinitions || !Array.isArray(dbDefinitions)) return null;
          const defText = String(def.definition || '').trim().toLowerCase();

          for (const dbDef of dbDefinitions) {
            const dbDefText = String(dbDef.definition || '').trim().toLowerCase();
            if (defText && dbDefText && defText === dbDefText) {
              return dbDef;
            }
          }
          return null;
        };

        // Check if we need to translate definitions and examples.
        // Only attempt translation when we actually have meanings/definitions to translate.
        const hasMeaningsToTranslate = !!(entry && Array.isArray(entry.meanings) && entry.meanings.length > 0);
        let needsTranslation = hasMeaningsToTranslate && (
          !dbDefs?.meanings ||
          (entry && entry.meanings && entry.meanings.some((meaning, mIdx) => {
            const dbMeaning = dbDefs.meanings?.[mIdx];
            if (!dbMeaning) return true;
            if (!isMeaningCompatible(meaning, dbMeaning)) return true;
            return meaning.definitions.some((def, dIdx) => {
              const dbDef = dbMeaning.definitions?.[dIdx];
              // Need translation if: no DB def, no zh field, or invalid Chinese translation
              return !dbDef || !isValidChineseTranslation(dbDef.zh, def.definition);
            });
          }))
        );
        if (!hadLookupEntry && dbDefs) {
          needsTranslation = false;
        }

        // For our built-in fallback entries (function words, contractions, etc.),
        // avoid async translation & "translate" buttons: use word-level translation if available.
        if (controlledRead) {
          needsTranslation = false;
        }

        console.log(`[Dictionary API] "${word}" needsTranslation=${needsTranslation}, dbDefs=${!!dbDefs}, dbDefs.meanings=${!!dbDefs?.meanings}`);

        // Check if async translation was recently attempted (cooldown to prevent infinite retries)
        const lastAttempt = asyncTranslationAttempts.get(word.toLowerCase());
        const now = Date.now();
        const canAttemptTranslation = !lastAttempt || (now - lastAttempt) > ASYNC_TRANSLATION_COOLDOWN_MS;

        if (needsTranslation && entry && entry.meanings && canAttemptTranslation) {
          console.log(`[Dictionary API] Starting async translation for "${word}"`);

          // Record this attempt timestamp
          asyncTranslationAttempts.set(word.toLowerCase(), now);

          // Clean up old entries (keep map size reasonable)
          if (asyncTranslationAttempts.size > 1000) {
            const cutoff = now - ASYNC_TRANSLATION_COOLDOWN_MS;
            for (const [key, timestamp] of asyncTranslationAttempts.entries()) {
              if (timestamp < cutoff) asyncTranslationAttempts.delete(key);
            }
          }

          // Translate definitions asynchronously (do NOT wait) to ensure fast response
          // Browser will display English first, while backend populates DB for next time
          (async () => {
            let capturedWordId = wordId;
            let capturedExpectedRevision = dbRecord?.content_revision == null
              ? null
              : Number(dbRecord.content_revision);
            const capturedWord = word;
            const capturedZh = dbDefs?.zh || '';
            const capturedMeanings = entry.meanings;
            const capturedUserLabel = userLabel;

            try {
              const q = analyzeWordQuality(capturedWord);
              if (!q.ok) {
                console.log(`[Dictionary API - Async] Skip caching low-quality word "${capturedWord}" (${q.reasons.join(',')})`);
                return;
              }
              const translationService = require('../services/translation');
              let currentDefs = dbDefs ? structuredClone(dbDefs) : null;

              if (!currentDefs || !currentDefs.meanings) {
                currentDefs = { meanings: [], zh: capturedZh, en: '' };
              }

              // Translate and save incrementally (one definition at a time)
              for (let mIdx = 0; mIdx < capturedMeanings.length; mIdx++) {
                const meaning = capturedMeanings[mIdx];

                // Ensure meaning exists in currentDefs
                if (!currentDefs.meanings[mIdx]) {
                  currentDefs.meanings[mIdx] = {
                    partOfSpeech: meaning.partOfSpeech,
                    definitions: []
                  };
                }

                for (let dIdx = 0; dIdx < (meaning.definitions || []).length; dIdx++) {
                  const def = meaning.definitions[dIdx];

                  // Ensure definitions array exists
                  if (!currentDefs.meanings[mIdx].definitions) {
                    currentDefs.meanings[mIdx].definitions = [];
                  }

                  // Helper to validate Chinese translation
                  const isValidZh = (zhText) => zhText && /[\u4e00-\u9fa5]/.test(zhText) && !zhText.startsWith('[待翻译]');

                  // Check if this definition already has valid Chinese translation
                  const existingDef = currentDefs.meanings[mIdx].definitions[dIdx];
                  if (existingDef && isValidZh(existingDef.zh)) {
                    continue; // Skip to next definition
                  }

                  try {
                    // Translate definition
                    const defResult = await translationService.translateWord(def.definition, { userLabel: capturedUserLabel });
                    const hasChinese = defResult.translation && /[\u4e00-\u9fa5]/.test(defResult.translation);
                    const defZh = (hasChinese && !defResult.translation.startsWith('[待翻译]')) ? defResult.translation : '';

                    // Skip saving if translation failed (no Chinese characters)
                    if (!hasChinese) {
                      continue; // Skip to next definition
                    }

                    let exZh = '';
                    if (def.example) {
                      try {
                        const exResult = await translationService.translateWord(def.example, { userLabel: capturedUserLabel });
                        const hasChineseEx = exResult.translation && /[\u4e00-\u9fa5]/.test(exResult.translation);
                        exZh = (hasChineseEx && !exResult.translation.startsWith('[待翻译]')) ? exResult.translation : '';
                      } catch (exErr) {
                        console.warn(`[Dictionary API] Failed to translate example:`, exErr.message);
                      }
                    }

                    // Update this specific definition
                    currentDefs.meanings[mIdx].definitions[dIdx] = {
                      definition: def.definition,
                      zh: defZh,
                      example: def.example || '',
                      exampleZh: exZh,
                      examples: def.example ? [def.example] : [],
                      examplesZh: exZh ? [exZh] : []
                    };

                    // Persist through the quality boundary after each definition so legacy
                    // clients still see incremental progress without bypassing provenance.
                    try {
                      const curated = await curation.apply({
                        write: {
                          ...(capturedWordId ? { id: capturedWordId } : { word: capturedWord }),
                          candidate: {
                            ...(!capturedWordId ? {
                              word: capturedWord,
                              word_lowercase: capturedWord.toLowerCase(),
                            } : {}),
                            definitions: currentDefs,
                          },
                          source: defResult.source || 'machine_translation',
                          reviewed: false,
                          ...(capturedExpectedRevision == null
                            ? {}
                            : { expected_revision: capturedExpectedRevision }),
                          metadata: {
                            path: '/dictionary/:word',
                            mode: 'automatic_definition_translation',
                            meaning_index: mIdx,
                            definition_index: dIdx,
                            translation_score: Number.isFinite(defResult.score) ? defResult.score : null,
                          },
                        },
                        actor: { type: 'system', id: 'dictionary-auto-translate' },
                      });
                      if (curated.after?.id) capturedWordId = curated.after.id;
                      if (curated.after?.content_revision != null) {
                        capturedExpectedRevision = Number(curated.after.content_revision);
                      }
                      console.log(`[Dictionary API - Async] "${capturedWord}" [${mIdx},${dIdx}] Curated: ${defZh.substring(0, 30)}`);
                    } catch (saveErr) {
                      console.warn(`[Dictionary API] Failed to curate translation:`, saveErr.message);
                      if (String(saveErr.message || '').startsWith('REVISION_CONFLICT:')) return;
                    }
                  } catch (defErr) {
                    console.warn(`[Dictionary API] Failed to translate definition:`, defErr.message);
                  }
                }
              }
              console.log(`[Dictionary API - Async] Translation completed for "${capturedWord}"`);
            } catch (translateErr) {
              console.error(`[Dictionary API - Async] Translation failed for "${capturedWord}":`, translateErr.message);
            }
          })(); // Immediately invoked async function
        } else if (needsTranslation && !canAttemptTranslation) {
          const timeSinceLastAttempt = now - lastAttempt;
          console.log(`[Dictionary API] Skipping async translation for "${word}" - attempted ${Math.round(timeSinceLastAttempt / 1000)}s ago (cooldown: ${ASYNC_TRANSLATION_COOLDOWN_MS / 1000}s)`);
        }

        } catch (dbErr) {
          // Ignore database errors, return entry without Chinese translations
          console.warn('[Dictionary API] Failed to load/translate Chinese translations:', dbErr.message);
        }

        if (!entry) return sendError(res, 404, 'Word not found');
        return sendJson(res, 200, { entry, zh: wordTranslation, quality });
      } catch (err) {
        const status = err.statusCode || mapErrorToStatus(err);
        return sendError(res, status, err.message || 'Lookup failed');
      }
    }

  // GET /translate/:word (DEPRECATED - 已废弃，单词翻译现在从 /dictionary/:word 获取)
  // if (pathname.startsWith('/translate/') && req.method === 'GET') {
  //     try {
  //       const user = await authenticate(req);
  //       const word = decodeURIComponent(pathname.split('/').pop() || '').trim();
  //       if (!word) return sendError(res, 400, 'Word is required');
  //       const userLabel = user?.username || user?.email || `user-${user?.id || 'unknown'}`;
  //       const result = await translationService.translateWord(word, { userLabel });
  //       return sendJson(res, 200, result || { translation: word });
  //     } catch (err) {
  //       const status = err.statusCode || mapErrorToStatus(err);
  //       return sendError(res, status, err.message || 'Translate failed');
  //     }
  //   }

    // POST /dictionary/:word/translate-definition
    // Translate a specific definition for a word and save to database
    if (pathname.match(/^\/dictionary\/[^/]+\/translate-definition$/) && req.method === 'POST') {
      try {
        const user = await authenticate(req);
        const word = decodeURIComponent(pathname.split('/')[2] || '').trim();
        if (!word) return sendError(res, 400, 'Word is required');

        const dataStore = require('../data-store');
        const userLabel = user?.username || user?.email || `user-${user?.id || 'unknown'}`;

        // Parse request body
        let body = '';
        await new Promise((resolve, reject) => {
          req.on('data', chunk => { body += chunk; });
          req.on('end', resolve);
          req.on('error', reject);
        });

        const { meaningIndex, definitionIndex, text, type = 'definition' } = JSON.parse(body);

        if (meaningIndex === undefined || definitionIndex === undefined || !text) {
          return sendError(res, 400, 'meaningIndex, definitionIndex and text are required');
        }

        console.log(`[Dictionary API] Translating ${type} for "${word}" [${meaningIndex},${definitionIndex}]: ${text.substring(0, 50)}`);

        // For manual translation (user clicked button), use OpenAI for high quality
        // First try regular translation services
        let result = await translationService.translateWord(text, { userLabel });
        let hasChinese = result.translation && /[\u4e00-\u9fa5]/.test(result.translation);
        let translation = result.translation;
        let translationSource = result.source || 'machine_translation';

        // If free APIs failed, try OpenAI as fallback for better quality
        if (!hasChinese) {
          console.log(`[Dictionary API] Free APIs failed for "${text.substring(0, 50)}", trying OpenAI`);

          // Check if OpenAI is configured
          const openaiKey = process.env.OPENAI_API_KEY;
          if (!openaiKey || openaiKey === 'your-api-key-here') {
            console.log('[Dictionary API] OpenAI not configured, returning helpful message');
            return sendJson(res, 200, {
              success: false,
              error: 'translation_unavailable',
              message: '此定义暂时无法翻译（所有免费翻译服务都已达到速率限制）。请稍后重试，或配置OpenAI API密钥以获得更好的翻译质量。',
              originalText: text,
              translationAttempted: translation
            });
          }

          try {
            const openaiResult = await translationService.correctTranslation(text, translation, { userLabel });
            translation = openaiResult.translation;
            translationSource = openaiResult.source || 'openai_correction';
            hasChinese = translation && /[\u4e00-\u9fa5]/.test(translation);

            if (!hasChinese) {
              return sendJson(res, 200, {
                success: false,
                error: 'translation_failed',
                message: '翻译失败：所有服务都无法生成有效的中文翻译',
                originalText: text
              });
            }
            console.log(`[Dictionary API] OpenAI success: ${translation.substring(0, 50)}`);
          } catch (openaiErr) {
            console.error('[Dictionary API] OpenAI translation also failed:', openaiErr);

            // Return user-friendly error instead of 500
            return sendJson(res, 200, {
              success: false,
              error: 'openai_error',
              message: openaiErr.message.includes('TRANSLATE_AUTH_FAILED')
                ? 'OpenAI API配置错误，请检查API密钥'
                : '翻译服务暂时不可用，请稍后重试',
              originalText: text
            });
          }
        }

        // Load current word data from database
        const { rows } = await dataStore.pool.query(
          'SELECT id, definitions, content_revision FROM words WHERE word_lowercase = $1 LIMIT 1',
          [word.toLowerCase()]
        );

        if (rows.length === 0) {
          return sendError(res, 404, 'Word not found in database');
        }

        const wordId = rows[0].id;
        let defs = rows[0].definitions || {};

        // If meanings structure doesn't exist, create it from the request text
        if (!defs.meanings || !defs.meanings[meaningIndex] || !defs.meanings[meaningIndex].definitions || !defs.meanings[meaningIndex].definitions[definitionIndex]) {
          console.log(`[Dictionary API] Creating meanings structure for "${word}" at [${meaningIndex},${definitionIndex}]`);

          // Initialize meanings array if needed
          if (!defs.meanings) {
            defs.meanings = [];
          }

          // Ensure we have enough meaning entries
          while (defs.meanings.length <= meaningIndex) {
            defs.meanings.push({ partOfSpeech: '', definitions: [] });
          }

          // Ensure we have enough definition entries
          while (defs.meanings[meaningIndex].definitions.length <= definitionIndex) {
            defs.meanings[meaningIndex].definitions.push({ definition: '', zh: '' });
          }

          // Set the definition text from the request
          if (type === 'definition') {
            defs.meanings[meaningIndex].definitions[definitionIndex].definition = text;
          } else if (type === 'example') {
            defs.meanings[meaningIndex].definitions[definitionIndex].example = text;
          }
        }

        if (type === 'definition') {
          defs.meanings[meaningIndex].definitions[definitionIndex].zh = translation;
        } else if (type === 'example') {
          defs.meanings[meaningIndex].definitions[definitionIndex].exampleZh = translation;
          if (!defs.meanings[meaningIndex].definitions[definitionIndex].examplesZh) {
            defs.meanings[meaningIndex].definitions[definitionIndex].examplesZh = [];
          }
          defs.meanings[meaningIndex].definitions[definitionIndex].examplesZh[0] = translation;
        }

        const curated = await curation.apply({
          write: {
            id: wordId,
            candidate: { definitions: defs },
            source: translationSource,
            reviewed: false,
            expected_revision: Number(rows[0].content_revision),
            metadata: {
              path: '/dictionary/:word/translate-definition',
              mode: 'user_definition_translation',
              meaning_index: Number(meaningIndex),
              definition_index: Number(definitionIndex),
              definition_type: type,
              translation_score: Number.isFinite(result.score) ? result.score : null,
            },
          },
          actor: { type: 'user', id: user?.id },
        });

        console.log(`[Dictionary API] Curated translation for "${word}" [${meaningIndex},${definitionIndex}]: ${translation.substring(0, 30)}`);

        return sendJson(res, 200, {
          success: true,
          translation,
          meaningIndex,
          definitionIndex,
          type,
          saved: Number(curated.applied || 0) > 0,
          batch_id: curated.batch_id || null,
          source: curated.source || translationSource,
          reasons: curated.reasons || [],
          conflicts: curated.conflicts || [],
        });
      } catch (err) {
        console.error('[Dictionary API] Translate definition failed:', err);
        const status = err.statusCode || mapErrorToStatus(err);
        return sendError(res, status, err.message || 'Translate definition failed');
      }
    }

    // POST /dictionary/translate-text
    // Translate arbitrary text (e.g. transcript sentences) to Chinese for UI display.
    if (pathname === '/dictionary/translate-text' && req.method === 'POST') {
      try {
        const user = await authenticate(req);
        const userLabel = user?.username || user?.email || `user-${user?.id || 'unknown'}`;

        // Parse request body
        let body = '';
        await new Promise((resolve, reject) => {
          req.on('data', chunk => { body += chunk; });
          req.on('end', resolve);
          req.on('error', reject);
        });

        let text = '';
        try {
          const parsed = JSON.parse(body || '{}');
          text = String(parsed.text || '').trim();
        } catch (_) { }

        if (!text) return sendError(res, 400, 'text is required');

        // Use translation service; it supports phrases/sentences as well.
        const result = await translationService.translateWord(text, { userLabel });
        const translation = (result && result.translation) ? String(result.translation) : '';
        const hasChinese = translation && /[\u4e00-\u9fa5]/.test(translation);
        if (!hasChinese) {
          return sendJson(res, 200, {
            success: false,
            message: '翻译暂不可用',
            translationAttempted: translation
          });
        }
        return sendJson(res, 200, { success: true, translation });
      } catch (err) {
        const status = err.statusCode || mapErrorToStatus(err);
        return sendError(res, status, err.message || 'Translate failed');
      }
    }

    return false;
  }

  function readGlossLexicon() {
    if (readGlossLexicon.cache) return readGlossLexicon.cache;
    try {
      const file = require('path').join(__dirname, '../../frontend/data/gloss-lexicon.json');
      readGlossLexicon.cache = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    } catch (_) {
      readGlossLexicon.cache = {};
    }
    return readGlossLexicon.cache;
  }

  module.exports = { registerDictionaryRoutes, extractGloss, glossWords, mergeGlossItems };
