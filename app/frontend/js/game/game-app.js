(function (root) {
  'use strict';

  const PACK_URL = '/js/game/word-packs/pack-max.json?v=11';
  const CARD_DECKS_URL = '/js/game/word-packs/card-decks.json?v=20';
  // 按屏宽选登录页:PC 落到 mobile-auth 会是被拉宽变形的手机版式。
  function requestedDeckId() {
    try {
      return new URLSearchParams(root.location.search).get('deck') || '';
    } catch (_) {
      return '';
    }
  }

  function gameReturnPath() {
    const deck = requestedDeckId();
    return deck ? '/game.html?deck=' + encodeURIComponent(deck) : '/game.html';
  }

  const LOGIN_URL = (root.matchMedia && root.matchMedia('(min-width: 900px)').matches)
    ? '/desktop-auth.html?next=' + encodeURIComponent(gameReturnPath())
    : '/mobile-auth.html?next=' + encodeURIComponent(gameReturnPath());
  // 安装窗口的 start_url 正好是 /index-desktop.html。点一个完全相同的地址时，
  // 系统会把它当成再次启动当前窗口，页面停在闯关。带上 from 后仍是首页。
  const HOME_URL = (root.matchMedia && root.matchMedia('(min-width: 900px)').matches)
    ? '/index-desktop.html?from=game'
    : '/mobile-today.html?from=game';
  const QUIZ_QUESTIONS = 6;
  const BOSS_LEVEL = root.GameLevelEngine.BOSS_LEVEL;
  const views = root.GameViews;
  const h = views.h;
  const button = views.button;
  const show = views.show;

  const container = document.getElementById('game-root');
  const reducedMotion = root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function bindHome(link) {
    link.href = HOME_URL;
    link.dataset.nav = 'back';
    link.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
      event.preventDefault();
      root.location.assign(HOME_URL);
    });
  }

  // client_mode 为 navigate-existing 时，再次启动不会自己换页，目标地址在 launchQueue 里。
  if (root.launchQueue && typeof root.launchQueue.setConsumer === 'function') {
    root.launchQueue.setConsumer(function (params) {
      const target = params && params.targetURL;
      if (!target) return;
      let next;
      try { next = new URL(target, root.location.href); } catch (_) { return; }
      if (next.origin !== root.location.origin) return;
      const here = root.location.pathname + root.location.search;
      const dest = next.pathname + next.search;
      if (dest && dest !== here) root.location.assign(dest + next.hash);
    });
  }

  // 统计是旁路:api-client 若是缓存的旧版本(无 track),游戏照常跑。
  function track(eventName, properties) {
    if (api && typeof api.track === 'function') api.track(eventName, properties);
  }

  let engine = null;
  let store = null;
  let api = null;
  let pack = null;
  let cardDecks = null;
  let progress = null;

  async function ensureToken() {
    const existing = root.AuthManager && root.AuthManager.getToken();
    return existing || null;
  }

  async function boot() {
    const token = await ensureToken();
    if (!token) { root.location.replace(LOGIN_URL); return; }

    // 共用一个 Audio 元素:每次 new Audio() 会在移动端堆出几十个解码器。
    // 不传 audio 的话 api.speak() 直接返回 false——拼写工坊没有发音就等于没有题面。
    const element = new root.Audio();
    api = root.GameApiClient.createApiClient({
      fetch: root.fetch.bind(root),
      getToken: function () { return root.AuthManager.getToken(); },
      storage: root.localStorage,
      audio: {
        play: function (url) {
          element.src = url;
          element.playbackRate = 0.92;
          return element.play();
        },
        playing: function () {
          return Boolean(element.src) && !element.paused && !element.ended;
        },
        paused: function () {
          return Boolean(element.src) && element.paused && element.currentTime > 0 && !element.ended;
        },
        pause: function () { element.pause(); },
        resume: function () { return element.play(); },
        setEnded: function (fn) { element.onended = fn; },
      },
    });
    store = root.GameProgressStore.createProgressStore(root.localStorage);
    progress = store.load();

    const response = await fetch(PACK_URL);
    if (!response.ok) { show(container, [h('p', 'game-error', '词包加载失败,请刷新重试。')]); return; }
    pack = await response.json();
    try {
      const decksResponse = await fetch(CARD_DECKS_URL);
      cardDecks = decksResponse.ok ? await decksResponse.json() : { decks: [] };
    } catch (_) {
      cardDecks = { decks: [] };
    }

    engine = root.GameLevelEngine.createLevelEngine({ pack, progressStore: store, apiClient: api });
    const deckId = requestedDeckId();
    const decks = (cardDecks && Array.isArray(cardDecks.decks)) ? cardDecks.decks : [];
    if (deckId && decks.some(function (deck) { return deck.id === deckId; })) {
      openCardDeck(deckId);
    } else {
      renderMap();
    }
    api.flushRetryQueue().catch(function () {});
    track('game_view', {
      chapter: progress.currentChapter,
      level: progress.currentLevel,
      parts_unlocked: progress.unlockedParts.length,
    });
  }

  function clearDeckQuery() {
    try {
      const url = new URL(root.location.href);
      if (!url.searchParams.has('deck')) return;
      url.searchParams.delete('deck');
      root.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (_) {}
  }

  function themeNav(activeId) {
    const nav = h('nav', 'game-theme-nav');
    nav.setAttribute('aria-label', '主题词卡菜单');
    // 点击后、视图未切完前先亮起目标项,避免侧栏仍停在旧选中态。
    function markPending(tabEl) {
      const tabs = nav.querySelectorAll('.game-theme-tab');
      for (let i = 0; i < tabs.length; i += 1) {
        tabs[i].classList.remove('game-theme-tab--active', 'game-theme-tab--pending');
      }
      tabEl.classList.add('game-theme-tab--pending');
    }
    const quest = button(
      'game-theme-tab' + (!activeId ? ' game-theme-tab--active' : ''),
      '闯关',
      function () {
        if (!activeId) return;
        markPending(quest);
        renderMap();
      }
    );
    nav.appendChild(quest);
    const decks = (cardDecks && Array.isArray(cardDecks.decks)) ? cardDecks.decks : [];
    decks.forEach(function (deck) {
      const tab = button(
        'game-theme-tab' + (activeId === deck.id ? ' game-theme-tab--active' : ''),
        (deck.emoji ? deck.emoji + ' ' : '') + deck.label,
        function () {
          if (activeId === deck.id) return;
          markPending(tab);
          openCardDeck(deck.id);
        }
      );
      nav.appendChild(tab);
    });
    return nav;
  }

  // 地图:顶部六章切换条 + 所在章的纵向关卡路径。已通的旧章可回去刷,
  // 未到的章置灰——整个系列一眼可见,不是"只有一章"。
  function renderMap(viewChapter) {
    clearDeckQuery();
    const chapter = Number(viewChapter) || progress.currentChapter;
    const stars = root.GameLevelEngine.chapterStars(progress, chapter);
    const gate = root.GameLevelEngine.BOSS_STAR_GATE;
    const themes = { 1: '学校', 2: '文具', 3: '数字', 4: '颜色', 5: '动作', 6: '时间' };
    function bossGateOpenFor(targetChapter) {
      return targetChapter < progress.currentChapter
        || root.GameLevelEngine.chapterStars(progress, targetChapter) >= gate;
    }

    const tabs = h('div', 'game-chapter-tabs');
    pack.chapters.forEach(function (entry) {
      const reachable = entry.chapter <= progress.currentChapter;
      const tab = button('game-chapter-tab',
        entry.chapter + '章 ' + (reachable ? (themes[entry.chapter] || '') : '🔒'),
        function () { renderMap(entry.chapter); });
      tab.disabled = !reachable;
      tab.dataset.active = String(entry.chapter === chapter);
      tabs.appendChild(tab);
    });

    const daily = root.GameDailyChallenge;
    const dailyDone = daily.isDailyDone(progress);
    const head = h('header', 'game-map-head');
    const kickerRow = h('div', 'game-map-kicker-row');
    kickerRow.appendChild(h('p', 'game-map-kicker', '闯关词汇'));
    const home = h('a', 'game-home', '返回');
    bindHome(home);
    kickerRow.appendChild(home);
    head.appendChild(kickerRow);
    head.appendChild(h('h1', 'game-map-title', '第 ' + chapter + ' 章 · ' + (themes[chapter] || '')));
    head.appendChild(h('p', 'game-map-stars', '本章星星 ' + stars + ' / ' + gate));

    const dailyBtn = button(
      'game-btn game-daily-btn' + (dailyDone ? ' game-daily-btn--done' : ''),
      dailyDone ? '今日挑战已完成' : '今日挑战',
      function () { if (!dailyDone) playDailyChallenge(); }
    );
    dailyBtn.disabled = dailyDone;

    const continueIsBoss = progress.currentLevel === BOSS_LEVEL;
    const continueBossGateOpen = !continueIsBoss || bossGateOpenFor(progress.currentChapter);
    const continueLabel = continueIsBoss
      ? (continueBossGateOpen
        ? '挑战 BOSS'
        : '还差 ' + (gate - root.GameLevelEngine.chapterStars(progress, progress.currentChapter)) + ' 星解锁 BOSS')
      : '继续第 ' + progress.currentLevel + ' 关';
    const continueButton = button('game-btn game-map-continue', continueLabel, function () {
      playLevel(progress.currentLevel, progress.currentChapter);
    });
    continueButton.disabled = !continueBossGateOpen;

    const actions = h('div', 'game-map-actions');
    actions.appendChild(continueButton);
    actions.appendChild(dailyBtn);

    const path = h('div', 'game-path');
    // 旧章已全通:关卡全开放,随便回去刷星;当前章按推进指针锁。
    const isPastChapter = chapter < progress.currentChapter;
    for (let level = 1; level <= BOSS_LEVEL; level += 1) {
      const levelId = 'c' + chapter + 'l' + level;
      const earned = Number(progress.stars[levelId]) || 0;
      const isBoss = level === BOSS_LEVEL;
      const bossGateOpen = bossGateOpenFor(chapter);
      const locked = isPastChapter
        ? false
        : (level > progress.currentLevel || (isBoss && !bossGateOpen));
      const label = (isBoss ? 'BOSS' : '第 ' + level + ' 关')
        + (earned ? '  ' + '★'.repeat(earned) : '');
      const node = button('game-node', label, function () { playLevel(level, chapter); });
      node.disabled = locked;
      node.dataset.current = String(!isPastChapter && level === progress.currentLevel);
      if (isBoss && !isPastChapter && !bossGateOpen) {
        node.appendChild(h('span', 'game-node__gate', '还差 ' + (gate - stars) + ' 星'));
      }
      path.appendChild(node);
    }

    const tools = h('div', 'game-map-tools');
    tools.appendChild(button('game-btn game-btn--ghost', '单词图鉴', function () { renderWordDex(); }));
    tools.appendChild(button('game-btn game-btn--ghost', '我的伙伴', function () { renderCharacter(); }));

    const shell = h('div', 'game-shell');
    const main = h('div', 'game-shell-main');
    [head, tabs, actions, path, tools].forEach(function (node) { main.appendChild(node); });
    shell.appendChild(themeNav(null));
    shell.appendChild(main);
    show(container, [shell]);
  }

  async function openCardDeck(deckId) {
    try {
      const url = new URL(root.location.href);
      if (url.searchParams.get('deck') !== deckId) {
        url.searchParams.set('deck', deckId);
        root.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch (_) {}
    const decks = (cardDecks && Array.isArray(cardDecks.decks)) ? cardDecks.decks : [];
    const deck = decks.find(function (item) { return item.id === deckId; });
    if (!deck) {
      show(container, [
        themeNav(deckId),
        h('p', 'game-error', '词卡加载失败，请返回重试。'),
        button('game-btn', '返回地图', renderMap),
      ]);
      return;
    }

    const host = h('div', 'game-shell');
    const main = h('div', 'game-shell-main game-shell-main--cards');
    host.appendChild(themeNav(deck.id));
    host.appendChild(main);
    show(container, [host]);

    const ctx = {
      container: main,
      api,
      reducedMotion,
      scene: null,
    };
    const round = attachLeave(ctx);
    track('game_card_deck_open', { deck: deck.id, words: (deck.words || []).length });
    await views.renderCardDeck(ctx, deck);
    if (!round.stopped) renderMap();
  }

  function attachLeave(ctx) {
    const round = { stopped: false, stop: null };
    ctx.bindLeave = function (fn) { round.stop = fn; };
    ctx.isStopped = function () { return round.stopped; };
    ctx.leave = function () {
      if (round.stopped) return;
      round.stopped = true;
      const stop = round.stop;
      round.stop = null;
      if (typeof stop === 'function') stop();
      renderMap();
    };
    return round;
  }

  async function runPhase(round, work) {
    await work;
    return !round.stopped;
  }

  async function playLevel(level, chapter) {
    // 进关用临时副本选关;progress 本体保住高水位,finishLevel 只在当前章前进指针。
    let session = await engine.startLevel({
      ...progress,
      currentChapter: Number(chapter) || progress.currentChapter,
      currentLevel: level,
    });
    track('game_level_start', {
      chapter: session.chapter,
      level: session.level,
      is_boss: session.isBoss,
    });

    const chapterEntry = pack.chapters.find(function (c) { return c.chapter === session.chapter; });
    const ctx = {
      container,
      api,
      reducedMotion,
      scene: (chapterEntry && chapterEntry.scene) || null,
      session: function () { return session; },
      commit: async function (result) {
        session = await engine.recordResult(session, result);
        return session;
      },
    };
    const round = attachLeave(ctx);

    function trackPhase(phase) {
      track('game_phase_complete', {
        chapter: session.chapter,
        level: session.level,
        is_boss: session.isBoss,
        phase,
      });
    }

    if (!(await runPhase(round, session.isBoss
      ? views.renderBoss(
        ctx,
        function (count) { return engine.bossQuestionWords(session, count); },
        session.newWords
      )
      : views.renderLearn(ctx, session.newWords)))) return;
    if (session.isBoss) {
      trackPhase('boss');
    } else {
      trackPhase('learn');
      if (!(await runPhase(round, views.renderSpeak(ctx, session.newWords)))) return;
      trackPhase('speaking');
      // 规范 §4.1:连连看单局 8-10 词 = 6 新词 + 2-4 复习词,不是只有新词。
      // 复习词在连连看(认知)和拼写(产出)里各出现一次,正好满足 §5.1「≥2 种题型答对」。
      if (!(await runPhase(round, views.renderLianliankan(ctx, session.newWords.concat(session.reviewWords))))) return;
      trackPhase('matching');
      if (session.reviewWords.length) {
        if (!(await runPhase(round, views.renderSpelling(ctx, session.reviewWords)))) return;
        trackPhase('spelling');
      }
      if (!(await runPhase(round, views.renderQuiz(ctx, session.newWords.slice(0, QUIZ_QUESTIONS))))) return;
      trackPhase('quiz');
    }

    const outcome = await engine.finishLevel(session, progress);
    progress = outcome.progress;
    track('game_level_complete', {
      chapter: session.chapter,
      level: session.level,
      is_boss: session.isBoss,
      stars: outcome.stars,
      accuracy: Math.round(outcome.accuracy * 100),
      boss_status: outcome.bossStatus,
    });
    if (outcome.unlockedPart) {
      track('game_chapter_pass', {
        chapter: session.chapter,
        part: outcome.unlockedPart,
        character_complete: outcome.characterComplete,
      });
    }
    await renderResult(outcome);
  }

  async function playDailyChallenge() {
    const daily = root.GameDailyChallenge;
    if (daily.isDailyDone(progress)) {
      renderMap();
      return;
    }
    const words = daily.pickDailyWords(pack, progress, daily.DAILY_WORD_COUNT);
    if (!words.length) {
      show(container, [
        h('p', 'game-error', '暂时没有可挑战的词,先打一关再来。'),
        button('game-btn', '回到地图', renderMap),
      ]);
      return;
    }

    let session = {
      levelId: 'daily',
      chapter: progress.currentChapter,
      level: progress.currentLevel,
      isBoss: false,
      isDaily: true,
      newWords: words,
      reviewWords: [],
      results: [],
      boss: null,
      phase: 'daily',
      startedAt: Date.now(),
    };
    track('game_daily_start', { words: words.length, chapter: session.chapter });

    const chapterEntry = pack.chapters.find(function (c) { return c.chapter === session.chapter; });
    const ctx = {
      container,
      api,
      reducedMotion,
      scene: (chapterEntry && chapterEntry.scene) || null,
      session: function () { return session; },
      commit: async function (result) {
        session = await engine.recordResult(session, result);
        return session;
      },
    };

    const round = attachLeave(ctx);

    await views.renderSpeak(ctx, words);
    if (round.stopped) return;
    track('game_phase_complete', { phase: 'speaking', is_daily: true });
    await views.renderQuiz(ctx, words);
    if (round.stopped) return;
    track('game_phase_complete', { phase: 'quiz', is_daily: true });

    const outcome = await engine.finishLevel(session, progress);
    progress = outcome.progress;
    track('game_daily_complete', {
      accuracy: Math.round(outcome.accuracy * 100),
      words: words.length,
    });
    await renderResult(outcome);
  }

  function renderWordDex(activeBucket) {
    const dex = root.GameWordDex.buildDex(pack, progress);
    const bucket = activeBucket || (dex.counts.weak ? 'weak' : (dex.counts.learning ? 'learning' : 'mastered'));
    const labels = {
      mastered: '已掌握 ' + dex.counts.mastered,
      learning: '学习中 ' + dex.counts.learning,
      weak: '易错 ' + dex.counts.weak,
      unseen: '未接触 ' + dex.counts.unseen,
    };
    const tabs = h('div', 'game-dex-tabs');
    ['mastered', 'learning', 'weak', 'unseen'].forEach(function (key) {
      const tab = button(
        'game-dex-tab' + (key === bucket ? ' game-dex-tab--active' : ''),
        labels[key],
        function () { renderWordDex(key); }
      );
      tabs.appendChild(tab);
    });

    const list = h('div', 'game-dex-list');
    const items = dex.buckets[bucket] || [];
    if (!items.length) {
      list.appendChild(h('p', 'game-dex-empty', '这一栏还没有词。'));
    } else {
      items.forEach(function (word) {
        const row = button('game-dex-item', '', function () { api.speak(word.lemma); });
        row.appendChild(h('strong', 'game-dex-lemma', word.lemma));
        row.appendChild(h('span', 'game-dex-zh', word.zh || ''));
        if (word.wrongCount) {
          row.appendChild(h('span', 'game-dex-meta', '错 ' + word.wrongCount + ' 次'));
        }
        list.appendChild(row);
      });
    }

    show(container, [
      h('h2', 'game-view-title', '单词图鉴'),
      h('p', 'game-dex-summary',
        '掌握 ' + dex.counts.mastered + ' / ' + dex.counts.total
        + ' · 点词可听发音'),
      tabs,
      list,
      button('game-btn', '回到地图', renderMap),
      homeLink(),
    ]);
  }

  async function renderResult(outcome) {
    const stats = outcome.statsResult;
    // Boss 打赢但正确率没过 90% 掌握线时(won 却没解锁部位),章节不前进——
    // 必须把差距说出来,不然玩家看着"过关!"却发现下一章没开,以为是 bug。
    const bossWonButNotMastered = outcome.bossStatus === 'won' && !outcome.unlockedPart;
    const title = outcome.isDaily ? '今日挑战完成!'
      : (outcome.bossStatus === 'lost' ? '再来一次!'
        : (bossWonButNotMastered ? '打赢了,但还没通关!' : '过关!'));
    const nodes = [
      h('h2', 'game-view-title', title),
    ];
    if (!outcome.isDaily && outcome.stars) {
      nodes.push(h('p', 'game-result-stars', '⭐'.repeat(outcome.stars)));
    }
    nodes.push(h('p', 'game-result-accuracy', '正确率 ' + Math.round(outcome.accuracy * 100) + '%'));
    if (outcome.isDaily) {
      nodes.push(h('p', 'game-result-hint', '明天再来打卡;也可打开单词图鉴复习易错词。'));
    }
    if (bossWonButNotMastered) {
      nodes.push(h('p', 'game-result-hint',
        '通关需要正确率达到 90%——再打一次 BOSS,错过的词多听多拼就能过!'));
    }
    if (stats) {
      nodes.push(h('p', 'game-result-xp', '+' + stats.xp_earned + ' XP'));
      nodes.push(h('p', 'game-result-streak', '🔥 连胜 ' + stats.current_streak + ' 天'));
    }
    const stageHost = h('div', 'game-stage');
    if (outcome.unlockedPart) nodes.push(stageHost);
    nodes.push(button('game-btn', '回到地图', renderMap));
    nodes.push(homeLink());
    show(container, nodes);

    if (!outcome.unlockedPart) return;
    // Three.js 只在真的要点亮部位时才下载,地图和局内都不加载。
    const module = await import('/js/game/character-stage.js');
    const stage = await module.createCharacterStage(stageHost, {
      unlockedParts: progress.unlockedParts,
      reducedMotion,
    });
    await stage.unlockPart(outcome.unlockedPart);
    if (outcome.characterComplete) await stage.playRevival();
  }

  async function renderCharacter() {
    const stageHost = h('div', 'game-stage');
    show(container, [
      h('h2', 'game-view-title', '我的伙伴'),
      stageHost,
      button('game-btn', '返回', renderMap),
      homeLink(),
    ]);
    const module = await import('/js/game/character-stage.js');
    await module.createCharacterStage(stageHost, {
      unlockedParts: progress.unlockedParts,
      reducedMotion,
    });
  }

  function homeLink() {
    const link = h('a', 'game-home game-home--block', '返回');
    bindHome(link);
    return link;
  }

  boot();
})(window);
