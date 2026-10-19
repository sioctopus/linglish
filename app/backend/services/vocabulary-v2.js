/**
 * Vocabulary Service V2 - 全局唯一词汇系统
 *
 * 架构设计:
 * - words表: 全局词汇库，由所有用户从视频导入时自动填充
 * - user_vocabulary表: 用户的词汇关联，包含个人学习进度
 *
 * 特点:
 * - 每个单词全局唯一（不重复存储）
 * - 用户从视频导入词汇时自动贡献到全局词库
 * - 翻译统一管理，一次更新全局生效
 */

const { pool, init, dbUnavailable, assertDbAvailable } = require('../data-store/core');
const { classifyTranscript } = require('./video-level');
const dictionary = require('./dictionary');
const { analyzeWordQuality } = require('../utils/word-quality');
const { createCurationService } = require('./dictionary/curation');

const curation = createCurationService();

/**
 * 获取或创建全局唯一的词汇
 * 当用户从视频导入词汇时自动调用
 *
 * 工作流程:
 * 1. 检查words表是否已存在该词汇
 * 2. 存在 → 返回现有记录，更新lookup_count
 * 3. 不存在 → 插入新记录（贡献新词！）
 *
 * @param {string} word - 词汇原型
 * @returns {Promise<Object>} 词汇对象 {id, word, word_lowercase, ...}
 */
async function getOrCreateWord(word) {
  await init();
  assertDbAvailable();

  const quality = analyzeWordQuality(word);
  if (!quality.ok) {
    const err = new Error(`LOW_QUALITY_WORD:${quality.reasons.join(',')}`);
    err.code = 'LOW_QUALITY_WORD';
    err.reasons = quality.reasons;
    throw err;
  }
  const normalized = quality.lower;

  // 尝试获取现有词汇
  let result = await pool.query(
    'SELECT * FROM words WHERE word_lowercase = $1 LIMIT 1',
    [normalized]
  );

  if (result.rows.length > 0) {
    const existingWord = result.rows[0];
    console.log(`[Vocab V2] Word "${word}" already exists in global vocabulary (id: ${existingWord.id})`);

    // 更新使用次数
    await pool.query(
      'UPDATE words SET lookup_count = lookup_count + 1, updated_at = NOW() WHERE id = $1',
      [existingWord.id]
    );

    return existingWord;
  }

  // 词汇不存在，添加到全局词汇库（新贡献！）
  // 尝试从字典API获取定义和音标
  let definitions = null;
  let phonetic = null;

  try {
    console.log(`[Vocab V2] Fetching dictionary definition for "${word}"...`);
    const dictResult = await dictionary.lookup(word);

    if (dictResult && dictResult.entry) {
      const entry = dictResult.entry;

      // 提取音标
      phonetic = entry.phonetic || '';
      if (!phonetic && Array.isArray(entry.phonetics) && entry.phonetics.length > 0) {
        const phoneticEntry = entry.phonetics.find(p => p && (p.text || p.phonetic));
        phonetic = phoneticEntry?.text || phoneticEntry?.phonetic || '';
      }

      // 提取英文定义（第一个meaning的第一个definition）
      let enDefinition = '';
      if (Array.isArray(entry.meanings) && entry.meanings.length > 0) {
        const firstMeaning = entry.meanings[0];
        if (Array.isArray(firstMeaning.definitions) && firstMeaning.definitions.length > 0) {
          enDefinition = firstMeaning.definitions[0].definition || '';
        }
      }

      // 构造JSONB格式的definitions: {"en": "英文定义", "zh": "[待翻译]"}
      // 中文翻译标记为待填充，保持与现有数据格式一致
      if (enDefinition) {
        definitions = {
          en: enDefinition,
          zh: '[待翻译]' // 占位符，后续可通过翻译服务填充
        };
      }

      console.log(`[Vocab V2] Dictionary lookup successful for "${word}": phonetic=${phonetic}, hasDefinition=${!!enDefinition}`);
    }
  } catch (err) {
    // 字典查询失败不影响词汇创建，只是definitions为NULL
    console.log(`[Vocab V2] Dictionary lookup failed for "${word}": ${err.message}`);
  }

  const curated = await curation.apply({
    write: {
      word: normalized,
      candidate: { word, word_lowercase: normalized, phonetic, definitions },
      source: 'dictionary_external',
      reviewed: false,
      metadata: { path: 'vocabulary-v2.getOrCreateWord' },
    },
    actor: { type: 'system', id: 'vocabulary-v2' },
  });

  console.log(`[Vocab V2] ✨ New word added to global vocabulary: "${word}" (id: ${curated.after?.id})`);
  return curated.after;
}

/**
 * 为用户添加词汇到"我的词汇"（如果尚未添加）
 *
 * 使用场景:
 * 1. 用户从视频导入词汇（自动调用）
 * 2. 用户从"完整词汇库"手动添加词汇
 * 3. 智能导入系统确认导入（带 learning_context）
 *
 * @param {number} userId - 用户ID
 * @param {string} word - 词汇
 * @param {Object} context - 上下文信息 {videoId, sentence, learningContext, ...}
 * @returns {Promise<Object>} user_vocabulary 记录
 */
async function addWordForUser(userId, word, context = {}) {
  await init();
  assertDbAvailable();

  // 1. 确保词汇在全局词汇库中存在（如不存在则创建）
  let wordRecord;
  try {
    wordRecord = await getOrCreateWord(word);
  } catch (e) {
    if (e && e.code === 'LOW_QUALITY_WORD') {
      const err = new Error('无效/低质量词汇，已跳过');
      err.status = 400;
      err.code = 'LOW_QUALITY_WORD';
      err.reasons = e.reasons || [];
      throw err;
    }
    throw e;
  }

  // 2. 检查用户的"我的词汇"中是否已有此词
  let result = await pool.query(
    'SELECT * FROM user_vocabulary WHERE user_id = $1 AND word_id = $2 LIMIT 1',
    [userId, wordRecord.id]
  );

  if (result.rows.length > 0) {
    // 用户已有此词汇，可选择性更新 learning_context（如果传入且当前为空）
    const existingRecord = result.rows[0];
    const updates = ['updated_at = NOW()'];
    const values = [userId, wordRecord.id];
    let idx = 3;

    // 如果传入了 learning_context 且当前为空，则更新
    if (context.learningContext && !existingRecord.learning_context) {
      updates.push(`learning_context = $${idx}`);
      values.push(JSON.stringify(context.learningContext));
      idx++;
    }

    await pool.query(
      `UPDATE user_vocabulary
       SET ${updates.join(', ')}
       WHERE user_id = $1 AND word_id = $2`,
      values
    );
    console.log(`[Vocab V2] User ${userId} already has "${word}" in their vocabulary`);
    // 返回记录并标记为已存在
    return { ...existingRecord, _alreadyExisted: true };
  }

  // 3. 构建 learning_context（如果传入）
  let learningContextJson = null;
  if (context.learningContext) {
    // 确保有 version 字段
    const lc = {
      version: 1,
      ...context.learningContext
    };
    learningContextJson = JSON.stringify(lc);
  }

  // 4. 添加到用户的"我的词汇"
  result = await pool.query(
    `INSERT INTO user_vocabulary (
       user_id, word_id, word, status, first_seen_at,
       first_seen_context, first_seen_article_id, first_seen_video_id,
       learning_context, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'unknown', NOW(), $4, $5, $6, $7, NOW(), NOW())
     RETURNING *`,
    [
      userId,
      wordRecord.id,
      word,
      context.sentence || null,
      context.articleId || null,
      context.videoId || null,
      learningContextJson
    ]
  );

  console.log(`[Vocab V2] ✓ User ${userId} added "${word}" to their vocabulary`);
  return result.rows[0];
}

/**
 * 批量为用户添加词汇到"我的词汇"（从视频导入）
 *
 * 工作流程:
 * 1. 遍历视频中提取的所有词汇
 * 2. 每个词汇先在全局词汇库(words)中检查/创建
 * 3. 然后在用户的词汇(user_vocabulary)中创建关联
 *
 * 示例:
 * - 用户A从视频1导入 [hello, world, apple]
 *   → words表: 新增3个词（如果不存在）
 *   → user_vocabulary: 为用户A创建3条关联
 *
 * - 用户B从视频2导入 [hello, banana]
 *   → words表: hello已存在(跳过)，新增banana
 *   → user_vocabulary: 为用户B创建2条关联
 *
 * @param {number} userId - 用户ID
 * @param {Array<string>} words - 从视频提取的词汇列表
 * @param {Object} context - 上下文信息 {videoId, videoTitle, ...}
 * @returns {Promise<Object>} {added, skipped, newGlobalWords, total, words}
 */
async function batchAddWordsForUser(userId, words, context = {}) {
  await init();
  assertDbAvailable();

  const results = {
    added: 0,              // 添加到用户"我的词汇"的新词数量
    skipped: 0,            // 用户已有的词汇数量
    newGlobalWords: 0,     // 新增到全局词汇库的词汇数量
    total: words.length,
    words: []
  };

  // 获取用户信息用于日志
  const userInfo = `User ${userId}${context.videoId ? ` from video ${context.videoId}` : ''}`;

  for (const word of words) {
    try {
      // Skip low-quality tokens early
      const q = analyzeWordQuality(word);
      if (!q.ok) {
        results.skipped++;
        results.words.push({ word, success: false, error: `LOW_QUALITY_WORD:${q.reasons.join(',')}` });
        continue;
      }

      // 检查这个词是否是全局词汇库的新词
      const beforeCount = await pool.query(
        'SELECT COUNT(*) FROM words WHERE word_lowercase = $1',
        [q.lower]
      );
      const wasNew = parseInt(beforeCount.rows[0].count) === 0;

      // 添加到用户词汇（内部会调用getOrCreateWord）
      const record = await addWordForUser(userId, q.word, context);

      // 统计
      if (wasNew) {
        results.newGlobalWords++;
        console.log(`[Vocab V2] ✨ "${q.word}" is a new global word contributed by ${userInfo}`);
      }

      // 判断是否是新添加到用户词汇的
      if (record._alreadyExisted) {
        results.skipped++;
      } else {
        results.added++;
      }

      results.words.push({
        word: q.word,
        success: true,
        id: record.id,
        wasNewGlobal: wasNew
      });
    } catch (err) {
      console.error(`[Vocab V2] Failed to add word "${word}" for ${userInfo}:`, err);
      results.words.push({ word, success: false, error: err.message });
    }
  }

  console.log(`[Vocab V2] ${userInfo}: Added ${results.added} new words, skipped ${results.skipped}, contributed ${results.newGlobalWords} new global words`);
  return results;
}

/**
 * 获取"我的词汇"（用户已添加的词汇）
 *
 * @param {number} userId - 用户ID
 * @param {Object} options - 查询选项 {status, limit, offset}
 * @returns {Promise<Array>} 词汇列表
 */
async function getMyVocabulary(userId, options = {}) {
  await init();
  if (dbUnavailable()) {
    return [];
  }

  const {
    status = null,
    limit = 100,
    offset = 0
  } = options;

  const conditions = ['uv.user_id = $1'];
  const values = [userId];
  let idx = 2;

  if (status) {
    conditions.push(`uv.status = $${idx}`);
    values.push(status);
    idx++;
  }

  values.push(limit, offset);

  const result = await pool.query(
    `SELECT
       uv.id,
       uv.user_id,
       uv.word_id,
       uv.word,
       uv.status,
       uv.mastery_level,
       uv.first_seen_at,
       uv.last_reviewed_at,
       uv.review_count,
       uv.correct_count,
       uv.wrong_count,
       uv.first_seen_context,
       uv.first_seen_article_id,
       uv.first_seen_video_id,
       uv.next_review_at,
       uv.ease_factor,
       uv.interval_days,
       uv.learning_context,
       uv.created_at,
       uv.updated_at,
       w.word_lowercase,
       w.phonetic,
       w.definitions,
       w.frequency_rank,
       w.lookup_count as global_learner_count
     FROM user_vocabulary uv
     JOIN words w ON w.id = uv.word_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY uv.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values
  );

  // Debug log to check data structure
  if (result.rows.length > 0) {
    const sample = result.rows[0];
    console.log(`[Vocab V2] Sample word: ${sample.word}, definitions:`, sample.definitions);
  }

  return result.rows;
}

/**
 * 获取"完整词汇库"（所有用户贡献的词汇，可搜索、过滤）
 *
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>} 词汇列表
 */
async function getFullVocabulary(options = {}) {
  await init();
  if (dbUnavailable()) {
    return [];
  }

  const {
    search = null,           // 搜索关键词
    minLearners = null,      // 最少学习人数
    maxLearners = null,      // 最多学习人数
    partOfSpeech = null,     // 词性筛选
    includeLowQuality = false,
    limit = 1000,            // 默认1000个
    offset = 0
  } = options;

  const conditions = [];
  const values = [];
  let idx = 1;

  const lowQualitySql = `
    (LENGTH(word_lowercase) >= 8 AND word_lowercase ~ '([a-z])\\1\\1\\1')
    OR (word_lowercase ~ '[0-9]')
    OR (word_lowercase ~ '[^a-z\\-\\']')
    OR (LENGTH(word_lowercase) > 45)
    OR ((LENGTH(word_lowercase) = 1) AND word_lowercase NOT IN ('a','i'))
    OR ((LENGTH(word_lowercase) >= 7) AND word_lowercase !~ '[aeiouy]')
  `;
  if (!includeLowQuality) {
    conditions.push(`NOT (${lowQualitySql})`);
  }

  if (search) {
    conditions.push(`word_lowercase LIKE $${idx}`);
    values.push(`%${search.toLowerCase()}%`);
    idx++;
  }

  if (minLearners !== null) {
    conditions.push(`lookup_count >= $${idx}`);
    values.push(minLearners);
    idx++;
  }

  if (maxLearners !== null) {
    conditions.push(`lookup_count <= $${idx}`);
    values.push(maxLearners);
    idx++;
  }

  if (partOfSpeech) {
    conditions.push(`part_of_speech = $${idx}`);
    values.push(partOfSpeech);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const result = await pool.query(
    `SELECT
       id, word, word_lowercase, phonetic, part_of_speech,
       frequency_rank, definitions, lookup_count
     FROM words
     ${whereClause}
     ORDER BY lookup_count DESC NULLS LAST, word ASC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values
  );

  return result.rows;
}

/**
 * 检查用户是否已添加某个词汇到"我的词汇"
 *
 * @param {number} userId - 用户ID
 * @param {number} wordId - 词汇ID
 * @returns {Promise<boolean>} 是否已添加
 */
async function hasWordInMyVocabulary(userId, wordId) {
  await init();
  if (dbUnavailable()) {
    return false;
  }

  const result = await pool.query(
    'SELECT 1 FROM user_vocabulary WHERE user_id = $1 AND word_id = $2 LIMIT 1',
    [userId, wordId]
  );
  return result.rows.length > 0;
}

/**
 * 更新用户词汇的状态
 *
 * @param {number} userId - 用户ID
 * @param {string} word - 词汇
 * @param {string} status - 新状态 (unknown, learning, known)
 * @returns {Promise<Object>} 更新后的记录
 */
async function updateWordStatus(userId, word, status) {
  await init();
  assertDbAvailable();

  const normalized = word.toLowerCase();
  const validStatuses = ['unknown', 'learning', 'known'];

  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }

  // 先查找词汇在全局表中的ID
  const wordResult = await pool.query(
    'SELECT id FROM words WHERE word_lowercase = $1 LIMIT 1',
    [normalized]
  );

  if (wordResult.rows.length === 0) {
    throw new Error(`Word "${word}" not found in global vocabulary`);
  }

  const wordId = wordResult.rows[0].id;

  // 更新用户词汇状态
  const result = await pool.query(
    `UPDATE user_vocabulary
     SET status = $1, updated_at = NOW()
     WHERE user_id = $2 AND word_id = $3
     RETURNING *`,
    [status, userId, wordId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Word "${word}" not found in user's vocabulary`);
  }

  console.log(`[Vocab V2] User ${userId} updated "${word}" status to "${status}"`);
  return result.rows[0];
}

/**
 * 获取词汇库统计信息
 *
 * @param {number} userId - 用户ID（可选）
 * @returns {Promise<Object>} 统计信息
 */
async function getVocabularyStats(userId = null) {
  await init();
  if (dbUnavailable()) {
    return { totalGlobalWords: 0, myWords: 0, canExplore: 0, mastered: 0, reviewing: 0, learning: 0, unknown: 0 };
  }

  // 全局词汇库总数
  const globalResult = await pool.query('SELECT COUNT(*) as count FROM words');
  const totalGlobalWords = parseInt(globalResult.rows[0].count);

  if (!userId) {
    return { totalGlobalWords, myWords: 0, canExplore: totalGlobalWords, mastered: 0, reviewing: 0, learning: 0, unknown: 0 };
  }

  // 用户的词汇数量和状态统计
  const myResult = await pool.query(
    'SELECT COUNT(*) as count FROM user_vocabulary WHERE user_id = $1',
    [userId]
  );
  const myWords = parseInt(myResult.rows[0].count);

  // 按状态统计
  const statusResult = await pool.query(
    `SELECT
       status,
       COUNT(*)::int as count
     FROM user_vocabulary
     WHERE user_id = $1
     GROUP BY status`,
    [userId]
  );

  const statusCounts = {
    mastered: 0,
    reviewing: 0,
    learning: 0,
    unknown: 0,
    encountered: 0
  };

  statusResult.rows.forEach(row => {
    statusCounts[row.status] = row.count;
  });

  return {
    totalGlobalWords,
    myWords,
    canExplore: totalGlobalWords - myWords,
    mastered: statusCounts.mastered + (statusCounts.known || 0), // 兼容旧的known状态
    reviewing: statusCounts.reviewing,
    learning: statusCounts.learning,
    unknown: statusCounts.unknown,
    encountered: statusCounts.encountered
  };
}

/**
 * Get word level by frequency rank
 * @param {number} frequencyRank - Word frequency rank
 * @returns {string} Level: 'beginner' | 'intermediate' | 'advanced'
 */
function getWordLevelByRank(frequencyRank) {
  if (!frequencyRank || frequencyRank <= 0) {
    return 'intermediate'; // Default to intermediate if no rank
  }
  if (frequencyRank <= 3000) {
    return 'beginner';
  }
  if (frequencyRank <= 8000) {
    return 'intermediate';
  }
  return 'advanced';
}

/**
 * Get vocabulary level statistics for a user
 * Shows progress for each level (beginner, intermediate, advanced)
 *
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Level statistics
 */
async function getLevelStats(userId) {
  await init();
  if (dbUnavailable()) {
    return { currentLevel: 'beginner', levels: [] };
  }

  // Get level configuration
  const configResult = await pool.query(`
    SELECT level, level_order, rank_start, rank_end, display_name, icon, completion_threshold
    FROM vocabulary_level_config
    ORDER BY level_order
  `);

  // Get global word counts by level
  const globalCountsResult = await pool.query(`
    SELECT
      CASE
        WHEN frequency_rank IS NULL OR frequency_rank <= 0 THEN 'intermediate'
        WHEN frequency_rank <= 3000 THEN 'beginner'
        WHEN frequency_rank <= 8000 THEN 'intermediate'
        ELSE 'advanced'
      END AS level,
      COUNT(*) as count
    FROM words
    GROUP BY 1
  `);

  const globalCounts = {};
  globalCountsResult.rows.forEach(row => {
    globalCounts[row.level] = (globalCounts[row.level] || 0) + parseInt(row.count);
  });

  // Get user's vocabulary counts by level
  const userCountsResult = await pool.query(`
    SELECT
      CASE
        WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 'intermediate'
        WHEN w.frequency_rank <= 3000 THEN 'beginner'
        WHEN w.frequency_rank <= 8000 THEN 'intermediate'
        ELSE 'advanced'
      END AS level,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE uv.status NOT IN ('unknown', 'new')) as learned,
      COUNT(*) FILTER (WHERE uv.status IN ('known', 'mastered')) as mastered
    FROM user_vocabulary uv
    LEFT JOIN words w ON w.id = uv.word_id
    WHERE uv.user_id = $1
    GROUP BY 1
  `, [userId]);

  const userCounts = {};
  userCountsResult.rows.forEach(row => {
    userCounts[row.level] = {
      total: parseInt(row.total),
      learned: parseInt(row.learned),
      mastered: parseInt(row.mastered)
    };
  });

  // Get user's current level setting
  const settingsResult = await pool.query(`
    SELECT current_vocabulary_level, vocabulary_level_auto_progress
    FROM user_profiles
    WHERE user_id = $1
  `, [userId]);

  const currentLevel = settingsResult.rows[0]?.current_vocabulary_level || 'beginner';
  const autoProgress = settingsResult.rows[0]?.vocabulary_level_auto_progress !== false;

  // Build levels array
  const levels = configResult.rows.map(config => {
    const globalTotal = globalCounts[config.level] || 0;
    const userStats = userCounts[config.level] || { total: 0, learned: 0, mastered: 0 };
    const completion = globalTotal > 0 ? (userStats.mastered / globalTotal * 100) : 0;
    const isCompleted = completion >= parseFloat(config.completion_threshold);

    return {
      level: config.level,
      levelOrder: config.level_order,
      displayName: config.display_name,
      icon: config.icon,
      rankStart: config.rank_start,
      rankEnd: config.rank_end,
      globalTotal,
      userTotal: userStats.total,
      learned: userStats.learned,
      mastered: userStats.mastered,
      completion: parseFloat(completion.toFixed(1)),
      completionThreshold: parseFloat(config.completion_threshold),
      isCompleted,
      isActive: config.level === currentLevel
    };
  });

  return {
    currentLevel,
    autoProgress,
    levels
  };
}

/**
 * Get words from a specific level for the user to learn
 *
 * @param {number} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Words to learn
 */
async function getLevelWords(userId, options = {}) {
  await init();
  if (dbUnavailable()) {
    return [];
  }

  const {
    level = 'beginner',
    status = 'not_learned', // 'not_learned' | 'all' | specific status
    limit = 20,
    offset = 0
  } = options;

  // Get rank range for the level
  const configResult = await pool.query(`
    SELECT rank_start, rank_end FROM vocabulary_level_config WHERE level = $1
  `, [level]);

  if (configResult.rows.length === 0) {
    return [];
  }

  const { rank_start, rank_end } = configResult.rows[0];

  let query;
  let values;

  if (status === 'not_learned') {
    // Words in this level that user hasn't added yet
    query = `
      SELECT w.id, w.word, w.word_lowercase, w.phonetic, w.definitions,
             w.frequency_rank, w.lookup_count as learner_count,
             $4::varchar as computed_level
      FROM words w
      WHERE w.frequency_rank >= $1 AND w.frequency_rank <= $2
        AND NOT EXISTS (
          SELECT 1 FROM user_vocabulary uv
          WHERE uv.word_id = w.id AND uv.user_id = $3
        )
      ORDER BY w.frequency_rank ASC
      LIMIT $5 OFFSET $6
    `;
    values = [rank_start, rank_end, userId, level, limit, offset];
  } else {
    // All words in this level (or filter by specific status)
    const statusCondition = status === 'all' ? '' : `AND uv.status = $7`;
    query = `
      SELECT w.id, w.word, w.word_lowercase, w.phonetic, w.definitions,
             w.frequency_rank, w.lookup_count as learner_count,
             $4::varchar as computed_level,
             uv.status, uv.mastery_level, uv.last_reviewed_at
      FROM words w
      LEFT JOIN user_vocabulary uv ON uv.word_id = w.id AND uv.user_id = $3
      WHERE w.frequency_rank >= $1 AND w.frequency_rank <= $2
        ${statusCondition}
      ORDER BY w.frequency_rank ASC
      LIMIT $5 OFFSET $6
    `;
    values = [rank_start, rank_end, userId, level, limit, offset];
    if (status !== 'all') {
      values.push(status);
    }
  }

  const result = await pool.query(query, values);
  return result.rows;
}

/**
 * Update user's learning level settings
 *
 * @param {number} userId - User ID
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Updated settings
 */
async function updateLearningSettings(userId, settings) {
  await init();
  assertDbAvailable();

  const { currentLevel, autoProgress } = settings;
  const validLevels = ['beginner', 'intermediate', 'advanced'];

  if (currentLevel && !validLevels.includes(currentLevel)) {
    throw new Error(`Invalid level: ${currentLevel}. Must be one of: ${validLevels.join(', ')}`);
  }

  const updates = [];
  const values = [userId];
  let idx = 2;

  if (currentLevel !== undefined) {
    updates.push(`current_vocabulary_level = $${idx}`);
    values.push(currentLevel);
    idx++;
  }

  if (autoProgress !== undefined) {
    updates.push(`vocabulary_level_auto_progress = $${idx}`);
    values.push(autoProgress);
    idx++;
  }

  if (updates.length === 0) {
    throw new Error('No settings to update');
  }

  updates.push('vocabulary_level_updated_at = NOW()');

  // Use INSERT ... ON CONFLICT to handle both insert and update
  const result = await pool.query(`
    INSERT INTO user_profiles (user_id, current_vocabulary_level, vocabulary_level_auto_progress, vocabulary_level_updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      ${updates.join(', ')}
    RETURNING current_vocabulary_level, vocabulary_level_auto_progress, vocabulary_level_updated_at
  `, [userId, currentLevel || 'beginner', autoProgress !== false]);

  console.log(`[Vocab V2] User ${userId} updated learning settings: level=${currentLevel}, autoProgress=${autoProgress}`);
  return result.rows[0];
}

/**
 * Classify a transcript as a1, a2, b1, b2, or c1.
 * Frequency ranks are used when the dictionary covers the transcript.
 * Otherwise sentence length and word length decide the level.
 *
 * @param {string|Array} transcript - Full transcript text or segment list
 * @returns {Promise<Object>} {difficulty, score, stats}
 */
async function calculateVideoDifficulty(transcript) {
  await init();

  let fullText = '';
  if (Array.isArray(transcript)) {
    fullText = transcript.map(seg => {
      if (typeof seg === 'string') return seg;
      return seg.text || '';
    }).join(' ');
  } else if (typeof transcript === 'string') {
    fullText = transcript;
  }

  if (!fullText || fullText.trim().length === 0) {
    return {
      difficulty: null,
      score: null,
      stats: { a1: 0, a2: 0, b1: 0, b2: 0, c1: 0, c2: 0, unknown: 0, total: 0 }
    };
  }

  const uniqueWords = [...new Set(
    fullText
      .toLowerCase()
      .replace(/[^a-z'\-\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && w.length <= 30 && /^[a-z]/.test(w))
  )];

  const rankMap = {};
  if (uniqueWords.length > 0) {
    try {
      const placeholders = uniqueWords.map((_, i) => `$${i + 1}`).join(', ');
      const result = await pool.query(
        `SELECT word_lowercase, frequency_rank
         FROM words
         WHERE word_lowercase IN (${placeholders})`,
        uniqueWords
      );
      result.rows.forEach(row => {
        rankMap[row.word_lowercase] = row.frequency_rank;
      });
    } catch (err) {
      console.warn('[Vocab V2] Word ranks unavailable, using sentence structure:', err.message);
    }
  }

  const classified = classifyTranscript(fullText, rankMap);
  console.log(`[Vocab V2] Video level ${classified.difficulty || 'unknown'} via ${classified.source} (words: ${classified.stats.total})`);
  return classified;
}

/**
 * Batch calculate and update difficulty for all videos
 *
 * @param {Object} options - Options
 * @param {boolean} options.forceUpdate - Update even if already has difficulty
 * @returns {Promise<Object>} Update results
 */
async function batchUpdateVideoDifficulty(options = {}) {
  await init();

  const { forceUpdate = false } = options;

  // Query videos that need difficulty calculation
  let query;
  if (forceUpdate) {
    query = `SELECT id, transcript, transcript_segments FROM video_resources WHERE status = 'ready'`;
  } else {
    query = `SELECT id, transcript, transcript_segments FROM video_resources WHERE status = 'ready' AND (difficulty_level IS NULL OR difficulty_level = '')`;
  }

  const { rows: videos } = await pool.query(query);

  console.log(`[Vocab V2] Batch updating difficulty for ${videos.length} videos (forceUpdate: ${forceUpdate})`);

  const results = {
    total: videos.length,
    updated: 0,
    skipped: 0,
    errors: 0,
    details: []
  };

  for (const video of videos) {
    try {
      // Get transcript text - prefer segments, fallback to transcript field
      let transcriptData = video.transcript_segments || video.transcript;

      // Handle JSON string
      if (typeof transcriptData === 'string' && transcriptData.startsWith('[')) {
        try {
          transcriptData = JSON.parse(transcriptData);
        } catch (e) {
          // Keep as string
        }
      }

      const { difficulty, score, stats } = await calculateVideoDifficulty(transcriptData);

      if (difficulty) {
        await pool.query(
          `UPDATE video_resources SET difficulty_level = $1, updated_at = NOW() WHERE id = $2`,
          [difficulty, video.id]
        );
        results.updated++;
        results.details.push({
          id: video.id,
          difficulty,
          score,
          wordCount: stats.total
        });
      } else {
        results.skipped++;
      }
    } catch (err) {
      console.error(`[Vocab V2] Failed to calculate difficulty for video ${video.id}:`, err.message);
      results.errors++;
    }
  }

  console.log(`[Vocab V2] Batch update complete: ${results.updated} updated, ${results.skipped} skipped, ${results.errors} errors`);

  return results;
}

module.exports = {
  getOrCreateWord,
  addWordForUser,
  batchAddWordsForUser,
  getMyVocabulary,           // 我的词汇
  getFullVocabulary,         // 完整词汇库
  hasWordInMyVocabulary,     // 检查是否已添加
  getVocabularyStats,        // 统计信息
  updateWordStatus,          // 更新词汇状态
  // Level-related functions
  getWordLevelByRank,        // 根据词频获取级别
  getLevelStats,             // 获取级别统计
  getLevelWords,             // 获取某级别词汇
  updateLearningSettings,    // 更新学习设置
  // Video difficulty functions
  calculateVideoDifficulty,      // 计算单个视频难度
  batchUpdateVideoDifficulty,    // 批量更新视频难度
};
