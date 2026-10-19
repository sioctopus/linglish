(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameViews = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 棋盘按实际词数算,不写死:buildBoard 从左上角起逐格填,格子多于 词数×2 会留下一片空白。
  // 规范 §4.1 的 6×4 是满局(12 词)尺寸,实际单局 8-10 词 → 4×4 或 5×4。
  const BOARD_COLS = 4;
  const LIANLIANKAN_MS = 90000;   // 规范 §4.1:单局限时 90 秒
  const COMBO_THRESHOLD = 3;      // 规范 §4.1:连续 3 次进 combo
  const SHAKE_MS = 500;           // 配错抖动 + 变灰的时长

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // 一切可点的东西都是真 <button>:键盘可达是验收项,<div onclick> 不可达。
  function button(className, text, onClick) {
    const node = h('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function show(container, nodes) {
    container.textContent = '';
    nodes.forEach(function (node) { container.appendChild(node); });
  }

  function viewHead(ctx, title, index, total) {
    const head = h('header', 'game-view-head');
    if (ctx && typeof ctx.leave === 'function') {
      head.appendChild(button('game-back', '返回地图', function () { ctx.leave(); }));
    }
    head.appendChild(h('h2', 'game-view-title', title));
    const step = h('p', 'game-step');
    if (total) step.textContent = (Number(index) + 1) + ' / ' + total;
    else step.hidden = true;
    head.appendChild(step);
    head.stepEl = step;
    return head;
  }

  function stillPlaying(ctx) {
    return !(ctx && typeof ctx.isStopped === 'function' && ctx.isStopped());
  }

  // 阅读卡快捷键:上下翻卡,空格播放或暂停。输入框里不抢键。
  function cardKeyAction(event) {
    if (!event) return null;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    if (event.key === 'ArrowUp') return 'prev';
    if (event.key === 'ArrowDown') return 'next';
    if (event.key === ' ' || event.code === 'Space') return 'toggle';
    return null;
  }

  let cardKeyHandler = null;
  function bindCardKeys(handler) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;
    if (cardKeyHandler) doc.removeEventListener('keydown', cardKeyHandler);
    cardKeyHandler = handler;
    if (handler) doc.addEventListener('keydown', handler);
  }

  // 重音后的关键音。顺序只在同一位置冲突时用，实际取音标里出现得更早的那个。
  const SOUND_TIPS = [
    ['eɪ', 'eɪ 从“诶”滑向“衣”'],
    ['aɪ', 'aɪ 从“啊”滑向“衣”'],
    ['ɔɪ', 'ɔɪ 从“奥”滑向“衣”'],
    ['aʊ', 'aʊ 从“啊”收向“乌”'],
    ['əʊ', 'əʊ 从轻声收向“欧”'],
    ['oʊ', 'oʊ 从“哦”收圆'],
    ['ɪə', 'ɪə 从短“衣”滑向轻声'],
    ['eə', 'eə 从“诶”滑向轻声'],
    ['ʊə', 'ʊə 圆唇后再放松'],
    ['iː', 'iː 嘴角拉开，把音拉长'],
    ['uː', 'uː 嘴唇收圆，把音拉长'],
    ['ɑː', 'ɑː 嘴张大，舌后缩，拉长'],
    ['ɔː', 'ɔː 嘴唇收圆，把音拉长'],
    ['ɜː', 'ɜː 嘴微张，舌中部抬起'],
    ['æ', 'æ 嘴张大，舌放平，比“哎”更开'],
    ['ɒ', 'ɒ 嘴张圆，舌往后收'],
    ['ʌ', 'ʌ 嘴半开，短促地发“啊”'],
    ['ɪ', 'ɪ 又短又松，不要发成“衣”'],
    ['ʊ', 'ʊ 嘴唇微圆，短促'],
    ['e', 'e 嘴半开，短促'],
    ['ə', 'ə 轻轻带过，嘴巴放松'],
    ['θ', 'θ 舌尖轻触齿间，只送气'],
    ['ð', 'ð 舌尖轻触齿间，声带要振动'],
    ['ʃ', 'ʃ 嘴唇前突，像轻轻的“虚”'],
    ['ʒ', 'ʒ 嘴唇前突，同时振动声带'],
    ['tʃ', 'tʃ 舌尖抵住再放开，像“吃”'],
    ['dʒ', 'dʒ 舌尖抵住再放开，像“知”'],
    ['ŋ', 'ŋ 舌根抵住软腭，气从鼻子出'],
  ];
  const VOWEL_NUCLEUS = /eɪ|aɪ|ɔɪ|aʊ|əʊ|oʊ|ɪə|eə|ʊə|iː|uː|ɑː|ɔː|ɜː|æ|ɑ|ɒ|ɔ|ʌ|ɪ|ʊ|ə|e/g;

  function pronunciationTip(ipa) {
    const body = String(ipa || '').replace(/[\/\s]/g, '');
    if (!body) return '';
    const stressAt = body.indexOf('ˈ');
    const stressed = stressAt >= 0 ? body.slice(stressAt + 1).split(/[ˈˌ.]/)[0] : body;
    let sound = '';
    let soundAt = -1;
    let soundLen = 0;
    SOUND_TIPS.forEach(function (pair) {
      const at = stressed.indexOf(pair[0]);
      if (at < 0) return;
      if (soundAt < 0 || at < soundAt || (at === soundAt && pair[0].length > soundLen)) {
        soundAt = at;
        soundLen = pair[0].length;
        sound = pair[1];
      }
    });
    let stress = '';
    if (stressAt >= 0) {
      const before = body.slice(0, stressAt);
      const nuclei = before.match(VOWEL_NUCLEUS);
      const index = (nuclei ? nuclei.length : 0) + 1;
      const label = ['一', '二', '三', '四', '五', '六'][index - 1] || String(index);
      stress = '重音在第' + label + '个音节';
    }
    if (stress && sound) return stress + ' · ' + sound;
    return stress || sound;
  }

  // 认词、跟读、拼写共用同一张词卡:左图右字,中文是标签,英文是主标题。
  function wordCard(word, options) {
    const settings = options || {};
    const card = h('article', 'game-card game-word-card');
    const row = h('div', 'game-word-row');
    const stage = h('div', 'game-word-stage');
    const copy = h('div', 'game-word-copy');
    const picture = photoArt(word, 'game-word-photo');
    if (picture) stage.appendChild(picture);
    else stage.appendChild(h('span', 'game-word-fallback', (word && word.emoji) || 'Aa'));
    if (settings.zh !== false && word && word.zh) copy.appendChild(h('p', 'game-word-zh', word.zh));
    if (settings.lemma !== false && word && word.lemma) {
      const lemma = h('p', 'game-word-lemma', word.lemma);
      if (settings.coach) lemma.classList.add('game-word-lemma--coach');
      copy.appendChild(lemma);
    }
    if (settings.ipa !== false && settings.lemma !== false && word && word.ipa) {
      copy.appendChild(h('p', 'game-word-ipa', word.ipa));
    }
    if (settings.coach && word && word.ipa) {
      const tip = pronunciationTip(word.ipa);
      if (tip) copy.appendChild(h('p', 'game-pronounce-tip', tip));
    }
    row.appendChild(stage);
    row.appendChild(copy);
    card.appendChild(row);
    return card;
  }

  // 词条插图:优先自托管 Twemoji SVG(CC-BY 4.0,fetch-twemoji.js 下载),
  // 无对应素材的条目(纯数字/序数)回退为文本 emoji。onerror 兜底防 404 裂图。
  const TWEMOJI_DIR = '/images/game/twemoji/';

  function emojiCode(emoji) {
    const cleaned = emoji.indexOf('‍') < 0 ? emoji.replace(/️/g, '') : emoji;
    const points = [];
    for (const ch of cleaned) points.push(ch.codePointAt(0).toString(16));
    return points.join('-');
  }

  function numberWords() {
    const host = typeof window !== 'undefined' ? window : globalThis;
    return host.GameNumberWords || null;
  }

  function digitFace(word) {
    return /^\d+$/.test(String(word && word.emoji || ''));
  }

  function art(word, className) {
    if (!word || !word.emoji) return null;
    // 数数卡直接画数字。大数没有对应照片，两位数字也用同一套字号，避免图面被裁空。
    if (digitFace(word)) {
      const face = String(word.emoji);
      const reader = numberWords();
      const shown = reader && face.length > 3 ? reader.group(Number(face)) : face;
      const node = h('span', className + ' game-word-fallback game-word-fallback--digits', shown);
      node.dataset.digits = String(Math.min(face.length, 16));
      return node;
    }
    // 字母卡用纯字符当图面,直接放大显示,不必走 Twemoji。
    if (/^[A-Za-z]{1,3}$/.test(word.emoji)) {
      return h('span', className + ' game-word-fallback', word.emoji);
    }
    const img = document.createElement('img');
    img.className = className;
    img.src = TWEMOJI_DIR + emojiCode(word.emoji) + '.svg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      // Twemoji 缺失时用文本 emoji,并挂上 fallback 类保证字号与闯关词卡一致。
      const fallback = h('span', className + ' game-word-fallback', word.emoji);
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    });
    return img;
  }

  // 真实照片词图(languageguide 式):有 photo 用照片,加载失败降级到 emoji 插图。
  // 最终必须留下可见节点,禁止空图区(主题卡空白就是这里删光了节点)。
  function photoArt(word, className) {
    if (digitFace(word)) return art(word, className.replace('photo', 'art'));
    if (!word || !word.photo) return art(word, className.replace('photo', 'art'));
    const img = document.createElement('img');
    img.className = className;
    img.src = word.photo;
    img.alt = word.zh || word.lemma || '';
    img.width = 640;
    img.height = 640;
    img.decoding = 'async';
    img.addEventListener('error', function () {
      const fallback = art(word, className.replace('photo', 'art'))
        || h('span', className.replace('photo', 'art') + ' game-word-fallback', (word && word.emoji) || 'Aa');
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    });
    return img;
  }

  // 学:整体场景图(languageguide 式)——全景常驻,脉冲标记跳到当前词的位置;
  // 词条无场景坐标时退回单词卡。点卡片播发音,同时把词加进服务端词库(SRS 跟踪)。
  function renderLearn(ctx, words) {
    return new Promise(function (resolve) {
      let index = 0;
      const hasScene = Boolean(ctx.scene) && words.some(function (w) { return w.spot; });
      const card = h('article', 'game-card game-word-card game-learn-card');
      const head = viewHead(ctx, '认识新词', 0, words.length);
      const next = button('game-btn', '下一个', function () {
        index += 1;
        if (index >= words.length) return finishLearn();
        paint();
      });

      let sceneBox = null;
      let marker = null;
      if (hasScene) {
        // 场景本身可点:点整幅图重播当前词发音,图不再是"点了没反应"的死区。
        sceneBox = button('game-scene', '', function () { ctx.api.speak(words[index].lemma); });
        sceneBox.setAttribute('aria-label', '点击场景重听当前单词发音');
        const img = document.createElement('img');
        img.className = 'game-scene__img';
        img.src = ctx.scene;
        img.alt = '';
        sceneBox.appendChild(img);
        marker = h('div', 'game-scene__marker');
        marker.setAttribute('aria-hidden', 'true');
        sceneBox.appendChild(marker);
      }

      const replay = button('game-icon-btn', '再听', function () {
        ctx.api.speak(words[index].lemma);
      });
      const actions = h('div', 'game-duo');
      actions.appendChild(replay);
      actions.appendChild(next);

      function paint() {
        const word = words[index];
        head.stepEl.textContent = (index + 1) + ' / ' + words.length;
        if (hasScene && word.spot) {
          marker.style.left = word.spot[0] + '%';
          marker.style.top = word.spot[1] + '%';
          marker.style.display = 'block';
          // 重挂类名重启脉冲动画,让视线跟着标记跳。
          marker.classList.remove('game-scene__marker--pulse');
          void marker.offsetWidth;
          marker.classList.add('game-scene__marker--pulse');
        } else if (marker) {
          marker.style.display = 'none';
        }
        const fresh = wordCard(word);
        show(card, Array.from(fresh.childNodes));
        next.textContent = index === words.length - 1 ? '开始游戏' : '下一个';
        ctx.api.speak(word.lemma);
        ctx.api.addWord(word.lemma);
      }

      if (typeof ctx.bindLeave === 'function') ctx.bindLeave(finishLearn);
      function finishLearn() {
        resolve();
      }

      // 场景图与词卡收进同一舞台,桌面端并排靠近,避免宽屏被撑成两端。
      const stage = h('div', 'game-learn-stage' + (hasScene ? ' game-learn-stage--scene' : ''));
      if (sceneBox) stage.appendChild(sceneBox);
      stage.appendChild(card);
      show(ctx.container, [head, stage, actions]);
      paint();
    });
  }

  // 连连看:英↔中配对。90 秒限时,连击 ≥3 进 combo,同一词第 2 次配错浮出中文提示。
  function renderLianliankan(ctx, words) {
    return new Promise(function (resolve) {
      const engine = window.GameLianliankan;
      const rows = Math.ceil((words.length * 2) / BOARD_COLS);
      let board = engine.buildBoard(words, { rows, cols: BOARD_COLS });
      let picked = null;
      let combo = 0;
      const missCount = {};

      const timerLabel = h('p', 'game-timer');
      const comboLabel = h('p', 'game-combo');
      const grid = h('div', 'game-board');
      const deadline = Date.now() + LIANLIANKAN_MS;
      const ticker = setInterval(function () {
        const left = Math.max(0, deadline - Date.now());
        timerLabel.textContent = Math.ceil(left / 1000) + ' 秒';
        if (left === 0) finish();
      }, 200);

      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(ticker);
        resolve();
      }
      let finished = false;
      if (typeof ctx.bindLeave === 'function') ctx.bindLeave(finish);

      function cellButton(cell) {
        const word = wordFor(cell.lemma);
        // 中文面带插图,配对变成「图意 ↔ 英文」而不止「译文 ↔ 英文」。
        const face = cell.face === 'en' ? cell.lemma : word.zh;
        const node = button('game-cell', face, function () { pick(cell); });
        if (cell.face === 'zh') {
          // 照片优先:emoji 是近似联想(desk 没有专属 emoji),照片才是准确图意。
          const picture = photoArt(word, 'game-cell__photo');
          if (picture) node.insertBefore(picture, node.firstChild);
        }
        node.dataset.cleared = String(cell.cleared);
        node.style.gridArea = (cell.row + 1) + ' / ' + (cell.col + 1);
        if (picked && picked.id === cell.id) node.dataset.picked = 'true';
        if (missCount[cell.lemma] >= 2 && cell.face === 'en') {
          node.appendChild(h('span', 'game-cell__hint', wordFor(cell.lemma).zh));
        }
        return node;
      }

      function wordFor(lemma) {
        return words.find(function (w) { return w.lemma === lemma; }) || { zh: '' };
      }

      function paint() {
        show(grid, board.cells.filter(function (c) { return !c.cleared; }).map(cellButton));
        comboLabel.textContent = combo >= COMBO_THRESHOLD ? 'COMBO ×' + combo : '';
        comboLabel.dataset.active = String(combo >= COMBO_THRESHOLD);
      }

      async function pick(cell) {
        if (!picked) { picked = cell; paint(); return; }
        if (picked.id === cell.id) { picked = null; paint(); return; }

        // 认对即消,不设经典连连看的两折连线门槛:被围住的词对会"配不上"
        // 且按答错记(combo 清零 + SRS 记错)——孩子认对了词却被路径规则惩罚。
        const matched = picked.lemma === cell.lemma && picked.face !== cell.face;
        const lemma = picked.lemma;
        if (matched) {
          board = engine.clearPair(board, picked.id, cell.id);
          combo += 1;
          ctx.api.speak(lemma);
          picked = null;
          paint();
          await ctx.commit({ lemma, gameType: engine.GAME_TYPE, isCorrect: true });
          if (engine.isBoardCleared(board)) finish();
          return;
        }

        combo = 0;
        missCount[lemma] = (missCount[lemma] || 0) + 1;
        grid.dataset.shake = 'true';
        setTimeout(function () { delete grid.dataset.shake; }, SHAKE_MS);
        picked = null;
        paint();
        await ctx.commit({ lemma, gameType: engine.GAME_TYPE, isCorrect: false });
      }

      const hud = h('div', 'game-hud');
      hud.appendChild(timerLabel);
      hud.appendChild(comboLabel);
      show(ctx.container, [viewHead(ctx, '单词连连看'), hud, grid]);
      paint();
    });
  }

  // 拼写工坊:不显示英文,TTS 发音就是题面。卡住 10 秒自动亮下一个字母。
  function renderSpelling(ctx, words) {
    const engine = window.GameSpelling;
    return words.reduce(function (chain, word, index) {
      return chain.then(function () {
        if (!stillPlaying(ctx)) return;
        return new Promise(function (resolve) {
          let challenge = engine.buildChallenge(word);
          const slots = h('p', 'game-spell-slots');
          const tiles = h('div', 'game-tiles');
          let hintTimer = setTimeout(hint, engine.HINT_DELAY_MS);
          if (typeof ctx.bindLeave === 'function') {
            ctx.bindLeave(function () {
              clearTimeout(hintTimer);
              resolve();
            });
          }

          function hint() {
            challenge = engine.revealHint(challenge);
            afterChange();
          }

          function afterChange() {
            clearTimeout(hintTimer);
            if (engine.isComplete(challenge)) return done(false);
            hintTimer = setTimeout(hint, engine.HINT_DELAY_MS);
            paint();
          }

          async function done(timedOut) {
            clearTimeout(hintTimer);
            const scored = engine.scoreChallenge(challenge, { timedOut });
            await ctx.commit({
              lemma: challenge.lemma,
              gameType: engine.GAME_TYPE,
              isCorrect: scored.tier === 'perfect',
            });
            resolve();
          }

          function paint() {
            slots.textContent = challenge.filled
              .map(function (id) {
                return challenge.tiles.find(function (t) { return t.id === id; }).letter;
              })
              .join(' ') || '_ '.repeat(challenge.lemma.length);
            show(tiles, challenge.tiles
              .filter(function (tile) { return !challenge.filled.includes(tile.id); })
              .map(function (tile) {
                return button('game-tile', tile.letter, function () {
                  const result = engine.placeTile(challenge, tile.id);
                  if (!result.accepted) {
                    tiles.dataset.shake = 'true';
                    setTimeout(function () { delete tiles.dataset.shake; }, SHAKE_MS);
                    return;
                  }
                  challenge = result.challenge;
                  afterChange();
                });
              }));
          }

          const card = wordCard(word, { lemma: false, ipa: false });
          card.appendChild(button('game-play', '播放发音', function () { ctx.api.speak(word.lemma); }));
          show(ctx.container, [
            viewHead(ctx, '拼写工坊', index, words.length),
            card,
            slots,
            tiles,
          ]);
          ctx.api.speak(word.lemma);
          paint();
        });
      });
    }, Promise.resolve());
  }

  // 跟读:听标准音 → 按住说 → Web Speech 识别比对。无麦克风权限时允许跳过,不记错。
  function renderSpeak(ctx, words) {
    const engine = window.GameSpeaking;
    const Recognition = engine.getSpeechRecognition(window);
    return words.reduce(function (chain, word, index) {
      return chain.then(function () {
        if (!stillPlaying(ctx)) return;
        return new Promise(function (resolve) {
          let settled = false;
          let recognition = null;
          let micBtn = null;
          const card = wordCard(word);
          const status = h('p', 'game-speak-status', Recognition
            ? '听一遍，再大声跟读'
            : '当前浏览器不支持语音识别，可听读后跳过');
          const heard = h('p', 'game-speak-heard');

          async function finish(isCorrect, note) {
            if (settled) return;
            settled = true;
            if (micBtn) micBtn.dataset.listening = 'false';
            if (isCorrect === true) card.dataset.state = 'ok';
            if (isCorrect === false) card.dataset.state = 'miss';
            if (recognition) {
              try { recognition.stop(); } catch (_) { /* ignore */ }
            }
            if (note) status.textContent = note;
            if (isCorrect !== null) {
              await ctx.commit({
                lemma: word.lemma,
                gameType: engine.GAME_TYPE,
                isCorrect: Boolean(isCorrect),
              });
            }
            const wait = isCorrect === true ? 420 : 0;
            setTimeout(resolve, wait);
          }

          function startListening() {
            if (settled || !Recognition) return;
            micBtn.dataset.listening = 'true';
            status.textContent = '正在听你说…';
            heard.textContent = '';
            recognition = new Recognition();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            recognition.maxAlternatives = 3;
            recognition.onresult = function (event) {
              const transcript = Array.from(event.results || [])
                .map(function (result) { return result[0] && result[0].transcript; })
                .filter(Boolean)
                .join(' ');
              const graded = engine.gradeTranscript(word.lemma, transcript);
              heard.textContent = graded.heard ? ('识别: ' + graded.heard) : '没有听清';
              if (graded.isCorrect) {
                status.textContent = '说对了!';
                finish(true);
              } else {
                status.textContent = '再试一次,或跳过';
              }
            };
            recognition.onerror = function () {
              micBtn.dataset.listening = 'false';
              status.textContent = '没听清,再试一次或跳过';
            };
            recognition.onend = function () {
              if (!settled) status.textContent = status.textContent || '说完了?再按一次继续';
            };
            try {
              recognition.start();
            } catch (_) {
              micBtn.dataset.listening = 'false';
              status.textContent = '麦克风忙,稍后再试或跳过';
            }
          }

          micBtn = button(
            'game-btn game-btn--speak',
            Recognition ? '开始跟读' : '无法跟读',
            startListening
          );
          micBtn.disabled = !Recognition;
          if (typeof ctx.bindLeave === 'function') {
            ctx.bindLeave(function () {
              if (settled) return;
              settled = true;
              if (recognition) {
                try { recognition.stop(); } catch (_) { /* ignore */ }
              }
              resolve();
            });
          }

          const actions = h('div', 'game-duo');
          actions.appendChild(button('game-icon-btn', '播放', function () { ctx.api.speak(word.lemma); }));
          actions.appendChild(micBtn);
          show(ctx.container, [
            viewHead(ctx, '开口跟读', index, words.length),
            card,
            status,
            heard,
            actions,
            button('game-btn game-btn--quiet', '跳过', function () { finish(null, '已跳过'); }),
          ]);
          ctx.api.speak(word.lemma);
        });
      });
    }, Promise.resolve());
  }

  // 速答:4 选 1,每题 3 秒;超时按答错记。Boss 关复用同一个引擎。
  function askQuestion(ctx, word, pool, title, step) {
    const engine = window.GameQuiz;
    return new Promise(function (resolve) {
      const question = engine.buildQuestion(word, pool);
      const bar = h('div', 'game-countdown');
      const timer = setTimeout(function () { answer(-1); }, engine.TIME_PER_QUESTION_MS);
      let settled = false;
      if (typeof ctx.bindLeave === 'function') {
        ctx.bindLeave(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ isCorrect: false, abandoned: true });
        });
      }

      async function answer(index) {
        // 触屏双击会连开两枪:两次 commit、一次错扣两盾。答一次就锁死。
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const graded = engine.gradeAnswer(question, index);
        await ctx.commit({
          lemma: question.lemma,
          gameType: engine.GAME_TYPE,
          isCorrect: graded.isCorrect,
        });
        resolve(graded);
      }

      show(ctx.container, [
        step ? viewHead(ctx, title, step.index, step.total) : viewHead(ctx, title),
        bar,
        wordCard(word, { zh: false }),
        h('p', 'game-quiz-hint', '选出对应的中文'),
        h('div', 'game-options'),
      ]);
      const options = ctx.container.querySelector('.game-options');
      question.options.forEach(function (option, index) {
        options.appendChild(button('game-btn game-btn--option', option, function () { answer(index); }));
      });
      bar.style.animationDuration = engine.TIME_PER_QUESTION_MS + 'ms';
    });
  }

  function renderQuiz(ctx, words) {
    return words.reduce(function (chain, word, index) {
      return chain.then(function () {
        if (!stillPlaying(ctx)) return;
        return askQuestion(ctx, word, words, '限时速答', { index: index, total: words.length });
      });
    }, Promise.resolve());
  }

  // Boss:每轮问 engine 要一批词(自动偏向错词),血量护盾从实时 session 读。
  async function renderBoss(ctx, nextWords, chapterWords) {
    let round = nextWords(1);
    while (round.length > 0) {
      const state = ctx.session().boss;
      const hp = h('p', 'game-boss-hp', '❤️ ' + state.hp + ' / ' + state.maxHp);
      const shields = h('p', 'game-boss-shields', '🛡 '.repeat(Math.max(0, state.shields)));
      show(ctx.container, [hp, shields]);
      await askQuestion(ctx, round[0], chapterWords, 'BOSS 战');
      if (!stillPlaying(ctx)) return;
      if (window.GameBoss.bossOutcome(ctx.session().boss).status !== 'ongoing') return;
      round = nextWords(1);
    }
  }

  // 主题词卡:点图或播放听发音。↑上一张,↓下一张,空格播放/暂停。
  // 货币卡先选币种,再翻面值听金额。
  function renderCardDeck(ctx, deck) {
    return new Promise(function (resolve) {
      const groups = Array.isArray(deck && deck.groups) ? deck.groups.filter(function (group) {
        return group && Array.isArray(group.words) && group.words.length;
      }) : [];
      const currencyDeck = Boolean(deck && deck.id === 'currencies' && groups.length);
      let groupIndex = 0;
      let words = currencyDeck
        ? groups[0].words.slice()
        : (Array.isArray(deck && deck.words) ? deck.words : []);
      let index = 0;
      const head = viewHead(ctx, (deck && deck.label) || '单词卡片', 0, words.length || 1);
      const cardHost = h('div', 'game-card-host');
      const status = h('p', 'game-speak-status', '↑↓ 翻卡，空格播放或暂停');
      const reader = numberWords();
      const numberDeck = Boolean(reader) && deck && deck.id === 'numbers';
      let custom = null;
      let placeStep = 0;
      let placeBar = null;
      let currencyBar = null;
      let amountBar = null;
      let numberInput = null;

      function syncPlaces() {
        if (!placeBar) return;
        const current = custom ? custom.n : null;
        Array.prototype.forEach.call(placeBar.children, function (chip) {
          const unit = Number(chip.dataset.n);
          chip.setAttribute('aria-pressed', String(placeStep > 0 && unit === placeStep));
        });
        if (numberInput && current != null) numberInput.value = String(current);
      }

      function syncCurrencyBars() {
        if (currencyBar) {
          Array.prototype.forEach.call(currencyBar.children, function (chip, chipIndex) {
            chip.setAttribute('aria-pressed', String(chipIndex === groupIndex));
          });
        }
        if (!amountBar) return;
        show(amountBar, words.map(function (word, wordIndex) {
          const chip = button(
            'game-number-place',
            word.zh || String(word.amount || wordIndex + 1),
            function () {
              custom = null;
              index = wordIndex;
              paint();
            }
          );
          chip.dataset.index = String(wordIndex);
          chip.setAttribute('aria-pressed', String(wordIndex === index && !custom));
          return chip;
        }));
      }

      function finish() {
        bindCardKeys(null);
        if (ctx.api && typeof ctx.api.setSpeakIdle === 'function') ctx.api.setSpeakIdle(null);
        resolve();
      }
      if (typeof ctx.bindLeave === 'function') ctx.bindLeave(finish);

      function markPlaying() { play.textContent = '暂停'; }
      function markIdle() { play.textContent = '播放'; }

      function playWord(lemma) {
        markPlaying();
        ctx.api.speak(lemma);
      }

      async function toggleWord() {
        const word = custom || words[index];
        if (!word) return;
        if (typeof ctx.api.toggleSpeak === 'function') {
          const state = await ctx.api.toggleSpeak(word.lemma);
          if (state === 'playing') markPlaying();
          else markIdle();
          return;
        }
        playWord(word.lemma);
      }

      function go(step) {
        if (numberDeck && custom && placeStep > 0) {
          const unit = placeStep;
          let next = custom.n + step * unit;
          const top = Math.floor(999999999999999 / unit) * unit;
          if (next < unit) next = top;
          else if (next > top) next = unit;
          showAmount(next);
          return;
        }
        if (!words.length) return;
        custom = null;
        placeStep = 0;
        index = (index + step + words.length) % words.length;
        paint();
      }

      function selectCurrency(nextIndex) {
        if (!currencyDeck || !groups[nextIndex]) return;
        groupIndex = nextIndex;
        words = groups[groupIndex].words.slice();
        index = 0;
        custom = null;
        paint();
      }

      function selectPlace(unit) {
        placeStep = unit;
        showAmount(unit);
      }

      function showAmount(raw) {
        if (!reader) return;
        const word = reader.read(raw);
        if (!word) {
          status.textContent = '请输入 1 到 15 位数字。';
          return;
        }
        custom = word;
        if (!(placeStep > 0)) placeStep = 1;
        paint();
      }

      function onKey(event) {
        const action = cardKeyAction(event);
        if (!action) return;
        event.preventDefault();
        if (action === 'prev') go(-1);
        else if (action === 'next') go(1);
        else toggleWord();
      }

      function paint() {
        if (!words.length) {
          show(cardHost, [h('p', 'game-dex-empty', '这个分类还没有词卡。')]);
          return;
        }
        const word = custom || words[index];
        head.stepEl.hidden = false;
        if (currencyDeck) {
          const group = groups[groupIndex];
          head.stepEl.textContent = (group && group.label ? group.label + ' · ' : '') + (index + 1) + ' / ' + words.length;
        } else {
          head.stepEl.textContent = custom ? '读大数' : ((index + 1) + ' / ' + words.length);
        }
        syncPlaces();
        syncCurrencyBars();
        const card = wordCard(word, { coach: true });
        card.classList.add('game-theme-card');
        if (numberDeck) card.classList.add('game-number-card');
        if (currencyDeck) card.classList.add('game-currency-card');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', '播放 ' + word.lemma);
        card.addEventListener('click', function () { playWord(word.lemma); });
        show(cardHost, [card]);
        playWord(word.lemma);
        if (!custom && typeof ctx.api.addWord === 'function') ctx.api.addWord(word.lemma);
      }

      const play = button('game-icon-btn', '播放', function () { toggleWord(); });
      play.setAttribute('aria-keyshortcuts', 'Space');
      const next = button('game-btn', '下一张', function () { go(1); });
      next.setAttribute('aria-keyshortcuts', 'ArrowDown');
      const prev = button('game-btn game-btn--quiet', '上一张', function () { go(-1); });
      prev.setAttribute('aria-keyshortcuts', 'ArrowUp');
      const actions = h('div', 'game-duo game-card-nav');
      actions.appendChild(prev);
      actions.appendChild(play);
      actions.appendChild(next);

      if (ctx.api && typeof ctx.api.setSpeakIdle === 'function') {
        ctx.api.setSpeakIdle(function () { markIdle(); });
      }
      bindCardKeys(onKey);
      const layout = [head];
      if (currencyDeck) {
        currencyBar = h('div', 'game-number-places game-currency-places');
        currencyBar.setAttribute('role', 'group');
        currencyBar.setAttribute('aria-label', '选择币种');
        groups.forEach(function (group, chipIndex) {
          const chip = button('game-number-place', group.label, function () { selectCurrency(chipIndex); });
          chip.setAttribute('aria-pressed', String(chipIndex === groupIndex));
          currencyBar.appendChild(chip);
        });
        amountBar = h('div', 'game-number-places game-currency-amounts');
        amountBar.setAttribute('role', 'group');
        amountBar.setAttribute('aria-label', '选择面值');
        layout.push(currencyBar, amountBar);
        status.textContent = '先选币种，再点面值听金额。↑↓ 翻面值，空格播放或暂停。';
      }
      if (numberDeck) {
        placeBar = h('div', 'game-number-places');
        placeBar.setAttribute('role', 'group');
        placeBar.setAttribute('aria-label', '数位读法');
        reader.places.forEach(function (place) {
          const chip = button('game-number-place', place.zh, function () { selectPlace(place.n); });
          chip.dataset.n = String(place.n);
          chip.title = place.zh;
          chip.setAttribute('aria-pressed', 'false');
          placeBar.appendChild(chip);
        });
        const readRow = h('form', 'game-number-read');
        numberInput = document.createElement('input');
        numberInput.type = 'text';
        numberInput.inputMode = 'numeric';
        numberInput.maxLength = 19;
        numberInput.placeholder = '输入数字，听读法';
        numberInput.setAttribute('aria-label', '输入要读的数字');
        const readBtn = button('game-btn', '读', function () {});
        readBtn.type = 'submit';
        readRow.appendChild(numberInput);
        readRow.appendChild(readBtn);
        readRow.addEventListener('submit', function (event) {
          event.preventDefault();
          placeStep = 1;
          showAmount(numberInput.value);
        });
        layout.push(placeBar, readRow);
        status.textContent = '点百后再下一张：100→200→300。点十则 10→20→30。输入数字后按 1 递增。';
      }
      layout.push(cardHost, status, actions);
      show(ctx.container, layout);
      paint();
    });
  }

  return {
    h,
    button,
    show,
    renderLearn,
    renderSpeak,
    renderLianliankan,
    renderSpelling,
    renderQuiz,
    renderBoss,
    renderCardDeck,
    cardKeyAction,
    pronunciationTip,
  };
});
