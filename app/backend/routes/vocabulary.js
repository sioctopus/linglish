/**
 * Vocabulary Routes Module
 * Handles all vocabulary management endpoints
 */

const dataStore = require('../data-store');
const translationService = require('../services/translation');
const authService = require('../services/auth');
const cacheService = require('../services/cache');
const srsBridge = require('../services/srs-bridge');
const { addToSchedule } = require('../services/spaced-repetition');

// SRS engine switch: SM-2 (services/srs-bridge.js) is the default; set
// SRS_ENGINE=legacy to roll back to the original heuristic implementation.
function isSm2Enabled() {
  return process.env.SRS_ENGINE !== 'legacy';
}

// Helper: Check if sentence contains complete word (word boundary)
function containsWord(sentence, word) {
  if (!sentence || !word) return false;
  const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return regex.test(sentence);
}

// Helper: Find lemma contexts across videos (fallback)
async function findLemmaContextsAcrossVideos(lemma, limit = 3) {
  try {
    const all = await dataStore.listVideoResources();
    const results = [];
    if (!Array.isArray(all) || !lemma) return results;
    const needle = String(lemma).toLowerCase();
    for (const res of all) {
      const resource = serializeVideoResource(res);
      const segments = Array.isArray(resource.transcript_segments) ? resource.transcript_segments : [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const text = seg?.text || '';
        // 使用词边界匹配，避免子串匹配（如 "neighbor" 匹配到 "neighborhood"）
        const match = containsWord(text, lemma);
        if (match) {
          results.push({
            video_resource_id: resource.id,
            segment_index: seg?.index != null ? seg.index : i,
            start_sec: Number(seg?.start) || null,
            end_sec: Number(seg?.end) || null,
            sentence: seg?.text || '',
          });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  } catch (err) {
    console.warn('findLemmaContextsAcrossVideos failed:', err?.message || err);
    return [];
  }
}

// Helper: Serialize video resource
function serializeVideoResource(resource) {
  if (!resource) return null;
  let segments = [];
  if (Array.isArray(resource.transcript_segments)) {
    segments = resource.transcript_segments;
  } else if (resource.transcript_segments) {
    if (typeof resource.transcript_segments === 'string') {
      try {
        segments = JSON.parse(resource.transcript_segments);
      } catch (err) {
        segments = [];
      }
    } else {
      segments = resource.transcript_segments;
    }
  }

  return {
    id: resource.id,
    uploader_id: resource.uploader_id,
    title: resource.title,
    description: resource.description,
    video_path: resource.video_path,
    thumbnail_path: (typeof resource.thumbnail_path === 'string' && resource.thumbnail_path.includes('${')) ? null : resource.thumbnail_path,
    original_filename: resource.original_filename,
    transcript: resource.transcript,
    transcript_segments: segments,
    language: resource.language,
    duration_sec: resource.duration_sec,
    status: resource.status,
    failure_reason: resource.failure_reason,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

// Helper: Normalize lemma
function normalizeLemma(word) {
  return (word || '').trim().toLowerCase();
}

// Helper: Map error to HTTP status
function mapErrorToStatus(err, defaultStatus = 500) {
  if (!err || !err.message) return defaultStatus;
  if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
    return 401;
  }
  if (err.message === 'FORBIDDEN' || err.message === 'BANNED' || err.status === 403) {
    return 403;
  }
  if (err.message === 'DATASTORE_UNAVAILABLE') {
    return 503;
  }
  return defaultStatus;
}

function buildUserCacheKey(userId, suffix) {
  return `vocab:user:${userId}:${suffix}`;
}

async function invalidateUserVocabCache(userId) {
  return cacheService.invalidate(`vocab:user:${userId}:*`);
}

// Helper: Add days to a date
function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

// Helper: Compute state transition
function computeStateTransition(item, desiredState) {
  const now = new Date();
  const updates = {
    last_seen_at: now,
  };

  switch (desiredState) {
    case 'new':
      updates.state = 'encountered';
      updates.next_review_at = null;
      updates.interval_days = item?.interval_days || 1;
      break;
    case 'learning':
      updates.state = 'learning';
      updates.interval_days = 1;
      updates.next_review_at = addDays(now, 1);
      if (item && item.review_count < 1) {
        updates.review_count = 0;
      }
      break;
    case 'known':
      const reviewCount = Math.max(item?.review_count || 0, 1);
      updates.state = reviewCount >= 5 ? 'mastered' : 'reviewing';
      const interval = Math.max(item?.interval_days || 1, 7);
      updates.interval_days = interval;
      updates.review_count = reviewCount;
      updates.next_review_at = addDays(now, interval);
      break;
    default:
      break;
  }

  return updates;
}

// Helper: Apply review outcome
function applyReviewOutcome(item, outcome) {
  const now = new Date();
  // Ensure numeric values with safe fallbacks
  let ease = parseFloat(item?.ease_factor) || 2.5;
  let interval = parseInt(item?.interval_days, 10) || 1;
  let reviewCount = parseInt(item?.review_count, 10) || 0;
  let state = item?.state || 'learning';
  let lapses = parseInt(item?.lapses, 10) || 0;
  let consecutiveFails = parseInt(item?.consecutive_fails, 10) || 0;

  // Validate numeric values
  if (isNaN(ease)) ease = 2.5;
  if (isNaN(interval)) interval = 1;
  if (isNaN(reviewCount)) reviewCount = 0;
  if (isNaN(lapses)) lapses = 0;
  if (isNaN(consecutiveFails)) consecutiveFails = 0;

  const normalizedOutcome = String(outcome || '').toLowerCase();

  // Special: force mastered (used by "完全掌握" button on desktop review UI)
  if (normalizedOutcome === 'mastered' || normalizedOutcome === 'master' || normalizedOutcome === 'easy') {
    ease = Math.max(1.3, ease + 0.2);
    reviewCount = Math.max(reviewCount + 1, 5);
    state = 'mastered';
    consecutiveFails = 0;
    interval = Math.max(4, interval);
  } else
  if (outcome === 'pass' || outcome === 'success' || outcome === true) {
    ease = Math.max(1.3, ease + 0.1);
    if (reviewCount === 0) {
      interval = 1;
    } else if (reviewCount === 1) {
      interval = 3;
    } else {
      interval = Math.round(interval * ease);
    }
    reviewCount += 1;
    state = reviewCount >= 5 ? 'mastered' : 'reviewing';
    consecutiveFails = 0; // reset on success
  } else {
    ease = Math.max(1.3, ease - 0.3);
    interval = 0; // bring forward immediately
    reviewCount = Math.max(0, reviewCount - 1);
    consecutiveFails = (consecutiveFails || 0) + 1;
    // 连错降级：连续2次失败且之前非learning，则降级并记一次lapse
    if (consecutiveFails >= 2 && (state === 'reviewing' || state === 'mastered')) {
      state = 'learning';
      lapses = (lapses || 0) + 1;
    }
  }

  const nextReviewAt = addDays(now, interval);

  // Ensure all numeric values are valid before returning
  return {
    updates: {
      state,
      ease_factor: isNaN(ease) ? 2.5 : ease,
      interval_days: isNaN(interval) ? 1 : interval,
      review_count: isNaN(reviewCount) ? 0 : reviewCount,
      lapses: isNaN(lapses) ? 0 : lapses,
      consecutive_fails: isNaN(consecutiveFails) ? 0 : consecutiveFails,
      next_review_at: nextReviewAt,
      last_review_at: now,
      last_seen_at: now,
    },
    log: {
      outcome: (normalizedOutcome === 'mastered' || normalizedOutcome === 'master' || normalizedOutcome === 'easy' || outcome === 'pass' || outcome === true) ? 'pass' : 'fail',
      easeFactor: isNaN(ease) ? 2.5 : ease,
      intervalDays: isNaN(interval) ? 1 : interval,
    },
  };
}

// Helper: Parse JSON body from request
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new Error('INVALID_JSON');
  }
}

// Helper: Send JSON response
function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[Vocabulary] Attempted to send response after stream closed');
    return false;
  }
  const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
  };
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

// Helper: Send error response
function sendError(res, status, message) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[Vocabulary] Attempted to send error after stream closed');
    return false;
  }
  return sendJson(res, status, { code: status, message });
}

// Helper: Authenticate user
async function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  const [, token] = authHeader.split(' ');
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  return authService.requireUser(token);
}

/**
 * Register vocabulary routes
 * @param {string} pathname - The request pathname
 * @param {http.IncomingMessage} req - The request object
 * @param {http.ServerResponse} res - The response object
 * @param {URL} url - The parsed URL object
 * @returns {boolean} - true if route was handled, false otherwise
 */
async function registerVocabularyRoutes(pathname, req, res, url) {
  // GET /vocab - List all vocabulary items
  if (pathname === '/vocab' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const state = url.searchParams.get('state') || null;
      const limit = url.searchParams.get('limit')
        ? Math.min(Number(url.searchParams.get('limit')), 10000)
        : 10000;
      const offset = url.searchParams.get('offset')
        ? Number(url.searchParams.get('offset'))
        : 0;

      const cacheKey = buildUserCacheKey(user.id, `list:${state || 'all'}:${limit}:${offset}:video`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const items = await dataStore.listAllVocabItems(user.id, { state, limit, offset });
      const payload = { items, count: items.length };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // GET /vocab/item - Get a single vocabulary item with contexts
  if (pathname === '/vocab/item' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const lemmaRaw = (url.searchParams.get('lemma') || '').trim();
      if (!lemmaRaw) {
        return sendError(res, 400, 'Lemma is required');
      }
      const lemma = normalizeLemma(lemmaRaw);
      const cacheKey = buildUserCacheKey(user.id, `item:${lemma}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      let item = await dataStore.getVocabItem(user.id, lemma);
      // 如果没有翻译，尝试自动补全翻译并保存
      try {
        const needTranslate = item && (!item.translation || String(item.translation).startsWith('[待翻译]'));
        if (needTranslate) {
          const userLabel = user.username || user.email || `user-${user.id}`;
          const tr = await translationService.translateWord(lemma, { userLabel });
          if (tr && tr.translation && !String(tr.translation).startsWith('[待翻译]')) {
            item = await dataStore.upsertVocabItem(user.id, lemma, { translation: tr.translation });
          }
        }
      } catch (_) {}
      let contexts = await dataStore.listRecentContexts(user.id, lemma, 5);
      if (!contexts || contexts.length === 0) {
        // Try to auto-populate from transcripts for better review UX
        const fallback = await findLemmaContextsAcrossVideos(lemma, 3);
        if (fallback.length) {
          // persist for future quick access
          try {
            for (const c of fallback) {
              await dataStore.saveVocabContext({
                userId: user.id,
                lemma,
                videoResourceId: c.video_resource_id,
                segmentIndex: c.segment_index,
                startSec: c.start_sec,
                endSec: c.end_sec,
                sentence: c.sentence,
              });
            }
          } catch (_) {}
          contexts = fallback;
        }
      }
      const payload = { item, contexts };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message);
    }
  }

  // POST /vocab/translate-missing - Translate missing vocabulary translations
  if (pathname === '/vocab/translate-missing' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const userLabel = user.username || user.email || `user-${user.id}`;
      let limit = 50;
      try {
        const body = await parseBody(req);
        if (body && Number.isFinite(Number(body.limit))) {
          limit = Math.max(1, Math.min(200, Number(body.limit)));
        }
      } catch (_) {}

      const all = await dataStore.listAllVocabItems(user.id, { state: null, limit: 10000, offset: 0 });
      const missing = [];
      for (const it of Array.isArray(all) ? all : []) {
        const tr = (it && it.translation) ? String(it.translation) : '';
        if (!tr || tr.startsWith('[待翻译]')) {
          missing.push(it.lemma);
          if (missing.length >= limit) break;
        }
      }

      let translated = 0;
      for (const lemma of missing) {
        try {
          const tr = await translationService.translateWord(lemma, { userLabel });
          if (tr && tr.translation && !String(tr.translation).startsWith('[待翻译]')) {
            await dataStore.upsertVocabItem(user.id, lemma, { translation: tr.translation });
            translated += 1;
          }
        } catch (e) {
          // continue on individual failures
        }
      }
      if (translated > 0) {
        await invalidateUserVocabCache(user.id);
      }
      return sendJson(res, 200, { requested: missing.length, translated });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || 'Failed to translate missing vocabulary');
    }
  }

  // POST /vocab/mark - Mark vocabulary item with state and context
  if (pathname === '/vocab/mark' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const lemmaRaw = (body.lemma || '').trim();
      if (!lemmaRaw) {
        return sendError(res, 400, 'Lemma is required');
      }
      const lemma = normalizeLemma(lemmaRaw);
      const desiredState = (body.state || 'learning').toLowerCase();
      const validStates = new Set(['new', 'learning', 'known']);
      if (!validStates.has(desiredState)) {
        return sendError(res, 400, 'Invalid vocabulary state');
      }
      const now = new Date();
      const segmentIndex = body.segmentIndex !== undefined && body.segmentIndex !== null
        ? Number(body.segmentIndex)
        : null;
      const startSec = body.startSec !== undefined && body.startSec !== null
        ? Number(body.startSec)
        : null;
      const endSec = body.endSec !== undefined && body.endSec !== null
        ? Number(body.endSec)
        : null;

      let item = await dataStore.getVocabItem(user.id, lemma);
      const exposures = (item?.exposures || 0) + 1;

      // 如果还没有翻译，自动获取翻译
      let translation = item?.translation || null;
      if (!translation) {
        try {
          const userLabel = user.username || user.email || `user-${user.id}`;
          const translationResult = await translationService.translateWord(lemma, { userLabel });
          // 不保存占位符翻译（以[待翻译]开头的）
          if (translationResult.translation && !translationResult.translation.startsWith('[待翻译]')) {
            translation = translationResult.translation;
            console.log(`[Vocab Mark] Auto-fetched translation for "${lemma}": ${translation}`);
          } else {
            console.warn(`[Vocab Mark] Translation not available for "${lemma}", skipping save`);
          }
        } catch (err) {
          console.warn(`[Vocab Mark] Failed to fetch translation for "${lemma}":`, err.message);
        }
      }

      item = await dataStore.upsertVocabItem(user.id, lemma, {
        exposures,
        translation,
        last_seen_at: now,
      });

      const stateUpdates = computeStateTransition(item, desiredState);
      if (Object.keys(stateUpdates).length) {
        item = await dataStore.upsertVocabItem(user.id, lemma, stateUpdates);
      }

      if (body.sentence && containsWord(body.sentence, lemma)) {
        await dataStore.saveVocabContext({
          userId: user.id,
          lemma,
          videoResourceId: body.videoResourceId ? Number(body.videoResourceId) : null,
          segmentIndex: Number.isFinite(segmentIndex) ? segmentIndex : null,
          startSec: Number.isFinite(startSec) ? startSec : null,
          endSec: Number.isFinite(endSec) ? endSec : null,
          sentence: body.sentence,
        });
      }

      const contexts = await dataStore.listRecentContexts(user.id, lemma, 5);
      await invalidateUserVocabCache(user.id);

      if (isSm2Enabled() && item && item.id && desiredState === 'learning') {
        addToSchedule(user.id, { itemType: 'vocabulary', itemId: item.id, lemma: item.word || lemma })
          .catch(err => console.error('addToSchedule failed:', err.message));
      }

      return sendJson(res, 200, { item, contexts });
    } catch (err) {
      const status = err.message === 'UNAUTHORIZED'
        ? 401
        : err.message === 'DATASTORE_UNAVAILABLE'
          ? 503
          : 500;
      if (status >= 500) {
        console.error('Vocab mark error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // PATCH /vocab/translation - Update vocabulary translation (manual calibration)
  if (pathname === '/vocab/translation' && req.method === 'PATCH') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const lemmaRaw = (body.lemma || '').trim();
      const translation = (body.translation || '').trim();

      if (!lemmaRaw) {
        return sendError(res, 400, 'Lemma is required');
      }
      if (!translation) {
        return sendError(res, 400, 'Translation is required');
      }

      const lemma = normalizeLemma(lemmaRaw);

      // 检查词汇项是否存在
      const item = await dataStore.getVocabItem(user.id, lemma);
      if (!item) {
        return sendError(res, 404, 'Vocabulary item not found');
      }

      // 更新翻译
      const updated = await dataStore.upsertVocabItem(user.id, lemma, {
        translation,
      });

      console.log(`[Vocab Translation] Updated translation for "${lemma}": ${translation}`);
      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, { item: updated });
    } catch (err) {
      const status = err.message === 'UNAUTHORIZED'
        ? 401
        : err.message === 'DATASTORE_UNAVAILABLE'
          ? 503
          : 500;
      if (status >= 500) {
        console.error('Vocab translation update error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // POST /vocab/correct-translation - Correct translation using OpenAI (PAID API)
  // This is ONLY called when user manually clicks "Fix Translation" button
  if (pathname === '/vocab/correct-translation' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const lemmaRaw = (body.lemma || '').trim();
      const currentTranslation = body.currentTranslation || '';

      if (!lemmaRaw) {
        return sendError(res, 400, 'Lemma is required');
      }

      const lemma = normalizeLemma(lemmaRaw);
      const userLabel = user.username || user.email || `user-${user.id}`;

      console.log(`[Vocab Correction] User ${userLabel} requested correction for: ${lemma}`);

      // Call the correction service (uses OpenAI)
      const result = await translationService.correctTranslation(
        lemma,
        currentTranslation,
        { userLabel }
      );

      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, {
        success: true,
        lemma,
        oldTranslation: result.oldTranslation,
        newTranslation: result.translation,
        source: result.source,
        message: 'Translation corrected successfully using AI'
      });
    } catch (err) {
      console.error('[Vocab Correction] Error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to correct translation');
    }
  }

  // POST /vocab/refresh-translations - Refresh all vocabulary translations
  if (pathname === '/vocab/refresh-translations' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const items = await dataStore.listAllVocabItems(user.id, { limit: 1000 });
      const userLabel = user.username || user.email || `user-${user.id}`;

      let refreshed = 0;
      for (const item of items) {
        try {
          const translationResult = await translationService.translateWord(item.lemma, { userLabel });
          // 只保存有效翻译，跳过占位符翻译
          if (translationResult.translation && !translationResult.translation.startsWith('[待翻译]')) {
            await dataStore.upsertVocabItem(user.id, item.lemma, {
              translation: translationResult.translation,
            });
            refreshed++;
          } else {
            console.warn(`[Vocab Refresh] Translation not available for "${item.lemma}", skipping`);
          }
        } catch (err) {
          console.warn(`[Vocab Refresh] Failed to refresh translation for "${item.lemma}":`, err.message);
        }
      }

      console.log(`[Vocab Refresh] Refreshed ${refreshed} translations for user ${user.id}`);
      if (refreshed > 0) {
        await invalidateUserVocabCache(user.id);
      }
      return sendJson(res, 200, { refreshed, total: items.length });
    } catch (err) {
      const status = mapErrorToStatus(err);
      if (status >= 500) {
        console.error('Vocab refresh translations error:', err);
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /vocab/review-queue - Get vocabulary review queue with heuristic sorting
  if (pathname === '/vocab/review-queue' && req.method === 'GET') {
    try {
      if (!dataStore.isDatabaseAvailable()) {
        return sendJson(res, 200, { items: [] });
      }
      const user = await authenticate(req);
      const limit = url.searchParams.get('limit')
        ? Math.min(Number(url.searchParams.get('limit')), 50)
        : 20;
      // Optional plain mode for QA
      const mode = url.searchParams.get('mode') || 'heuristic';
      const hardParam = url.searchParams.get('hard');
      // 缓存键必须区分 SRS 引擎:两种引擎的队列行结构不同,SRS_ENGINE 切换后不能命中旧引擎的缓存
      const cacheKey = buildUserCacheKey(user.id, `review-queue:${isSm2Enabled() ? 'sm2' : 'legacy'}:${mode}:${hardParam || '0'}:${limit}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      if (isSm2Enabled()) {
        // SM-2 引擎下 mode/hard 参数仅属 legacy 启发式排序,在此忽略
        const items = await srsBridge.getDueQueue(user.id, limit);
        const payload = { items };
        await cacheService.set(cacheKey, payload, 60);
        return sendJson(res, 200, payload);
      }
      if (mode === 'plain') {
        const plain = await dataStore.listDueVocabItems(user.id, limit || 20);
        const payload = { items: plain };
        await cacheService.set(cacheKey, payload, 60);
        return sendJson(res, 200, payload);
      }
      // Fetch a wider set first, then sort heuristically
      const rawItems = await dataStore.listDueVocabItems(user.id, Math.max(limit * 3, 30));
      const lemmas = rawItems.map(it => it.lemma).filter(Boolean);
      const recent48 = await dataStore.getRecentReviewStats(user.id, lemmas, 48);
      const recent168 = await dataStore.getRecentReviewStats(user.id, lemmas, 168);
      const hardWeight = (hardParam === '1' || hardParam === 'true') ? 1.8 : 1.0;
      const now = Date.now();
      function score(it) {
        const dueAt = it.next_review_at ? new Date(it.next_review_at).getTime() : now;
        const hoursOverdue = Math.max(0, (now - dueAt) / 3600000);
        const dueScore = Math.min(10, hoursOverdue);
        const effortScore = Math.log1p(Math.max(0, it.exposures || 0));
        const confidence = 10 - Math.max(1.3, Math.min(3.5, it.ease_factor || 2.5));
        const learningBoost = it.state === 'learning' ? 1.5 : 0;
        const r48 = recent48[it.lemma] || { fails: 0, passes: 0, total: 0 };
        const r168 = recent168[it.lemma] || { fails: 0, passes: 0, total: 0 };
        const failRatio = r48.total > 0 ? r48.fails / r48.total : 0;
        const lapses7 = Math.min(5, r168.fails || 0);
        const persistentLapses = Math.min(5, it.lapses || 0);
        const hardScore = hardWeight * (3 * failRatio + lapses7 * 0.6 + persistentLapses * 0.8);
        return 2 * dueScore + 1.2 * effortScore + confidence + learningBoost + hardScore;
      }
      const items = rawItems
        .slice()
        .sort((a, b) => score(b) - score(a))
        .slice(0, limit || 20);

      // Debug: log first item's definitions field
      if (items.length > 0) {
        console.log('[DEBUG] First item definitions:', {
          lemma: items[0].lemma,
          definitions: items[0].definitions,
          definitionsType: typeof items[0].definitions,
          definitionsZh: items[0].definitions?.zh
        });
      }

      const payload = { items };
      await cacheService.set(cacheKey, payload, 60);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = err.message === 'UNAUTHORIZED'
        ? 401
        : err.message === 'DATASTORE_UNAVAILABLE'
          ? 503
          : 500;
      return sendError(res, status, err.message);
    }
  }

  // POST /vocab/exposures - Batch record word exposures
  if (pathname === '/vocab/exposures' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      let processed = 0;
      for (const it of items.slice(0, 500)) {
        const lemma = (it?.lemma || '').toLowerCase().trim();
        if (!lemma) continue;
        // ensure item exists
        await dataStore.upsertVocabItem(user.id, lemma, { last_seen_at: new Date() });
        await dataStore.incrementExposure(user.id, lemma);
        // optional context - 仅在句子包含该单词时保存
        try {
          const sentence = it.sentence ? String(it.sentence).slice(0, 500) : null;
          if (sentence && containsWord(sentence, lemma)) {
            await dataStore.saveVocabContext({
              userId: user.id,
              lemma,
              videoResourceId: Number(it.videoId) || null,
              segmentIndex: Number(it.segmentIndex) || null,
              startSec: Number(it.startSec) || null,
              endSec: Number(it.endSec) || null,
              sentence,
            });
          }
        } catch (_) {}
        processed += 1;
      }
      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, { ok: true, processed });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to record exposures');
    }
  }

  // POST /vocab/reads - Batch record word reads
  if (pathname === '/vocab/reads' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      let processed = 0;
      for (const it of items.slice(0, 500)) {
        const lemma = (it?.lemma || '').toLowerCase().trim();
        if (!lemma) continue;
        await dataStore.upsertVocabItem(user.id, lemma, { last_seen_at: new Date() });
        await dataStore.incrementRead(user.id, lemma);
        // 仅在句子包含该单词时保存上下文
        try {
          const sentence = it.sentence ? String(it.sentence).slice(0, 500) : null;
          if (sentence && containsWord(sentence, lemma)) {
            await dataStore.saveVocabContext({
              userId: user.id,
              lemma,
              videoResourceId: Number(it.videoId) || null,
              segmentIndex: Number(it.segmentIndex) || null,
              startSec: Number(it.startSec) || null,
              endSec: Number(it.endSec) || null,
              sentence,
            });
          }
        } catch (_) {}
        processed += 1;
      }
      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, { ok: true, processed });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to record reads');
    }
  }

  // POST /vocab/interaction - Record word interactions (lookup/pronounce)
  if (pathname === '/vocab/interaction' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      let processed = 0;
      for (const it of items.slice(0, 500)) {
        const lemma = (it?.lemma || '').toLowerCase().trim();
        const type = (it?.type || '').toLowerCase();
        if (!lemma || !type) continue;
        const existing = await dataStore.getVocabItem(user.id, lemma);
        if (!existing) {
          await dataStore.upsertVocabItem(user.id, lemma, { state: 'encountered', last_seen_at: new Date() });
        }
        if (type === 'lookup') {
          await dataStore.incrementLookup(user.id, lemma);
        } else if (type === 'pronounce') {
          await dataStore.incrementPronounce(user.id, lemma);
        }
        // Promote to learning on first interaction
        const item = existing || await dataStore.getVocabItem(user.id, lemma);
        if (!item || item.state === 'encountered') {
          const nextAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes later
          await dataStore.upsertVocabItem(user.id, lemma, { state: 'learning', next_review_at: nextAt });
        }
        processed += 1;
      }
      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, { ok: true, processed });
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to record interactions');
    }
  }

  // POST /vocab/review - Record vocabulary review outcome
  if (pathname === '/vocab/review' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);

      // SM-2 路径(默认);SRS_ENGINE=legacy 时走下方原有逻辑
      if (isSm2Enabled()) {
        const quality = srsBridge.resolveQuality(body);
        if (!quality) return sendError(res, 400, 'INVALID_OUTCOME');
        const result = await srsBridge.reviewByLemma(user.id, {
          lemma: body.lemma,
          quality,
          // outcome:'mastered' 是用户显式声明,不能由 quality 反推(四档按钮的 'easy' 不算)
          explicitMastery: srsBridge.isExplicitMastery(body),
        });
        if (!result) return sendError(res, 404, 'NOT_TRACKED');
        await invalidateUserVocabCache(user.id);
        return sendJson(res, 200, { item: result.item, schedule: result.schedule });
      }

      const lemmaRaw = (body.lemma || '').trim();
      const outcomeRaw = body.outcome;
      if (!lemmaRaw || !outcomeRaw) {
        return sendError(res, 400, 'Lemma and outcome are required');
      }
      const lemma = normalizeLemma(lemmaRaw);
      const item = await dataStore.getVocabItem(user.id, lemma);
      if (!item) {
        return sendError(res, 404, 'Word not tracked');
      }

      const { updates, log } = applyReviewOutcome(item, outcomeRaw);
      const updated = await dataStore.upsertVocabItem(user.id, lemma, updates);
      await dataStore.recordVocabReview({
        userId: user.id,
        lemma,
        outcome: log.outcome,
        easeFactor: log.easeFactor,
        intervalDays: log.intervalDays,
      });

      await invalidateUserVocabCache(user.id);
      return sendJson(res, 200, { item: updated });
    } catch (err) {
      console.error('Vocab review error:', err);
      const status = err.message === 'UNAUTHORIZED'
        ? 401
        : err.message === 'DATASTORE_UNAVAILABLE'
          ? 503
          : 500;
      return sendError(res, status, err.message);
    }
  }

  // GET /vocab/full-library - Get full vocabulary library (all words from words table)
  if (pathname === '/vocab/full-library' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      if (!dataStore.isDatabaseAvailable()) {
        return sendJson(res, 200, { items: [], count: 0 });
      }

      const search = url.searchParams.get('search') || '';
      const includeLowQuality = (url.searchParams.get('include_low_quality') || '0') === '1';
      const difficultyRaw = (url.searchParams.get('difficulty') || '').trim().toLowerCase(); // beginner|intermediate|advanced|unknown
      const difficulty = (difficultyRaw === 'beginner' || difficultyRaw === 'intermediate' || difficultyRaw === 'advanced' || difficultyRaw === 'unknown')
        ? difficultyRaw
        : '';
      const limit = url.searchParams.get('limit')
        ? Math.min(Number(url.searchParams.get('limit')), 10000)
        : 1000;
      const offset = url.searchParams.get('offset')
        ? Number(url.searchParams.get('offset'))
        : 0;

      const cacheKey = buildUserCacheKey(
        user.id,
        `full-library:${encodeURIComponent(search)}:${includeLowQuality ? '1' : '0'}:${difficulty || 'all'}:${limit}:${offset}`,
      );
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      // Query words table with optional search filter
      let query = `
        SELECT
          w.id,
          w.word,
          w.word_lowercase,
          w.part_of_speech,
          w.frequency_rank,
          w.difficulty_level,
          w.definitions,
          w.phonetic,
          w.audio_url,
          w.example_sentences,
          w.synonyms,
          w.antonyms,
          w.related_words,
          w.lookup_count,
          w.learned_by_count,
          EXISTS(
            SELECT 1 FROM user_vocabulary uv
            WHERE uv.user_id = $1 AND uv.word_id = w.id
          ) as in_my_vocabulary
        FROM words w
      `;
      const params = [user.id];
      let idx = 2;

      const lowQualitySql = `
        (LENGTH(w.word_lowercase) >= 8 AND w.word_lowercase ~ '([a-z])\\1\\1\\1')
        OR (w.word_lowercase ~ '[0-9]')
        OR (w.word_lowercase ~ '[^a-z''-]')
        OR (LENGTH(w.word_lowercase) > 45)
        OR ((LENGTH(w.word_lowercase) = 1) AND w.word_lowercase NOT IN ('a','i'))
        OR ((LENGTH(w.word_lowercase) >= 7) AND w.word_lowercase !~ '[aeiouy]')
      `;

      const where = [];
      const searchLower = search.trim() ? search.toLowerCase() : '';
      if (searchLower) {
        where.push(`w.word_lowercase LIKE $${idx}`);
        params.push(`%${searchLower}%`);
        idx += 1;
      }
      if (!includeLowQuality) {
        where.push(`NOT (${lowQualitySql})`);
      }

      // Difficulty filter:
      // - Prefer explicit difficulty_level values: beginner/intermediate/advanced or CEFR (A1-C2) or easy/medium/hard
      // - Fallback to frequency_rank when difficulty_level is missing (rank must be NOT NULL)
      if (difficulty) {
        if (difficulty === 'unknown') {
          where.push(`((w.difficulty_level IS NULL OR w.difficulty_level = '') AND w.frequency_rank IS NULL)`);
        } else {
          const diffParam = `$${idx}`;
          params.push(difficulty);
          idx += 1;

          const cefrList = difficulty === 'beginner'
            ? ['a1', 'a2', 'easy']
            : difficulty === 'intermediate'
              ? ['b1', 'b2', 'medium']
              : ['c1', 'c2', 'hard'];
          const cefrParams = cefrList.map((v) => {
            const p = `$${idx}`;
            params.push(v);
            idx += 1;
            return p;
          }).join(', ');

          let rankCond = 'w.frequency_rank > 8000';
          if (difficulty === 'beginner') rankCond = 'w.frequency_rank <= 3000';
          if (difficulty === 'intermediate') rankCond = 'w.frequency_rank > 3000 AND w.frequency_rank <= 8000';

          where.push(`(
            LOWER(COALESCE(w.difficulty_level, '')) = ${diffParam}
            OR LOWER(w.difficulty_level) IN (${cefrParams})
            OR ((w.difficulty_level IS NULL OR w.difficulty_level = '') AND w.frequency_rank IS NOT NULL AND ${rankCond})
          )`);
        }
      }

      if (where.length) query += ` WHERE ${where.join(' AND ')}`;

      if (searchLower) {
        // Order by: exact match first, then starts with, then contains, then alphabetical
        const exactParam = `$${idx}`; params.push(searchLower); idx += 1;
        const startsParam = `$${idx}`; params.push(`${searchLower}%`); idx += 1;
        const limitParam = `$${idx}`; params.push(limit); idx += 1;
        const offsetParam = `$${idx}`; params.push(offset); idx += 1;
        query += ` ORDER BY
          CASE
            WHEN w.word_lowercase = ${exactParam} THEN 0
            WHEN w.word_lowercase LIKE ${startsParam} THEN 1
            ELSE 2
          END,
          LENGTH(w.word_lowercase) ASC,
          w.word_lowercase ASC
          LIMIT ${limitParam} OFFSET ${offsetParam}
        `;
      } else {
        const limitParam = `$${idx}`; params.push(limit); idx += 1;
        const offsetParam = `$${idx}`; params.push(offset); idx += 1;
        query += ` ORDER BY
          CASE
            WHEN w.frequency_rank IS NOT NULL THEN 0
            ELSE 1
          END,
          w.frequency_rank ASC NULLS LAST,
          w.learned_by_count DESC NULLS LAST,
          w.word_lowercase ASC
          LIMIT ${limitParam} OFFSET ${offsetParam}
        `;
      }

      const result = await dataStore.pool.query(query, params);

      // Get total count from database
      let countQuery = 'SELECT COUNT(*) as total FROM words w';
      const countParams = [];
      let cidx = 1;
      const countWhere = [];
      if (searchLower) {
        countWhere.push(`w.word_lowercase LIKE $${cidx}`);
        countParams.push(`%${searchLower}%`);
        cidx += 1;
      }
      if (!includeLowQuality) {
        countWhere.push(`NOT (${lowQualitySql})`);
      }
      if (difficulty) {
        if (difficulty === 'unknown') {
          countWhere.push(`((w.difficulty_level IS NULL OR w.difficulty_level = '') AND w.frequency_rank IS NULL)`);
        } else {
          const diffParam = `$${cidx}`;
          countParams.push(difficulty);
          cidx += 1;

          const cefrList = difficulty === 'beginner'
            ? ['a1', 'a2', 'easy']
            : difficulty === 'intermediate'
              ? ['b1', 'b2', 'medium']
              : ['c1', 'c2', 'hard'];
          const cefrParams = cefrList.map((v) => {
            const p = `$${cidx}`;
            countParams.push(v);
            cidx += 1;
            return p;
          }).join(', ');

          let rankCond = 'w.frequency_rank > 8000';
          if (difficulty === 'beginner') rankCond = 'w.frequency_rank <= 3000';
          if (difficulty === 'intermediate') rankCond = 'w.frequency_rank > 3000 AND w.frequency_rank <= 8000';

          countWhere.push(`(
            LOWER(COALESCE(w.difficulty_level, '')) = ${diffParam}
            OR LOWER(w.difficulty_level) IN (${cefrParams})
            OR ((w.difficulty_level IS NULL OR w.difficulty_level = '') AND w.frequency_rank IS NOT NULL AND ${rankCond})
          )`);
        }
      }
      if (countWhere.length) countQuery += ` WHERE ${countWhere.join(' AND ')}`;
      const countResult = await dataStore.pool.query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0]?.total || 0);

      // Helper to compute level from frequency rank
      const computeLevel = (rank) => {
        if (!rank) return null;
        if (rank <= 3000) return 'beginner';
        if (rank <= 8000) return 'intermediate';
        return 'advanced';
      };

      // Transform to match frontend format
      const items = result.rows.map(row => ({
        id: row.id,
        lemma: row.word,
        word: row.word,
        partOfSpeech: row.part_of_speech,
        frequencyRank: row.frequency_rank,
        difficultyLevel: row.difficulty_level,
        computed_level: computeLevel(row.frequency_rank),
        definitions: row.definitions,
        phonetic: row.phonetic,
        audioUrl: row.audio_url,
        exampleSentences: row.example_sentences,
        synonyms: row.synonyms,
        antonyms: row.antonyms,
        relatedWords: row.related_words,
        lookupCount: row.lookup_count || 0,
        learnedByCount: row.learned_by_count || 0,
        inMyVocabulary: row.in_my_vocabulary || false,
        // Add translation from definitions if available
        translation: row.definitions?.zh || null
      }));

      const payload = {
        items,
        count: items.length,
        totalCount: totalCount  // 全局词库的真实总数
      };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      console.error('Full library error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to get full library');
    }
  }

  // GET /vocab/stats-summary - Get vocabulary statistics summary
  if (pathname === '/vocab/stats-summary' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      if (!dataStore.isDatabaseAvailable()) {
        return sendJson(res, 200, { total: 0, mastered: 0, reviewing: 0, learning: 0, encountered: 0, due: 0, newToday: 0 });
      }
      const cacheKey = buildUserCacheKey(user.id, 'stats-summary');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const stats = await dataStore.getVocabStatsSummary(user.id);
      await cacheService.set(cacheKey, stats, 60);
      return sendJson(res, 200, stats);
    } catch (err) {
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to get stats');
    }
  }

  // GET /vocab/difficulty-stats - Get user's vocabulary difficulty distribution
  if (pathname === '/vocab/difficulty-stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      if (!dataStore.isDatabaseAvailable()) {
        return sendJson(res, 200, { total: 0, beginner: 0, intermediate: 0, advanced: 0, unknown: 0 });
      }

      const cacheKey = buildUserCacheKey(user.id, 'difficulty-stats');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const { rows } = await dataStore.pool.query(
        `WITH classified AS (
          SELECT
            CASE
              WHEN COALESCE(NULLIF(LOWER(w.difficulty_level), ''), '') IN ('beginner','intermediate','advanced','easy','medium','hard','a1','a2','b1','b2','c1','c2') THEN
                CASE
                  WHEN LOWER(w.difficulty_level) IN ('beginner','easy','a1','a2') THEN 'beginner'
                  WHEN LOWER(w.difficulty_level) IN ('intermediate','medium','b1','b2') THEN 'intermediate'
                  WHEN LOWER(w.difficulty_level) IN ('advanced','hard','c1','c2') THEN 'advanced'
                  ELSE NULL
                END
              WHEN w.frequency_rank IS NULL THEN NULL
              WHEN w.frequency_rank <= 3000 THEN 'beginner'
              WHEN w.frequency_rank <= 8000 THEN 'intermediate'
              ELSE 'advanced'
            END AS lvl
          FROM user_vocabulary uv
          LEFT JOIN words w ON w.id = uv.word_id
          WHERE uv.user_id = $1
        )
        SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN lvl = 'beginner' THEN 1 ELSE 0 END)::int AS beginner,
          SUM(CASE WHEN lvl = 'intermediate' THEN 1 ELSE 0 END)::int AS intermediate,
          SUM(CASE WHEN lvl = 'advanced' THEN 1 ELSE 0 END)::int AS advanced,
          SUM(CASE WHEN lvl IS NULL THEN 1 ELSE 0 END)::int AS unknown
        FROM classified`,
        [user.id],
      );

      const row = rows && rows[0] ? rows[0] : { total: 0, beginner: 0, intermediate: 0, advanced: 0, unknown: 0 };
      await cacheService.set(cacheKey, row, 60);
      return sendJson(res, 200, row);
    } catch (err) {
      console.error('Difficulty stats error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to get difficulty stats');
    }
  }

  // GET /vocab/full-library/difficulty-stats - Get full library difficulty distribution (optionally filtered by search/quality)
  if (pathname === '/vocab/full-library/difficulty-stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req); // keep consistent auth requirement
      if (!dataStore.isDatabaseAvailable()) {
        return sendJson(res, 200, { total: 0, beginner: 0, intermediate: 0, advanced: 0, unknown: 0 });
      }

      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const includeLowQuality = (url.searchParams.get('include_low_quality') || '0') === '1';
      const cacheKey = buildUserCacheKey(
        user.id,
        `full-library:stats:${encodeURIComponent(search)}:${includeLowQuality ? '1' : '0'}`,
      );
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const lowQualitySql = `
        (LENGTH(w.word_lowercase) >= 8 AND w.word_lowercase ~ '([a-z])\\1\\1\\1')
        OR (w.word_lowercase ~ '[0-9]')
        OR (w.word_lowercase ~ '[^a-z''-]')
        OR (LENGTH(w.word_lowercase) > 45)
        OR ((LENGTH(w.word_lowercase) = 1) AND w.word_lowercase NOT IN ('a','i'))
        OR ((LENGTH(w.word_lowercase) >= 7) AND w.word_lowercase !~ '[aeiouy]')
      `;

      const where = [];
      const params = [];
      let idx = 1;
      if (search) {
        where.push(`w.word_lowercase LIKE $${idx}`);
        params.push(`%${search}%`);
        idx += 1;
      }
      if (!includeLowQuality) {
        where.push(`NOT (${lowQualitySql})`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const { rows } = await dataStore.pool.query(
        `WITH classified AS (
          SELECT
            CASE
              WHEN COALESCE(NULLIF(LOWER(w.difficulty_level), ''), '') IN ('beginner','intermediate','advanced','easy','medium','hard','a1','a2','b1','b2','c1','c2') THEN
                CASE
                  WHEN LOWER(w.difficulty_level) IN ('beginner','easy','a1','a2') THEN 'beginner'
                  WHEN LOWER(w.difficulty_level) IN ('intermediate','medium','b1','b2') THEN 'intermediate'
                  WHEN LOWER(w.difficulty_level) IN ('advanced','hard','c1','c2') THEN 'advanced'
                  ELSE NULL
                END
              WHEN w.frequency_rank IS NULL THEN NULL
              WHEN w.frequency_rank <= 3000 THEN 'beginner'
              WHEN w.frequency_rank <= 8000 THEN 'intermediate'
              ELSE 'advanced'
            END AS lvl
          FROM words w
          ${whereSql}
        )
        SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN lvl = 'beginner' THEN 1 ELSE 0 END)::int AS beginner,
          SUM(CASE WHEN lvl = 'intermediate' THEN 1 ELSE 0 END)::int AS intermediate,
          SUM(CASE WHEN lvl = 'advanced' THEN 1 ELSE 0 END)::int AS advanced,
          SUM(CASE WHEN lvl IS NULL THEN 1 ELSE 0 END)::int AS unknown
        FROM classified`,
        params,
      );

      const row = rows && rows[0] ? rows[0] : { total: 0, beginner: 0, intermediate: 0, advanced: 0, unknown: 0 };
      await cacheService.set(cacheKey, row, 120);
      return sendJson(res, 200, row);
    } catch (err) {
      console.error('Full library difficulty stats error:', err);
      const status = mapErrorToStatus(err);
      return sendError(res, status, err.message || 'Failed to get full library difficulty stats');
    }
  }

  // Not a vocabulary route
  return false;
}

module.exports = {
  registerVocabularyRoutes,
  findLemmaContextsAcrossVideos,
  isSm2Enabled,
};
