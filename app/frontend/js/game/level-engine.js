(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode
    ? {
        wordPool: require('./word-pool.js'),
        mastery: require('./mastery.js'),
        rig: require('./character-rig.js'),
        boss: require('./boss.js'),
        daily: require('./daily-challenge.js'),
      }
    : {
        wordPool: root.GameWordPool,
        mastery: root.GameMastery,
        rig: root.GameCharacterRig,
        boss: root.GameBoss,
        daily: root.GameDailyChallenge,
      };
  const api = factory(deps);
  if (isNode) module.exports = api;
  if (root) root.GameLevelEngine = api;
})(typeof window !== 'undefined' ? window : null, function (deps) {
  'use strict';

  const { wordPool, mastery, rig, boss, daily } = deps;

  const LEVELS_PER_CHAPTER = 5;
  const BOSS_LEVEL = LEVELS_PER_CHAPTER + 1;
  const TARGET_LEVEL_MS = 300000;
  const BOSS_STAR_GATE = 8;

  // 每关词数以 word-pool 为唯一真源,这里不再抄一份。
  const NEW_WORDS_PER_LEVEL = wordPool.NEW_WORDS_PER_LEVEL;
  const REVIEW_WORDS_PER_LEVEL = wordPool.REVIEW_WORDS_PER_LEVEL;

  function computeStars(input) {
    const accuracy = Number(input.accuracy) || 0;
    const elapsed = Number(input.elapsedMs) || 0;
    const target = Number(input.targetMs) || TARGET_LEVEL_MS;
    if (accuracy >= 0.95 && elapsed <= target) return 3;
    if (accuracy >= 0.8) return 2;
    return 1;
  }

  function chapterWords(pack, chapter) {
    const entry = pack.chapters.find(function (c) { return c.chapter === chapter; });
    return entry ? entry.words : [];
  }

  function chapterStars(progress, chapter) {
    const stars = (progress && progress.stars) || {};
    let total = 0;
    for (let level = 1; level <= LEVELS_PER_CHAPTER; level += 1) {
      total += Number(stars['c' + chapter + 'l' + level]) || 0;
    }
    return total;
  }

  function createLevelEngine(options) {
    const settings = options || {};
    const pack = settings.pack;
    const progressStore = settings.progressStore;
    const apiClient = settings.apiClient;

    async function startLevel(progress) {
      const chapter = progress.currentChapter;
      const level = progress.currentLevel;
      const words = chapterWords(pack, chapter);
      const isBoss = level === BOSS_LEVEL;

      const offset = (level - 1) * NEW_WORDS_PER_LEVEL;
      const fresh = isBoss ? words : words.slice(offset, offset + NEW_WORDS_PER_LEVEL);

      // 服务端 review-queue 只给 lemma/state,没有 zh/ipa;三个游戏引擎都要读 .zh,
      // 所以必须回词包补全。补不到的(别处学的词)直接丢弃,不能让 zh:undefined 进棋盘。
      const packWords = pack.chapters.reduce(function (all, c) { return all.concat(c.words); }, []);
      const findInPack = function (lemma) {
        return packWords.find(function (w) { return w.lemma === lemma; });
      };

      const queue = (await apiClient.fetchReviewQueue(REVIEW_WORDS_PER_LEVEL))
        .map(function (item) {
          const known = findInPack(item.lemma);
          return known ? { ...known, ...item, zh: known.zh, ipa: known.ipa } : null;
        })
        .filter(Boolean);
      const relearn = mastery
        .dueRelearnWords(progress.relearnQueue || [], level)
        .map(function (lemma) { return findInPack(lemma); })
        .filter(Boolean);

      const pool = wordPool.buildLevelPool({
        newWords: fresh,
        reviewWords: queue,
        relearnQueue: relearn,
        newCount: isBoss ? words.length : NEW_WORDS_PER_LEVEL,
        reviewCount: REVIEW_WORDS_PER_LEVEL,
      });

      return {
        levelId: 'c' + chapter + 'l' + level,
        chapter,
        level,
        isBoss,
        newWords: pool.newWords,
        reviewWords: pool.reviewWords,
        results: [],
        boss: isBoss ? boss.createBossState(words) : null,
        phase: 'learn',
        startedAt: Date.now(),
      };
    }

    async function recordResult(session, result) {
      await apiClient.submitReview(result.lemma, result.isCorrect ? 'good' : 'again');
      return {
        ...session,
        results: session.results.concat(result),
        boss: session.boss ? boss.applyAnswer(session.boss, result) : null,
      };
    }

    // Boss 出题:上局/本局答错的词优先回炉,game-app 每轮问它要下一批。
    function bossQuestionWords(session, count) {
      if (!session.isBoss || !session.boss) return [];
      return boss.nextBossWords(session.boss, chapterWords(pack, session.chapter), count);
    }

    // 结算时把 results 重新折进状态机,而不是信任 session.boss:
    // 血量/护盾的裁定只有这一套逻辑,UI 少调一次 recordResult 也不会改判。
    function bossVerdictFor(session) {
      const state = session.results.reduce(function (acc, result) {
        return boss.applyAnswer(acc, result);
      }, boss.createBossState(chapterWords(pack, session.chapter)));
      return boss.bossOutcome(state);
    }

    async function finishLevel(session, progress) {
      const results = session.results;
      const correct = results.filter(function (r) { return r.isCorrect; }).length;
      const accuracy = results.length === 0 ? 0 : correct / results.length;

      let nextProgress = results.reduce(function (acc, result) {
        return progressStore.recordWordResult(acc, result.lemma, result.gameType, result.isCorrect);
      }, progress);

      nextProgress = {
        ...nextProgress,
        relearnQueue: results.reduce(function (queue, result) {
          return mastery.updateRelearnQueue(queue, {
            lemma: result.lemma,
            isCorrect: result.isCorrect,
            currentLevel: session.level,
          });
        }, progress.relearnQueue || []),
      };

      // 每日挑战只记词态/复习队列/打卡日,不推进关卡、不写星、不解锁部位。
      if (session.isDaily) {
        const today = daily && typeof daily.todayKey === 'function'
          ? daily.todayKey()
          : new Date().toISOString().slice(0, 10);
        nextProgress = { ...nextProgress, lastDailyDate: today };

        const statsResult = await apiClient.logSession({
          minutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)),
          wordsLearned: session.newWords.length,
        });
        progressStore.save(nextProgress);
        return {
          progress: nextProgress,
          stars: 0,
          accuracy,
          unlockedPart: null,
          bossStatus: null,
          characterComplete: rig.isCharacterComplete(nextProgress.unlockedParts),
          statsResult,
          isDaily: true,
        };
      }

      const stars = computeStars({
        accuracy,
        elapsedMs: Date.now() - session.startedAt,
        targetMs: TARGET_LEVEL_MS,
      });
      // 重玩只能刷高不能刷低,否则 ≥8 星的 Boss 门会因为一次手滑倒退。
      const bestStars = Math.max(stars, Number(nextProgress.stars[session.levelId]) || 0);
      nextProgress = { ...nextProgress, stars: { ...nextProgress.stars, [session.levelId]: bestStars } };

      // 两个条件都要满足才算通章:护盾没被打光(boss.status === 'won'),
      // 且正确率过 90% 掌握门。前者是玩法胜负,后者是"通关=掌握"的承诺。
      const bossVerdict = session.isBoss ? bossVerdictFor(session) : null;
      const bossPassed = Boolean(bossVerdict)
        && bossVerdict.status === 'won'
        && mastery.canPassChapter(bossVerdict.accuracy);

      // 重玩已通关的旧章不动推进指针:只有打的是当前章,章节/关卡才前进,
      // 否则回去刷星会把 currentChapter/currentLevel 拉回去、新章重新上锁。
      const isCurrentChapter = session.chapter === nextProgress.currentChapter;
      let unlockedPart = null;
      if (bossPassed) {
        unlockedPart = rig.partForChapter(session.chapter);
        nextProgress = {
          ...nextProgress,
          currentChapter: isCurrentChapter ? session.chapter + 1 : nextProgress.currentChapter,
          currentLevel: isCurrentChapter ? 1 : nextProgress.currentLevel,
          unlockedParts: nextProgress.unlockedParts.includes(unlockedPart)
            ? nextProgress.unlockedParts.slice()
            : nextProgress.unlockedParts.concat(unlockedPart),
        };
      } else if (!session.isBoss && isCurrentChapter) {
        // 重玩早期关刷星是星门设计鼓励的玩法,进度顶针只能向前,不然已解锁的关会重新上锁。
        nextProgress = {
          ...nextProgress,
          currentLevel: Math.max(nextProgress.currentLevel, session.level + 1),
        };
      }

      const statsResult = await apiClient.logSession({
        minutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)),
        wordsLearned: session.newWords.length,
      });

      progressStore.save(nextProgress);

      return {
        progress: nextProgress,
        stars,
        accuracy,
        unlockedPart,
        bossStatus: bossVerdict ? bossVerdict.status : null,
        characterComplete: rig.isCharacterComplete(nextProgress.unlockedParts),
        statsResult,
        isDaily: false,
      };
    }

    function canEnterBoss(progress) {
      return chapterStars(progress, progress.currentChapter) >= BOSS_STAR_GATE;
    }

    return { startLevel, recordResult, finishLevel, canEnterBoss, bossQuestionWords };
  }

  return {
    createLevelEngine,
    computeStars,
    chapterStars,
    LEVELS_PER_CHAPTER,
    BOSS_LEVEL,
    BOSS_STAR_GATE,
    TARGET_LEVEL_MS,
  };
});
