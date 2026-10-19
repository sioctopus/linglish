const { pool, init, dbUnavailable, assertDbAvailable } = require('../core');
const { containsWord } = require('../utils/helpers');
const { createCurationService } = require('../../services/dictionary/curation');

const curation = createCurationService();

/**
 * @deprecated 此函数使用旧的 user_vocab_items 表
 * 新代码请使用 services/vocabulary-v2.js
 *
 * 迁移计划：
 * 1. 运行 scripts/migrate-vocab-to-v2.js 迁移数据
 * 2. 更新所有调用此函数的代码
 * 3. 运行 scripts/cleanup-old-vocab-table.js 删除旧表
 */
async function getVocabItem(userId, lemma) {
  await init();
  if (dbUnavailable()) {
    return null;
  }
  const normalized = lemma.toLowerCase();
  const { rows } = await pool.query(
    `SELECT
       uv.id,
       uv.user_id,
       uv.word_id,
       uv.word AS lemma,
       uv.word,
       uv.status AS state,
       uv.mastery_level,
       uv.first_seen_at,
       uv.last_reviewed_at AS last_review_at,
       uv.review_count,
       uv.correct_count,
       uv.wrong_count,
       uv.next_review_at,
       uv.ease_factor,
       uv.interval_days,
       uv.created_at,
       uv.updated_at,
       w.definitions,
       w.phonetic
     FROM user_vocabulary uv
     LEFT JOIN words w ON w.id = uv.word_id
     WHERE uv.user_id = $1 AND LOWER(uv.word) = $2
     LIMIT 1`,
    [userId, normalized],
  );
  return rows[0] || null;
}

async function upsertVocabItem(userId, lemma, updates = {}) {
  await init();
  assertDbAvailable();
  const normalized = lemma.toLowerCase();
  const existing = await getVocabItem(userId, normalized);

  // Map old field names to new table structure
  // Only include fields that exist in user_vocabulary table
  const fieldMap = {
    'state': 'status',
    'ease_factor': 'ease_factor',
    'interval_days': 'interval_days',
    'review_count': 'review_count',
    'last_review_at': 'last_reviewed_at',
    'next_review_at': 'next_review_at',
    'correct_count': 'correct_count',
    'wrong_count': 'wrong_count',
  };

  // Fields that exist in old schema but not in new schema - ignore them
  const ignoredFields = ['lapses', 'consecutive_fails', 'exposures', 'lookups', 'pronounces', 'reads', 'difficulty', 'notes', 'translation'];

  const lastSeenUpdate = updates.last_seen_at;
  delete updates.last_seen_at;

  if (!existing) {
    // For new records, we need word_id from words table
    let { rows: wordRows } = await pool.query(
      `SELECT id, is_blacklisted FROM words WHERE word_lowercase = $1 LIMIT 1`,
      [normalized]
    );

    // 检查是否在黑名单中
    if (wordRows && wordRows.length > 0 && wordRows[0].is_blacklisted === true) {
      console.log(`[Vocabulary] Word "${normalized}" is blacklisted, refusing to create user vocabulary`);
      return null;
    }

    // If word doesn't exist in words table, create it automatically
    if (!wordRows || wordRows.length === 0) {
      console.log(`[Vocabulary] Word "${normalized}" not in words table, creating...`);
      const curated = await curation.apply({
        write: {
          word: normalized,
          candidate: { word: normalized, word_lowercase: normalized },
          source: 'legacy_vocabulary',
          reviewed: false,
          metadata: { path: 'vocabulary.upsertVocabItem' },
        },
        actor: { type: 'system', id: 'legacy-vocabulary' },
      });
      wordRows = curated.after ? [{ id: curated.after.id }] : [];
    }

    const wordId = wordRows[0].id;
    const fields = ['user_id', 'word_id', 'word'];
    const placeholders = ['$1', '$2', '$3'];
    const values = [userId, wordId, normalized];
    let index = 4;

    // Map and add allowed fields
    Object.keys(updates).forEach((key) => {
      if (ignoredFields.includes(key)) return; // Skip ignored fields
      const dbField = fieldMap[key] || key;
      if (updates[key] !== undefined) {
        fields.push(dbField);
        placeholders.push(`$${index++}`);
        values.push(updates[key]);
      }
    });

    fields.push('first_seen_at');
    placeholders.push('NOW()');

    const sql = `INSERT INTO user_vocabulary (${fields.join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING *`;
    const { rows } = await pool.query(sql, values);
    return rows[0];
  }

  // Update existing record
  const sets = [];
  const values = [];
  let index = 1;

  Object.keys(updates).forEach((key) => {
    if (ignoredFields.includes(key)) return; // Skip ignored fields
    const dbField = fieldMap[key] || key;
    if (updates[key] !== undefined) {
      sets.push(`${dbField} = $${index++}`);
      values.push(updates[key]);
    }
  });

  sets.push('updated_at = NOW()');

  const sql = `UPDATE user_vocabulary
               SET ${sets.join(', ')}
               WHERE user_id = $${index} AND LOWER(word) = $${index + 1}
               RETURNING *`;
  values.push(userId, normalized);
  const { rows } = await pool.query(sql, values);
  return rows[0] || null;
}

/**
 * @deprecated incrementExposure is deprecated.
 * The new user_vocabulary table doesn't have an 'exposures' field.
 * Use review_count instead or track exposures via training events.
 */
async function incrementExposure(userId, lemma) {
  // No-op: exposures field doesn't exist in user_vocabulary table
  return;
}

/**
 * @deprecated incrementCounter is deprecated.
 * The new user_vocabulary table doesn't have lookups/pronounces/reads fields.
 * Track these via training_events table instead.
 */
async function incrementCounter(userId, lemma, column) {
  // No-op: these counters don't exist in user_vocabulary table
  return;
}

async function incrementLookup(userId, lemma) {
  return incrementCounter(userId, lemma, 'lookups');
}

async function incrementPronounce(userId, lemma) {
  return incrementCounter(userId, lemma, 'pronounces');
}

async function incrementRead(userId, lemma) {
  return incrementCounter(userId, lemma, 'reads');
}

async function saveVocabContext({
  userId,
  lemma,
  videoResourceId = null,
  segmentIndex = null,
  startSec = null,
  endSec = null,
  sentence = null,
}) {
  await init();
  if (dbUnavailable()) return;
  const normalized = lemma.toLowerCase();
  await pool.query(
    `INSERT INTO vocab_contexts
       (user_id, lemma, video_resource_id, segment_index, start_sec, end_sec, sentence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, normalized, videoResourceId, segmentIndex, startSec, endSec, sentence],
  );

  // Keep only most recent 20 contexts per lemma
  await pool.query(
    `DELETE FROM vocab_contexts
      WHERE id IN (
        SELECT id FROM vocab_contexts
        WHERE user_id = $1 AND lemma = $2
        ORDER BY created_at DESC OFFSET 20
      )`,
    [userId, normalized],
  );
}

async function listRecentContexts(userId, lemma, limit = 5) {
  await init();
  if (dbUnavailable()) {
    return [];
  }
  const normalized = lemma.toLowerCase();
  // 查询更多记录以便过滤后仍有足够结果
  const { rows } = await pool.query(
    `SELECT * FROM vocab_contexts
       WHERE user_id = $1 AND lemma = $2
       ORDER BY created_at DESC
       LIMIT $3`,
    [userId, normalized, limit * 3], // 查询3倍数量以应对过滤
  );

  // 过滤掉句子中不包含该词的记录
  const validRows = rows.filter(row => {
    if (!row.sentence) return false;
    return containsWord(row.sentence, lemma);
  });

  // 返回前 limit 条有效记录
  return validRows.slice(0, limit);
}

async function listDueVocabItems(userId, limit = 20) {
  await init();
  if (dbUnavailable()) {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT
       uv.id,
       uv.user_id,
       uv.word AS lemma,
       uv.word,
       uv.status AS state,
       uv.ease_factor,
       uv.interval_days,
       uv.next_review_at,
       uv.last_reviewed_at,
       uv.review_count,
       uv.first_seen_at,
       uv.review_count AS exposures,
       uv.correct_count,
       uv.wrong_count,
       uv.created_at,
       uv.updated_at,
       w.definitions,
       w.phonetic
     FROM user_vocabulary uv
     LEFT JOIN words w ON w.id = uv.word_id
       WHERE uv.user_id = $1
         AND uv.next_review_at IS NOT NULL
         AND uv.next_review_at <= NOW()
         AND uv.word IS NOT NULL
         AND TRIM(uv.word) != ''
       ORDER BY uv.next_review_at ASC
       LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

async function listAllVocabItems(userId, { state = null, limit = 100, offset = 0 } = {}) {
  await init();
  if (dbUnavailable()) {
    return [];
  }
  const conditions = ['uv.user_id = $1'];
  const values = [userId];
  let idx = 2;

  if (state) {
    conditions.push(`uv.status = $${idx}`);
    values.push(state);
    idx += 1;
  }

  values.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT
       uv.id,
       uv.user_id,
       uv.word AS lemma,
       uv.word,
       uv.status AS state,
       uv.mastery_level,
       uv.first_seen_at,
       uv.last_reviewed_at AS last_review_at,
       uv.review_count,
       uv.review_count AS exposures,
       uv.correct_count,
       uv.wrong_count,
       uv.next_review_at,
       uv.ease_factor,
       uv.interval_days,
       uv.first_seen_video_id AS "firstSeenVideoId",
       uv.created_at,
       uv.updated_at,
       w.frequency_rank AS "frequencyRank",
       w.difficulty_level AS "difficultyLevel",
       w.definitions,
       w.phonetic
     FROM user_vocabulary uv
     LEFT JOIN words w ON w.id = uv.word_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY uv.last_reviewed_at DESC NULLS LAST, uv.review_count DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  );
  return rows;
}

async function recordVocabReview({ userId, lemma, outcome, easeFactor, intervalDays }) {
  await init();
  if (dbUnavailable()) return;
  const normalized = lemma.toLowerCase();
  await pool.query(
    `INSERT INTO vocab_reviews (user_id, lemma, outcome, ease_factor, interval_days)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, normalized, outcome, easeFactor, intervalDays],
  );
}

async function getVocabStatsSummary(userId) {
  await init();
  if (dbUnavailable()) {
    return { total: 0, mastered: 0, reviewing: 0, learning: 0, encountered: 0, due: 0, newToday: 0 };
  }
  const totalQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1`, [userId]);
  const masteredQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND status = 'mastered'`, [userId]);
  const reviewingQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND status = 'reviewing'`, [userId]);
  const learningQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND status = 'learning'`, [userId]);
  const encounteredQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND status = 'encountered'`, [userId]);
  const dueQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND next_review_at IS NOT NULL AND next_review_at <= NOW()`, [userId]);
  const newTodayQ = pool.query(`SELECT COUNT(*)::int AS c FROM user_vocabulary WHERE user_id = $1 AND first_seen_at >= NOW() - INTERVAL '1 day'`, [userId]);
  const [total, mastered, reviewing, learning, encountered, due, newToday] = await Promise.all([totalQ, masteredQ, reviewingQ, learningQ, encounteredQ, dueQ, newTodayQ]);
  return {
    total: total.rows[0].c,
    mastered: mastered.rows[0].c,
    reviewing: reviewing.rows[0].c,
    learning: learning.rows[0].c,
    encountered: encountered.rows[0].c,
    due: due.rows[0].c,
    newToday: newToday.rows[0].c,
  };
}

async function getRecentReviewStats(userId, lemmas, hours = 48) {
  await init();
  if (dbUnavailable() || !Array.isArray(lemmas) || lemmas.length === 0) {
    return {};
  }
  const { rows } = await pool.query(
    `SELECT lemma,
            SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END)::int AS fails,
            SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END)::int AS passes
       FROM vocab_reviews
      WHERE user_id = $1
        AND created_at >= NOW() - ($3 || ' hours')::interval
        AND lemma = ANY($2)
      GROUP BY lemma`,
    [userId, lemmas, String(hours)],
  );
  const result = {};
  for (const r of rows) {
    const total = (r.fails || 0) + (r.passes || 0);
    result[r.lemma] = { fails: r.fails || 0, passes: r.passes || 0, total };
  }
  return result;
}

async function deleteVocabItem(userId, lemma) {
  await init();
  if (dbUnavailable()) {
    return false;
  }
  const normalized = lemma.toLowerCase();
  const result = await pool.query(
    `DELETE FROM user_vocabulary
     WHERE user_id = $1 AND LOWER(word) = $2
     RETURNING *`,
    [userId, normalized],
  );
  return result.rowCount > 0;
}

module.exports = {
  getVocabItem,
  upsertVocabItem,
  incrementExposure,
  incrementLookup,
  incrementPronounce,
  incrementRead,
  saveVocabContext,
  listRecentContexts,
  listDueVocabItems,
  listAllVocabItems,
  recordVocabReview,
  getVocabStatsSummary,
  getRecentReviewStats,
  deleteVocabItem,
};
