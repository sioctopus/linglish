
    // 返回桌面端首页
    function goBack() {
      window.location.href = './index-desktop.html';
    }

    function getYouTubeOrigin() {
      if (window.location.origin && window.location.origin !== 'null') {
        return window.location.origin;
      }
      if (window.location.protocol && window.location.host) {
        return `${window.location.protocol}//${window.location.host}`;
      }
      return '';
    }

    // ==================== Anti-Flicker Overlay Helper ====================
    // Debounce overlay display changes to prevent flickering
    let overlayDisplayPending = null;
    let lastOverlayChange = 0;
    const OVERLAY_DEBOUNCE_MS = 100;

    function setOverlayDisplay(overlay, display) {
      if (!overlay) return;
      const now = Date.now();
      if (now - lastOverlayChange < OVERLAY_DEBOUNCE_MS) {
        // Debounce rapid changes
        if (overlayDisplayPending) clearTimeout(overlayDisplayPending);
        overlayDisplayPending = setTimeout(() => {
          overlay.style.display = display;
          lastOverlayChange = Date.now();
          overlayDisplayPending = null;
        }, OVERLAY_DEBOUNCE_MS);
        return;
      }
      overlay.style.display = display;
      lastOverlayChange = now;
    }

    // ==================== Practice Mode Management ====================
    const PRACTICE_MODE_STORAGE_KEY = 'linglish_practice_mode';
    const THEME_STORAGE_KEY = 'linglish_theme';

    function loadPracticeModePreference() {
      try {
        const saved = localStorage.getItem(PRACTICE_MODE_STORAGE_KEY);
        if (saved === 'shadowing' || saved === 'dialogue') {
          return saved;
        }
      } catch (_) { }
      return null;
    }

    function savePracticeModePreference(mode) {
      try {
        localStorage.setItem(PRACTICE_MODE_STORAGE_KEY, mode);
      } catch (_) { }
    }

    function getPracticePageParams() {
      try {
        return new URLSearchParams(window.location.search || '');
      } catch (_) {
        return new URLSearchParams('');
      }
    }

    function isQuickFirstLesson() {
      const params = getPracticePageParams();
      return params.get('quick') === '1' || params.get('from') === 'today_first_lesson';
    }

    function getQuickFirstLessonLimit() {
      const parsed = Number(getPracticePageParams().get('lines') || 3);
      if (!Number.isFinite(parsed) || parsed <= 0) return 3;
      return Math.max(1, Math.min(5, Math.round(parsed)));
    }

    const FIRST_LESSON_COMPLETION_KEY = 'linglish_first_lesson_completion';

    function getLocalDateKey() {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    function markQuickFirstLessonComplete(lines, averageScore) {
      if (!isQuickFirstLesson()) return;
      const videoId = state.videoId || getPracticePageParams().get('videoId') || null;
      const payload = {
        date: getLocalDateKey(),
        completed_at: new Date().toISOString(),
        video_id: videoId,
        lines: Number(lines) || getQuickFirstLessonLimit(),
        target_lines: getQuickFirstLessonLimit(),
        average_score: averageScore,
        source: 'practice-session-desktop',
      };
      try {
        localStorage.setItem(FIRST_LESSON_COMPLETION_KEY, JSON.stringify(payload));
      } catch (_) { }
    }

    function selectQuickFirstLessonSentences(sentences) {
      const source = Array.isArray(sentences) ? sentences : [];
      const limit = getQuickFirstLessonLimit();
      const preferred = source.filter((sentence) => {
        const text = String(sentence?.text || '').trim();
        const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
        const start = Number(sentence?.startTime ?? sentence?.start ?? 0);
        const end = Number(sentence?.endTime ?? sentence?.end ?? start);
        const duration = end - start;
        return wordCount >= 3 && (!Number.isFinite(duration) || duration <= 9);
      });
      return (preferred.length >= Math.min(limit, source.length) ? preferred : source).slice(0, limit);
    }

    function getInitialPracticeMode() {
      if (isQuickFirstLesson()) return 'shadowing';
      const requestedMode = getPracticePageParams().get('mode');
      if (requestedMode === 'shadowing' || requestedMode === 'dialogue') return requestedMode;
      return loadPracticeModePreference() || 'shadowing';
    }

    let currentPracticeMode = getInitialPracticeMode(); // shadowing or dialogue

    function buildPracticeVideoHref(videoId) {
      const previous = getPracticePageParams();
      const params = new URLSearchParams({ videoId: String(videoId), mode: currentPracticeMode });
      for (const key of ['from', 'quick', 'lines', 'level', 'desktop']) {
        if (previous.has(key)) params.set(key, previous.get(key));
      }
      return `?${params.toString()}`;
    }

    function loadThemePreference() {
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') return saved;
      } catch (_) { }
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
      return 'light';
    }

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-theme', theme);
    }

    function saveThemePreference(theme) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch (_) { }
    }

    // Shadowing mode state
    let shadowingCurrentIndex = 0; // Current sentence index for shadowing
    let shadowingSentences = []; // All sentences for shadowing
    let shadowingAutoPauseListener = null; // Video timeupdate listener
    let shadowingProgressTimer = null; // Fallback polling timer for YouTube/HTML5
    let shadowingPlaybackGuard = null;

    function createShadowingPlaybackGuard(sentence, requiresSeek = true) {
      shadowingPlaybackGuard = window.LinglishOriginalAudioReplay.createSegmentPlaybackGuard({
        start: Number(sentence.startTime), end: Number(sentence.endTime), requiresSeek
      });
      return shadowingPlaybackGuard;
    }

    function canFinishShadowingPlayback(time, endPoint = shadowingTargetEndTime) {
      return shadowingPlaybackGuard && !shadowingSentenceEnded &&
        shadowingPlaybackGuard.acceptTime(time) && time >= endPoint;
    }
    let shadowingYouTubePauseInterval = null; // YouTube pause watchdog (legacy cleanup)
    let shadowingSentenceEnded = false; // Guard to avoid double-end
    let shadowingTargetEndTime = null; // Natural sentence end time
    let shadowingStopIndex = null; // Last segment index included in current sentence
    let shadowingLastStopIndex = null; // Index that produced shadowingLastStopTime
    let shadowingLastStopTime = null; // Actual paused time (can overshoot target slightly)
    let shadowingAutoMode = false; // Whether auto mode is active
    let shadowingWaitingTimeout = null; // Timeout for waiting period

    function computeShadowingTargetEndTime(sentenceIndex) {
      const sentence = shadowingSentences[sentenceIndex];
      if (!sentence) return 0;

      const segMode = getSegmentationMode();
      const baseEndTime = Number(sentence.endTime);
      const startTime = Number(sentence.startTime);
      const text = sentence.text || '';

      // In caption mode, follow subtitle line timings but add small buffer for edge cases.
      if (segMode === 'caption') {
        const nextSentence = shadowingSentences[sentenceIndex + 1];
        const nextStartTime = nextSentence ? Number(nextSentence.startTime ?? nextSentence.start ?? Infinity) : Infinity;
        const hasNext = Number.isFinite(nextStartTime);
        const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;

        // 根据句子时长动态计算缓冲时间和允许的重叠
        // YouTube 字幕时间戳往往不够精确，实际说完最后一个词需要额外时间
        const duration = baseEndTime - startTime;

        // Caption 模式：缓冲根据时长计算
        // 缓冲 = 时长的 15%，最少 0.3 秒，最多 0.6 秒
        const dynamicBuffer = Math.min(0.6, Math.max(0.3, duration * 0.15));

        // 如果下一句紧接着（间隔 < 0.3 秒），允许进入下一句最多 0.4 秒
        // 确保最后一个词能完整播放
        if (gapToNext < 0.3) {
          return Math.min(baseEndTime + dynamicBuffer, nextStartTime + 0.4);
        }

        // 有间隔的句子：播放到结束时间 + 缓冲，但不超过下一句开始
        const maxEnd = hasNext ? nextStartTime : baseEndTime + 1;
        return Math.min(baseEndTime + dynamicBuffer, maxEnd);
      }

      // Count words in the sentence
      const wordCount = (text.match(/\b[\w']+\b/g) || []).length;

      // Calculate minimum duration based on speaking rate
      // Average speaking rate is ~150 words per minute = 2.5 words per second
      // So minimum ~0.4 seconds per word for natural speech
      const MIN_SECONDS_PER_WORD = 0.45;
      const minDuration = wordCount * MIN_SECONDS_PER_WORD;

      // Calculate actual duration from timing
      const actualDuration = baseEndTime - startTime;
      const nextSentence = shadowingSentences[sentenceIndex + 1];
      const nextStartTime = nextSentence ? Number(nextSentence.startTime ?? nextSentence.start ?? Infinity) : Infinity;

      // We want to add a tail buffer to ensure the last word is fully audible.
      // YouTube字幕经常在句子中间切断，需要更大的缓冲时间让最后几个词播放完整
      // BUT we must absolutely prevent overlapping into the next sentence.
      // Strategy: Add tail buffer, but CLAMP it to be at least 0.05s before the next sentence starts.

      const safetyGap = 0.05;
      // Some caption sources produce perfectly contiguous timestamps (nextStart === baseEnd).
      // In that case, clamping to `nextStart - safetyGap` yields zero tail buffer and cuts the last word.
      // Allow a small overlap tail; we always re-seek to the next sentence start, so the overlap becomes
      // a tiny replay rather than missing audio.
      const OVERLAP_TAIL_SEC = 0.22;
      const hasNext = Number.isFinite(nextStartTime);
      const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;
      const maxPossibleEnd = (hasNext && gapToNext <= safetyGap)
        ? (nextStartTime + OVERLAP_TAIL_SEC)
        : (nextStartTime - safetyGap);

      // 增加缓冲时间：基础 0.8 秒，长句子额外 0.3 秒
      // 这样可以确保 "Lucy", "Expressions" 等句尾词能完整播放
      const baseTail = 0.8;
      const extraTail = wordCount > 10 ? 0.3 : (wordCount > 6 ? 0.15 : 0);
      const desiredTarget = baseEndTime + baseTail + extraTail;

      // Clamp
      const finalTarget = Math.min(desiredTarget, maxPossibleEnd);

      // Ensure we at least play until baseEndTime (if next sentence allows).
      // If next sentence starts BEFORE baseEndTime (bad data), we just stop at nextStartTime.
      return Math.max(baseEndTime, finalTarget);
    }

    function computeShadowingSeekTime(sentenceIndex) {
      const sentence = shadowingSentences[sentenceIndex];
      if (!sentence) return 0;

      // Strict seek to start time.
      // This resets any drift or overshoot from the previous sentence.
      return Number(sentence.startTime ?? sentence.start ?? 0);
    }

    // Reading mode state - REMOVED (reading mode has been removed)

    // Mode descriptions
    const modeMeta = {
      shadowing: {
        description: '跟读模式：跟随原声同步朗读，系统自动停顿让你接着说',
        hint: '跟读：听原声 → 同步朗读 → 自动停顿',
        steps: [
          { title: '节奏', text: '自动播放→遇到你的句子暂停 3 秒→继续下一句' },
          { title: '如何练', text: '耳朵跟原声，嘴巴同步，先保证节奏再注意咬字' },
          { title: '适合谁', text: '热身、上手最快的模式，像播客/视频跟读工具' }
        ],
        header: {
          icon: '👥',
          title: '跟读模式',
          subtitle: '自动暂停 3 秒让你跟读，然后继续',
          tags: ['节奏辅助', '免手动操作']
        }
      },
      dialogue: {
        description: '对话模式：扮演角色，系统在你的台词前自动停顿并录音',
        hint: '对话：角色轮换 → 麦克风录音 → 自动评分',
        steps: [
          { title: '流程', text: '选角色→系统在你的台词前停顿→录完自动下一句' },
          { title: '技巧', text: '开启严格轮换或交换起点，保持对话节奏自然' },
          { title: '适合谁', text: '情景对话、口语考试角色扮演、面试模拟' }
        ],
        header: {
          icon: '🎭',
          title: '对话模式',
          subtitle: '扮演角色，系统在你的台词前自动停顿录音',
          tags: ['角色扮演', '自动停顿', '多角色']
        }
      }
    };

    function applyModeMeta(mode) {
      const meta = modeMeta[mode] || {};
      const quickMode = isQuickFirstLesson() && mode === 'shadowing';

      // Update description
      const descEl = document.getElementById('mode-description');
      if (descEl) descEl.textContent = quickMode
        ? `3 分钟首课：最多 ${getQuickFirstLessonLimit()} 句，完成后回到 Today 继续。`
        : (meta.description || '');

      const hintEl = document.getElementById('mode-top-hint');
      if (hintEl) hintEl.textContent = quickMode
        ? '首课：听一句，跟读一句，再回到今日训练。'
        : (meta.hint || meta.description || '');

      // Update quick steps
      const stepsEl = document.getElementById('mode-quick-steps');
      if (stepsEl) {
        const steps = quickMode
          ? [
            { title: '时长', text: `最多 ${getQuickFirstLessonLimit()} 句，适合第一次开口` },
            { title: '目标', text: '先完成，不追求一次完美' },
            { title: '完成后', text: '回到 Today 看下一步训练建议' }
          ]
          : (Array.isArray(meta.steps) ? meta.steps : []);
        stepsEl.innerHTML = steps.map(step => `
          <div class="mode-quick-step">
            <div class="step-title">${step.title || ''}</div>
            <div class="step-text">${step.text || ''}</div>
          </div>
        `).join('');
      }

      // Update live header (only visible after开始练习)
      const headerEl = document.getElementById('mode-live-header');
      const controlsContainer = document.getElementById('desktop-controls-container');
      const controlsVisible = controlsContainer && controlsContainer.style.display !== 'none';
      if (headerEl) {
        const iconEl = document.getElementById('mode-live-icon');
        const titleEl = document.getElementById('mode-live-title');
        const subEl = document.getElementById('mode-live-subtitle');
        const tagsEl = document.getElementById('mode-live-tags');
        if (iconEl) iconEl.textContent = (meta.header && meta.header.icon) || '🎯';
        if (titleEl) titleEl.textContent = (meta.header && meta.header.title) || '练习模式';
        if (subEl) subEl.textContent = (meta.header && meta.header.subtitle) || '';
        if (tagsEl) {
          const tags = (meta.header && meta.header.tags) || [];
          tagsEl.innerHTML = tags.map(tag => `<span class="mode-live-tag">${tag}</span>`).join('');
        }
        headerEl.style.display = controlsVisible ? 'flex' : 'none';
      }
    }

    function applyModeVisualState(mode) {
      document.body.classList.toggle('mode-shadowing', mode === 'shadowing');
      document.body.classList.toggle('mode-dialogue', mode === 'dialogue');
      renderPracticeLines();
    }

    function syncPracticeModeUrl(mode, historyMode) {
      if (historyMode === 'skip') return;
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('mode') === mode) return;
        url.searchParams.set('mode', mode);
        history.pushState({ studyMode: mode }, '', url);
      } catch (_) {}
    }

    // Switch practice mode
    function switchPracticeMode(mode, options) {
      if (isQuickFirstLesson()) {
        mode = 'shadowing';
      }
      if (currentPracticeMode === 'shadowing' && mode !== 'shadowing') pauseAutoShadowing();
      currentPracticeMode = mode;
      document.title = `${mode === 'shadowing' ? '跟读练习' : '对话练习'}（桌面版） - Linglish`;
      if (mode !== 'dialogue') {
        setDialogueFocusLayout(false);
      }
      if (mode !== 'shadowing' && document.body.classList.contains('immersive-active')) {
        document.body.classList.remove('immersive-active');
      }
      syncPracticeFocusChrome();
      if (!isShareMode() && !isQuickFirstLesson()) {
        savePracticeModePreference(mode);
      }

      // Update tab active state
      document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
        tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
      });
      document.querySelectorAll('.mode-demo-card').forEach(card => {
        card.classList.toggle('active', card.dataset.demo === mode);
      });

      applyModeMeta(mode);
      applyModeVisualState(mode);
      const studySwitch = document.getElementById('study-switch');
      if (studySwitch) {
        const current = mode === 'dialogue' ? 'arena' : 'coach';
        studySwitch.querySelectorAll('[data-study]').forEach((link) => {
          if (link.dataset.study === current) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        });
      }
      const brandTitle = document.getElementById('coach-brand-title');
      const brandNote = document.getElementById('coach-brand-note');
      if (brandTitle) brandTitle.textContent = mode === 'dialogue' ? '实战场' : 'AI陪练';
      if (brandNote) brandNote.textContent = mode === 'dialogue' ? '选一段内容，扮演着说' : '选一段内容，听一句跟着说';

      const shadowingControls = document.getElementById('shadowing-controls');
      const dialogueControls = document.getElementById('dialogue-controls');
      document.body.classList.remove('mode-transitioning');

      if (shadowingControls && dialogueControls) {
        const showShadowing = mode === 'shadowing';
        shadowingControls.style.display = showShadowing ? 'block' : 'none';
        dialogueControls.style.display = showShadowing ? 'none' : 'block';
        shadowingControls.classList.toggle('active', showShadowing);
        dialogueControls.classList.toggle('active', !showShadowing);
      }

      const controlsContainer = document.getElementById('desktop-controls-container');
      if (controlsContainer) controlsContainer.style.display = 'block';
      const startLabel = document.querySelector('#start-practice-btn .btn-text');
      const startButton = document.getElementById('start-practice-btn');
      if (startLabel && startButton && !startButton.hidden) {
        startLabel.textContent = mode === 'dialogue' ? '开始对话' : '开始跟读';
      }
      syncPracticeModeUrl(mode, options && options.history);

      // Reset states based on mode
      if (mode === 'shadowing') {
        // Shadowing mode: continuous playback, no recording
        if (videoPlayer) videoPlayer.playbackRate = 1;
      } else {
        // Clean up shadowing mode when switching away
        if (shadowingAutoPauseListener && videoPlayer) {
          videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
          shadowingAutoPauseListener = null;
        }

        if (mode === 'dialogue') {
          // Dialogue mode: use existing role-play functionality
        }
      }
    }

    window.switchPracticeMode = switchPracticeMode;

    function applyQuickFirstLessonUI() {
      if (!isQuickFirstLesson()) return;
      document.body.classList.add('quick-first-lesson');

      const title = document.querySelector('.practice-header h2');
      if (title) title.textContent = '3 分钟首课';

      const startBtn = document.getElementById('start-practice-btn');
      if (startBtn) {
        const textEl = startBtn.querySelector('.btn-text');
        if (textEl) textEl.textContent = '开始 3 分钟首课';
      }

      const dialogueTab = document.querySelector('[data-mode="dialogue"]');
      if (dialogueTab) {
        dialogueTab.setAttribute('aria-disabled', 'true');
        dialogueTab.setAttribute('title', '首课模式使用跟读流程');
      }

      const banner = document.getElementById('quick-first-lesson-banner');
      if (banner) {
        const copy = banner.querySelector('.quick-first-lesson-copy');
        if (copy) copy.textContent = `完成最多 ${getQuickFirstLessonLimit()} 句跟读，就能回到今日训练看到下一步建议。`;
      }

      postPracticeEvent('practice_first_lesson_view', {
        quick_first_lesson: true,
        target_lines: getQuickFirstLessonLimit(),
      });
    }

    // Initialize mode tabs
    document.addEventListener('DOMContentLoaded', () => {
      let currentTheme = loadThemePreference();
      applyTheme(currentTheme);

      const themeToggle = document.getElementById('theme-toggle');
      if (themeToggle) {
        themeToggle.addEventListener('click', () => {
          currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
          applyTheme(currentTheme);
          saveThemePreference(currentTheme);
        });
      }

      document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          switchPracticeMode(tab.dataset.mode);
        });
      });

      const modeExplainToggle = document.getElementById('mode-explain-toggle');
      if (modeExplainToggle) {
        modeExplainToggle.addEventListener('click', () => {
          const modeSelector = document.getElementById('practice-mode-selector');
          const isCollapsed = !!modeSelector && modeSelector.classList.contains('collapsed');
          if (modeSelector) {
            modeSelector.classList.toggle('collapsed', !isCollapsed);
            modeExplainToggle.textContent = isCollapsed ? '收起' : '展开';
          }
        });
      }

      // 初始化模式文案和提示
      switchPracticeMode(currentPracticeMode);
      applyQuickFirstLessonUI();
      fetchScoreHistoryFromServer();

      // Initialize speed buttons for shadowing mode
      document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const speed = parseFloat(btn.dataset.speed);
          if (videoPlayer) {
            videoPlayer.playbackRate = speed;
          }
          if (youtubePlayer && youtubePlayer.setPlaybackRate) {
            youtubePlayer.setPlaybackRate(speed);
          }
          document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      // Initialize start practice button
      const startPracticeBtn = document.getElementById('start-practice-btn');
      if (startPracticeBtn) {
        startPracticeBtn.addEventListener('click', () => {
          const quickMode = isQuickFirstLesson();
          postPracticeEvent(quickMode ? 'practice_first_lesson_start' : 'practice_session_start', {
            quick_first_lesson: quickMode,
            target_lines: quickMode ? getQuickFirstLessonLimit() : null,
          });

          // Show practice interface
          const controlsContainer = document.getElementById('desktop-controls-container');
          const practiceControls = document.querySelector('.practice-controls');
          const linesContainer = document.querySelector('.lines-container');

          if (controlsContainer) {
            controlsContainer.style.display = 'block';
          }
          if (practiceControls) {
            practiceControls.style.display = 'block';
          }
          if (linesContainer) {
            linesContainer.style.display = 'block';

            // Remove all mode classes
            linesContainer.classList.remove('shadowing-mode', 'dialogue-mode');

            // Add appropriate mode class and initialize
            if (currentPracticeMode === 'shadowing') {
              linesContainer.classList.add('shadowing-mode');
              initShadowingMode();
              // 🚀 Auto-start shadowing
              setTimeout(() => {
                startAutoShadowing();
              }, 100);
            } else if (currentPracticeMode === 'dialogue') {
              linesContainer.classList.add('dialogue-mode');

              // 清除跟读模式的定时器和监听器，避免干扰对话模式
              if (shadowingProgressTimer) {
                clearInterval(shadowingProgressTimer);
                shadowingProgressTimer = null;
                console.log('[Dialogue] Cleared shadowing progress timer');
              }
              if (shadowingAutoPauseListener && videoPlayer) {
                videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
                shadowingAutoPauseListener = null;
                console.log('[Dialogue] Cleared shadowing auto-pause listener');
              }
              if (shadowingYouTubePauseInterval) {
                clearInterval(shadowingYouTubePauseInterval);
                shadowingYouTubePauseInterval = null;
                console.log('[Dialogue] Cleared YouTube pause interval');
              }

              // Dialogue mode initialization is handled separately
            }
          }

          // Update live header copy now that控制区已展示
          applyModeMeta(currentPracticeMode);

          // 🎯 隐藏模式选择器和介绍信息，让用户专注于练习
          const modeSelector = document.getElementById('practice-mode-selector');
          if (modeSelector) {
            modeSelector.style.display = 'none';
          }
          ['start-practice-btn', 'mode-top-hint', 'mode-explain-toggle'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.hidden = true;
          });

          // 🎯 Hide the start button container itself
          const startContainer = document.querySelector('.start-practice-container');
          if (startContainer) {
            startContainer.style.display = 'none';
          }

          const modeLiveHeader = document.getElementById('mode-live-header');
          if (modeLiveHeader) {
            modeLiveHeader.style.display = 'none';
          }

          if (currentPracticeMode === 'dialogue') {
            try {
              if (!localStorage.getItem(PRACTICE_GUIDE_KEY)) {
                setTimeout(showPracticeGuide, 400);
              }
            } catch (_) { }
          }

        });
      }

      // Initialize shadowing mode buttons
      // New: Toggle Button
      const shadowingToggleBtn = document.getElementById('shadowing-toggle-btn');
      if (shadowingToggleBtn) {
        shadowingToggleBtn.addEventListener('click', () => {
          togglePracticePlayback();
        });
      }

      // Compact Speed Buttons
      document.querySelectorAll('.speed-btn-compact').forEach(btn => {
        btn.addEventListener('click', () => {
          const speed = parseFloat(btn.dataset.speed);
          if (videoPlayer) videoPlayer.playbackRate = speed;
          if (youtubePlayer && youtubePlayer.setPlaybackRate) youtubePlayer.setPlaybackRate(speed);

          document.querySelectorAll('.speed-btn-compact').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      const shadowingReplayBtn = document.getElementById('shadowing-replay-btn');
      const shadowingNextBtn = document.getElementById('shadowing-next-btn');

      if (shadowingReplayBtn) {
        shadowingReplayBtn.addEventListener('click', replayCurrentSentence);
      }
      if (shadowingNextBtn) {
        shadowingNextBtn.addEventListener('click', handleFocusNextSentence);
      }

    });

    // ==================== Shadowing Mode Functions ====================

    function initShadowingMode() {

      // 非语音内容正则：咳嗽/笑声/音效标注等，跟读模式无意义
      const nonSpeechRe = /^\s*(\(.*?\)|\[.*?\]|(?:coughs?|laughs?|sighs?|clears?\s+throat|applause|music|laughter|chuckles?|sneezes?|hmm+|uh+|um+)\.?\s*)\s*$/i;
      function normalizeShadowingText(t) {
        return t
          .replace(/\baswell\b/g, 'as well')   // 常见 ASR 粘连
          .replace(/\.{4,}/g, '...')            // 超长省略号标准化
          .replace(/\s{2,}/g, ' ')
          .trim();
      }

      // Prefer canonical data (state.currentSegments). The DOM list may still be a placeholder when user clicks "开始练习".
      if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
        shadowingSentences = state.currentSegments
          .filter(seg => {
            const t = String(seg?.text || '').trim();
            return t.length > 1 && !nonSpeechRe.test(t);
          })
          .map((seg, i) => {
          const start = Number(seg?.start) || 0;
          const end = Number(seg?.end != null ? seg.end : start) || start;
          return {
            index: i,
            segmentIndex: seg?.index != null ? seg.index : i,
            text: normalizeShadowingText(typeof seg?.text === 'string' ? seg.text : ''),
            startTime: start,
            endTime: end,
          };
        });
      } else {
        // Fallback: read from rendered DOM list if available.
        const lineItems = document.querySelectorAll('#practice-line-list .line-item');
        shadowingSentences = Array.from(lineItems).map((item, index) => {
          const textEl = item.querySelector('.line-text');
          return {
            index,
            segmentIndex: item.dataset.segmentIndex || index,
            text: textEl ? textEl.textContent : '',
            startTime: item.dataset.start ? parseFloat(item.dataset.start) : 0,
            endTime: item.dataset.end ? parseFloat(item.dataset.end) : 0,
          };
        });
      }

      if (isQuickFirstLesson()) {
        const originalCount = shadowingSentences.length;
        shadowingSentences = selectQuickFirstLessonSentences(shadowingSentences);
        postPracticeEvent('practice_first_lesson_ready', {
          quick_first_lesson: true,
          target_lines: getQuickFirstLessonLimit(),
          selected_lines: shadowingSentences.length,
          source_lines: originalCount,
        });
      }

      // No normalization. We rely on smart playback buffers.

      shadowingCurrentIndex = 0;
      shadowingAutoMode = false;
      shadowingTargetEndTime = null;
      shadowingStopIndex = null;

      // 清空会话评分历史
      state.sessionScoreHistory = [];

      // 调试：打印前10句的详细信息
      shadowingSentences.slice(0, 10).forEach((s, i) => {
      });

      // Display first sentence
      updateShadowingDisplay();
      updateShadowingStatus('准备开始', '⏸️');
    }

    function updateShadowingStatus(text, icon) {
      const statusEl = document.getElementById('shadowing-status');
      if (statusEl) {
        const iconEl = statusEl.querySelector('.status-icon');
        const textEl = statusEl.querySelector('.status-text');
        if (iconEl) iconEl.textContent = icon;
        if (textEl) textEl.textContent = text;
      }
    }

    async function startAutoShadowing({ resume = false } = {}) {
      shadowingAutoMode = true;
      state.autoMode = true; // Sync global state

      // Update Native Toggle Button Icon -> Show Pause
      const playIcon = document.getElementById('native-play-icon');
      const pauseIcon = document.getElementById('native-pause-icon');
      if (playIcon) playIcon.style.display = 'none';
      if (pauseIcon) pauseIcon.style.display = 'block';

      // Show pause button, hide start button (Legacy fallback)
      const oldStart = document.getElementById('shadowing-start-btn');
      const oldPause = document.getElementById('shadowing-pause-btn');
      if (oldStart) oldStart.style.display = 'none';
      if (oldPause) oldPause.style.display = 'block';

      // Enable Immersive Mode (unified practice focus chrome + fullscreen like video learning)
      document.body.classList.add('immersive-active');
      if (typeof syncPracticeFocusChrome === 'function') syncPracticeFocusChrome();
      if (typeof requestPracticeFullscreen === 'function') requestPracticeFullscreen();

      // 🔧 关键：在用户点击事件的同步上下文中立即触发 play()
      // 这样浏览器才会认可这是用户手势触发的播放
      if (videoPlayer && !isYouTubeVideo) {
        const playOverlay = document.getElementById('play-overlay');
        const currentSentence = shadowingSentences[shadowingCurrentIndex];

        // 先 seek 到正确位置，再 play - 都在同步上下文中
        const needsSeek = currentSentence && !(resume && videoPlayer.currentTime >= currentSentence.startTime && videoPlayer.currentTime < currentSentence.endTime);
        const positionGuard = currentSentence ? createShadowingPlaybackGuard(currentSentence, Boolean(needsSeek)) : null;
        if (needsSeek) {
          const seekTime = computeShadowingSeekTime(shadowingCurrentIndex);
          videoPlayer.currentTime = seekTime;
        }

        try {
          // 同步调用 play()，解锁视频播放
          await videoPlayer.play();
          if (positionGuard !== shadowingPlaybackGuard) return;

          // Double check if it actually played
          if (videoPlayer.paused) {
            console.warn('[Shadowing] Play call resolved but video is still paused. Retrying...');
            await videoPlayer.play();
            if (positionGuard !== shadowingPlaybackGuard) return;
          }

          if (playOverlay) playOverlay.style.display = 'none';

          // 设置 auto-pause 监听器
          if (currentSentence) {
            const baseEndTime = Number(currentSentence.endTime ?? currentSentence.end ?? 0);
            shadowingTargetEndTime = computeShadowingTargetEndTime(shadowingCurrentIndex);
            const buffer = Math.max(0, shadowingTargetEndTime - baseEndTime);
            shadowingStopIndex = shadowingCurrentIndex;
            shadowingSentenceEnded = false;
            setupAutoPauseForSentence(currentSentence, shadowingTargetEndTime);

            // 启动轮询检测
            if (shadowingProgressTimer) clearInterval(shadowingProgressTimer);
            shadowingProgressTimer = setInterval(() => {
              const currentTime = videoPlayer.currentTime;
              if (canFinishShadowingPlayback(currentTime)) {
                videoPlayer.pause();
                onSentenceEnded();
              }
            }, 30);
          }

          updateShadowingDisplay();
          return; // 成功播放，直接返回
        } catch (err) {
          if (positionGuard !== shadowingPlaybackGuard) return;
          console.warn('[Shadowing] Sync play failed:', err);
          // 如果失败，继续使用 fallback 逻辑
        }
      }

      // Fallback: 使用原来的 playCurrentSentenceAuto
      // Ensure state is synced even in fallback
      state.autoMode = true;
      playCurrentSentenceAuto({ resume, forceSeek: !resume });
    }

    let shadowingWaitingInterval = null;

    function pauseAutoShadowing() {
      shadowingPlaybackGuard = null;
      shadowingAutoMode = false;
      state.autoMode = false; // Sync global state

      // Update Native Toggle Button Icon -> Show Play
      const playIcon = document.getElementById('native-play-icon');
      const pauseIcon = document.getElementById('native-pause-icon');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';

      // Show start button, hide pause button (Legacy fallback)
      const oldStart = document.getElementById('shadowing-start-btn');
      const oldPause = document.getElementById('shadowing-pause-btn');
      if (oldStart) oldStart.style.display = 'block';
      if (oldPause) oldPause.style.display = 'none';

      // Disable Immersive Mode (unified practice focus chrome + leave fullscreen)
      document.body.classList.remove('immersive-active');
      if (typeof syncPracticeFocusChrome === 'function') syncPracticeFocusChrome();
      if (typeof exitPracticeFullscreen === 'function') exitPracticeFullscreen();

      // Clear any waiting timeout/interval
      if (shadowingWaitingTimeout) {
        clearTimeout(shadowingWaitingTimeout);
        shadowingWaitingTimeout = null;
      }
      if (shadowingWaitingInterval) {
        clearInterval(shadowingWaitingInterval);
        shadowingWaitingInterval = null;
      }
      if (shadowingProgressTimer) {
        clearInterval(shadowingProgressTimer);
        shadowingProgressTimer = null;
      }

      // Pause video
      if (isYouTubeVideo && youtubePlayer && youtubePlayer.pauseVideo) {
        youtubePlayer.pauseVideo();
      } else if (!isYouTubeVideo && videoPlayer) {
        videoPlayer.pause();
      }

      updateShadowingStatus('已暂停', '⏸️');
    }

    function replayCurrentSentence() {
      // 🔧 先标记结束，防止旧的监听器触发
      shadowingSentenceEnded = true;
      // 🔧 清理旧的定时器和监听器
      if (shadowingProgressTimer) {
        clearInterval(shadowingProgressTimer);
        shadowingProgressTimer = null;
      }
      if (shadowingAutoPauseListener && videoPlayer) {
        videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
        shadowingAutoPauseListener = null;
      }
      playCurrentSentenceAuto({ forceSeek: true });
    }

    function updateShadowingDisplay() {
      const currentSentence = shadowingSentences[shadowingCurrentIndex];
      if (!currentSentence) {
        console.warn('[Shadowing] No sentence at index', shadowingCurrentIndex);
        return;
      }

      // In shadowing mode, the list is hidden; show the current line in the dedicated panel.
      if (practiceCurrentLine) {
        practiceCurrentLine.hidden = false;
        practiceCurrentLine.className = 'practice-current-line';
        const lineLabel = isQuickFirstLesson()
          ? `首课句子 ${shadowingCurrentIndex + 1}/${shadowingSentences.length}`
          : `Line ${shadowingCurrentIndex + 1} of ${shadowingSentences.length}`;
        practiceCurrentLine.innerHTML = `
		          <div class="practice-current-meta">${lineLabel}</div>
		          <div class="practice-current-text">${escapeHtml(currentSentence.text || '')}</div>
		          <div class="practice-current-time">${formatTime(currentSentence.startTime)} – ${formatTime(currentSentence.endTime)}</div>
		        `;
      }

      // Update list highlighting only when the list is visible (reading mode, etc).
      const listEl = document.getElementById('practice-line-list');
      if (listEl && getComputedStyle(listEl).display !== 'none') {
        const allItems = listEl.querySelectorAll('.line-item');
        allItems.forEach((item, index) => {
          if (index === shadowingCurrentIndex) {
            item.classList.add('current');
            scrollItemIntoView(item);
          } else {
            item.classList.remove('current');
          }
        });
      }

    }

    async function playCurrentSentenceAuto({ resume = false, forceSeek = false } = {}) {
      const currentSentence = shadowingSentences[shadowingCurrentIndex];
      if (!currentSentence) return;

      const segMode = getSegmentationMode();
      updateShadowingStatus('正在播放...', '▶️');
      const _sEl = document.getElementById('shadowing-status');
      if (_sEl) _sEl.classList.remove('waiting-to-shadow');

      const player = videoPlayer || youtubePlayer;
      if (!player) {
        console.error('[Shadowing] No video player found');
        return;
      }

      // 确保视频不是静音状态，音量正常
      if (videoPlayer) {
        videoPlayer.muted = false;
        videoPlayer.volume = 1.0;
      }
      if (youtubePlayer && youtubePlayer.unMute) {
        youtubePlayer.unMute();
        if (youtubePlayer.setVolume) youtubePlayer.setVolume(100);
      }

      // Clear any existing timeout/polling
      if (shadowingWaitingTimeout) {
        clearTimeout(shadowingWaitingTimeout);
      }
      if (shadowingProgressTimer) {
        clearInterval(shadowingProgressTimer);
        shadowingProgressTimer = null;
      }
      shadowingSentenceEnded = false;

      const baseEndTime = Number(currentSentence.endTime ?? currentSentence.end ?? 0);
      shadowingTargetEndTime = computeShadowingTargetEndTime(shadowingCurrentIndex);
      shadowingStopIndex = shadowingCurrentIndex;

      // Seek to start time and play
      const seekTime = computeShadowingSeekTime(shadowingCurrentIndex);

      // Determine if we should seek based on multiple signals:
      // 1. Use stored stop time if advancing from the immediately previous sentence
      // 2. Fall back to getCurrentTime() otherwise
      let shouldSeek = true;

      // If we just finished the previous sentence and are advancing to the next
      if (shadowingLastStopIndex !== null &&
        shadowingLastStopIndex === shadowingCurrentIndex - 1 &&
        shadowingLastStopTime !== null) {
        // Use the stored stop time which is more reliable
        // Don't seek if we're already past the start point
        // Caption 模式：总是 seek 到 startTime，确保不跳过内容
        // 非 caption 模式：如果上一句停止位置已经超过下一句开始，不需要 seek
        if (segMode !== 'caption' && shadowingLastStopTime >= seekTime - 0.1) {
          shouldSeek = false;
        }
      } else {
        // Fall back to getCurrentTime() for other cases
        const currentTime = isYouTubeVideo
          ? (youtubePlayer && youtubePlayer.getCurrentTime ? youtubePlayer.getCurrentTime() : 0)
          : (videoPlayer ? videoPlayer.currentTime : 0);
        // Caption 模式总是 seek；非 caption 模式看当前位置
        shouldSeek = (segMode === 'caption') ? true : (currentTime < seekTime - 0.1);
      }

      const playbackTime = unifiedPlayer.getCurrentTime();
      if (forceSeek) shouldSeek = true;
      if (resume) shouldSeek = !(playbackTime >= currentSentence.startTime && playbackTime < currentSentence.endTime);
      if (playbackTime >= currentSentence.endTime) shouldSeek = true;
      const positionGuard = createShadowingPlaybackGuard(currentSentence, shouldSeek);
      setupAutoPauseForSentence(currentSentence, shadowingTargetEndTime);

      if (youtubePlayer && youtubePlayer.seekTo) {
        if (shouldSeek) {
          youtubePlayer.seekTo(seekTime);
        }
        youtubePlayer.playVideo();
      } else if (videoPlayer) {
        if (shouldSeek) {
          videoPlayer.currentTime = seekTime;
        }
        const playOverlay = document.getElementById('play-overlay');

        // 处理自动播放可能被浏览器阻止的情况
        const tryPlay = async () => {
          try {
            await videoPlayer.play();
            if (positionGuard !== shadowingPlaybackGuard) return;

            // 验证视频确实在播放
            if (videoPlayer.paused) {
              console.warn('[Shadowing] Video still paused after play() resolved');
              throw new Error('Video still paused');
            }

            // 隐藏播放覆盖层
            if (playOverlay) playOverlay.style.display = 'none';
            return true;
          } catch (playErr) {
            console.warn('[Shadowing] Play attempt failed:', playErr.message || playErr);
            return false;
          }
        };

        // 第一次尝试：正常播放
        let played = await tryPlay();
        if (positionGuard !== shadowingPlaybackGuard) return;

        // 第二次尝试：静音播放
        if (!played) {
          const prevMuted = videoPlayer.muted;
          videoPlayer.muted = true;
          try {
            await videoPlayer.play();
            if (positionGuard !== shadowingPlaybackGuard) return;
            if (!videoPlayer.paused) {
              if (playOverlay) playOverlay.style.display = 'none';
              // 短暂延迟后恢复音量
              setTimeout(() => { videoPlayer.muted = prevMuted; }, 100);
              played = true;
            }
          } catch (e) {
            console.warn('[Shadowing] Muted play failed:', e);
          }
        }

        if (positionGuard !== shadowingPlaybackGuard) return;
        // 最后手段：提示用户点击
        if (!played) {
          updateShadowingStatus('请点击视频开始播放', '⚠️');
          if (playOverlay) {
            playOverlay.style.display = 'flex';
            playOverlay.onclick = async () => {
              if (positionGuard !== shadowingPlaybackGuard) return;
              try {
                await videoPlayer.play();
                if (positionGuard !== shadowingPlaybackGuard) return;
                if (!videoPlayer.paused) {
                  playOverlay.style.display = 'none';
                  updateShadowingStatus('正在播放...', '▶️');
                }
              } catch (e) {
                console.error('[Shadowing] Manual play failed:', e);
              }
            };
          }
        }
      }

      // Fallback polling for YouTube / timeupdate-less scenarios
      if (positionGuard !== shadowingPlaybackGuard) return;
      shadowingProgressTimer = setInterval(() => {
        const currentTime = isYouTubeVideo
          ? (youtubePlayer && youtubePlayer.getCurrentTime ? youtubePlayer.getCurrentTime() : 0)
          : (videoPlayer ? videoPlayer.currentTime : 0);

        // Debug log every ~1s (throttle to avoid spamming too much, but enough to see)
        // Actually, let's log every check for now since we are deep debugging

        if (canFinishShadowingPlayback(currentTime)) {
          if (isYouTubeVideo && youtubePlayer && youtubePlayer.pauseVideo) {
            youtubePlayer.pauseVideo();
          } else if (!isYouTubeVideo && videoPlayer) {
            videoPlayer.pause();
          }
          onSentenceEnded();
        }
      }, 50); // Polling interval (50ms for balance between responsiveness and performance)
    }

    function onSentenceEnded() {
      if (shadowingSentenceEnded) return;
      shadowingSentenceEnded = true;

      // Record actual stop time to avoid boundary re-play on next seek (YouTube polling can overshoot slightly).
      try {
        let t = null;
        if (isYouTubeVideo && youtubePlayer && youtubePlayer.getCurrentTime) {
          t = Number(youtubePlayer.getCurrentTime());
        } else if (!isYouTubeVideo && videoPlayer) {
          t = Number(videoPlayer.currentTime);
        }
        if (Number.isFinite(t)) {
          shadowingLastStopIndex = shadowingCurrentIndex;
          shadowingLastStopTime = t;
        }
      } catch (_) { }

      // Stop fallback polling once executed
      if (shadowingProgressTimer) {
        clearInterval(shadowingProgressTimer);
        shadowingProgressTimer = null;
      }

      // IMPORTANT: Ensure video is paused
      if (isYouTubeVideo && youtubePlayer && youtubePlayer.pauseVideo) {
        youtubePlayer.pauseVideo();
      } else if (!isYouTubeVideo && videoPlayer) {
        videoPlayer.pause();
      }

      // Disable the autoplay watchdog to prevent auto-resume
      state.segmentPlaybackEnd = null;
      state.segmentPlaybackCallback = null;

      // Manual Mode: Wait indefinitely for user input

      // Clear previous interval if any (just to be safe)
      if (shadowingWaitingInterval) {
        clearInterval(shadowingWaitingInterval);
        shadowingWaitingInterval = null;
      }

      // Update UI to prompt user - 绿色呼吸灯提示轮到用户跟读
      updateShadowingStatus('轮到你了，请跟读！', '🎤');
      const statusEl = document.getElementById('shadowing-status');
      if (statusEl) statusEl.classList.add('waiting-to-shadow');

      // We do NOT start a countdown. We stop here.
      // The user must click "Next" button to call goToNextSentence()
    }

    function goToNextSentence() {

      // 🔧 防止旧的监听器/定时器触发
      shadowingSentenceEnded = true;

      // Clear any waiting timeout/interval
      if (shadowingWaitingTimeout) {
        clearTimeout(shadowingWaitingTimeout);
        shadowingWaitingTimeout = null;
      }
      if (shadowingWaitingInterval) {
        clearInterval(shadowingWaitingInterval);
        shadowingWaitingInterval = null;
      }
      // 🔧 清理进度轮询定时器
      if (shadowingProgressTimer) {
        clearInterval(shadowingProgressTimer);
        shadowingProgressTimer = null;
      }
      // 🔧 移除旧的 timeupdate 监听器
      if (shadowingAutoPauseListener && videoPlayer) {
        videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
        shadowingAutoPauseListener = null;
      }

      if (shadowingCurrentIndex < shadowingSentences.length - 1) {
        shadowingCurrentIndex++;
        updateShadowingDisplay();

        // Always play the next sentence when manually clicking "Next"
        playCurrentSentenceAuto();
      } else {
        // 完成最后一句 - 显示会话完成总结
        showSessionCompleteSummary();
      }
    }

    /**
     * 显示跟读会话完成总结弹窗
     */
    function showSessionCompleteSummary() {
      updateShadowingStatus('练习完成！', '🎉');

      // 计算会话统计
      const totalSentences = shadowingSentences.length;

      // 从 state 中获取录音评分记录（如果有的话）
      const scoreHistory = state.sessionScoreHistory || [];
      const avgScore = scoreHistory.length > 0
        ? Math.round(scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length * 100)
        : null;
      const quickMode = isQuickFirstLesson();
      if (quickMode) {
        markQuickFirstLessonComplete(totalSentences, avgScore);
        postPracticeEvent('practice_first_lesson_complete', {
          quick_first_lesson: true,
          lines: totalSentences,
          average_score: avgScore,
          target_lines: getQuickFirstLessonLimit(),
        });
      }

      postPracticeEvent('today_practice_completed', {
        lines: totalSentences,
        average_score: avgScore,
        quick_first_lesson: quickMode,
        target_lines: quickMode ? getQuickFirstLessonLimit() : null,
      });

      // 创建弹窗
      const overlay = document.createElement('div');
      overlay.className = 'pronunciation-feedback-overlay';
      overlay.id = 'sessionCompleteOverlay';

      const scoreSection = avgScore !== null
        ? `<div class="session-avg-score">
             <span class="score-label">平均准确度</span>
             <span class="score-value">${avgScore}%</span>
           </div>`
        : '';

      overlay.innerHTML = `
        <div class="pronunciation-feedback-card" style="text-align: center;">
          <div class="feedback-header">
            <span class="feedback-emoji" style="font-size: 3rem;">🎉</span>
            <span class="feedback-title" style="font-size: 1.5rem;">${quickMode ? '首课完成！' : '练习完成！'}</span>
          </div>
          <div style="padding: 1.5rem 0;">
            <div style="font-size: 1.1rem; color: #64748b; margin-bottom: 1rem;">
              本次完成 <strong style="color: #0ea5e9;">${totalSentences}</strong> 句${quickMode ? '首课跟读' : '跟读练习'}
            </div>
            ${scoreSection}
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.75rem; padding: 0 1rem;">
            <button class="feedback-btn next-btn" id="sessionReviewVocab" style="justify-content: center;">
              <span class="btn-icon">${quickMode ? '✅' : '📚'}</span>
              <span class="btn-text">${quickMode ? '回到今日训练' : '复习本节生词'}</span>
            </button>
            <button class="feedback-btn retry-btn" id="sessionContinue" style="justify-content: center;">
              <span class="btn-icon">${quickMode ? '🎬' : '🎬'}</span>
              <span class="btn-text">${quickMode ? '继续完整训练' : '选择下一个视频'}</span>
            </button>
            <button class="feedback-btn" id="sessionRestart" style="justify-content: center; background: #f1f5f9; color: #64748b;">
              <span class="btn-icon">🔄</span>
              <span class="btn-text">重新练习本视频</span>
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // 绑定事件
      const reviewVocabBtn = overlay.querySelector('#sessionReviewVocab');
      const continueBtn = overlay.querySelector('#sessionContinue');
      const restartBtn = overlay.querySelector('#sessionRestart');

      const closeOverlay = () => {
        overlay.classList.remove('visible');
        overlay.classList.add('closing');
        setTimeout(() => overlay.remove(), 250);
      };

      // 复习生词 - 跳转到词汇页面（带视频ID参数）
      reviewVocabBtn?.addEventListener('click', () => {
        closeOverlay();
        if (isQuickFirstLesson()) {
          const params = new URLSearchParams({ from: 'first_lesson_complete' });
          const videoId = state.videoId || pageParams.get('videoId') || '';
          if (videoId) params.set('videoId', videoId);
          params.set('lines', String(shadowingSentences.length || getQuickFirstLessonLimit()));
          window.location.href = `./today.html?${params.toString()}`;
          return;
        }
        const videoId = state.videoId || '';
        const from = pageParams.get('from') === 'today' ? 'today' : 'practice';
        window.location.href = `./video-vocabulary-desktop.html?video_id=${encodeURIComponent(videoId)}&from=${encodeURIComponent(from)}`;
      });

      // 选择下一个视频
      continueBtn?.addEventListener('click', () => {
        closeOverlay();
        if (isQuickFirstLesson()) {
          const videoId = state.videoId || pageParams.get('videoId') || '';
          const params = new URLSearchParams({ from: 'today', mode: 'shadowing' });
          if (videoId) params.set('videoId', videoId);
          window.location.href = `./practice-session-desktop.html?${params.toString()}`;
          return;
        }
        window.location.href = './video-reader-desktop.html';
      });

      // 重新练习
      restartBtn?.addEventListener('click', () => {
        closeOverlay();
        shadowingCurrentIndex = 0;
        updateShadowingDisplay();
        playCurrentSentenceAuto();
      });

      // 点击背景关闭
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
      });

      // 动画显示
      requestAnimationFrame(() => {
        overlay.classList.add('visible');
      });
    }

    function setupAutoPauseForSentence(sentence, targetEndTime) {
      const positionGuard = shadowingPlaybackGuard;
      // Remove existing listener if any
      if (shadowingAutoPauseListener && videoPlayer) {
        videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
      }

      // Create new listener
      shadowingAutoPauseListener = () => {
        if (positionGuard !== shadowingPlaybackGuard) return;
        if (shadowingSentenceEnded) return;
        const currentTime = isYouTubeVideo
          ? (youtubePlayer && youtubePlayer.getCurrentTime ? youtubePlayer.getCurrentTime() : 0)
          : (videoPlayer ? videoPlayer.currentTime : 0);

        const endPoint = Number.isFinite(targetEndTime) ? targetEndTime : sentence.endTime;
        if (canFinishShadowingPlayback(currentTime, endPoint)) {
          // Pause video when sentence ends
          if (isYouTubeVideo && youtubePlayer && youtubePlayer.pauseVideo) {
            youtubePlayer.pauseVideo();
          } else if (!isYouTubeVideo && videoPlayer) {
            videoPlayer.pause();
            videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
          }
          shadowingAutoPauseListener = null;

          // Trigger sentence ended callback
          onSentenceEnded();
        }
      };

      // Attach listener
      if (videoPlayer) {
        videoPlayer.addEventListener('timeupdate', shadowingAutoPauseListener);
      }
      // Note: YouTube player timeupdate requires polling, handled separately if needed
    }

    const API_BASE = '';
    const pageParams = new URLSearchParams(window.location.search);
    const shareToken = pageParams.get('share') || pageParams.get('share_token');
    const shareMode = Boolean(shareToken);
    function getAuthToken() {
      try {
        if (window.AuthManager && typeof window.AuthManager.getToken === 'function') {
          const t = window.AuthManager.getToken();
          if (t) return t;
        }
      } catch (_) { }
      try {
        return localStorage.getItem('linglish_token')
          || sessionStorage.getItem('linglish_token')
          || localStorage.getItem('authToken')
          || sessionStorage.getItem('authToken');
      } catch (_) { return null; }
    }
    let token = getAuthToken();
    function refreshAuthToken() {
      token = getAuthToken();
      return token;
    }

    function postPracticeEvent(name, properties = {}) {
      const authToken = refreshAuthToken();
      if (!authToken) return;
      try {
        fetch(`${API_BASE}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({
            event_name: name,
            properties: {
              page: 'practice-session-desktop',
              from: pageParams.get('from') || null,
              mode: currentPracticeMode || null,
              video_resource_id: state.videoId || pageParams.get('videoId') || null,
              ...properties,
            },
          }),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }

    function renderPronunciationCoaching(container, coaching, options = {}) {
      const coachUI = window.LinglishPronunciationCoachUI;
      if (!container || !coachUI) return false;
      if (!coaching) {
        coachUI.clear?.(container);
        return false;
      }
      return coachUI.mount(container, coaching, {
        beforeNode: options.beforeNode || null,
        impressionId: options.impressionId || null,
        emit: options.track === false ? null : postPracticeEvent,
        dispatch: options.track === false ? null : (name, detail) => {
          document.dispatchEvent(new CustomEvent(name, { detail }));
        },
      });
    }

    function recordPronunciationCoachingRetry(coaching) {
      const coachUI = window.LinglishPronunciationCoachUI;
      const normalized = coachUI?.normalizeCoaching?.(coaching);
      if (!normalized) return;
      postPracticeEvent('pronunciation_coaching_retry', coachUI.buildEventProperties(normalized));
    }

    function getShareToken() {
      return shareToken;
    }

    function isShareMode() {
      return shareMode;
    }

    const videoPlayer = document.getElementById('practice-video');
    const playOverlay = document.getElementById('play-overlay');
    const youtubePlayerContainer = document.getElementById('youtube-player-container');

    // YouTube player state
    let youtubePlayer = null;
    let isYouTubeVideo = false;
    let youtubeApiReady = false;
    let youtubePlayerInitializing = false;

    // Load YouTube IFrame API (only once)
    if (!window.YT && !window.onYouTubeIframeAPIReady) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.id = 'youtube-iframe-api-script';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    } else if (window.YT && window.YT.Player) {
      youtubeApiReady = true;
    }

    // YouTube API ready callback
    if (!window.onYouTubeIframeAPIReady) {
      window.onYouTubeIframeAPIReady = function () {
        youtubeApiReady = true;
      };
    }

    // YouTube time update polling (since iframe doesn't fire timeupdate events)
    let youtubeTimeUpdateInterval = null;

    function startYouTubeTimeUpdatePolling() {
      if (youtubeTimeUpdateInterval) {
        clearInterval(youtubeTimeUpdateInterval);
      }
      // Poll every 100ms for smooth segment tracking
      youtubeTimeUpdateInterval = setInterval(() => {
        if (isYouTubeVideo && youtubePlayer) {
          handleVideoTimeUpdate();

          // Manually trigger shadowing auto-pause listener if it exists
          if (typeof shadowingAutoPauseListener === 'function') {
            shadowingAutoPauseListener();
          }
        }
      }, 100);
    }

    function stopYouTubeTimeUpdatePolling() {
      if (youtubeTimeUpdateInterval) {
        clearInterval(youtubeTimeUpdateInterval);
        youtubeTimeUpdateInterval = null;
      }
    }

    const practiceArmBtn = document.getElementById('practice-arm-btn');
    const practiceHintEl = document.getElementById('practice-hint');
    const practiceSpeakerSelect = document.getElementById('practice-speaker');
    const roleCountSelect = document.getElementById('role-count-select');
    const roleRotateBtn = document.getElementById('role-rotate-btn');
    const roleRenameBtn = document.getElementById('role-rename-btn');
    const strictAltToggle = document.getElementById('strict-alt-toggle');
    const roleRenameOverlay = document.getElementById('role-rename-overlay');
    const renameListEl = document.getElementById('rename-list');
    const rrSave = document.getElementById('rr-save');
    const rrCancel = document.getElementById('rr-cancel');
    const practiceCurrentLine = document.getElementById('practice-current-line');

    async function loadRoleProfile(videoId) {
      try {
        const token = refreshAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/video-role-profiles?video_id=${encodeURIComponent(videoId)}`, { headers });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.profile || null;
      } catch (e) {
        console.warn('[Practice] loadRoleProfile failed:', e);
        return null;
      }
    }

    async function saveRoleProfile({ scope = 'user' } = {}) {
      try {
        if (!state.videoId) return null;
        const token = refreshAuthToken();
        const headers = {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        };
        const k = (() => {
          if (state.strictAlternate) return 2;
          // Persist concrete number (for 'auto', persist current inferred count)
          if (state.roleCount === 'auto') return chosenRoleCountJS();
          const n = parseInt(state.roleCount, 10);
          return (isFinite(n) && n >= 2 && n <= 5) ? n : chosenRoleCountJS();
        })();
        const names = Array.isArray(state.speakers)
          ? state.speakers.slice(0, k).map((s, i) => String(s?.speaker || `Speaker ${i + 1}`))
          : Array.from({ length: k }, (_, i) => `Speaker ${i + 1}`);
        const body = {
          video_resource_id: state.videoId,
          scope,
          role_count: k,
          role_rotation: Number(state.roleRotation) || 0,
          role_names: names,
          infer_mode: state.strictAlternate ? 'round_robin' : 'content_aware',
        };
        const res = await fetch(`${API_BASE}/video-role-profiles`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.warn('[Practice] saveRoleProfile failed status', res.status);
          return null;
        }
        const data = await res.json();
        return data?.profile || null;
      } catch (e) {
        console.warn('[Practice] saveRoleProfile failed:', e);
        return null;
      }
    }
    const practiceLineList = document.getElementById('practice-line-list');
    // 行元素缓存 + 上次高亮索引（用于 highlightCurrentSegment 的快速路径）
    let practiceLineEls = [];
    let lastHighlightedArrayIndex = -2;

    // 台词列表事件委托：单一监听器替代每行多个监听器
    if (practiceLineList) {
      practiceLineList.addEventListener('click', (event) => {
        // Single-click selects a sentence; double-click opens the dictionary.
        if (event.detail > 1 || state.isRecording) return;
        // 2) 分享模式播放按钮自带 listener（stopPropagation），不会到这里
        if (event.target.closest('.share-play-recording-btn')) return;
        // 3) 行点击
        const li = event.target.closest('.line-item');
        if (!li || !practiceLineList.contains(li)) return;
        const start = Number(li.dataset.start);
        if (Number.isFinite(start)) {
          if (currentPracticeMode === 'shadowing') {
            const index = shadowingSentences.findIndex(sentence => sentence.index === Number(li.dataset.arrayIndex));
            if (index >= 0) {
              playShadowingSentence(index);
              return;
            }
          }
          // 手动点击段落：保护窗口内抑制自动暂停/静音，先完整播放该段
          const end = Number(li.dataset.end);
          state.manualPlayUntil = (Number.isFinite(end) ? end : start + 4) + 0.75;
          unifiedPlayer.setCurrentTime(start);
          safePlayVideo();
        }
        if (li.dataset.hasTranslation === '1') {
          li.classList.toggle('show-translation');
        }
        // 对话模式下，点击字幕不改变高亮（高亮由录音流程控制）
        if (currentPracticeMode === 'dialogue') return;
        const studentIdx = li.dataset.studentIdx != null ? Number(li.dataset.studentIdx) : null;
        const canonicalIndex = li.dataset.canonicalIndex != null && li.dataset.canonicalIndex !== ''
          ? Number(li.dataset.canonicalIndex)
          : null;
        if (studentIdx != null && Number.isFinite(studentIdx)) {
          state.practiceIndex = studentIdx;
          // 局部更新：只切换 current class，不全量重建列表
          if (canonicalIndex != null) {
            highlightCurrentSegment(canonicalIndex);
          } else {
            practiceLineEls.forEach((item) => item.classList.toggle('current', item === li));
          }
          renderPracticeCurrentLine();
        } else if (canonicalIndex != null) {
          state.currentSegmentIndex = canonicalIndex;
          highlightCurrentSegment(canonicalIndex);
        }
      });
      practiceLineList.addEventListener('dblclick', (event) => {
        const vocab = event.target.closest('.vocab-word');
        if (!vocab || !practiceLineList.contains(vocab)) return;
        event.preventDefault();
        event.stopPropagation();
        openPracticeDictionary(vocab.dataset.word);
      });
    }
    const practiceFeedbackEl = document.getElementById('practice-feedback');
    const practiceScorePanel = document.getElementById('practice-score-panel');
    const practiceScoreGrid = document.getElementById('practice-score-grid');
    const practiceScoreSummary = document.getElementById('practice-score-summary');
    const audioModeBtns = Array.from(document.querySelectorAll('.audio-mode-btn'));
    const recordingIndicatorEl = document.getElementById('recording-indicator');
    const recordedCountEl = document.getElementById('recorded-count');
    const startRecordingFab = document.getElementById('start-recording-fab');
    const practiceGuideOverlay = document.getElementById('practice-guide-overlay');
    const guideSpotlight = document.getElementById('guide-spotlight');
    const guideBubble = document.getElementById('guide-bubble');
    const guideDismissBtn = document.getElementById('guide-dismiss');
    // VAD indicator elements
    const vadIndicatorEl = document.getElementById('vad-indicator');
    const vadFillEl = document.getElementById('vad-fill');
    const vadLabelEl = document.getElementById('vad-label');
    const practiceProgressEl = document.getElementById('practice-progress');
    const recordingStatusChip = document.getElementById('recording-status-chip');
    const recordingStatusMain = document.getElementById('recording-status-main');
    const recordingStatusSub = document.getElementById('recording-status-sub');
    const PRACTICE_GUIDE_KEY = 'linglish_practice_guide_v1';

    function getGuideTarget() {
      if (startRecordingFab && !startRecordingFab.hidden) return startRecordingFab;
      const fabBtn = document.getElementById('fab-record-btn');
      if (fabBtn && fabBtn.offsetParent) return fabBtn;
      const armBtn = document.getElementById('practice-arm-btn');
      if (armBtn && armBtn.offsetParent) return armBtn;
      return null;
    }

    function positionPracticeGuide(target) {
      if (!target || !guideSpotlight || !guideBubble) return;
      const rect = target.getBoundingClientRect();
      const size = Math.max(72, rect.width + 24);
      guideSpotlight.style.width = `${size}px`;
      guideSpotlight.style.height = `${size}px`;
      guideSpotlight.style.left = `${rect.left + rect.width / 2 - size / 2}px`;
      guideSpotlight.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
      guideBubble.style.left = `${Math.min(window.innerWidth - 220, rect.left)}px`;
      guideBubble.style.top = `${Math.max(20, rect.bottom + 14)}px`;
    }

    function showPracticeGuide() {
      if (!practiceGuideOverlay) return;
      const target = getGuideTarget();
      if (!target) return;
      practiceGuideOverlay.hidden = false;
      positionPracticeGuide(target);
      window.addEventListener('resize', () => positionPracticeGuide(target), { once: true });
    }

    function hidePracticeGuide() {
      if (!practiceGuideOverlay) return;
      practiceGuideOverlay.hidden = true;
      try { localStorage.setItem(PRACTICE_GUIDE_KEY, '1'); } catch (_) { }
    }

    if (guideDismissBtn) guideDismissBtn.addEventListener('click', hidePracticeGuide);
    if (practiceGuideOverlay) {
      practiceGuideOverlay.addEventListener('click', (e) => {
        if (e.target === practiceGuideOverlay) hidePracticeGuide();
      });
    }

    // ------- Audio utilities: smooth volume ramps -------
    function rampVolume(mediaEl, from, to, durationMs = 120) {
      if (!mediaEl) return Promise.resolve();
      const start = performance.now();
      const clampedFrom = Number.isFinite(from) ? from : 0;
      const clampedTo = Number.isFinite(to) ? to : 0;
      if (mediaEl.__volRampCancel) {
        try { mediaEl.__volRampCancel(); } catch (_) { }
      }
      return new Promise((resolve) => {
        let cancelled = false;
        mediaEl.__volRampCancel = () => { cancelled = true; resolve(); };
        function step(now) {
          if (cancelled) return;
          const t = Math.min(1, (now - start) / Math.max(1, durationMs));
          // Smooth S-curve easing for more natural fades
          const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
          try { mediaEl.volume = clampedFrom + (clampedTo - clampedFrom) * eased; } catch (_) { }
          if (t < 1) {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
            else setTimeout(() => step(performance.now()), 16);
          } else {
            try { mediaEl.volume = clampedTo; } catch (_) { }
            resolve();
          }
        }
        try { mediaEl.volume = clampedFrom; } catch (_) { }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(() => step(performance.now()), 0);
      });
    }

    async function smoothMute(videoEl, fadeMs = 120, finalVolume = 0) {
      if (!videoEl) return;
      const startVol = Number.isFinite(videoEl.volume) ? videoEl.volume : 1;
      if (videoEl.muted && startVol === 0) return;
      await rampVolume(videoEl, startVol, finalVolume, fadeMs);
      videoEl.muted = true;
      try { videoEl.volume = finalVolume; } catch (_) { }
    }

    async function smoothUnmute(videoEl, targetVolume = 1, fadeMs = 120) {
      if (!videoEl) return;
      const toVol = Math.max(0.01, Number(targetVolume) || 1);
      videoEl.muted = false;
      const fromVol = Number.isFinite(videoEl.volume) ? videoEl.volume : 0;
      await rampVolume(videoEl, fromVol, toVol, fadeMs);
      try { videoEl.volume = toVol; } catch (_) { }
    }

    // Tunable timings (ms)
    // Fine-grained fades for more natural dialog
    const DIALOG_FADE_IN_MS = 240;   // other-speaker (original) fade-in in mixed mode
    const RESTORE_FADE_MS = 140;     // restore video volume after user recording
    const DUCK_FADE_MS = 240;        // general duck duration used when silencing before user recording
    const VOICE_FADE_IN_MS = 140;    // user recording fade-in
    const VOICE_FADE_OUT_MS = 90;
    const USER_PREP_MS = 650;        // lead time before auto-record kicks in
    const STUDENT_PREDUCK_LEAD_MS = 350;   // how early to mute before student's segment start (hard mute)
    const STUDENT_PREDUCK_GRACE_MS = 800;  // after start, wait this before fallback unmute if no user audio
    const debugLogEl = document.getElementById('debug-log');
    const debugEntriesEl = document.getElementById('debug-entries');
    const urlParams = new URLSearchParams(window.location.search);
    const debugMode = urlParams.get('debugAudio') === '1';
    const isArenaMode = urlParams.get('mode') === 'arena';  // 实战场模式
    const LINGLISH_ENV = window.__LINGLISH_ENV__ || {};
    const parseEnvBool = (value, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value === 'boolean') return value;
      return String(value).toLowerCase() !== 'false';
    };
    const parseEnvNumber = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const waveformSegmentationConfig = {
      enabled: parseEnvBool(LINGLISH_ENV.waveformSegmentationEnabled, true),
      minDurationSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinDurationSec, 5.5),
      minWords: Math.max(1, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinWords, 8))),
      minSilenceSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinSilenceSec, 0.25),
      silenceThresholdRatio: parseEnvNumber(LINGLISH_ENV.waveformSegmentationThresholdRatio, 0.1),
      minThreshold: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinThreshold, 0.02),
      minEdgeSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinEdgeSec, 0.25),
      minChunkSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinChunkSec, 0.45),
      maxSplits: Math.max(0, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMaxSplits, 24))),
      maxSplitsPerSegment: Math.max(1, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMaxSplitsPerSegment, 2))),
    };
    if (debugMode && debugLogEl) {
      debugLogEl.classList.remove('hidden');
    }

    // 实战场模式：根据是否有录音动态设置按钮状态
    // 这个函数会在录音加载后调用
    function updateArenaModeButtons() {
      if (!isArenaMode) return;

      // 使用统一的按钮状态管理函数（会考虑练习模式状态）
      if (typeof updateAudioModeButtonsAvailability === 'function') {
        updateAudioModeButtonsAvailability();
      }
    }

    function normalizeSegmentIndex(value) {
      if (value === null || value === undefined || value === '') return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    function buildSegmentKey(value) {
      if (value === null || value === undefined || value === '') return null;
      const normalized = normalizeSegmentIndex(value);
      if (normalized !== null) return String(normalized);
      try {
        return String(value);
      } catch (_err) {
        return null;
      }
    }

    function getLocalRecordingCache(videoId) {
      if (!videoId) return null;
      try {
        const storageKey = `user_recordings_${videoId}`;
        const raw = localStorage.getItem(storageKey);
        if (!raw || raw === 'undefined' || raw === 'null') return null;
        return JSON.parse(raw);
      } catch (err) {
        console.warn('[录音] 无法读取本地缓存:', err);
        return null;
      }
    }

    function getSegmentLookupKeys(segmentIndex) {
      const keys = [];
      const key = buildSegmentKey(segmentIndex);
      if (key) keys.push(key);
      const normalized = normalizeSegmentIndex(segmentIndex);
      if (normalized !== null) {
        const numericKey = normalized;
        const stringKey = String(normalized);
        if (!keys.includes(stringKey)) keys.push(stringKey);
        if (!keys.includes(numericKey)) keys.push(numericKey);
      }
      return keys;
    }

    function resolveSegmentSpeaker(segmentIndex) {
      if (!(state.segmentSpeakerMap instanceof Map) || !state.segmentSpeakerMap.size) {
        return null;
      }
      const keys = getSegmentLookupKeys(segmentIndex);
      for (const key of keys) {
        if (state.segmentSpeakerMap.has(key)) {
          return state.segmentSpeakerMap.get(key);
        }
      }
      return null;
    }

    function markSegmentRole(map, segmentIndex, role) {
      const keys = getSegmentLookupKeys(segmentIndex);
      keys.forEach((key) => {
        if (key !== null && key !== undefined) {
          map.set(key, role);
        }
      });
    }

    function rebuildSegmentRoleMap() {
      const roleMap = new Map();
      if (Array.isArray(state.currentSegments)) {
        state.currentSegments.forEach((segment, idx) => {
          const indexValue = segment?.index != null ? segment.index : idx;
          markSegmentRole(roleMap, indexValue, 'original');
        });
      }
      if (Array.isArray(state.practiceLines)) {
        state.practiceLines.forEach((line) => {
          const indexValue = line?.index != null ? line.index : line?.segmentIndex;
          if (indexValue != null) {
            markSegmentRole(roleMap, indexValue, 'student');
          }
        });
      }
      state.segmentRoleMap = roleMap;
    }

    function determineSegmentRole(segmentIndex, assignedSpeaker = null) {
      const keys = getSegmentLookupKeys(segmentIndex);
      if (state.segmentRoleMap instanceof Map && state.segmentRoleMap.size) {
        for (const key of keys) {
          if (state.segmentRoleMap.has(key)) {
            return state.segmentRoleMap.get(key) === 'student' ? 'student' : 'original';
          }
        }
      }
      const selectedSpeaker = state.selectedSpeaker || null;
      const resolvedSpeaker = assignedSpeaker || resolveSegmentSpeaker(segmentIndex);
      if (selectedSpeaker && resolvedSpeaker && resolvedSpeaker === selectedSpeaker) {
        return 'student';
      }
      if (state.practiceLineIndexMap instanceof Map && state.practiceLineIndexMap.size) {
        if (keys.some((key) => state.practiceLineIndexMap.has(key))) {
          return 'student';
        }
      }
      return 'original';
    }

    function isStudentSegment(segmentIndex, assignedSpeaker = null) {
      return determineSegmentRole(segmentIndex, assignedSpeaker) === 'student';
    }

    function synchronizeSegmentSpeakers() {
      if (!Array.isArray(state.currentSegments)) return;

      const mapping = new Map();
      if (state.segmentSpeakerMap instanceof Map) {
        state.segmentSpeakerMap.forEach((value, key) => {
          if (!value) return;
          const keyString = buildSegmentKey(key);
          if (keyString) {
            mapping.set(keyString, value);
          }
        });
      }

      state.practiceSummary = state.practiceLines.map((line, idx) => {
        const rawIdx = line.index != null ? line.index : line.segmentIndex;
        const normalizedIdx = normalizeSegmentIndex(rawIdx);
        const segmentKey = buildSegmentKey(rawIdx);
        // 注意：只在行内显式标注了 speaker 时才写入 speakerName
        const speakerName = line.speaker || null;
        if (speakerName) {
          const keys = getSegmentLookupKeys(rawIdx);
          keys.forEach((key) => {
            if (key !== null && key !== undefined) {
              mapping.set(key, speakerName);
            }
          });
        }
        return {
          idx,
          segmentIndex: rawIdx,
          normalizedIndex: normalizedIdx,
          segmentKey,
          speaker: speakerName,
        };
      });

      state.segmentSpeakerMap = mapping;

      state.currentSegments = state.currentSegments.map((segment, arrayIndex) => {
        const rawIdx = segment.index != null ? segment.index : arrayIndex;
        const keys = getSegmentLookupKeys(rawIdx);
        let assignedSpeaker = null;
        for (const key of keys) {
          if (mapping.has(key)) {
            assignedSpeaker = mapping.get(key);
            break;
          }
        }
        if (assignedSpeaker && !segment.speaker) {
          return { ...segment, speaker: assignedSpeaker };
        }
        return segment;
      });

      if (debugMode) {
        const summary = state.currentSegments.map((segment, arrayIndex) => {
          const rawIdx = segment.index != null ? segment.index : arrayIndex;
          return {
            idx: arrayIndex,
            segmentIndex: rawIdx,
            normalizedIndex: normalizeSegmentIndex(rawIdx),
            segmentKey: buildSegmentKey(rawIdx),
            speaker: segment.speaker || null,
          };
        });
        console.log('[RoleMap] debug', {
          selectedSpeaker: state.selectedSpeaker,
          mapping: Array.from(mapping.entries()),
          summary,
        });
      }

      rebuildSegmentRoleMap();
    }

    // 自动流程UI元素
    const autoPracticeStatus = document.getElementById('auto-practice-status');
    const statusIcon = document.getElementById('status-icon');
    const statusText = document.getElementById('status-text');
    const analysisProgress = document.getElementById('analysis-progress');
    const analysisMeta = document.getElementById('analysis-meta');
    const autoStartBtn = document.getElementById('auto-start-btn');
    const autoPauseBtn = document.getElementById('auto-pause-btn');
    const autoPrevBtn = document.getElementById('auto-prev-btn');
    const autoNextBtn = document.getElementById('auto-next-btn');

    const state = {
      videoId: null,
      videoData: null,
      currentSegments: [],
      speakers: [],
      selectedSpeaker: '',
      practiceLines: [],
      practiceIndex: 0,
      practiceAttempts: 0,
      practiceLineResults: {},
      practiceLineWordResults: {},
      practiceLineIndexMap: new Map(),
      segmentSpeakerMap: new Map(),
      practiceArmed: false,
      waitingForPractice: false,
      practicePlaybackLock: false,
      // 手动点击段落后的"保护播放"截止时间（视频时间轴秒）：
      // 在此之前抑制所有自动暂停/静音，保证点哪段都先完整出声播放
      manualPlayUntil: null,
      // 用户主动取消跟读录音的标志，短路 recorder stop 回调的评分弹层
      recordingCancelled: false,
      segmentPlaybackEnd: null,
      segmentPlaybackCallback: null,
      currentSegmentIndex: null,
      autoSegmentCursor: 0,
      recorder: null,
      recordingChunks: [],
      lastRecordingBlob: null,
      lastPronunciationEval: null,
      sessionScoreHistory: [],  // 记录会话中的所有评分，用于计算平均分
      recorderMimeType: null,
      mediaStream: null,
      recordingMonitor: null,
      dialogueMaxDurationMs: null,
      activeMaxRecordingMs: null,

      // 自动流程新增状态
      autoMode: false,               // 是否启用自动模式
      isPaused: false,               // 是否暂停
      currentRetry: 0,               // 当前重试次数（0-2）
      maxRetries: 3,                 // 最大重试次数
      isRecording: false,            // 是否正在录音
      audioContext: null,            // 音频上下文
      audioAnalyser: null,           // 音频分析器
      silenceStart: null,            // 静音开始时间
      // NOTE: A lower default avoids cutting off quiet speakers; final threshold is adapted via noise floor.
      silenceThreshold: 0.0045,      // 静音阈值（最小门槛）
      silenceDuration: 1500,         // 静音持续时间（毫秒）
      vadCheckInterval: null,        // VAD检查定时器
      // 更稳健的录音控制
      recordingStartAt: null,        // 录音开始时间戳（ms）
      firstVoiceAt: null,            // 第一次检测到声音的时间戳（ms）
      voicedMs: 0,                   // 已累计的发声时长估计（ms）
      vadInitialIgnoreMs: 1200,      // 开始录音后的静音忽略期（不自动停止）
      vadMinSpeakMs: 800,            // 至少需要说话多长时间后才允许因静音停止
      vadMaxRecordingMs: 10000,      // 单句最大录音时长上限（兜底）
      dialogueMinDurationMs: null,   // 对话模式下：最短允许自动停止时长（ms）
      serverRecordings: [],
      debugMode,
      isMainlandUser: false,  // 国内用户标识，用于跳过YouTube
      practiceSummary: [],
      remoteRecordingKeys: [],
      localRecordingKeys: [],
      segmentRoleMap: new Map(),
      autoplayNudgeAt: 0,
      studentGuard: null,           // { key, start, setAt, fallbackAt }
      hasServerSpeakers: false,
      roleCount: 'auto',            // 'auto' | 2..5
      roleRotation: 0,              // rotation offset for inferred roles
      roleNames: [],                // optional custom names
      roleProfile: null,            // loaded/saved server profile snapshot
      strictAlternate: false,       // 是否启用严格轮换(2人)
      lastOriginalWaveform: null,
      originalAudioBuffer: null,
      originalAudioBufferVideoId: null,
      originalAudioBufferPromise: null,
      mediaElementSource: null,
      mediaElementAnalyser: null,
      mediaElementSourceEl: null,
      originalWaveformCache: new Map(),
    };

    const MEDIA_READY_THRESHOLD = typeof HTMLMediaElement !== 'undefined'
      ? HTMLMediaElement.HAVE_METADATA
      : 1;

    // ===== Improved multi-speaker inference (dialogue-aware) =====
    function inferDistinctSpeakersFromSegmentsJS() {
      try {
        if (!Array.isArray(state.currentSegments)) return [];
        const names = new Map();
        state.currentSegments.forEach((seg) => {
          const n = (seg?.speaker || '').trim();
          if (n) names.set(n, (names.get(n) || 0) + 1);
        });
        return Array.from(names.keys()).slice(0, 5);
      } catch (_) { return []; }
    }

    function chosenRoleCountJS() {
      const val = state.roleCount;
      if (val === 'auto') {
        const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
        const q = segs.reduce((n, s) => n + (/[?？]\s*$/.test(String(s?.text || '')) ? 1 : 0), 0);
        // In most practice videos, 2 speakers are safest default
        return Math.min(5, Math.max(2, q > 8 ? 2 : 2));
      }
      const n = parseInt(val, 10);
      return (isFinite(n) && n >= 2 && n <= 5) ? n : 2;
    }

    function buildInferredSpeakers() {
      const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
      const distinct = inferDistinctSpeakersFromSegmentsJS();
      const k = state.strictAlternate ? 2 : chosenRoleCountJS();

      // If explicit names exist, group by name (top-k by frequency)
      if (distinct.length >= 2) {
        const freq = new Map();
        segs.forEach(seg => { const n = (seg?.speaker || '').trim(); if (!n) return; freq.set(n, (freq.get(n) || 0) + 1); });
        const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n);
        const speakers = top.map(n => ({ speaker: n, lines: [] }));
        const indexOf = (n) => { const i = top.indexOf(n); return i >= 0 ? i : 0; };
        segs.forEach((seg, i) => {
          const idx = seg?.index != null ? seg.index : i;
          const name = (seg?.speaker || '').trim();
          if (!name) return;
          const role = speakers[indexOf(name)];
          role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text: seg.text, speaker: role.speaker });
        });
        state.speakers = speakers;
        return;
      }

      // Dialogue-aware inference when no speakers are embedded
      const speakers = Array.from({ length: k }, (_, i) => ({ speaker: `Speaker ${i + 1}`, lines: [] }));
      const offset = Math.abs(state.roleRotation) % k;
      let curRole = offset;
      let lastIdx = -1;
      let consecCount = 0;
      let lastWasQuestion = false;
      let lastText = '';

      const shortReplyRe = /^(yes|no|sure|ok|okay|alright|thank you|thanks|my name is|i\b|yes,|no,)\b/i;
      const interrogativeRe = /[?？]\s*$|\b(who|what|when|where|why|how|can|could|do|did|are|is|will|would|should)\b/i;
      const greetOrCloseRe = /^(good (morning|afternoon|evening)|thank you|thanks|have a nice day|goodbye|bye)\b/i;

      function pickRole(i, text) {
        const t = String(text || '').trim();
        const isQ = interrogativeRe.test(t);
        const isShort = t.length <= 40 || shortReplyRe.test(t);
        let switchNow = false;

        if (lastIdx === -1) return curRole; // first line

        if (lastWasQuestion) switchNow = true; // Q → A
        if (!switchNow && isQ && !interrogativeRe.test(lastText)) switchNow = true; // A → Q
        if (!switchNow && isShort) switchNow = true; // short answers tend to be the other role
        if (!switchNow && greetOrCloseRe.test(t) && !greetOrCloseRe.test(lastText)) switchNow = true;
        if (!switchNow && consecCount >= 2) switchNow = true; // avoid long monologues

        if (switchNow) {
          if (k === 2) curRole = (curRole + 1) % 2; else curRole = (curRole + 1) % k;
          consecCount = 0;
        }
        return curRole;
      }

      segs.forEach((seg, i) => {
        const idx = seg?.index != null ? seg.index : i;
        const text = String(seg?.text || '').trim();
        const roleIdx = pickRole(i, text);
        const role = speakers[roleIdx];
        role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
        if (lastIdx === -1 || roleIdx === curRole) consecCount += 1; else consecCount = 1;
        lastIdx = i;
        lastText = text;
        lastWasQuestion = /[?？]\s*$/.test(text);
      });

      // If k===2 and strict alternation is enabled, do pure alternation
      if (k === 2 && state.strictAlternate) {
        speakers[0].lines = [];
        speakers[1].lines = [];
        let turn = (Math.abs(state.roleRotation) % 2);
        segs.forEach((seg, i) => {
          const idx = seg?.index != null ? seg.index : i;
          const text = String(seg?.text || '').trim();
          const role = speakers[turn];
          role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
          turn = (turn + 1) % 2;
        });
      } else if (k === 2) {
        const c0 = speakers[0].lines.length;
        const c1 = speakers[1].lines.length;
        if (Math.min(c0, c1) === 0 || Math.max(c0, c1) >= (Math.min(c0, c1) + 8)) {
          speakers[0].lines = [];
          speakers[1].lines = [];
          let turn = offset % 2;
          segs.forEach((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            const text = String(seg?.text || '').trim();
            // Alternate strictly when dialogue-like
            const role = speakers[turn];
            role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
            // Switch on question or every line
            turn = (turn + 1) % 2;
          });
        }
      }

      state.speakers = speakers;
    }
    const SILENT_AUDIO_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAACJWAAACABAAZGF0YQAAAAA=';
    const isLikelyMobileDevice = (() => {
      if (typeof navigator === 'undefined' || !navigator) return false;
      const ua = navigator.userAgent || '';
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|Mobi/i.test(ua);
    })();

    class AudioModeManager {
      constructor() {
        this.mode = 'original'; // original | my-voice | mixed
        this.userRecordings = {}; // { segmentIndex: HTMLAudioElement }
        this.currentVideoId = null;
        this.overlayAudio = null;
        this.selectedSpeaker = null;
        this.originalVolume = null;
        this.baseVolume = 1;
        this.lastPlaybackSegment = null;
        this.lastPlaybackKey = null;
        this.lastPlaybackTimestamp = 0;
        this.decisionCache = new Map();
        this.lastRoleLog = new Map();
        this.overlayPlaybackState = null;
        this.missingRecordingRetries = new Map();
        this.segmentPlaybackLog = new Map();
        this.isMobileEnvironment = isLikelyMobileDevice;
        this.pendingPlaybackRequests = new Map();
        this.maxDeferredPlaybackWaitMs = this.isMobileEnvironment ? 6000 : 3500;
        this.playbackWindow = this.isMobileEnvironment
          ? { startOffset: -0.35, endOffset: 2.1 }
          : { startOffset: -0.2, endOffset: 1.5 };
        this.minimumPlaybackCooldownMs = this.isMobileEnvironment ? 2000 : 1400;
        this.isAudioUnlocked = !this.isMobileEnvironment;
        this.unlockHandlersBound = false;
        this.boundUnlockHandler = null;
        this.playbackAudioContext = null;
        this.playbackAnalyserCache = new WeakMap();
        this.activeAnalyserAudios = new Set();
        this.leadingSilenceCache = new Map();
        this.pendingSilenceAnalysis = new Map();
        this.silenceTrimThreshold = 0.012;
        this.maxSilenceTrimSeconds = 2.5;
        this.emptyRecordingCache = new Map();
        this.pendingEmptyDetection = new Map();
        this.activeUserAudios = new Set();
        this.playedGuard = new Map(); // key -> untilVideoTime (seconds)
      }

      stopAllUserRecordingsExcept(exclude) {
        try {
          const list = this.userRecordings ? Object.values(this.userRecordings) : [];
          list.forEach((a) => {
            if (!a || a === exclude) return;
            try {
              a.pause();
              // Don't reset currentTime here to preserve readiness if replayed
            } catch (_) { }
          });
        } catch (_) { }
      }

      prepareAudioElement(key, audio, sourceType) {
        if (!audio) return;
        const handleReady = () => {
          audio.removeEventListener('loadeddata', handleReady);
          audio.removeEventListener('canplay', handleReady);
          // 跳过已处理录音的静音分析（服务器录音已经裁剪过了）
          if (audio.dataset?.isProcessed !== 'true') {
            this.scheduleLeadingSilenceAnalysis(key, audio);
          } else {
            // 清除缓存，确保已处理录音不使用静音分析结果
            const cacheKey = this.buildSilenceCacheKey(key, audio);
            if (cacheKey && this.leadingSilenceCache) {
              this.leadingSilenceCache.set(cacheKey, 0);
            }
          }
          this.scheduleEmptyRecordingDetection(key, audio);
        };
        const handleError = (event) => {
          audio.removeEventListener('error', handleError);
          audio.removeEventListener('loadeddata', handleReady);
          audio.removeEventListener('canplay', handleReady);
          if (this.userRecordings?.[key] === audio) {
            delete this.userRecordings[key];
          }
          if (sourceType === 'remote' && Array.isArray(state.serverRecordings)) {
            state.serverRecordings = state.serverRecordings.filter((item) => {
              const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
              return itemKey !== key;
            });
          }
          console.warn('[音频模式] 录音加载失败', {
            segmentIndex: key,
            sourceType,
            error: event?.message || audio?.error?.code || 'unknown',
          });
          this.updateRecordingIndicator();
          if (sourceType === 'remote') {
            this.tryRestoreMissingRecording(key);
          }
        };
        audio.addEventListener('loadeddata', handleReady);
        audio.addEventListener('canplay', handleReady);
        audio.addEventListener('error', handleError);
      }

      loadUserRecordings(videoId, remoteRecordings = []) {
        this.currentVideoId = videoId;
        this.userRecordings = {};
        this.decisionCache.clear();
        if (this.lastRoleLog) this.lastRoleLog.clear();
        this.overlayPlaybackState = null;
        this.missingRecordingRetries.clear();
        this.segmentPlaybackLog.clear();
        this.clearAllPendingPlayback();
        if (this.emptyRecordingCache) this.emptyRecordingCache.clear();
        if (this.pendingEmptyDetection) this.pendingEmptyDetection.clear();
        this.bindMobileUnlockHooks();

        if (!videoId) {
          this.updateRecordingIndicator(0);
          return;
        }

        let count = 0;
        const seenSegments = new Set();
        const remoteKeys = [];
        const localKeys = [];
        if (debugMode) {
          console.log('[音频模式] 加载录音', {
            videoId,
            remoteCount: Array.isArray(remoteRecordings) ? remoteRecordings.length : 0,
          });
        }

        if (Array.isArray(remoteRecordings) && remoteRecordings.length) {
          remoteRecordings.forEach((recording) => {
            const segmentIndex = recording?.segment_index ?? recording?.segmentIndex;
            const key = buildSegmentKey(segmentIndex);
            if (!key) return;
            const recordingSpeaker = recording?.speaker || null;
            if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
              return;
            }

            const rawUrl = recording?.audio_url || recording?.audioPath || recording?.audioData;
            if (!rawUrl) return;

            try {
              const audio = new Audio();
              audio.preload = 'auto';
              // 标记为已处理的录音（服务器录音已裁剪过静音）
              audio.dataset.isProcessed = 'true';
              // 清除任何可能的偏移值，因为服务器录音已经实际裁剪过了
              delete audio.dataset.startOffset;
              delete audio.dataset.endOffset;
              this.prepareAudioElement(key, audio, 'remote');
              this.userRecordings[key] = audio;
              setProtectedMediaSource(audio, rawUrl, recording?.updated_at).then(() => {
                if (typeof audio.load === 'function') {
                  audio.load();
                }
              }).catch(() => {
                if (this.userRecordings[key] === audio) delete this.userRecordings[key];
                this.updateRecordingIndicator();
              });
              seenSegments.add(key);
              count += 1;
              remoteKeys.push(key);
              if (recording?.speaker && !this.selectedSpeaker) {
                this.selectedSpeaker = recording.speaker;
              }
            } catch (err) {
              console.warn('[音频模式] 无法加载服务器录音:', err);
            }
          });
        }

        try {
          const storageKey = `user_recordings_${videoId}`;
          const data = localStorage.getItem(storageKey);
          if (data && data !== 'undefined' && data !== 'null') {
            const recordings = JSON.parse(data);
            if (!this.selectedSpeaker && recordings?.selectedSpeaker) {
              this.selectedSpeaker = recordings.selectedSpeaker;
            }
            for (const [segmentIndex, recording] of Object.entries(recordings.recordings || {})) {
              const key = buildSegmentKey(segmentIndex);
              if (!key || seenSegments.has(key)) continue;
              const recordingSpeaker = recording?.speaker || recordings?.selectedSpeaker || null;
              if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
                continue;
              }
              if (recording?.audioData) {
                try {
                  const audio = new Audio(recording.audioData);
                  audio.preload = 'auto';
                  // 存储静音裁剪的偏移信息（移动端虚拟裁剪需要）
                  if (recording.startOffset !== undefined) {
                    audio.dataset.startOffset = String(recording.startOffset);
                  }
                  if (recording.endOffset !== undefined) {
                    audio.dataset.endOffset = String(recording.endOffset);
                  }
                  this.prepareAudioElement(key, audio, 'local');
                  this.userRecordings[key] = audio;
                  if (typeof audio.load === 'function') {
                    try {
                      audio.load();
                    } catch (loadErr) {
                      console.warn('[音频模式] 预加载本地录音失败:', loadErr);
                    }
                  }
                  count += 1;
                  seenSegments.add(key);
                  localKeys.push(key);
                } catch (err) {
                  console.warn('[音频模式] 无法加载本地录音:', err);
                }
              }
            }
          }
        } catch (err) {
          console.error('[音频模式] 加载录音失败:', err);
        }

        state.remoteRecordingKeys = remoteKeys;
        state.localRecordingKeys = localKeys;

        if (debugMode) {
          console.log('[音频模式] 录音统计', {
            count,
            speaker: this.selectedSpeaker,
            remoteKeys,
            localKeys,
            cachedKeys: Object.keys(this.userRecordings || {}),
          });
        }
        this.updateRecordingIndicator(count);

        // 实战场模式：更新按钮状态
        if (typeof updateArenaModeButtons === 'function') {
          updateArenaModeButtons();
        }
      }

      clearPendingPlayback(key) {
        if (!key || !this.pendingPlaybackRequests?.size) return;
        const pending = this.pendingPlaybackRequests.get(key);
        if (!pending) return;
        try {
          pending.cleanup?.();
        } catch (err) {
          console.warn('[音频模式] 无法清理延迟播放:', err);
        }
        this.pendingPlaybackRequests.delete(key);
      }

      clearAllPendingPlayback() {
        if (!this.pendingPlaybackRequests?.size) return;
        Array.from(this.pendingPlaybackRequests.keys()).forEach((key) => {
          this.clearPendingPlayback(key);
        });
      }

      enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio) {
        if (!key || !audio || !videoEl) return false;
        const now = performance.now();
        const existing = this.pendingPlaybackRequests.get(key);
        if (existing) {
          existing.segment = segment || existing.segment || null;
          existing.segmentIndex = segmentIndex;
          existing.videoEl = videoEl;
          existing.requestedAt = now;
          existing.videoTime = videoEl.currentTime;
          return true;
        }

        if (!this.isMobileEnvironment && audio.readyState >= MEDIA_READY_THRESHOLD) {
          return false;
        }

        const self = this;
        let timeoutId = null;

        function cleanup() {
          audio.removeEventListener('canplaythrough', handleReady);
          audio.removeEventListener('canplay', handleReady);
          audio.removeEventListener('loadeddata', handleReady);
          audio.removeEventListener('error', handleError);
          if (timeoutId !== null && typeof window !== 'undefined' && window) {
            window.clearTimeout(timeoutId);
            timeoutId = null;
          }
        }

        function handleReady() {
          cleanup();
          self.pendingPlaybackRequests.delete(key);
          if (debugMode) {
            console.log('[音频模式] 延迟播放就绪', {
              segmentIndex: key,
              readyState: audio.readyState,
            });
          }
          const invoke = () => self.syncPlayUserRecording(segmentIndex, videoEl, segment);
          if (typeof window !== 'undefined' && window?.requestAnimationFrame) {
            window.requestAnimationFrame(invoke);
          } else if (typeof setTimeout === 'function') {
            setTimeout(invoke, 0);
          } else {
            invoke();
          }
        }

        function handleError(event) {
          cleanup();
          self.pendingPlaybackRequests.delete(key);
          if (debugMode) {
            console.log('[音频模式] 延迟播放失败', {
              segmentIndex: key,
              error: event?.message || audio?.error?.code || 'unknown',
            });
          }
        }

        function handleTimeout() {
          cleanup();
          self.pendingPlaybackRequests.delete(key);
        }

        audio.addEventListener('canplaythrough', handleReady, { once: true });
        audio.addEventListener('canplay', handleReady, { once: true });
        audio.addEventListener('loadeddata', handleReady, { once: true });
        audio.addEventListener('error', handleError, { once: true });

        if (debugMode) {
          console.log('[音频模式] 延迟播放排队', {
            segmentIndex: key,
            readyState: audio.readyState,
          });
        }

        if (typeof window !== 'undefined' && window?.setTimeout) {
          timeoutId = window.setTimeout(handleTimeout, this.maxDeferredPlaybackWaitMs);
        }

        this.pendingPlaybackRequests.set(key, {
          key,
          segmentIndex,
          segment: segment || null,
          videoEl,
          requestedAt: now,
          videoTime: videoEl.currentTime,
          cleanup,
        });

        if (typeof audio.load === 'function') {
          try {
            audio.load();
          } catch (err) {
            console.warn('[音频模式] 延迟播放时强制加载失败:', err);
          }
        }

        if (this.isMobileEnvironment && !this.isAudioUnlocked) {
          this.bindMobileUnlockHooks();
        }

        return true;
      }

      tryRestoreMissingRecording(segmentKey) {
        if (!this.currentVideoId || !segmentKey) return;
        const attempts = this.missingRecordingRetries.get(segmentKey) || 0;
        if (attempts >= 2) return;

        const cache = getLocalRecordingCache(this.currentVideoId);
        const snapshot = cache?.recordings?.[segmentKey];
        if (!snapshot?.audioData) {
          this.missingRecordingRetries.set(segmentKey, attempts + 1);
          return;
        }

        const speaker = snapshot.speaker || cache?.selectedSpeaker || this.selectedSpeaker || null;
        if (!speaker) {
          this.missingRecordingRetries.set(segmentKey, attempts + 1);
          return;
        }

        this.missingRecordingRetries.set(segmentKey, attempts + 1);

        uploadRecordingToServer({
          videoId: this.currentVideoId,
          segmentIndex: segmentKey,
          speaker,
          audioData: snapshot.audioData,
          durationSec: snapshot.duration || null,
        })
          .then((recording) => {
            if (!recording) {
              return;
            }
            state.serverRecordings = Array.isArray(state.serverRecordings)
              ? state.serverRecordings.filter((item) => {
                const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
                return itemKey !== segmentKey;
              })
              : [];
            state.serverRecordings.push(recording);
            this.addOrUpdateRecording(recording);
          })
          .catch((err) => {
            console.warn('[音频模式] 修复录音失败:', err);
            console.warn('[音频模式] 修复录音失败详情', {
              segmentIndex: segmentKey,
              error: err?.message || err,
            });
          });
      }

      updateRecordingIndicator(count = Object.keys(this.userRecordings || {}).length) {
        if (recordingIndicatorEl && recordedCountEl) {
          if (count > 0) {
            recordedCountEl.textContent = String(count);
            recordingIndicatorEl.hidden = false;
          } else {
            recordingIndicatorEl.hidden = true;
          }
        }

        // 使用统一的按钮可用性更新函数（会考虑练习模式状态）
        updateAudioModeButtonsAvailability();
      }

      bindMobileUnlockHooks() {
        if (!this.isMobileEnvironment || this.isAudioUnlocked || this.unlockHandlersBound) {
          return;
        }
        if (typeof document === 'undefined') return;
        const handler = () => this.unlockAudioPlayback();
        this.boundUnlockHandler = handler;
        const options = { once: true, passive: true };
        document.addEventListener('touchend', handler, options);
        document.addEventListener('touchstart', handler, options);
        document.addEventListener('click', handler, options);
        this.unlockHandlersBound = true;
      }

      unlockAudioPlayback() {
        if (!this.isMobileEnvironment || this.isAudioUnlocked) {
          return;
        }
        if (typeof document !== 'undefined' && this.boundUnlockHandler) {
          document.removeEventListener('touchend', this.boundUnlockHandler);
          document.removeEventListener('touchstart', this.boundUnlockHandler);
          document.removeEventListener('click', this.boundUnlockHandler);
        }
        this.unlockHandlersBound = false;
        this.boundUnlockHandler = null;

        const finalize = (success) => {
          if (success) {
            this.isAudioUnlocked = true;
            this.flushPendingPlaybackRequests();
          } else {
            this.isAudioUnlocked = false;
            this.bindMobileUnlockHooks();
          }
        };

        try {
          if (typeof window === 'undefined' || !window.Audio) {
            finalize(false);
            return;
          }
          const silentAudio = new Audio(SILENT_AUDIO_DATA_URL);
          silentAudio.muted = true;
          const playPromise = silentAudio.play();
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise
              .then(() => {
                try {
                  silentAudio.pause();
                  silentAudio.currentTime = 0;
                } catch (_err) {
                  // ignore
                }
                finalize(true);
              })
              .catch((err) => {
                finalize(false);
              });
          } else {
            finalize(true);
          }
        } catch (err) {
          finalize(false);
        }
      }

      audioContextSupported() {
        if (typeof window === 'undefined') return false;
        return typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function';
      }

      ensurePlaybackAudioContext() {
        if (!this.audioContextSupported()) {
          return null;
        }
        if (this.playbackAudioContext) {
          return this.playbackAudioContext;
        }
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
          return null;
        }
        try {
          this.playbackAudioContext = new AudioContextCtor();
          return this.playbackAudioContext;
        } catch (err) {
          console.warn('[音频模式] 创建AudioContext失败:', err);
          this.playbackAudioContext = null;
          return null;
        }
      }

      ensureAnalyser(audioEl) {
        if (!audioEl) {
          throw new Error('missing-audio-element');
        }
        if (!this.audioContextSupported()) {
          throw new Error('audio-context-unsupported');
        }
        const captureFn =
          (typeof audioEl.captureStream === 'function' && audioEl.captureStream.bind(audioEl)) ||
          (typeof audioEl.mozCaptureStream === 'function' && audioEl.mozCaptureStream.bind(audioEl));
        if (!captureFn) {
          throw new Error('capture-stream-unsupported');
        }

        const cached = this.playbackAnalyserCache?.get(audioEl);
        if (cached && cached.analyser && !cached.disposed) {
          const streamActive =
            cached.stream && typeof cached.stream.active === 'boolean' ? cached.stream.active : true;
          if (streamActive) {
            return cached.analyser;
          }
          this.teardownAnalyser(audioEl);
        }

        const ctx = this.ensurePlaybackAudioContext();
        if (!ctx) {
          throw new Error('audio-context-unavailable');
        }
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          try {
            ctx.resume();
          } catch (_err) {
            // 部分环境会在没有用户手势时拒绝 resume，忽略即可
          }
        }

        let stream = null;
        try {
          stream = captureFn();
        } catch (err) {
          throw new Error(err?.message || 'capture-stream-failed');
        }
        if (!stream) {
          throw new Error('empty-capture-stream');
        }

        let source = null;
        let analyser = null;
        try {
          source = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
        } catch (err) {
          throw new Error(err?.message || 'create-analyser-failed');
        }

        const entry = {
          analyser,
          source,
          stream,
          disposed: false,
          cleanup: null,
          handleEnded: null,
          handleEmptied: null,
        };

        const cleanup = () => {
          if (entry.disposed) return;
          entry.disposed = true;
          try {
            source.disconnect();
          } catch (_disconnectErr) {
            // ignore disconnect errors
          }
          if (entry.handleEnded) {
            audioEl.removeEventListener('ended', entry.handleEnded);
          }
          if (entry.handleEmptied) {
            audioEl.removeEventListener('emptied', entry.handleEmptied);
          }
          if (this.playbackAnalyserCache) {
            this.playbackAnalyserCache.delete(audioEl);
          }
          if (this.activeAnalyserAudios) {
            this.activeAnalyserAudios.delete(audioEl);
          }
          if (stream && typeof stream.getTracks === 'function') {
            stream.getTracks().forEach((track) => {
              if (typeof track.stop === 'function') {
                try {
                  track.stop();
                } catch (_stopErr) {
                  // ignore
                }
              }
            });
          }
          this.shutdownPlaybackAudioContext();
        };

        entry.cleanup = cleanup;
        entry.handleEnded = () => cleanup();
        entry.handleEmptied = () => cleanup();

        audioEl.addEventListener('ended', entry.handleEnded, { once: true });
        audioEl.addEventListener('emptied', entry.handleEmptied, { once: true });

        this.playbackAnalyserCache?.set(audioEl, entry);
        this.activeAnalyserAudios?.add(audioEl);
        return analyser;
      }

      teardownAnalyser(audioEl) {
        if (!audioEl || !this.playbackAnalyserCache) return;
        const entry = this.playbackAnalyserCache.get(audioEl);
        if (!entry) return;
        if (typeof entry.cleanup === 'function') {
          entry.cleanup();
        }
      }

      disposeAllAnalysers() {
        if (!this.activeAnalyserAudios || this.activeAnalyserAudios.size === 0) {
          return;
        }
        const targets = Array.from(this.activeAnalyserAudios);
        targets.forEach((audioEl) => this.teardownAnalyser(audioEl));
      }

      shutdownPlaybackAudioContext() {
        if (!this.playbackAudioContext) return;
        if (this.activeAnalyserAudios && this.activeAnalyserAudios.size > 0) {
          return;
        }
        if (this.pendingSilenceAnalysis && this.pendingSilenceAnalysis.size > 0) {
          return;
        }
        const ctx = this.playbackAudioContext;
        this.playbackAudioContext = null;
        if (!ctx) return;
        try {
          const result = typeof ctx.close === 'function' ? ctx.close() : null;
          if (result && typeof result.catch === 'function') {
            result.catch(() => { });
          }
        } catch (err) {
          console.warn('[音频模式] 关闭AudioContext失败:', err);
        }
      }

      buildSilenceCacheKey(segmentKey, audioEl) {
        if (!audioEl) return null;
        const src = audioEl.currentSrc || audioEl.src || '';
        if (!segmentKey && !src) return null;
        return `${segmentKey || 'unknown'}::${src}`;
      }

      getCachedLeadingSilence(segmentKey, audioEl) {
        if (!this.leadingSilenceCache) return null;
        const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
        if (!cacheKey) return null;
        const cached = this.leadingSilenceCache.get(cacheKey);
        if (typeof cached === 'number' && Number.isFinite(cached)) {
          return cached;
        }
        return null;
      }

      getCachedEmptyRecordingStatus(segmentKey, audioEl) {
        if (!this.emptyRecordingCache) return null;
        const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
        if (!cacheKey) return null;
        const cached = this.emptyRecordingCache.get(cacheKey);
        if (typeof cached === 'boolean') {
          return cached;
        }
        return null;
      }

      scheduleLeadingSilenceAnalysis(segmentKey, audioEl) {
        if (!audioEl || !audioEl.currentSrc || !window?.fetch) {
          return null;
        }
        if (!this.audioContextSupported()) {
          return null;
        }
        const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
        if (!cacheKey) return null;
        if (this.leadingSilenceCache?.has(cacheKey)) {
          return this.leadingSilenceCache.get(cacheKey);
        }
        if (this.pendingSilenceAnalysis?.has(cacheKey)) {
          return this.pendingSilenceAnalysis.get(cacheKey);
        }
        const analysisPromise = this.computeLeadingSilenceSeconds(cacheKey, audioEl)
          .then((seconds) => {
            const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
            if (this.leadingSilenceCache) {
              this.leadingSilenceCache.set(cacheKey, value);
            }
            if (debugMode) {
              console.log('[音频模式] 静音分析完成', {
                segmentIndex: segmentKey,
                seconds: value,
              });
            }
            return value;
          })
          .catch((err) => {
            if (debugMode) {
              console.warn('[音频模式] 静音分析失败', {
                segmentIndex: segmentKey,
                errorCode: err?.name || 'SILENCE_ANALYSIS_ERROR',
              });
            }
            if (this.leadingSilenceCache) {
              this.leadingSilenceCache.set(cacheKey, 0);
            }
            return 0;
          })
          .finally(() => {
            if (this.pendingSilenceAnalysis) {
              this.pendingSilenceAnalysis.delete(cacheKey);
            }
          });
        if (this.pendingSilenceAnalysis) {
          this.pendingSilenceAnalysis.set(cacheKey, analysisPromise);
        }
        return analysisPromise;
      }

      async computeLeadingSilenceSeconds(cacheKey, audioEl) {
        const src = audioEl?.currentSrc || audioEl?.src;
        if (!src) {
          throw new Error('missing-audio-src');
        }
        let response = null;
        try {
          response = await fetch(src, {
            mode: 'cors',
            credentials: 'include',
            cache: 'force-cache',
          });
        } catch (err) {
          console.warn('[音频模式] 获取录音用于静音分析失败:', err);
          throw err;
        }
        if (!response || !response.ok) {
          throw new Error(`fetch-failed:${response?.status || 'network'}`);
        }
        let arrayBuffer = null;
        try {
          arrayBuffer = await response.arrayBuffer();
        } catch (err) {
          console.warn('[音频模式] 读取录音数据失败:', err);
          throw err;
        }
        const ctx = this.ensurePlaybackAudioContext();
        if (!ctx) {
          throw new Error('audio-context-unavailable');
        }
        const bufferCopy = arrayBuffer.slice(0);
        let audioBuffer = null;
        try {
          if (ctx.decodeAudioData.length > 1) {
            audioBuffer = await new Promise((resolve, reject) => {
              ctx.decodeAudioData(
                bufferCopy,
                (decoded) => resolve(decoded),
                (error) => reject(error || new Error('decode-failed'))
              );
            });
          } else {
            audioBuffer = await ctx.decodeAudioData(bufferCopy);
          }
        } catch (err) {
          console.warn('[音频模式] 解码录音失败:', err);
          throw err;
        }

        if (!audioBuffer || !Number.isFinite(audioBuffer.sampleRate)) {
          return 0;
        }

        const sampleRate = audioBuffer.sampleRate;
        const channelCount = audioBuffer.numberOfChannels || 1;
        const maxSamples = Math.min(
          audioBuffer.length,
          Math.floor(sampleRate * (this.maxSilenceTrimSeconds || 2.5))
        );
        if (maxSamples <= 0) {
          return 0;
        }

        const threshold = this.silenceTrimThreshold || 0.012;
        let earliestSample = maxSamples;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          const channelData = audioBuffer.getChannelData(channelIndex);
          if (!channelData) continue;
          for (let i = 0; i < maxSamples; i += 1) {
            const value = channelData[i];
            if (value > threshold || value < -threshold) {
              if (i < earliestSample) {
                earliestSample = i;
              }
              break;
            }
          }
        }

        if (earliestSample >= maxSamples) {
          return 0;
        }

        const offsetSeconds = earliestSample / sampleRate;
        if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
          return 0;
        }
        const clamped = Math.min(
          Math.max(offsetSeconds - 0.02, 0), // minor padding
          this.maxSilenceTrimSeconds || 2.5
        );
        return clamped >= 0.08 ? clamped : 0;
      }

      scheduleEmptyRecordingDetection(segmentKey, audioEl) {
        if (!audioEl || !audioEl.currentSrc || !window?.fetch) {
          return null;
        }
        if (!this.audioContextSupported()) {
          return null;
        }
        const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
        if (!cacheKey) return null;
        if (this.emptyRecordingCache?.has(cacheKey)) {
          return this.emptyRecordingCache.get(cacheKey);
        }
        if (this.pendingEmptyDetection?.has(cacheKey)) {
          return this.pendingEmptyDetection.get(cacheKey);
        }
        const detectionPromise = this.detectEmptyRecording(cacheKey, audioEl)
          .then((isEmpty) => {
            const value = typeof isEmpty === 'boolean' ? isEmpty : false;
            if (this.emptyRecordingCache) {
              this.emptyRecordingCache.set(cacheKey, value);
            }
            if (debugMode && value) {
              console.log('[音频模式] 空录音检测', {
                segmentIndex: segmentKey,
                isEmpty: value,
              });
            }
            return value;
          })
          .catch((err) => {
            if (debugMode) {
              console.warn('[音频模式] 空录音检测失败', {
                segmentIndex: segmentKey,
                errorCode: err?.name || 'EMPTY_RECORDING_ANALYSIS_ERROR',
              });
            }
            if (this.emptyRecordingCache) {
              this.emptyRecordingCache.set(cacheKey, false);
            }
            return false;
          })
          .finally(() => {
            if (this.pendingEmptyDetection) {
              this.pendingEmptyDetection.delete(cacheKey);
            }
          });
        if (this.pendingEmptyDetection) {
          this.pendingEmptyDetection.set(cacheKey, detectionPromise);
        }
        return detectionPromise;
      }

      async detectEmptyRecording(cacheKey, audioEl) {
        const src = audioEl?.currentSrc || audioEl?.src;
        if (!src) {
          throw new Error('missing-audio-src');
        }
        let response = null;
        try {
          response = await fetch(src, {
            mode: 'cors',
            credentials: 'include',
            cache: 'force-cache',
          });
        } catch (err) {
          console.warn('[音频模式] 获取录音用于空白检测失败:', err);
          throw err;
        }
        if (!response || !response.ok) {
          throw new Error(`fetch-failed:${response?.status || 'network'}`);
        }
        let arrayBuffer = null;
        try {
          arrayBuffer = await response.arrayBuffer();
        } catch (err) {
          console.warn('[音频模式] 读取录音数据失败:', err);
          throw err;
        }
        const ctx = this.ensurePlaybackAudioContext();
        if (!ctx) {
          throw new Error('audio-context-unavailable');
        }
        const bufferCopy = arrayBuffer.slice(0);
        let audioBuffer = null;
        try {
          if (ctx.decodeAudioData.length > 1) {
            audioBuffer = await new Promise((resolve, reject) => {
              ctx.decodeAudioData(
                bufferCopy,
                (decoded) => resolve(decoded),
                (error) => reject(error || new Error('decode-failed'))
              );
            });
          } else {
            audioBuffer = await ctx.decodeAudioData(bufferCopy);
          }
        } catch (err) {
          console.warn('[音频模式] 解码录音失败:', err);
          throw err;
        }

        if (!audioBuffer || !Number.isFinite(audioBuffer.sampleRate)) {
          return true;
        }

        const sampleRate = audioBuffer.sampleRate;
        const channelCount = audioBuffer.numberOfChannels || 1;
        const totalSamples = audioBuffer.length;
        if (totalSamples <= 0) {
          return true;
        }

        const threshold = this.silenceTrimThreshold || 0.012;

        // 检测整个录音，看是否有任何有效的音频信号
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          const channelData = audioBuffer.getChannelData(channelIndex);
          if (!channelData) continue;

          for (let i = 0; i < totalSamples; i += 1) {
            const value = channelData[i];
            if (value > threshold || value < -threshold) {
              // 找到有效信号，录音不是空白的
              return false;
            }
          }
        }

        // 所有样本都在阈值以下，录音是空白的
        return true;
      }

      flushPendingPlaybackRequests() {
        if (!this.pendingPlaybackRequests?.size) return;
        const entries = Array.from(this.pendingPlaybackRequests.entries());
        this.pendingPlaybackRequests.clear();
        entries.forEach(([key, payload]) => {
          try {
            payload.cleanup?.();
          } catch (_err) {
            // ignore cleanup errors
          }
          const { segmentIndex, segment, videoEl, videoTime } = payload || {};
          if (segmentIndex == null || !videoEl) {
            return;
          }

          // 检查视频当前时间是否还在片段范围内，避免播放已过期的录音
          const currentVideoTime = videoEl.currentTime;
          const segmentStart = Number(segment?.start);
          const segmentEnd = Number(segment?.end);

          // 如果有片段时间信息，验证当前视频时间是否在片段范围内
          if (Number.isFinite(segmentStart) && Number.isFinite(segmentEnd)) {
            // 允许一定的时间误差（0.5秒），因为解锁可能需要一点时间
            const tolerance = 0.5;
            if (currentVideoTime < segmentStart - tolerance || currentVideoTime > segmentEnd + tolerance) {
              if (debugMode) {
                console.warn('[音频模式] 忽略过期播放请求', {
                  segmentIndex: key,
                  videoTime: currentVideoTime,
                  segmentStart,
                  segmentEnd
                });
              }
              return;
            }
          } else if (Number.isFinite(videoTime)) {
            // 如果没有片段信息，检查视频时间是否变化太多（超过3秒说明已经不是同一个场景了）
            const timeDiff = Math.abs(currentVideoTime - videoTime);
            if (timeDiff > 3) {
              if (debugMode) {
                console.warn('[音频模式] 忽略过期播放请求(场景变化)', {
                  segmentIndex: key,
                  videoTime: currentVideoTime,
                  requestedTime: videoTime,
                  timeDiff
                });
              }
              return;
            }
          }

          this.syncPlayUserRecording(segmentIndex, videoEl, segment || null);
        });
      }

      getRecordingCount() {
        return Object.keys(this.userRecordings || {}).length;
      }

      addOrUpdateRecording(recording) {
        if (!recording) return;
        const segmentIndex = recording.segment_index ?? recording.segmentIndex;
        const key = buildSegmentKey(segmentIndex);
        if (!key) return;
        const rawUrl = recording.audio_url || recording.audioPath || recording.audioData;
        if (!rawUrl) return;
        try {
          const audio = new Audio();
          audio.preload = 'auto';
          // 标记为已处理的录音（服务器录音已裁剪过静音）
          audio.dataset.isProcessed = 'true';
          // 清除任何可能的偏移值，因为服务器录音已经实际裁剪过了
          delete audio.dataset.startOffset;
          delete audio.dataset.endOffset;
          this.prepareAudioElement(key, audio, 'remote');
          this.userRecordings[key] = audio;
          setProtectedMediaSource(audio, rawUrl, recording.updated_at).then(() => {
            if (typeof audio.load === 'function') {
              audio.load();
            }
          }).catch(() => {
            if (this.userRecordings[key] === audio) delete this.userRecordings[key];
            this.updateRecordingIndicator();
          });
          if (recording.speaker) {
            this.selectedSpeaker = recording.speaker;
          }
          this.updateRecordingIndicator();
        } catch (err) {
          console.warn('[音频模式] 无法更新录音:', err);
        }
      }

      setMode(newMode) {
        this.mode = newMode || 'original';
        this.clearAllPendingPlayback();
        if (this.mode !== 'original') {
          this.bindMobileUnlockHooks();
        }
        if (this.mode === 'original') {
          this.cleanup();
          this.segmentPlaybackLog.clear();
        }

        // Aggressively preload all recordings when switching to mixed or my-voice mode
        if (this.mode === 'mixed' || this.mode === 'my-voice') {
          this.preloadAllRecordings();
        }
      }

      preloadAllRecordings() {
        if (!this.userRecordings) return;

        let loadedCount = 0;
        let totalCount = 0;

        Object.entries(this.userRecordings).forEach(([key, audio]) => {
          if (!audio) return;
          totalCount++;

          // Force load if not already loaded
          if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            if (typeof audio.load === 'function') {
              try {
                audio.load();
                loadedCount++;
              } catch (err) {
                console.warn(`[预加载] 无法加载录音 ${key}:`, err);
              }
            }
          }
        });

        if (debugMode && loadedCount > 0) {
          console.log('[音频模式] 预加载录音', {
            mode: this.mode,
            loaded: loadedCount,
            total: totalCount,
          });
        }
      }

      shouldPlayUserRecording(segmentIndex, segment, playbackTime = null) {
        // 核心原则：优先播放用户录音
        // 只要用户有录音，就播放用户的声音，让用户听到自己的发音
        // 即使读得不标准、有静音、有噪音，也要播放，因为这是用户自己的声音
        if (this.mode === 'original') return false;
        this.bindMobileUnlockHooks();
        const key = buildSegmentKey(segmentIndex);
        if (!key) {
          return false;
        }
        const assignedSpeaker = segment?.speaker || resolveSegmentSpeaker(segmentIndex) || null;
        const segmentRole = determineSegmentRole(segmentIndex, assignedSpeaker);
        const audio = this.userRecordings?.[key];
        const hasRecording = !!audio;
        let isUserSegment = segmentRole === 'student';
        let fellBackByRecording = false;
        // 在 my-voice 模式允许对非本人段落也播用户录音；
        // 在 mixed（对话）模式仅在“我的台词”播放用户录音，其它段落保持原声
        if (!isUserSegment && hasRecording && this.mode === 'my-voice') {
          isUserSegment = true;
          fellBackByRecording = true;
        }

        // Check if this segment was played recently to prevent double playback
        if (key === this.lastPlaybackKey) {
          const elapsed = performance.now() - this.lastPlaybackTimestamp;
          // Use minimum cooldown instead of fixed 500ms
          if (elapsed < this.minimumPlaybackCooldownMs) {
            if (debugMode) {
              recordDecision('阻止重复播放（短时间内再次触发）', {
                elapsedMs: Math.round(elapsed),
                minimumCooldownMs: this.minimumPlaybackCooldownMs,
              });
            }
            return false;
          }
        }

        if (segmentRole && this.lastRoleLog) {
          const prevRole = this.lastRoleLog.get(key);
          if (prevRole !== segmentRole) {
            if (debugMode) {
              console.log('[音频模式] 角色变化', {
                segmentIndex: key,
                assignedSpeaker,
                selectedSpeaker: this.selectedSpeaker,
                role: segmentRole,
              });
            }
            this.lastRoleLog.set(key, segmentRole);
          }
        }

        const recordDecision = (action, extra = {}) => {
          const prev = this.decisionCache.get(key);
          const decisionKey = `${segmentRole}:${action}`;
          if (prev !== decisionKey) {
            if (debugMode) {
              const safeExtra = window.LinglishMediaSession?.sanitizeDebugPayload(extra) || {};
              console.log('[音频模式] 决策', {
                segmentIndex: key,
                assignedSpeaker,
                selectedSpeaker: this.selectedSpeaker,
                role: segmentRole,
                ...safeExtra,
              });
            }
            this.decisionCache.set(key, decisionKey);
          }
        };

        // Block replay for this segment until we pass guard time
        const segEnd = Number(segment?.end);
        if (this.playedGuard && this.playedGuard.has(key) && typeof playbackTime === 'number') {
          const until = this.playedGuard.get(key);
          if (Number.isFinite(until) && playbackTime < until) {
            return false;
          }
        }

        const playbackLog = this.segmentPlaybackLog.get(key);
        if (playbackLog) {
          const now = performance.now();
          const hasPlaybackTime = typeof playbackTime === 'number' && Number.isFinite(playbackTime);
          const hasLogVideoTime = Number.isFinite(playbackLog.lastVideoTime);
          const hasLogSegmentStart = Number.isFinite(playbackLog.segmentStart);
          const rewoundByPlayhead =
            hasPlaybackTime &&
            hasLogVideoTime &&
            playbackTime + 0.05 < playbackLog.lastVideoTime;
          const rewoundBeforeSegment =
            hasPlaybackTime &&
            hasLogSegmentStart &&
            playbackTime + 0.05 < playbackLog.segmentStart;
          if (rewoundByPlayhead || rewoundBeforeSegment) {
            this.segmentPlaybackLog.delete(key);
          } else {
            const cooldownMs = playbackLog.cooldown ?? this.minimumPlaybackCooldownMs;
            const elapsedMs = now - playbackLog.timestamp;
            if (elapsedMs < cooldownMs) {
              recordDecision('录音播放冷却中', {
                elapsedMs: Math.round(elapsedMs),
                cooldownMs: Math.round(cooldownMs),
              });
              return false;
            }
          }
        }

        if (!isUserSegment) {
          if (this.mode === 'mixed') {
            recordDecision('混合模式保持原声', {
              hasRecording,
              segmentRole,
              fellBackByRecording,
            });
            return false;
          }
          if (this.mode !== 'my-voice') {
            recordDecision('非学生段落保持原声');
            return false;
          }
        }

        if (!audio) {
          if (segmentRole === 'student') {
            recordDecision('⚠️ 学生段落缺少录音，播放原声', {
              mode: this.mode,
              segmentIndex: key,
              reason: '用户还没有录制这句话'
            });
          } else {
            recordDecision('非学生段落，播放原声', {
              mode: this.mode,
              segmentIndex: key
            });
          }
          return false;
        }

        if (audio.readyState < MEDIA_READY_THRESHOLD) {
          // Throttle repeated attempts while not ready
          const nowTs = performance.now();
          const nextTs = this.notReadyThrottle?.get(key) || 0;
          const hasPending = this.pendingPlaybackRequests && this.pendingPlaybackRequests.has(key);
          if (hasPending || nowTs < nextTs) {
            return false;
          }
          if (this.notReadyThrottle) {
            const minMs = (typeof this.notReadyMinMs === 'number' && this.notReadyMinMs > 0) ? this.notReadyMinMs : 300;
            this.notReadyThrottle.set(key, nowTs + minMs);
          }
          recordDecision('录音尚未就绪', {
            readyState: audio.readyState,
            mode: this.mode,
            relaxed: this.isMobileEnvironment,
          });
          if (!this.isMobileEnvironment) {
            return false;
          }
        }
        if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && typeof audio.load === 'function') {
          try {
            audio.load();
          } catch (err) {
            console.warn('[音频模式] 强制加载录音失败:', err);
          }
        }

        // 用户原则：只要有录音就播放，让用户听到自己的声音

        if (fellBackByRecording && debugMode) {
          console.log('[音频模式] 非本人段落复用录音', {
            segmentIndex: key,
            assignedSpeaker,
            selectedSpeaker: this.selectedSpeaker,
            isMatch: isUserSegment,
            hasRecording,
          });
        }

        if (this.mode === 'mixed') {
          recordDecision('混合模式播放');
          return true;
        }

        if (this.mode === 'my-voice') {
          recordDecision('我的配音模式播放');
          return true;
        }

        recordDecision('准备播放录音');
        return true;
      }

      syncPlayUserRecording(segmentIndex, videoEl, segment = null) {
        const key = buildSegmentKey(segmentIndex);
        if (!key) return;
        const audio = this.userRecordings?.[key];
        if (!audio || !videoEl) return;
        this.clearPendingPlayback(key);
        this.bindMobileUnlockHooks();
        const readyState = audio.readyState;
        if (readyState < MEDIA_READY_THRESHOLD) {
          if (this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio)) {
            return;
          }
          return;
        }
        if (
          typeof HTMLMediaElement !== 'undefined' &&
          readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
          this.isMobileEnvironment &&
          this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio)
        ) {
          return;
        }
        if (
          typeof HTMLMediaElement !== 'undefined' &&
          readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
          typeof audio.play === 'function'
        ) {
          if (typeof audio.load === 'function') {
            try {
              audio.load();
            } catch (err) {
              console.warn('[音频模式] 强制加载录音失败:', err);
            }
          }
        }

        if (this.overlayAudio && this.overlayAudio !== audio) {
          try { this.overlayAudio.pause(); } catch (_) { }
        }

        this.overlayAudio = audio;
        const currentVolume = videoEl.volume;
        if (currentVolume > 0) {
          this.baseVolume = currentVolume;
        }
        // 确保 baseVolume 有默认值
        if (!this.baseVolume || this.baseVolume === 0) {
          this.baseVolume = 1;
        }
        // 只在当前音量大于0时才更新 originalVolume
        if (currentVolume > 0) {
          this.originalVolume = currentVolume;
        } else if (!this.originalVolume || this.originalVolume === 0) {
          this.originalVolume = this.baseVolume;
        }
        const assignedSpeaker = resolveSegmentSpeaker(segmentIndex);
        const segmentRole = determineSegmentRole(segmentIndex, assignedSpeaker);
        const isUserSegment = segmentRole === 'student';
        const shouldMuteVideo = this.mode === 'my-voice' || (this.mode === 'mixed' && isUserSegment);
        const targetVolume = this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);

        // 对话模式：输出详细的角色判断信息
        if (this.mode === 'mixed') {
          if (debugMode) {
            console.log('[音频模式] 混合模式判定', {
              assignedSpeaker,
              selectedSpeaker: this.selectedSpeaker,
              segmentRole,
              isUserSegment,
              shouldMuteVideo,
              action: shouldMuteVideo ? '播放录音' : '播放原声'
            });
          }
        }

        const normalizedIndex = normalizeSegmentIndex(segmentIndex);
        let segmentData = segment || null;
        if (!segmentData && Array.isArray(state.currentSegments)) {
          segmentData = state.currentSegments.find((item, idx) => {
            const rawIdx = item.index != null ? item.index : idx;
            if (buildSegmentKey(rawIdx) === key) return true;
            const normalized = normalizeSegmentIndex(rawIdx);
            if (normalizedIndex !== null && normalized === normalizedIndex) {
              return true;
            }
            return false;
          }) || null;
        }

        const currentTime = videoEl.currentTime;
        const segmentStart = Number(segmentData?.start);
        const audioDuration = Number(audio.duration);
        let playbackCooldownMs = this.minimumPlaybackCooldownMs;
        if (Number.isFinite(audioDuration) && audioDuration > 0) {
          playbackCooldownMs = Math.max(
            playbackCooldownMs,
            (audioDuration * 1000) + 250
          );
        }
        const normalizedSegmentStart = Number.isFinite(segmentStart) ? segmentStart : null;
        this.segmentPlaybackLog.set(key, {
          timestamp: performance.now(),
          cooldown: playbackCooldownMs,
          lastVideoTime: currentTime,
          segmentStart: normalizedSegmentStart,
        });

        if (debugMode) {
          console.log('[音频模式] 播放录音准备', {
            segmentIndex: key,
            shouldMuteVideo,
            mode: this.mode,
            isUserSegment,
            segmentRole,
          });
        }

        // 简化逻辑：不暂停视频，只是静音/取消静音
        if (shouldMuteVideo) {
          // 学生角色：暂停视频，平滑静音，播放录音，再跳到片段结尾
          const previousMuted = typeof videoEl.muted === 'boolean' ? videoEl.muted : false;
          const wasPaused = typeof videoEl.paused === 'boolean' ? videoEl.paused : false;

          // 针对 YouTube/HTML5 不同处理
          if (typeof isYouTubeVideo !== 'undefined' && isYouTubeVideo) {
            unifiedPlayer.mute();
          } else {
            try { videoEl.pause(); } catch (_) { }
            // Smooth fade-down then mute to avoid abrupt cut
            try { smoothMute(videoEl, DUCK_FADE_MS, 0); } catch (_) { videoEl.muted = true; videoEl.volume = 0; }
          }

          // 计算何时取消静音（录音结束时）
          const segmentEnd = Number(segmentData?.end);
          let unmuteTime;

          // 优先使用片段结束时间，因为我们会调整播放速度来匹配片段时长
          // 这样可以确保视频静音持续到片段结束，避免录音还在播放时就播放原声
          if (Number.isFinite(segmentEnd) && Number.isFinite(segmentStart)) {
            unmuteTime = segmentEnd;
          } else if (Number.isFinite(audioDuration) && audioDuration > 0 && Number.isFinite(segmentStart)) {
            // 备用方案：使用录音时长（但这可能不准确，因为播放速度会调整）
            unmuteTime = segmentStart + audioDuration;
          } else {
            unmuteTime = currentTime + 2;
          }

          this.overlayPlaybackState = {
            startTime: Number.isFinite(segmentStart) ? segmentStart : currentTime,
            pauseTime: currentTime,
            segmentRef: segmentData || null,
            unmuteTime,
            volumeRestored: false,
            previousMuted,
            previousPaused: wasPaused,
            videoPausedForRecording: true,
          };

          if (debugMode) {
            console.log('[音频模式] 静音播放录音', {
              segmentIndex: key,
              unmuteTime,
              audioDuration,
              segmentEnd,
              videoMuted: true,
              videoType: (typeof isYouTubeVideo !== 'undefined' && isYouTubeVideo) ? 'YouTube' : 'HTML5',
              videoPaused: false,  // 视频继续播放
            });
          }
        } else {
          // 其他角色：视频正常播放原声（平滑恢复）
          try { smoothUnmute(videoEl, targetVolume, DIALOG_FADE_IN_MS); } catch (_) { videoEl.muted = false; videoEl.volume = targetVolume; }
          this.overlayPlaybackState = null;

          if (debugMode) {
            console.log('[音频模式] 保持原声播放', {
              segmentIndex: key,
              videoMuted: false,
              videoVolume: targetVolume,
            });
          }
        }

        // CRITICAL: Reset audio element if it's in ended state
        // This prevents immediate ended event when calling play()
        if (audio.ended) {
          try {
            audio.currentTime = 0;
            if (debugMode) {
              console.log('[音频模式] 重置录音进度', {
                segmentIndex: key,
                wasEnded: true,
              });
            }
          } catch (err) {
            console.warn('[音频模式] 重置音频失败:', err);
          }
        }

        let startOffset = 0;
        const shouldTrimSilence = segmentRole === 'student';
        const isProcessedRecording = audio.dataset && audio.dataset.isProcessed === 'true';

        // 已处理的录音（从服务器加载的）已经裁剪过静音，不需要再应用偏移
        if (shouldTrimSilence && !isProcessedRecording) {
          // 优先使用存储的偏移信息（移动端虚拟裁剪或已处理的录音）
          if (audio.dataset && audio.dataset.startOffset !== undefined) {
            const storedOffset = Number(audio.dataset.startOffset);
            if (Number.isFinite(storedOffset) && storedOffset > 0) {
              startOffset = storedOffset;
              if (debugMode) {
                console.log('[音频模式] 使用缓存偏移', {
                  segmentIndex: key,
                  startOffset,
                });
              }
            }
          } else {
            // 回退到缓存的静音检测结果
            const cachedLeading = this.getCachedLeadingSilence(key, audio);
            if (Number.isFinite(cachedLeading) && cachedLeading > 0) {
              startOffset = cachedLeading;
            } else {
              this.scheduleLeadingSilenceAnalysis(key, audio);
            }
          }
        }
        try {
          const minStart = Math.max(startOffset, 0.01);
          const safeDurationCap = Number.isFinite(audio.duration)
            ? Math.max(audio.duration - 0.01, 0)
            : null;
          const targetTime = safeDurationCap != null ? Math.min(minStart, safeDurationCap) : minStart;

          if (debugMode) {
            console.log('[音频模式] 录音跳转前', {
              segmentIndex: key,
              startOffset,
              minStart,
              safeDurationCap,
              targetTime,
              duration: audio.duration,
              beforeCurrentTime: audio.currentTime,
            });
          }

          audio.currentTime = Number.isFinite(targetTime) ? targetTime : Math.max(startOffset, 0);

          if (debugMode) {
            console.log('[音频模式] 录音跳转后', {
              segmentIndex: key,
              currentTime: audio.currentTime,
              duration: audio.duration,
              ended: audio.ended,
            });
          }
        } catch (err) {
        }

        const handlePlaying = () => {
          if (debugMode) {
            console.log('[音频模式] 录音开始播放', {
              segmentIndex: key,
              readyState: audio.readyState,
              mode: this.mode,
              volume: audio.volume,
              muted: audio.muted,
              duration: audio.duration,
              currentTime: audio.currentTime,
              ended: audio.ended,
            });
          }
        };
        audio.addEventListener('playing', () => { try { audio.__ll_isPlaying = true; } catch (_) { }; handlePlaying(); }, { once: true });

        // Add comprehensive event tracking for debugging
        if (debugMode) {
          const events = ['pause', 'ended', 'suspend', 'abort', 'emptied', 'stalled', 'waiting'];
          events.forEach(eventName => {
            audio.addEventListener(eventName, (e) => {
              console.log('[音频模式] 录音事件', {
                segmentIndex: key,
                eventName,
                currentTime: audio.currentTime,
                duration: audio.duration,
                ended: audio.ended,
                paused: audio.paused,
                readyState: audio.readyState,
                networkState: audio.networkState,
              });
            }, { once: true });
          });
        }

        // Add timeupdate monitor BEFORE defining restoreVolume
        let timeUpdateCount = 0;
        const timeUpdateMonitor = () => {
          timeUpdateCount++;
          if (debugMode && timeUpdateCount % 5 === 1) {  // Log every 5th update to reduce noise
            console.log('[音频模式] 播放进度', {
              segmentIndex: key,
              updateCount: timeUpdateCount,
              currentTime: audio.currentTime,
              duration: audio.duration,
              ended: audio.ended,
              paused: audio.paused,
              volume: audio.volume,
              muted: audio.muted,
            });
          }
        };
        audio.addEventListener('timeupdate', timeUpdateMonitor);
        try {
          audio.addEventListener('ended', () => { try { audio.__ll_isPlaying = false; } catch (_) { } }, { once: true });
          audio.addEventListener('pause', () => { if (!audio.ended) { try { audio.__ll_isPlaying = false; } catch (_) { } } });
        } catch (_) { }

        // 初始将录音音量设为0，稍后平滑淡入；并应用去噪的播放窗口
        // 已处理的录音（服务器录音）已裁剪过静音，不需要应用偏移
        let trimStartOffset = 0;
        let trimEndOffset = 0;
        if (!isProcessedRecording) {
          try {
            if (audio.dataset && audio.dataset.startOffset !== undefined) {
              const so = Number(audio.dataset.startOffset);
              if (Number.isFinite(so) && so > 0) trimStartOffset = so;
            }
            if (audio.dataset && audio.dataset.endOffset !== undefined) {
              const eo = Number(audio.dataset.endOffset);
              if (Number.isFinite(eo) && eo > 0) trimEndOffset = eo;
            }
          } catch (_) { }
        }
        const effectiveAudioDuration = Number.isFinite(audioDuration) ? Math.max(0, audioDuration - trimStartOffset - trimEndOffset) : audioDuration;
        try { audio.volume = 0.0; } catch (_) { }

        // 播放速度调整 - 让录音时长匹配片段剩余窗口
        if (shouldMuteVideo && Number.isFinite(effectiveAudioDuration) && effectiveAudioDuration > 0) {
          const segmentEnd = Number(segmentData?.end);
          const segmentStart = Number(segmentData?.start);

          if (Number.isFinite(segmentStart) && Number.isFinite(segmentEnd)) {
            const segmentDuration = segmentEnd - segmentStart;
            const remainingWindow = segmentEnd - currentTime;

            if (segmentDuration > 0) {
              // 计算需要的播放速度（优先压缩以适配剩余窗口）
              let idealPlaybackRate = effectiveAudioDuration / segmentDuration;
              if (Number.isFinite(remainingWindow) && remainingWindow > 0) {
                idealPlaybackRate = effectiveAudioDuration / remainingWindow;
              }

              // 限制在合理范围内 (0.8x - 1.8x)
              // 太快或太慢会听起来不自然
              // Narrow the range to keep playback natural
              const minRate = 0.9;
              const maxRate = 1.35;
              const playbackRate = Math.min(Math.max(idealPlaybackRate, minRate), maxRate);

              // 只有在明显不同于1.0时才调整速度
              if (Math.abs(playbackRate - 1.0) > 0.05) {
                audio.playbackRate = playbackRate;

                if (debugMode) {
                  console.log('[音频模式] 调整播放速度', {
                    segmentIndex: key,
                    audioDuration: effectiveAudioDuration.toFixed(2),
                    segmentDuration: segmentDuration.toFixed(2),
                    remainingWindow: Number.isFinite(remainingWindow) ? remainingWindow.toFixed(2) : null,
                    idealRate: idealPlaybackRate.toFixed(2),
                    actualRate: playbackRate.toFixed(2),
                    wasLimited: idealPlaybackRate !== playbackRate,
                  });
                }
              } else {
                // 保持正常速度
                audio.playbackRate = 1.0;

                if (debugMode) {
                  console.log('[音频模式] 保持正常速度', {
                    segmentIndex: key,
                    audioDuration: audioDuration.toFixed(2),
                    segmentDuration: segmentDuration.toFixed(2),
                  });
                }
              }
            }
          }
        } else {
          // 非学生片段或时长无效，使用正常速度
          audio.playbackRate = 1.0;
        }

        let playPromise = null;
        try {
          playPromise = audio.play();

          // 🔊 音量淡入逻辑 - 在播放开始后立即执行
          // 确保录音从静音平滑过渡到正常音量，避免突然出现的爆音
          const fadeInDuration = 140; // 淡入持续时间 (ms)
          const fadeInSteps = 14; // 淡入步数
          const volumeIncrement = 1.0 / fadeInSteps;
          const fadeInInterval = fadeInDuration / fadeInSteps;

          let currentStep = 0;
          const fadeInTimer = setInterval(() => {
            currentStep++;
            const newVolume = Math.min(currentStep * volumeIncrement, 1.0);

            try {
              audio.volume = newVolume;
              if (debugMode) {
                console.log('[音频模式] 音量淡入', {
                  segmentIndex: key,
                  step: currentStep,
                  volume: newVolume.toFixed(2),
                  mode: window.audioMode
                });
              }
            } catch (e) {
              console.error('[AudioDebug] 设置音量失败:', e);
            }

            if (currentStep >= fadeInSteps) {
              clearInterval(fadeInTimer);
              if (debugMode) {
                console.log('[音频模式] 音量淡入完成', {
                  segmentIndex: key,
                  finalVolume: audio.volume,
                  mode: window.audioMode
                });
              }
            }
          }, fadeInInterval);

          // 在音频结束时清理淡入定时器
          const cleanupFadeIn = () => {
            clearInterval(fadeInTimer);
          };
          audio.addEventListener('ended', cleanupFadeIn, { once: true });
          audio.addEventListener('pause', cleanupFadeIn, { once: true });

        } catch (err) {
          this.segmentPlaybackLog.delete(key);
          audio.removeEventListener('playing', handlePlaying);
          console.error('[音频模式] 播放录音失败详情', {
            segmentIndex: key,
            error: err?.name || 'Error',
            message: err?.message,
          });
          console.error('[音频模式] 播放录音失败:', err);
          this.teardownAnalyser(audio);
          if (this.isMobileEnvironment && !this.isAudioUnlocked) {
            this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio);
          }
          const previousMuted = this.overlayPlaybackState?.previousMuted;
          let volumeToRestore =
            this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
          // 确保恢复的音量不是0
          if (volumeToRestore === 0 || !volumeToRestore) {
            volumeToRestore = 1;
          }
          videoEl.volume = volumeToRestore;
          if (typeof previousMuted === 'boolean') {
            videoEl.muted = previousMuted;
          } else {
            videoEl.muted = false;
          }
          this.originalVolume = null;
          if (this.overlayAudio === audio) {
            this.overlayAudio = null;
          }
          if (this.overlayPlaybackState) {
            this.overlayPlaybackState = null;
          }
          return;
        }

        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            this.segmentPlaybackLog.delete(key);
            audio.removeEventListener('playing', handlePlaying);
            console.error('[音频模式] 播放录音失败详情', {
              segmentIndex: key,
              error: err?.name || 'Error',
              message: err?.message,
            });
            console.error('[音频模式] 播放录音失败:', err);
            this.teardownAnalyser(audio);
            if (this.isMobileEnvironment && !this.isAudioUnlocked) {
              this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio);
            }
            const previousMuted = this.overlayPlaybackState?.previousMuted;
            let volumeToRestore =
              this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
            // 确保恢复的音量不是0
            if (volumeToRestore === 0 || !volumeToRestore) {
              volumeToRestore = 1;
            }
            videoEl.volume = volumeToRestore;
            if (typeof previousMuted === 'boolean') {
              videoEl.muted = previousMuted;
            } else {
              videoEl.muted = false;
            }
            this.originalVolume = null;
            if (this.overlayAudio === audio) {
              this.overlayAudio = null;
            }
            if (this.overlayPlaybackState) {
              this.overlayPlaybackState = null;
            }
          });
        }

        let restoreVolumeCalled = false;
        const restoreVolume = () => {
          // Prevent duplicate calls to restoreVolume
          if (restoreVolumeCalled) {
            if (debugMode) {
              console.log('[音频模式] restoreVolume 已调用，跳过重复', {
                segmentIndex: key,
                mode: this.mode,
              });
            }
            return;
          }
          restoreVolumeCalled = true;

          // Clean up timeupdate monitor
          audio.removeEventListener('timeupdate', timeUpdateMonitor);
          if (debugMode) {
            console.log('[音频模式] timeupdate 监控结束', {
              segmentIndex: key,
              totalUpdates: timeUpdateCount,
            });
          }

          if (debugMode) {
            console.log('[音频模式] restoreVolume 前状态', {
              segmentIndex: key,
              mode: this.mode,
              duration: audio.duration,
              ended: audio.ended,
              paused: audio.paused,
              videoMuted: videoEl.muted,
              videoVolume: videoEl.volume,
              originalVolume: this.originalVolume,
              baseVolume: this.baseVolume,
              timeUpdateCount,
            });
          }
          this.teardownAnalyser(audio);
          let volumeToRestore =
            this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
          // 确保恢复的音量不是0
          if (volumeToRestore === 0 || !volumeToRestore) {
            volumeToRestore = 1;
          }
          videoEl.volume = volumeToRestore;
          this.originalVolume = null;

          if (debugMode) {
            console.log('[音频模式] restoreVolume 状态', {
              segmentIndex: key,
              hasOverlayPlaybackState: !!this.overlayPlaybackState,
              overlayPlaybackState: this.overlayPlaybackState ? {
                videoPausedForRecording: this.overlayPlaybackState.videoPausedForRecording,
                previousPaused: this.overlayPlaybackState.previousPaused,
                volumeRestored: this.overlayPlaybackState.volumeRestored,
              } : null,
            });
          }

          if (this.overlayPlaybackState) {
            this.handlePostOverlayPlayback(videoEl, audio);
          } else if (debugMode) {
            console.log('[音频模式] 无需 overlay 处理', {
              segmentIndex: key,
            });
          }

          if (audio === this.overlayAudio) {
            this.overlayAudio = null;
          }
          audio.onended = null;
          audio.onpause = null;

          // DON'T reset currentTime here - it causes issues with browser audio state
          // We already handle ended state check before playing in syncPlayUserRecording
        };

        // IMPORTANT: Only bind to onended, NOT onpause
        // Binding to onpause causes issues when audio is paused for other reasons
        audio.onended = restoreVolume;
        // audio.onpause = restoreVolume;  // REMOVED: This was causing premature cleanup

        // Mark this segment as played until its end to prevent re-trigger
        try {
          const endSec = Number(segmentData?.end);
          const guardUntil = Number.isFinite(endSec) ? (endSec + 0.2) : ((segmentData?.start || 0) + 2.5);
          if (this.playedGuard) this.playedGuard.set(key, guardUntil);
        } catch (_) { }

        // Smooth fade-in as playback starts
        try {
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.then(() => rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 0, 1.0, VOICE_FADE_IN_MS));
          } else {
            rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 0, 1.0, VOICE_FADE_IN_MS);
          }
        } catch (_) { }

        // Schedule a short fade-out near the (trimmed) end to avoid clicks
        try {
          const fadeOutMs = VOICE_FADE_OUT_MS;
          let rafId = 0;
          const fadeUpdate = () => {
            if (!audio || audio.ended || audio.paused || !Number.isFinite(audio.duration)) return;
            const endOffset = (() => { try { return Number(audio.dataset?.endOffset) || 0; } catch (_) { return 0; } })();
            const trimmedEnd = Math.max(0, (audio.duration - endOffset));
            const remain = (trimmedEnd - audio.currentTime) * 1000;
            if (remain <= fadeOutMs && !audio.__fadingOut) {
              audio.__fadingOut = true;
              rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 1, 0.0, Math.max(40, remain)).catch(() => { });
              setTimeout(() => { try { audio.pause(); } catch (_) { } }, Math.max(0, remain));
              return;
            }
            rafId = requestAnimationFrame(fadeUpdate);
          };
          if (typeof requestAnimationFrame === 'function') {
            rafId = requestAnimationFrame(fadeUpdate);
          }
        } catch (_) { }

        this.lastPlaybackSegment = normalizeSegmentIndex(segmentIndex) ?? segmentIndex;
        this.lastPlaybackKey = key;
        this.lastPlaybackTimestamp = performance.now();
        if (debugMode) {
          console.log('[音频模式] 录音播放触发', {
            segmentIndex: key,
            mode: this.mode,
            assignedSpeaker,
            role: segmentRole,
          });
        }
        // Opportunistically preload the next user recording to reduce gaps
        try {
          const seq = normalizeSegmentIndex(segmentIndex);
          const nextSeq = Number.isFinite(seq) ? seq + 1 : null;
          if (nextSeq != null) {
            const nextKey = buildSegmentKey(nextSeq);
            const nextAudio = this.userRecordings?.[nextKey];
            if (nextAudio && nextAudio.readyState < (window.HTMLMediaElement?.HAVE_FUTURE_DATA || 3)) {
              if (typeof nextAudio.load === 'function') {
                nextAudio.load();
              }
            }
          }
        } catch (_) { }
      }

      handlePostOverlayPlayback(videoEl, audio) {
        if (!this.overlayPlaybackState || !videoEl) return;
        const {
          previousMuted,
          previousPaused,
          unmuteTime,
          videoPausedForRecording,
        } = this.overlayPlaybackState;

        // 简化逻辑：只需要恢复音量
        let volumeToRestore =
          this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
        if (volumeToRestore === 0 || !volumeToRestore) {
          volumeToRestore = 1;
        }

        // Smoothly restore volume (shorter than dialog fade-in)
        try { rampVolume(videoEl, Number.isFinite(videoEl.volume) ? videoEl.volume : 0, volumeToRestore, RESTORE_FADE_MS); } catch (_) { videoEl.volume = volumeToRestore; }

        // 混合模式下：不要立即取消静音！
        // 让 maybeRestoreVideoVolume 在 unmuteTime 时再取消静音，避免录音结束后到片段结束之间播放原声
        if (this.mode === 'mixed') {
          const currentTime = videoEl.currentTime;
          const targetUnmuteTime = Number(unmuteTime);

          // 只有当视频已经播放到或超过 unmuteTime 时，才立即取消静音
          // 否则保持静音，等待 maybeRestoreVideoVolume 在合适的时机取消
          // 增加缓冲时间到0.15秒，确保不会过早取消静音
          if (Number.isFinite(targetUnmuteTime) && currentTime < targetUnmuteTime - 0.15) {
            // 保持静音，不做任何操作
            // maybeRestoreVideoVolume 会在 unmuteTime 时取消静音
            if (debugMode) {
              console.log('[音频模式] 等待取消静音', {
                volumeRestored: volumeToRestore,
                videoMuted: true,  // 仍然静音
                videoPaused: videoEl.paused,
                currentTime: currentTime.toFixed(2),
                unmuteTime: targetUnmuteTime.toFixed(2),
                waitTime: (targetUnmuteTime - currentTime).toFixed(2),
                mode: this.mode,
              });
            }
          } else {
            // 已经到达或超过 unmuteTime-0.15，可以取消静音了
            videoEl.muted = false;
            if (debugMode) {
              console.log('[音频模式] 取消静音', {
                volumeRestored: volumeToRestore,
                videoMuted: false,
                videoPaused: videoEl.paused,
                currentTime: currentTime.toFixed(2),
                unmuteTime: targetUnmuteTime.toFixed(2),
                mode: this.mode,
              });
            }
          }
        } else if (typeof previousMuted === 'boolean') {
          videoEl.muted = previousMuted;
          if (!previousMuted) {
            try { smoothUnmute(videoEl, volumeToRestore, RESTORE_FADE_MS); } catch (_) { }
          }
        }

        // 如果是为了学生录音而暂停的视频，录音结束后跳到片段末尾并恢复播放
        if (videoPausedForRecording) {
          try {
            if (Number.isFinite(unmuteTime)) {
              videoEl.currentTime = unmuteTime;
            }
            if (previousPaused === false) {
              if (typeof window.safePlayVideo === 'function') {
                window.safePlayVideo();
              } else {
                videoEl.play().catch(() => { });
              }
            }
          } catch (_) { }
        }

        // 不要清除 overlayPlaybackState，让 maybeRestoreVideoVolume 继续工作
        // this.overlayPlaybackState = null;
      }

      maybeRestoreVideoVolume(videoEl, currentTime) {
        if (!this.overlayPlaybackState || !videoEl) return;
        // 若用户录音仍在播放，严禁恢复视频音量，避免录音与原声混杂
        try {
          if (this.overlayAudio && !this.overlayAudio.ended && !this.overlayAudio.paused) {
            return;
          }
        } catch (_) { }
        if (this.mode !== 'mixed') return;
        const { unmuteTime, volumeRestored, segmentRef } = this.overlayPlaybackState;
        if (volumeRestored) return;
        const targetTime = Number(unmuteTime);
        if (!Number.isFinite(targetTime)) return;
        // 在片段结束前0.05秒取消静音，给予一些提前量以补偿处理延迟
        if (currentTime < targetTime - 0.05) return;

        let volumeToRestore =
          this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
        // 确保恢复的音量不是0
        if (volumeToRestore === 0 || !volumeToRestore) {
          volumeToRestore = 1;
        }

        if (typeof isYouTubeVideo !== 'undefined' && isYouTubeVideo) {
          unifiedPlayer.unmute();
        } else {
          try { rampVolume(videoEl, Number.isFinite(videoEl.volume) ? videoEl.volume : 0, volumeToRestore, RESTORE_FADE_MS); } catch (_) { videoEl.volume = volumeToRestore; }
          // 混合模式下，录音播放结束后必须取消muted，以便播放原声段落
          videoEl.muted = false;
        }

        if (debugMode) {
          console.log('[音频模式] maybeRestoreVideoVolume', {
            currentTime: currentTime.toFixed(2),
            unmuteTime: targetTime.toFixed(2),
            segmentIndex: segmentRef?.index ?? null,
          });
        }

        // 清除状态，避免影响下一个片段
        this.overlayPlaybackState = null;
      }

      cleanup(videoEl = videoPlayer) {
        const stateSnapshot = this.overlayPlaybackState
          ? { ...this.overlayPlaybackState }
          : null;
        if (this.overlayAudio) {
          const overlayAudioRef = this.overlayAudio;
          try {
            overlayAudioRef.pause();
            overlayAudioRef.currentTime = 0;
          } catch (err) {
            console.warn('[音频模式] 无法停止叠加音频:', err);
          }
          this.teardownAnalyser(overlayAudioRef);
          this.overlayAudio = null;
        }
        if (videoEl) {
          let volumeToRestore =
            this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
          // 确保恢复的音量不是0
          if (volumeToRestore === 0 || !volumeToRestore) {
            volumeToRestore = 1;
          }
          videoEl.volume = volumeToRestore;
          if (typeof stateSnapshot?.previousMuted === 'boolean') {
            videoEl.muted = stateSnapshot.previousMuted;
          } else {
            videoEl.muted = false;
          }

          if (typeof isYouTubeVideo !== 'undefined' && isYouTubeVideo) {
            // 对于YouTube，cleanup时总是尝试取消静音，除非我们能准确追踪之前的静音状态
            // 但为了安全起见（避免用户困在静音状态），这里直接unmute
            unifiedPlayer.unmute();
          }
          // 如果视频是因为录音播放而暂停的，恢复视频播放
          if (stateSnapshot?.videoPausedForRecording &&
            videoEl.paused &&
            !stateSnapshot?.previousPaused) {
            try {
              const playPromise = videoEl.play();
              if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch((err) => {
                  console.warn('[音频模式] 清理时恢复视频播放失败:', err);
                });
              }
            } catch (err) {
              console.warn('[音频模式] 清理时恢复视频播放失败:', err);
            }
          }
        }
        this.originalVolume = null;
        this.overlayPlaybackState = null;
        this.lastPlaybackSegment = null;
        this.lastPlaybackKey = null;
        this.lastPlaybackTimestamp = 0;
        this.clearAllPendingPlayback();
        this.disposeAllAnalysers();
      }

    }

    // ===== Feedback helpers (common in feedback.js) + page progress =====
    function updatePracticeProgress() {
      if (!practiceProgressEl) return;
      const total = Array.isArray(state.practiceLines) ? state.practiceLines.length : 0;
      let done = 0;
      if (total > 0 && state.practiceLineResults) {
        for (const v of Object.values(state.practiceLineResults)) if (v === 'success') done++;
      }
      practiceProgressEl.textContent = `✅ ${done}/${total}`;
      practiceProgressEl.hidden = total === 0;
      updatePracticeProgressRing(done, total);
    }

    function updatePracticeProgressRing(done, total) {
      const ring = document.getElementById('practice-progress-ring');
      const valueEl = document.getElementById('practice-progress-ring-value');
      if (!ring || !valueEl) return;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      ring.style.setProperty('--progress', `${pct}%`);
      valueEl.textContent = `${pct}%`;
      ring.style.opacity = total > 0 ? '1' : '0';
    }

    const audioModeManager = new AudioModeManager();
    let currentAudioMode = 'original';

    function updateAudioModeButtons() {
      audioModeBtns.forEach((btn) => {
        const mode = btn.dataset.mode || 'original';
        btn.classList.toggle('active', mode === currentAudioMode);
      });
    }

    function ensureAudioModeAvailability() {
      const matchingBtn = audioModeBtns.find((btn) => btn.dataset.mode === currentAudioMode);
      if (!matchingBtn || matchingBtn.disabled) {
        currentAudioMode = 'original';
      }
    }

    // 更新音频模式按钮的可用性（防止练习时误触）
    function updateAudioModeButtonsAvailability() {
      audioModeBtns.forEach((btn) => {
        const mode = btn.dataset.mode || 'original';

        // 在自动练习模式且未暂停时，禁用非原声按钮防止误触
        // 只有在用户主动暂停时才允许切换模式试听效果
        if (state.autoMode && !state.isPaused && mode !== 'original') {
          btn.disabled = true;
          btn.style.opacity = '0.5';
          btn.style.cursor = 'not-allowed';
          btn.title = '练习中暂时禁用，试听请先点击暂停 ⏸';
        } else {
          // 暂停状态或非练习模式时，根据录音数量决定可用性
          const count = audioModeManager ? Object.keys(audioModeManager.userRecordings || {}).length : 0;
          const shouldDisable = count === 0 && mode !== 'original';
          btn.disabled = shouldDisable;
          btn.style.opacity = shouldDisable ? '0.5' : '1';
          btn.style.cursor = shouldDisable ? 'not-allowed' : 'pointer';

          // 设置标题
          if (mode === 'original') {
            btn.title = '播放原声';
          } else if (mode === 'my-voice') {
            btn.title = shouldDisable ? '请先录制配音' : '播放我的配音';
          } else if (mode === 'mixed') {
            btn.title = shouldDisable ? '请先录制配音' : '我配音+其他原声';
          }
        }
      });
    }

    function ensureToken() {
      if (isShareMode()) return true;
      const token = refreshAuthToken();
      if (!token) {
        updatePracticeFeedback('登录后就能跟读这一句，进度也会留下来。', '#0f766e');
        return false;
      }
      return true;
    }

    function buildRecordingUrl(rawPath, updatedAt) {
      if (!rawPath) return null;
      if (rawPath.startsWith('data:') || rawPath.startsWith('blob:')) {
        return rawPath;
      }
      let baseUrl = rawPath;
      if (!/^https?:\/\//i.test(baseUrl)) {
        baseUrl = `${API_BASE}${rawPath}`;
      }
      const params = new URLSearchParams();
      if (isShareMode() && shareToken) {
        params.set('share', shareToken);
      }
      if (updatedAt) {
        const ts = new Date(updatedAt).getTime();
        if (Number.isFinite(ts)) {
          params.set('v', ts.toString());
        }
      }
      const queryString = params.toString();
      if (queryString) {
        baseUrl += baseUrl.includes('?') ? `&${queryString}` : `?${queryString}`;
      }
      return baseUrl;
    }

    function buildProtectedUrl(rawPath, updatedAt) {
      if (!rawPath) return null;
      let baseUrl = rawPath;
      if (!/^https?:\/\//i.test(baseUrl)) {
        baseUrl = `${API_BASE}${rawPath}`;
      }
      const params = new URLSearchParams();
      if (isShareMode() && shareToken) {
        params.set('share', shareToken);
      }
      if (updatedAt) {
        const ts = new Date(updatedAt).getTime();
        if (Number.isFinite(ts)) {
          params.set('v', ts.toString());
        }
      }
      const queryString = params.toString();
      if (queryString) {
        baseUrl += baseUrl.includes('?') ? `&${queryString}` : `?${queryString}`;
      }
      return baseUrl;
    }

    async function authorizeProtectedMediaSource(element, rawPath, updatedAt) {
      const source = buildProtectedUrl(rawPath, updatedAt);
      if (!source) throw new Error('MEDIA_SOURCE_REQUIRED');
      if (source.startsWith('data:') || source.startsWith('blob:') || isShareMode()) {
        element.src = source;
        return source;
      }
      const accountToken = refreshAuthToken();
      const mediaSession = window.LinglishMediaSession;
      if (!accountToken || !mediaSession) throw new Error('MEDIA_SESSION_UNAVAILABLE');
      const mediaState = await mediaSession.ensure({ token: accountToken });
      return mediaSession.setElementSource(element, source, {
        mode: mediaState.mode,
        legacyToken: accountToken,
      });
    }

    async function setProtectedMediaSource(element, rawPath, updatedAt) {
      try {
        return await authorizeProtectedMediaSource(element, rawPath, updatedAt);
      } catch (error) {
        if (window.LinglishMediaSession) {
          try { await window.LinglishMediaSession.clear(); } catch (_) { }
        }
        return authorizeProtectedMediaSource(element, rawPath, updatedAt);
      }
    }

    window.LinglishMediaSession?.bindLifecycle({
      getToken: () => isShareMode() ? null : refreshAuthToken(),
      onError: () => updatePracticeFeedback('媒体授权已失效，请重试', '#dc2626'),
    });

    async function loadVideoPlayer(rawVideoPath, localVideoPath, localVideoStatus) {
      isYouTubeVideo = isYouTubeUrl(rawVideoPath);
      if (isYouTubeVideo) {
        if (state.isMainlandUser) {
          const hasLocalVideo = localVideoPath && localVideoStatus === 'completed';
          if (hasLocalVideo) {
            isYouTubeVideo = false;
            videoPlayer.style.display = 'block';
            youtubePlayerContainer.style.display = 'none';
            videoPlayer.removeAttribute('src');
            videoPlayer.load();
            try {
              await setProtectedMediaSource(videoPlayer, localVideoPath);
            } catch (_) {
              updatePracticeFeedback('媒体授权失败，请重试', '#dc2626');
              return;
            }
            videoPlayer.load();
            return;
          }
          videoPlayer.style.display = 'none';
          youtubePlayerContainer.style.display = 'block';
          youtubePlayerContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:14px;text-align:center;padding:20px;">该视频暂无本地版本，无法播放</div>';
          updatePracticeFeedback('该视频暂无本地版本', '#f59e0b');
          return;
        }

        const videoId = extractYouTubeVideoId(rawVideoPath);
        if (!videoId) {
          console.error('[YouTube] Failed to extract video ID');
          updatePracticeFeedback('无法解析YouTube视频ID');
          return;
        }

        if (youtubePlayerInitializing) {
          return;
        }

        if (youtubePlayer) {
          try {
            const currentVideoData = youtubePlayer.getVideoData && youtubePlayer.getVideoData();
            if (currentVideoData && currentVideoData.video_id === videoId) {
              return;
            }
          } catch (e) {
            console.warn('[YouTube] Error checking existing player:', e);
          }
        }

        youtubePlayerInitializing = true;
        videoPlayer.style.display = 'none';
        youtubePlayerContainer.style.display = 'block';

        const waitForYouTubeAPI = (timeoutMs = 3000) => {
          return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const check = () => {
              if (youtubeApiReady && window.YT && window.YT.Player) {
                resolve(true);
              } else if (Date.now() - startTime > timeoutMs) {
                console.warn('[YouTube] API load timeout, continuing without YouTube player');
                reject(new Error('YouTube API timeout'));
              } else {
                setTimeout(check, 100);
              }
            };
            check();
          });
        };

        try {
          await waitForYouTubeAPI();
        } catch (err) {
          console.warn('[YouTube] Failed to load API:', err);
          youtubePlayerInitializing = false;
          updatePracticeFeedback('YouTube API 加载失败，但字幕已加载', '#f59e0b');
          return;
        }

        if (youtubePlayer) {
          try {
            stopYouTubeTimeUpdatePolling();
            youtubePlayer.destroy();
            youtubePlayer = null;
          } catch (e) {
            console.warn('[YouTube] Error destroying old player:', e);
          }
        }

        youtubePlayerContainer.innerHTML = '';
        updatePracticeFeedback('正在加载YouTube视频...');
        youtubePlayer = new YT.Player('youtube-player-container', {
          videoId: videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            enablejsapi: 1,
            origin: getYouTubeOrigin()
          },
          events: {
            onReady: () => {
              youtubePlayerInitializing = false;
              if (playOverlay) playOverlay.style.display = 'none';
              updatePracticeFeedback('YouTube视频已加载');
              startYouTubeTimeUpdatePolling();
            },
            onStateChange: (event) => {
              if (event.data === 0) {
                stopYouTubeTimeUpdatePolling();
              } else if (event.data === 1) {
                if (!youtubeTimeUpdateInterval) {
                  startYouTubeTimeUpdatePolling();
                }
              }
            },
            onError: (event) => {
              console.error('[YouTube] Player error:', event.data);
              youtubePlayerInitializing = false;
              updatePracticeFeedback('YouTube视频加载失败');
            }
          }
        });
        return;
      }

      isYouTubeVideo = false;
      videoPlayer.style.display = 'block';
      youtubePlayerContainer.style.display = 'none';
      videoPlayer.removeAttribute('src');
      videoPlayer.load();
      try {
        await setProtectedMediaSource(videoPlayer, rawVideoPath);
      } catch (_) {
        updatePracticeFeedback('媒体授权失败，请重试', '#dc2626');
        return;
      }
      videoPlayer.load();
    }

    async function fetchPracticeRecordings(videoId, speaker = null) {
      const token = refreshAuthToken();
      if (!token || !videoId) return [];
      const speakerQuery = speaker ? `?speaker=${encodeURIComponent(speaker)}` : '';
      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}/recordings${speakerQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          console.warn('[录音] 获取失败，未授权');
          return [];
        }
        if (!res.ok) {
          console.warn('[录音] 获取失败，状态码:', res.status);
          return [];
        }
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        return items;
      } catch (err) {
        console.warn('Failed to fetch practice recordings:', err);
        return [];
      }
    }

    async function uploadRecordingToServer({ videoId, segmentIndex, speaker, audioData, durationSec }) {
      const token = refreshAuthToken();
      if (!token || !videoId) return null;
      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}/recordings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            segmentIndex,
            speaker,
            audioData,
            durationSec,
          }),
        });

        if (res.status === 401) {
          alert('登录信息已过期，请重新登录。');
          throw new Error('UNAUTHORIZED');
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `上传失败 (${res.status})`);
        }
        const data = await res.json();
        return data?.recording || null;
      } catch (err) {
        console.error('[录音上传] 失败:', err);
        throw err;
      }
    }

    // Unified video player interface (supports both HTML5 video and YouTube iframe)
    const unifiedPlayer = {
      async play() {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.playVideo();
        } else {
          await videoPlayer.play();
        }
      },
      pause() {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.pauseVideo();
        } else {
          videoPlayer.pause();
        }
      },
      getCurrentTime() {
        if (isYouTubeVideo && youtubePlayer) {
          return youtubePlayer.getCurrentTime() || 0;
        }
        return videoPlayer.currentTime || 0;
      },
      setCurrentTime(time) {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.seekTo(time, true);
        } else {
          videoPlayer.currentTime = time;
        }
      },
      getDuration() {
        if (isYouTubeVideo && youtubePlayer) {
          return youtubePlayer.getDuration() || 0;
        }
        return videoPlayer.duration || 0;
      },
      setPlaybackRate(rate) {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.setPlaybackRate(rate);
        } else {
          videoPlayer.playbackRate = rate;
        }
      },
      getPlaybackRate() {
        if (isYouTubeVideo && youtubePlayer) {
          return youtubePlayer.getPlaybackRate() || 1.0;
        }
        return videoPlayer.playbackRate || 1.0;
      },
      isPaused() {
        if (isYouTubeVideo && youtubePlayer) {
          const state = youtubePlayer.getPlayerState();
          // YT.PlayerState: UNSTARTED=-1, ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
          return state !== 1 && state !== 3; // Not playing or buffering
        }
        return videoPlayer.paused;
      },
      mute() {
        if (isYouTubeVideo && youtubePlayer && typeof youtubePlayer.mute === 'function') {
          youtubePlayer.mute();
        } else if (videoPlayer) {
          videoPlayer.muted = true;
        }
      },
      unmute() {
        if (isYouTubeVideo && youtubePlayer && typeof youtubePlayer.unMute === 'function') {
          youtubePlayer.unMute();
        } else if (videoPlayer) {
          videoPlayer.muted = false;
        }
      },
      isMuted() {
        if (isYouTubeVideo && youtubePlayer) {
          return youtubePlayer.isMuted();
        }
        return videoPlayer.muted;
      },
      setVolume(volume) {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.setVolume(volume * 100); // YouTube expects 0-100
        } else {
          videoPlayer.volume = volume;
        }
      }
    };

    // Active Pause State for Mobile
    state.activePause = {
      isActive: false,
      pauseTime: 0,
      rafId: null,
      originalMuted: false
    };

    function safePauseVideo() {
      const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;

      // YouTube doesn't support Active Pause (playbackRate trick), always use real pause
      if (isYouTubeVideo) {
        unifiedPlayer.pause();
        return;
      }

      if (isMobile) {
        // Implement Active Pause (Fake Pause) using playbackRate for HTML5 video
        if (state.activePause.isActive) return; // Already paused

        state.activePause.isActive = true;
        state.activePause.pauseTime = videoPlayer.currentTime;
        state.activePause.originalMuted = videoPlayer.muted;

        // Mute video to avoid audio stutter
        videoPlayer.muted = true;

        // Slow down to almost stop (0.0625 is the minimum supported rate in most browsers)
        videoPlayer.playbackRate = 0.0625;

      } else {
        // Desktop: Standard pause
        videoPlayer.pause();
      }
    }

    async function safePlayVideo(options = {}) {
      const preferUnmuted = options.preferUnmuted !== false; // default true

      // YouTube: Simple play
      if (isYouTubeVideo) {
        try {
          await unifiedPlayer.play();
          if (playOverlay) playOverlay.style.display = 'none';
          return true;
        } catch (e) {
          console.warn('[YouTube] Play failed:', e);
          return false;
        }
      }

      // HTML5 video: Handle Active Pause Resume
      if (state.activePause && state.activePause.isActive) {
        state.activePause.isActive = false;

        // Restore playback rate
        videoPlayer.playbackRate = 1.0;

        // Restore mute state (unless we want to unmute)
        if (preferUnmuted) {
          videoPlayer.muted = false;
        } else {
          videoPlayer.muted = state.activePause.originalMuted;
        }

        // Ensure it is playing (it should be, but just in case)
        if (videoPlayer.paused) {
          try {
            await videoPlayer.play();
            return true;
          } catch (e) {
            console.warn('Active Pause resume failed to play:', e);
            // Fallthrough to standard recovery
          }
        } else {
          return true;
        }
      }

      try {
        await videoPlayer.play();
        if (playOverlay) playOverlay.style.display = 'none';
        return true;
      } catch (err) {
        // Autoplay policy may block. Try muted-play workaround then unmute.
        try {
          const prevMuted = videoPlayer.muted;
          videoPlayer.muted = true;
          await videoPlayer.play();
          if (playOverlay) playOverlay.style.display = 'none';
          // 仅在没有处于"用户录音覆盖静音窗口/学生预静音守卫"时再尝试解除静音
          const inOverlayMute = !!(audioModeManager && audioModeManager.overlayPlaybackState);
          const guardActive = !!(state && state.studentGuard && state.studentGuard.key);
          if (preferUnmuted && !inOverlayMute && !guardActive) {
            // unmute slightly later to avoid autoplay rejection
            setTimeout(() => {
              try { videoPlayer.muted = prevMuted === false ? false : false; } catch (_) { }
            }, 120);
          }
          return true;
        } catch (e2) {
          console.warn('Unable to autoplay video (even muted):', e2);
          // Show "Tap to Continue" overlay if autoplay fails completely (common on mobile)
          if (playOverlay) {
            playOverlay.style.display = 'flex';
            playOverlay.innerHTML = '<div class="play-overlay-icon"></div><div style="position:absolute;bottom:20%;color:white;font-weight:bold;text-shadow:0 2px 4px rgba(0,0,0,0.5);">点击继续播放</div>';
            playOverlay.onclick = () => {
              videoPlayer.play().then(() => {
                playOverlay.style.display = 'none';
              }).catch(e => console.error('Manual play failed:', e));
            };
          }
          return false;
        }
      }
    }

    function updatePracticeHint() {
      if (!practiceHintEl) return;
      if (!state.speakers.length) {
        practiceHintEl.textContent = '当前视频暂无角色扮演数据，先阅读完整台词。';
      } else if (!state.selectedSpeaker) {
        practiceHintEl.textContent = 'Auto-pause video for each of your lines. 请先选择你要扮演的角色。';
      } else if (state.practiceArmed) {
        practiceHintEl.textContent = 'Practice mode 已启用，视频会在你的台词前暂停。';
      } else {
        practiceHintEl.textContent = 'Auto-pause video for each of your lines.';
      }
    }

    // Role controls handlers
    if (roleCountSelect) {
      roleCountSelect.addEventListener('change', () => {
        const v = roleCountSelect.value;
        state.roleCount = v;
        if (!state.hasServerSpeakers) {
          buildInferredSpeakers();
          populateSpeakerSelect();
          generateRoleButtons();
          // 保持已选角色（如果仍存在），否则选第一个
          if (practiceSpeakerSelect) {
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value;
            const exists = state.speakers.some(s => s.speaker === cur);
            practiceSpeakerSelect.value = exists ? cur : (state.speakers[0]?.speaker || '');
            if (practiceSpeakerSelect.value) setPracticeSpeaker(practiceSpeakerSelect.value);
          }
        }
        // Persist profile
        saveRoleProfile().catch(() => { });
      });
    }
    if (roleRotateBtn) {
      roleRotateBtn.addEventListener('click', () => {
        state.roleRotation = (state.roleRotation + 1) % 5;
        if (!state.hasServerSpeakers) {
          buildInferredSpeakers();
          populateSpeakerSelect();
          generateRoleButtons();
          if (practiceSpeakerSelect) {
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value || (state.speakers[0]?.speaker || '');
            practiceSpeakerSelect.value = cur;
            if (cur) setPracticeSpeaker(cur);
          }
        }
        // Persist profile
        saveRoleProfile().catch(() => { });
      });
    }

    if (strictAltToggle) {
      strictAltToggle.addEventListener('change', () => {
        state.strictAlternate = !!strictAltToggle.checked;
        if (state.strictAlternate) {
          state.roleCount = '2';
          if (roleCountSelect) roleCountSelect.value = '2';
        }
        if (!state.hasServerSpeakers) {
          buildInferredSpeakers();
          populateSpeakerSelect();
          generateRoleButtons();
          if (practiceSpeakerSelect) {
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value || (state.speakers[0]?.speaker || '');
            practiceSpeakerSelect.value = cur;
            if (cur) setPracticeSpeaker(cur);
          }
        }
        saveRoleProfile().catch(() => { });
      });
    }

    function openRoleRename() {
      if (!Array.isArray(state.speakers) || state.speakers.length === 0) return;
      if (!renameListEl || !roleRenameOverlay) return;
      renameListEl.innerHTML = '';
      state.speakers.forEach((sp, idx) => {
        const row = document.createElement('div');
        row.className = 'rename-row';
        const label = document.createElement('label');
        label.textContent = `角色 ${idx + 1}`;
        const input = document.createElement('input');
        input.value = String(sp.speaker || `Speaker ${idx + 1}`);
        input.setAttribute('data-idx', String(idx));
        row.appendChild(label);
        row.appendChild(input);
        renameListEl.appendChild(row);
      });
      roleRenameOverlay.style.display = 'flex';
      roleRenameOverlay.setAttribute('aria-hidden', 'false');
    }

    function closeRoleRename() {
      if (!roleRenameOverlay) return;
      roleRenameOverlay.style.display = 'none';
      roleRenameOverlay.setAttribute('aria-hidden', 'true');
    }

    function applyRoleRename() {
      if (!renameListEl || !Array.isArray(state.speakers)) return;
      const inputs = Array.from(renameListEl.querySelectorAll('input'));
      const newNames = inputs.map((inp) => ({ idx: Number(inp.getAttribute('data-idx')), name: String(inp.value || '').trim() }));
      // 简单去空与去重（若重复，后缀 (2)）
      const used = new Map();
      newNames.forEach(n => {
        if (!n.name) n.name = `Speaker ${n.idx + 1}`;
        const count = used.get(n.name) || 0;
        if (count > 0) n.name = `${n.name} (${count + 1})`;
        used.set(n.name, (used.get(n.name) || 0) + 1);
      });

      // old->new map
      const renameMap = new Map();
      newNames.forEach(({ idx, name }) => {
        const old = state.speakers[idx]?.speaker || `Speaker ${idx + 1}`;
        if (old !== name) renameMap.set(old, name);
      });

      if (renameMap.size === 0) { closeRoleRename(); return; }

      // 替换 speakers 列表与 lines
      state.speakers.forEach((sp, idx) => {
        const oldName = sp.speaker;
        const newName = renameMap.has(oldName) ? renameMap.get(oldName) : oldName;
        state.speakers[idx].speaker = newName;
        (sp.lines || []).forEach(line => { line.speaker = newName; });
      });

      // 替换 segmentSpeakerMap 的值
      if (state.segmentSpeakerMap instanceof Map) {
        const newMap = new Map();
        state.segmentSpeakerMap.forEach((val, key) => {
          const nv = renameMap.has(val) ? renameMap.get(val) : val;
          newMap.set(key, nv);
        });
        state.segmentSpeakerMap = newMap;
      }

      // 保持当前选择
      let current = audioModeManager?.selectedSpeaker || (practiceSpeakerSelect ? practiceSpeakerSelect.value : '') || '';
      if (renameMap.has(current)) current = renameMap.get(current);
      if (audioModeManager) audioModeManager.selectedSpeaker = current;

      populateSpeakerSelect();
      generateRoleButtons();
      if (practiceSpeakerSelect) {
        practiceSpeakerSelect.value = current || (state.speakers[0]?.speaker || '');
        if (practiceSpeakerSelect.value) setPracticeSpeaker(practiceSpeakerSelect.value);
      }
      closeRoleRename();
      // Persist profile with new names
      saveRoleProfile().catch(() => { });
    }

    if (roleRenameBtn) roleRenameBtn.addEventListener('click', openRoleRename);
    if (rrCancel) rrCancel.addEventListener('click', closeRoleRename);
    if (rrSave) rrSave.addEventListener('click', applyRoleRename);
    if (roleRenameOverlay) {
      roleRenameOverlay.addEventListener('click', (e) => { if (e.target === roleRenameOverlay) closeRoleRename(); });
    }

    // 清除所有录音功能
    const clearRecordingsBtn = document.getElementById('clear-recordings-btn');
    if (clearRecordingsBtn) {
      clearRecordingsBtn.addEventListener('click', async () => {
        if (!confirm('⚠️ 确定要删除所有录音吗？\n\n删除后需要重新录制才能听到配音。\n\n这个操作无法撤销！')) {
          return;
        }

        try {
          clearRecordingsBtn.disabled = true;
          clearRecordingsBtn.textContent = '⏳ 删除中...';

          const videoId = state.videoId || new URLSearchParams(window.location.search).get('videoId');
          if (!videoId) {
            throw new Error('无法获取视频ID');
          }
          const token = refreshAuthToken();
          const headers = { 'Authorization': `Bearer ${token}` };

          // 调用后端API删除所有录音
          const response = await fetch(`${API_BASE}/recordings/video/${videoId}`, {
            method: 'DELETE',
            headers
          });

          if (response.ok) {
            const result = await response.json();

            // 清除本地缓存
            try {
              const storageKey = `user_recordings_${videoId}`;
              localStorage.removeItem(storageKey);
            } catch (e) { console.warn('清除 localStorage 失败', e); }

            if (audioModeManager) {
              audioModeManager.userRecordings = {};
              if (audioModeManager.decisionCache) audioModeManager.decisionCache.clear();
            }

            if (state.recordedSegments && typeof state.recordedSegments.clear === 'function') {
              state.recordedSegments.clear();
            }

            updateRecordingIndicator();

            alert('✅ 所有录音已删除！\n\n请重新录制以听到配音。');

            // 刷新页面以重新加载
            window.location.reload();
          } else {
            // 尝试解析错误响应
            let errorMsg = '删除失败';
            try {
              const errorData = await response.json();
              errorMsg = errorData.error || errorData.message || errorMsg;
              console.error('[清除录音] 服务器错误:', errorData);
            } catch (parseErr) {
              // JSON 解析失败，使用响应文本
              console.error('[清除录音] 无法解析错误响应:', parseErr);
              const textError = await response.text();
              console.error('[清除录音] 响应文本:', textError);
              errorMsg = textError || `HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMsg);
          }
        } catch (err) {
          console.error('[清除录音] 失败:', err);
          const errorMessage = err.message || err.toString() || '未知错误';
          alert(`❌ 删除录音失败：${errorMessage}\n\n请稍后重试或联系技术支持。`);
          clearRecordingsBtn.disabled = false;
          clearRecordingsBtn.textContent = '🗑️ 清除录音';
        }
      });
    }

    function updatePracticeFeedback(text, color = '#666') {
      if (!practiceFeedbackEl) return;
      practiceFeedbackEl.textContent = text;
      practiceFeedbackEl.style.color = color;
    }

    function computeSpeechRateWpm(text, durationSec) {
      const seconds = Number(durationSec);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
      if (!words) return null;
      return Math.round((words / seconds) * 60);
    }

    const SCORE_HISTORY_LIMIT = 20;
    let scoreHistoryCache = [];
    let scoreHistorySyncTimer = null;

    function getScoreHistoryVideoId() {
      return state.videoId || new URLSearchParams(window.location.search).get('videoId') || null;
    }

    function normalizeScoreHistory(items = []) {
      return items
        .map(item => ({
          ts: item.created_at ? new Date(item.created_at).getTime() : (item.ts || Date.now()),
          overall: Number(item.overall),
          accuracy: Number.isFinite(item.accuracy) ? Number(item.accuracy) : null,
          fluency: Number.isFinite(item.fluency) ? Number(item.fluency) : null,
          prosody: Number.isFinite(item.completeness) ? Number(item.completeness) : (Number.isFinite(item.prosody) ? Number(item.prosody) : null)
        }))
        .filter(item => Number.isFinite(item.overall))
        .sort((a, b) => a.ts - b.ts)
        .slice(-SCORE_HISTORY_LIMIT);
    }

    async function fetchScoreHistoryFromServer() {
      const token = refreshAuthToken();
      if (!token) return scoreHistoryCache;
      const videoId = getScoreHistoryVideoId();
      if (!videoId) return scoreHistoryCache;
      try {
        const res = await fetch(`${API_BASE}/pronunciation/history?video_id=${encodeURIComponent(videoId)}&limit=${SCORE_HISTORY_LIMIT}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return scoreHistoryCache;
        const data = await res.json();
        scoreHistoryCache = normalizeScoreHistory(data.items || []);
        renderScoreHistoryChart(scoreHistoryCache);
        return scoreHistoryCache;
      } catch (_) {
        return scoreHistoryCache;
      }
    }

    function appendScoreHistory({ accuracy, fluency, prosody, overall }) {
      const computedOverall = Number.isFinite(overall)
        ? Number(overall)
        : (Number.isFinite(accuracy) ? Number(accuracy) : null);
      if (!Number.isFinite(computedOverall)) return scoreHistoryCache;
      scoreHistoryCache = [...scoreHistoryCache, {
        ts: Date.now(),
        overall: computedOverall,
        accuracy: Number.isFinite(accuracy) ? Number(accuracy) : null,
        fluency: Number.isFinite(fluency) ? Number(fluency) : null,
        prosody: Number.isFinite(prosody) ? Number(prosody) : null
      }].slice(-SCORE_HISTORY_LIMIT);
      return scoreHistoryCache;
    }

    function scheduleScoreHistorySync() {
      if (scoreHistorySyncTimer) clearTimeout(scoreHistorySyncTimer);
      scoreHistorySyncTimer = setTimeout(() => {
        fetchScoreHistoryFromServer();
      }, 1200);
    }

    function renderScoreHistoryChart(history) {
      const container = document.getElementById('practice-score-history');
      if (!container) return;
      if (!history.length) {
        container.textContent = '等待录音后生成趋势';
        return;
      }
      const width = 260;
      const height = 70;
      const padding = 10;
      const values = history.map(item => item.overall).filter(v => Number.isFinite(v));
      if (!values.length) {
        container.textContent = '暂无有效成绩';
        return;
      }
      const minVal = Math.min(...values);
      const maxVal = Math.max(...values);
      const range = Math.max(10, maxVal - minVal);
      const pointsArr = values.map((val, idx) => {
        const x = padding + (idx / Math.max(1, values.length - 1)) * (width - padding * 2);
        const y = padding + (1 - (val - minVal) / range) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      const points = pointsArr.join(' ');
      const lastPoint = pointsArr[pointsArr.length - 1] || `${width - padding},${height - padding}`;
      const last = values[values.length - 1];
      container.innerHTML = `
        <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="scoreLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#60a5fa" />
              <stop offset="100%" stop-color="#34d399" />
            </linearGradient>
          </defs>
          <polyline points="${points}" fill="none" stroke="url(#scoreLine)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="${lastPoint.split(',')[0]}" cy="${lastPoint.split(',')[1]}" r="4" fill="#10b981" />
        </svg>
        <div style="font-size:0.72rem;color:#64748b;text-align:right;">当前 ${Math.round(last)}%</div>
      `;
    }

    function renderPracticePhonemeChips(phonemes = []) {
      const container = document.getElementById('practice-phoneme-chips');
      if (!container) return;
      if (!Array.isArray(phonemes) || phonemes.length === 0) {
        container.innerHTML = '<span class="score-phoneme-chip ok">暂无音素级数据</span>';
        return;
      }
      const errors = phonemes.filter(p => p.error || (p.accuracy != null && p.accuracy < 60));
      const picks = (errors.length ? errors : phonemes).slice(0, 8);
      container.innerHTML = picks.map(p => {
        const symbol = p.symbol || p.phoneme || '?';
        const isError = p.error || (p.accuracy != null && p.accuracy < 60);
        const accuracy = p.accuracy != null ? `${Math.round(p.accuracy)}%` : '';
        return `<span class="score-phoneme-chip ${isError ? '' : 'ok'}">/${escapeHtml(symbol)}/ ${accuracy}</span>`;
      }).join('');
    }

    function getWaveformSamplesFromMediaElement(mediaEl) {
      if (!mediaEl) return null;
      try {
        if (!audioModeManager || typeof audioModeManager.ensureAnalyser !== 'function') return null;
        const analyser = audioModeManager.ensureAnalyser(mediaEl);
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        return Float32Array.from(data, v => (v - 128) / 128);
      } catch (_) {
        // fallthrough to WebAudio element source
      }
      try {
        const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        if (!state.audioContext) state.audioContext = ctx;
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          try { ctx.resume(); } catch (_) { }
        }
        if (state.mediaElementSourceEl !== mediaEl || !state.mediaElementAnalyser) {
          if (state.mediaElementSource) {
            try { state.mediaElementSource.disconnect(); } catch (_) { }
          }
          const source = ctx.createMediaElementSource(mediaEl);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          state.mediaElementSource = source;
          state.mediaElementAnalyser = analyser;
          state.mediaElementSourceEl = mediaEl;
        }
        const analyser = state.mediaElementAnalyser;
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        return Float32Array.from(data, v => (v - 128) / 128);
      } catch (_) {
        return null;
      }
    }

    function captureOriginalWaveformSnapshot() {
      if (isYouTubeVideo || !videoPlayer) return false;
      const samples = getWaveformSamplesFromMediaElement(videoPlayer);
      if (!samples || samples.length === 0) return false;
      state.lastOriginalWaveform = samples;
      return true;
    }

    function renderScoreWaveforms(recordingBlob) {
      const originalCanvas = document.getElementById('practice-waveform-original');
      const recordingCanvas = document.getElementById('practice-waveform-recording');
      if (originalCanvas) {
        const cachedWave = state.lastOriginalWaveform;
        if (isWaveformUsable(cachedWave)) {
          drawWaveform(originalCanvas, normalizeWaveformSamples(cachedWave));
        } else {
          const samples = getWaveformSamplesFromMediaElement(videoPlayer);
          if (isWaveformUsable(samples)) {
            state.lastOriginalWaveform = samples;
            drawWaveform(originalCanvas, normalizeWaveformSamples(samples));
          } else {
            const sentence = getCurrentSentenceForPlayback();
            const start = Number(sentence?.start ?? 0);
            const end = Number(sentence?.end ?? 0);
            const afterLocal = (wave) => {
              if (isWaveformUsable(wave)) {
                state.lastOriginalWaveform = wave;
                drawWaveform(originalCanvas, normalizeWaveformSamples(wave));
                return;
              }
              fetchOriginalWaveformFromServer(start, end, 240)
                .then((remoteWave) => {
                  if (isWaveformUsable(remoteWave)) {
                    state.lastOriginalWaveform = remoteWave;
                    drawWaveform(originalCanvas, normalizeWaveformSamples(remoteWave));
                  } else {
                    drawPlaceholderWaveform(originalCanvas);
                  }
                })
                .catch(() => drawPlaceholderWaveform(originalCanvas));
            };
            loadOriginalAudioBuffer()
              .then((buffer) => afterLocal(getOriginalWaveformSamplesFromBuffer(buffer, start, end)))
              .catch(() => afterLocal(null));
          }
        }
      }
      if (recordingCanvas) {
        const blob = recordingBlob || getLatestRecordingBlob();
        if (blob) {
          drawWaveformFromBlob(recordingCanvas, blob).catch(() => drawPlaceholderWaveform(recordingCanvas));
        } else {
          drawPlaceholderWaveform(recordingCanvas);
        }
      }
    }

    function updatePracticeScorePanel({ accuracy, fluency, prosody, speedWpm, overall, phonemes = [], coaching = null, assessmentId = null, skillUpdate = null, recordingBlob = null, summaryText = '' }) {
      if (!practiceScorePanel || !practiceScoreGrid || !practiceScoreSummary) return;
      const metrics = [
        { label: '词级准确', value: Number.isFinite(accuracy) ? `${Math.round(accuracy)}%` : '--' },
        { label: '流畅估算', value: Number.isFinite(fluency) ? `${Math.round(fluency)}%` : '--' },
        { label: '完整估算', value: Number.isFinite(prosody) ? `${Math.round(prosody)}%` : '--' },
        { label: '语速', value: Number.isFinite(speedWpm) ? `${Math.round(speedWpm)} WPM` : '--' }
      ];
      practiceScoreGrid.innerHTML = metrics.map(m => `
        <div class="practice-score-card">
          <div class="label">${m.label}</div>
          <div class="value">${m.value}</div>
        </div>
      `).join('');
      if (summaryText) {
        practiceScoreSummary.textContent = summaryText;
      } else if (Number.isFinite(overall)) {
        practiceScoreSummary.textContent = `综合得分 ${Math.round(overall)}%`;
      } else if (Number.isFinite(accuracy)) {
        practiceScoreSummary.textContent = `准确度 ${Math.round(accuracy)}%`;
      } else {
        practiceScoreSummary.textContent = '等待录音';
      }
      renderPracticePhonemeChips(phonemes);
      renderScoreWaveforms(recordingBlob);
      const history = appendScoreHistory({ accuracy, fluency, prosody, overall });
      renderScoreHistoryChart(history);
      scheduleScoreHistorySync();
      practiceScorePanel.hidden = false;
      renderPronunciationCoaching(practiceScorePanel, coaching, {
        beforeNode: practiceScorePanel.querySelector('.score-history-panel'),
        impressionId: assessmentId,
      });
      try {
        const profileUI = window.LinglishPronunciationProfile;
        const emit = profileUI?.createPronunciationEventTransport?.({
          fetch: (...args) => fetch(...args),
          getToken: () => getAuthToken(),
          endpoint: `${API_BASE}/events`,
          source: 'web',
        });
        profileUI?.consumeSkillUpdate?.(practiceScorePanel, skillUpdate, {
          beforeNode: practiceScorePanel.querySelector('.score-history-panel'),
          emit,
          eventKey: assessmentId,
        });
      } catch (error) {
        console.warn('[Pronunciation] Desktop skill update rendering skipped:', error?.message || error);
      }
    }

    function showAchievementToast({ accuracy }) {
      const percent = Number.isFinite(accuracy) ? Math.round(accuracy) : null;
      if (percent == null) return;
      let copy = '';
      if (percent >= 92) copy = `发音准确度 ${percent}%，超过了 80% 的学习者！`;
      else if (percent >= 85) copy = `准确度 ${percent}%，继续保持这个节奏！`;
      else if (percent >= 75) copy = `准确度 ${percent}%，离目标更近一步！`;
      else return;
      const toast = document.createElement('div');
      toast.className = 'achievement-toast';
      toast.innerHTML = `<span>🏆</span><span>${copy}</span>`;
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    }

    function updateRecordingStatus(mainText, subText = '', color = '#1f2937') {
      if (!recordingStatusChip) return;
      if (!mainText && !subText) {
        recordingStatusChip.hidden = true;
        return;
      }
      recordingStatusChip.hidden = false;
      if (recordingStatusMain) {
        recordingStatusMain.textContent = mainText;
        recordingStatusMain.style.color = color;
      }
      if (recordingStatusSub) {
        recordingStatusSub.textContent = subText || '';
      }
    }

    // ===== 自动流程核心函数 =====

    function setAnalysisStage(stage) {
      if (!analysisProgress || !analysisMeta) return;

      if (stage === 'analyzing') {
        analysisProgress.hidden = false;
        analysisProgress.classList.remove('complete');
        analysisMeta.hidden = false;
        analysisMeta.textContent = '分析中...约2秒';
        return;
      }

      if (stage === 'complete') {
        analysisProgress.hidden = false;
        analysisProgress.classList.add('complete');
        analysisMeta.hidden = false;
        analysisMeta.textContent = '正在加载评分';
        return;
      }

      analysisProgress.hidden = true;
      analysisProgress.classList.remove('complete');
      analysisMeta.hidden = true;
    }

    function updateAutoStatus(icon, text) {
      if (statusIcon) statusIcon.textContent = icon;
      if (statusText) statusText.textContent = text;
      setAnalysisStage('none');
      // 不自动显示控制面板，只更新状态文本
      // 面板的显示由 startAutoMode() 函数控制
    }

    async function initializeAudioAnalyser() {
      // If we already have a stream and it's active, check if we need to switch device
      const micSelect = document.getElementById('mic-select');
      const selectedDeviceId = micSelect ? micSelect.value : null;

      // If stream exists but device changed, stop old tracks
      if (state.mediaStream) {
        const active = state.mediaStream.active && state.mediaStream.getAudioTracks().some(t => t.enabled && t.readyState === 'live');
        if (!active) {
          console.warn('[麦克风] 流已失效，重新获取');
          state.mediaStream = null;
          state.recordingStream = null;
        } else if (selectedDeviceId && state.currentDeviceId !== selectedDeviceId) {
          state.mediaStream.getTracks().forEach(t => t.stop());
          state.mediaStream = null;
          state.recordingStream = null;
        }
      }

      if (!state.mediaStream) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      if (state.audioContext.state === 'suspended') {
        await state.audioContext.resume();
      }

      if (!state.mediaStream) {
        const baseConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        };
        const constraints = {
          audio: selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId }, ...baseConstraints }
            : baseConstraints
        };
        try {
          state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
          state.currentDeviceId = selectedDeviceId;

          // ===== Web Audio Pipeline Setup =====
          // 1. Create Source from Mic
          const source = state.audioContext.createMediaStreamSource(state.mediaStream);

          // 2. Create Gain Node (Volume Control / Buffer)
          state.inputGain = state.audioContext.createGain();
          state.inputGain.gain.value = 1.0;

          // 3. Create Analyser (Visualizer)
          state.audioAnalyser = state.audioContext.createAnalyser();
          state.audioAnalyser.fftSize = 2048;

          // 4. Create Destination (Recorder Input)
          state.audioDestination = state.audioContext.createMediaStreamDestination();

          // Connect: Source -> Gain -> Analyser
          //                   -> Destination
          source.connect(state.inputGain);
          state.inputGain.connect(state.audioAnalyser);
          state.inputGain.connect(state.audioDestination);

          // Store the processed stream for recording
          state.recordingStream = state.audioDestination.stream;

        } catch (e) {
          console.error('[麦克风] 获取流失败:', e);
          alert('无法访问麦克风，请检查权限。');
          throw e;
        }
      }
    }

    // Populate Microphone Select
    async function populateMicSelect() {
      const micSelect = document.getElementById('mic-select');
      if (!micSelect) return;

      try {
        // Request permission first to get labels
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        micSelect.innerHTML = '';
        if (audioInputs.length === 0) {
          const opt = document.createElement('option');
          opt.text = '未检测到麦克风';
          micSelect.appendChild(opt);
          return;
        }

        audioInputs.forEach(device => {
          const opt = document.createElement('option');
          opt.value = device.deviceId;
          opt.text = device.label || `麦克风 ${micSelect.length + 1}`;
          micSelect.appendChild(opt);
        });

        // Restore selection if needed, or select default
        if (state.currentDeviceId) {
          micSelect.value = state.currentDeviceId;
        }

        micSelect.addEventListener('change', () => {
          state.currentDeviceId = micSelect.value;
          // Force re-init on next record
          if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(t => t.stop());
            state.mediaStream = null;
            state.recordingStream = null;
          }
        });

      } catch (e) {
        console.warn('[麦克风] 枚举设备失败:', e);
        micSelect.innerHTML = '<option>无法获取设备列表</option>';
      }
    }

    // Call on load
    window.addEventListener('DOMContentLoaded', populateMicSelect);

    // Test Mic Feature
    let isTestingMic = false;
    async function toggleMicTest() {
      const btn = document.getElementById('test-mic-btn');
      if (isTestingMic) {
        // Stop testing
        stopVADMonitoring();
        if (state.mediaStream) {
          state.mediaStream.getTracks().forEach(t => t.stop());
          state.mediaStream = null;
          state.recordingStream = null;
        }
        isTestingMic = false;
        if (btn) {
          btn.textContent = '🎤 测试麦克风';
          btn.classList.remove('btn-danger');
          btn.classList.add('btn-outline');
        }
        if (vadIndicatorEl) vadIndicatorEl.hidden = true;
      } else {
        // Start testing
        try {
          if (btn) btn.textContent = '⏳ 启动中...';
          await initializeAudioAnalyser();
          startVADMonitoring();
          isTestingMic = true;
          if (btn) {
            btn.textContent = '⏹ 停止测试';
            btn.classList.remove('btn-outline');
            btn.classList.add('btn-danger');
          }
          if (vadIndicatorEl) vadIndicatorEl.hidden = false;
        } catch (e) {
          console.error('Mic test failed', e);
          if (btn) btn.textContent = '❌ 失败';
          setTimeout(() => { if (btn) btn.textContent = '🎤 测试麦克风'; }, 2000);
        }
      }
    }

    const testMicBtn = document.getElementById('test-mic-btn');
    if (testMicBtn) testMicBtn.addEventListener('click', toggleMicTest);

    function getAudioLevel() {
      if (!state.audioAnalyser) return 0;

      const bufferLength = state.audioAnalyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      state.audioAnalyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / bufferLength);
      // Adaptive VAD: track a smoothed noise floor and set a conservative threshold.
      const minThreshold = Number.isFinite(state.silenceThreshold) ? state.silenceThreshold : 0.0045;
      if (!Number.isFinite(state.vadNoiseFloor)) state.vadNoiseFloor = 0.0025;
      const alpha = 0.92; // EMA smoothing (slightly faster to adapt)
      const currentThreshold = Number.isFinite(state.vadThreshold) ? state.vadThreshold : minThreshold;
      const updateFloor = rms < currentThreshold * 1.25;
      if (updateFloor) {
        state.vadNoiseFloor = alpha * state.vadNoiseFloor + (1 - alpha) * rms;
      }
      // Threshold is noiseFloor * factor + margin, clamped.
      const computed = (state.vadNoiseFloor * 1.8) + 0.001;
      state.vadThreshold = Math.min(0.02, Math.max(minThreshold, computed));
      return rms;
    }

    function startVADMonitoring() {
      if (state.vadCheckInterval) {
        clearInterval(state.vadCheckInterval);
      }

      state.silenceStart = null;
      state.lastVoiceTs = null;
      if (!state.vadHangMs) state.vadHangMs = 250; // hangover avoids choppy cuts
      if (!state.minSpeakMs) state.minSpeakMs = 300; // legacy field（保留兼容）

      // 录音起始标记
      state.recordingStartAt = Date.now();
      state.firstVoiceAt = null;
      state.voicedMs = 0;
      state.vadVoiceFrames = 0;
      state.vadSilenceFrames = 0;
      state.vadMinVoiceFrames = 3;    // 约 300ms 连续发声判定开始说话
      state.vadMinSilenceFrames = 5;  // 约 500ms 连续静音判定停止说话
      if (vadIndicatorEl) { vadIndicatorEl.hidden = false; }

      state.vadCheckInterval = setInterval(() => {
        const level = getAudioLevel();
        const threshold = state.vadThreshold || state.silenceThreshold || 0.01;
        const now = Date.now();
        const isVoice = level >= threshold;

        if (isVoice) {
          if (state.vadStopTimer) {
            clearTimeout(state.vadStopTimer);
            state.vadStopTimer = null;
          }
          state.lastVoiceTs = now;
          if (!state.firstVoiceAt) state.firstVoiceAt = now;
          // 粗略累加发声时长（基于采样周期）
          state.voicedMs += 100;
          state.silenceStart = null;
          state.vadVoiceFrames += 1;
          state.vadSilenceFrames = 0;
          if (!state.isSpeaking && state.vadVoiceFrames >= (state.vadMinVoiceFrames || 3)) {
            state.isSpeaking = true;
            if (vadLabelEl) vadLabelEl.textContent = '正在说话';
          }
          return;
        }

        if (!state.silenceStart) state.silenceStart = now;
        const silenceDur = now - state.silenceStart;
        const spokeRecently = state.lastVoiceTs && (now - state.lastVoiceTs) < state.vadHangMs;
        state.vadSilenceFrames += 1;
        state.vadVoiceFrames = 0;
        if (state.isSpeaking && state.vadSilenceFrames >= (state.vadMinSilenceFrames || 5)) {
          state.isSpeaking = false;
          if (vadLabelEl) vadLabelEl.textContent = '静音';
        }

        // 初始静音忽略：在录音开始后的前一段时间，不因为静音而停止
        const sinceStart = state.recordingStartAt ? (now - state.recordingStartAt) : 0;
        if (sinceStart < (state.vadInitialIgnoreMs || 0)) {
          return;
        }

        // 对话模式：至少录够一段时间再允许因静音停止（防止早停截断）。
        const minStopMs = Number.isFinite(state.dialogueMinDurationMs) ? state.dialogueMinDurationMs : 0;
        if (minStopMs && sinceStart < minStopMs) {
          return;
        }

        // 必须先说够一定时长，才允许因静音而停止
        const spokeEnough = state.firstVoiceAt && ((now - state.firstVoiceAt) >= (state.vadMinSpeakMs || 0));

        // 达到尾部静音阈值，并且最近没有发声且发声时间已满足要求，且距离首次发声已过最短时长
        const afterVoiceMs = state.firstVoiceAt ? (now - state.firstVoiceAt) : 0;
        const needAfterVoice = state.vadMinAfterVoiceMs || 0;
        if (!spokeRecently && silenceDur >= state.silenceDuration && state.isRecording && spokeEnough && afterVoiceMs >= needAfterVoice) {
          if (!state.vadStopTimer) {
            // Add a small grace period to avoid cutting off the last phoneme.
            state.vadStopTimer = setTimeout(() => {
              state.vadStopTimer = null;
              if (state.isRecording) {
                stopAutoRecording();
              }
            }, 250);
          }
        }

        // 兜底：超出单句最大录音时长，强制停止
        const seg = state.currentSegments?.[state.autoSegmentCursor];
        let maxMs = state.vadMaxRecordingMs || 10000;
        try {
          const s = Number(seg?.start) || 0; const e = Number(seg?.end);
          const dur = Number.isFinite(e) ? Math.max(0, (e - s) * 1000) : 0;
          if (dur > 0) {
            const segMaxMs = Math.min(Math.max(dur + 1500, 2500), 12000);
            // 不能用较短的分段时长覆盖全局上限，否则会过早截断（如只剩 2.5s）
            maxMs = Math.max(maxMs, segMaxMs);
          }
        } catch (_) { }
        if (Number.isFinite(state.dialogueMaxDurationMs)) {
          maxMs = Math.max(maxMs, state.dialogueMaxDurationMs);
        }
        state.activeMaxRecordingMs = maxMs;
        if (state.isRecording && state.recordingStartAt) {
          const remainingSec = Math.max(0, (maxMs - sinceStart) / 1000);
          const silenceMs = state.silenceStart ? (now - state.silenceStart) : 0;
          const isSpeaking = Boolean(state.isSpeaking);
          const statusSub = isSpeaking
            ? `正在说话 · 剩余 ${remainingSec.toFixed(1)} 秒`
            : `静音检测中${silenceMs > 0 ? ` (${silenceMs}ms)` : ''} · 剩余 ${remainingSec.toFixed(1)} 秒`;
          updateRecordingStatus('🎤 正在录音', statusSub, isSpeaking ? '#16a34a' : '#d97706');
        }
        if (state.isRecording && sinceStart >= maxMs) {
          stopAutoRecording();
        }

        // 更新仪表 UI
        try {
          if (vadFillEl) {
            // 将 RMS 粗略映射到 0-100%
            const denom = Math.max(0.001, (state.vadThreshold || 0.01) * 2.5);
            const pct = Math.max(0, Math.min(100, Math.round((level / denom) * 100)));
            vadFillEl.style.width = pct + '%';
          }
          if (vadLabelEl && typeof state.isSpeaking === 'boolean') {
            // label 在切换时已设置，这里仅在首次显示时兜底
            if (!state.isSpeaking && vadLabelEl.textContent !== '静音') vadLabelEl.textContent = '静音';
          }
        } catch (_) { }
      }, 100);
    }

    function stopVADMonitoring() {
      if (state.vadCheckInterval) {
        clearInterval(state.vadCheckInterval);
        state.vadCheckInterval = null;
      }
      if (state.vadStopTimer) {
        clearTimeout(state.vadStopTimer);
        state.vadStopTimer = null;
      }
      state.silenceStart = null;
    }

    async function startAutoRecording() {
      if (state.isRecording) return;

      // 对话模式下使用practiceIndex，shadowing模式使用autoSegmentCursor
      const currentLine = currentPracticeMode === 'dialogue'
        ? state.practiceLines[state.practiceIndex]
        : state.currentSegments[state.autoSegmentCursor];

      if (!currentLine) return;

      try {
        updateRecordingStatus('🎤 准备录音', '请稍等，马上开始，开口前先看到「正在录音」提示', '#3b82f6');

        await initializeAudioAnalyser();

        // Ensure AudioContext is running (crucial for some browsers)
        if (state.audioContext && state.audioContext.state === 'suspended') {
          await state.audioContext.resume();
        }

        state.recordingChunks = [];
        state.isRecording = true;
        const startRecFab = document.getElementById('start-recording-fab');
        const fabBtn = document.getElementById('fab-record-btn');
        if (startRecFab) startRecFab.classList.add('recording');
        if (fabBtn) fabBtn.classList.add('recording');

        // 移动端优化：使用兼容的音频格式
        let mimeType = 'audio/webm';
        const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;

        if (isMobile) {
          // 优先尝试 webm (服务器支持更好)，如果不支持再回退到 mp4
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
          } else if (MediaRecorder.isTypeSupported('audio/webm')) {
            mimeType = 'audio/webm';
          } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4';
          } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
            mimeType = 'audio/mpeg';
          }
        }

        try {
          // Use the processed Web Audio stream if available, otherwise fallback to raw stream
          const streamToRecord = state.recordingStream || state.mediaStream;
          const streamType = state.recordingStream ? 'Web Audio Pipeline' : 'Raw Microphone';

          state.recorder = new MediaRecorder(streamToRecord, { mimeType });
        } catch (err) {
          console.warn(`[录音] ${mimeType} 不支持，使用默认格式`, err);
          const streamToRecord = state.recordingStream || state.mediaStream;
          state.recorder = new MediaRecorder(streamToRecord);
        }

        state.recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) {
            state.recordingChunks.push(event.data);
            const totalBytes = state.recordingChunks.reduce((sum, chunk) => sum + chunk.size, 0);
          } else {
            console.warn('[录音数据] 收到空数据块！');
          }
        });

        state.recorder.addEventListener('stop', async () => {

          // 用户主动取消：不评分、不弹结果面板
          if (state.recordingCancelled) {
            state.recordingCancelled = false;
            state.recordingChunks = [];
            return;
          }

          if (!state.recordingChunks.length) {
            console.error('[录音] 没有录音数据 - 可能的原因：');
            console.error('  1. 录音时间太短（不到100ms）');
            console.error('  2. 麦克风没有声音输入');
            console.error('  3. 浏览器不支持所选的音频格式');
            console.error('  4. MediaRecorder 状态异常');
            console.error(`  当前状态: ${state.recorder?.state}, MimeType: ${state.recorder?.mimeType}`);
            handleRecordingFailed();
            return;
          }

          // 使用实际录制的格式
          // Force 'audio/webm' for server compatibility if it's a supported container
          // The server likely rejects 'audio/webm;codecs=opus' or 'audio/mp4' string but accepts the data if labeled 'audio/webm'
          const actualMimeType = state.recorder.mimeType || state.recordingChunks[0]?.type || mimeType;
          // Hack: Always label as audio/webm for upload if it's webm-based, or just try to pass it.
          // If mobile used mp4, we might need to keep it, but let's try forcing webm label if it was webm/opus
          let uploadMimeType = actualMimeType;
          if (actualMimeType.includes('webm')) {
            uploadMimeType = 'audio/webm';
          }

          const blob = new Blob(state.recordingChunks, { type: uploadMimeType });
          state.lastRecordingBlob = blob;

          // 🔍 检查 blob 是否真的有数据
          if (blob.size === 0) {
            console.error('[录音完成] ⚠️ Blob 大小为 0！虽然有数据块但最终blob为空');
            handleRecordingFailed();
            return;
          }

          // 录音完成，自动评分
          try {
            await evaluateRecording(currentLine, blob);
          } catch (err) {
            console.error('[录音] 评分失败:', err);
          }
        });

        // 标记开始时间，供VAD参考
        state.recordingStartAt = Date.now();
        state.firstVoiceAt = null;
        state.voicedMs = 0;
        // 移动端更宽松的阈值，避免过早结束
        try {
          const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;
          const isDialogue = currentPracticeMode === 'dialogue';
          if (isMobile) {
            state.vadInitialIgnoreMs = isDialogue ? 1400 : 1100;
            state.vadMinSpeakMs = isDialogue ? 900 : 800;
            state.vadMinAfterVoiceMs = isDialogue ? 800 : 1000;
            state.vadHangMs = isDialogue ? 550 : 300;
            state.silenceDuration = isDialogue ? 1100 : Math.max(state.silenceDuration || 1100, 1300);
            state.vadMaxRecordingMs = isDialogue
              ? (state.dialogueMaxDurationMs || 12000)
              : 9500;
          } else {
            state.vadInitialIgnoreMs = isDialogue ? 1100 : 750;
            state.vadMinSpeakMs = isDialogue ? 800 : 650;
            state.vadMinAfterVoiceMs = isDialogue ? 700 : 700;
            state.vadHangMs = isDialogue ? 450 : 250;
            state.silenceDuration = isDialogue ? 900 : 1100;
            state.vadMaxRecordingMs = isDialogue
              ? (state.dialogueMaxDurationMs || 12000)
              : 9000;
          }
        } catch (_) { }
        // Small start delay to avoid clipping the first phoneme
        await new Promise((r) => setTimeout(r, 60));

        // 🔧 设置 timeslice 为 100ms，确保定期收集数据
        state.recorder.start(100);  // 每100ms触发一次 dataavailable

        // Log when recorder actually enters recording state
        setTimeout(() => {
        }, 100);

        updateAutoStatus('🎤', '请开始说话...');
        startVADMonitoring();

        // Audio Level Monitoring
        state.audioLevelCheckInterval = setInterval(() => {
          const level = getAudioLevel();
          state.lastAudioLevel = level;  // 保存最新音量，供静音检测使用

          if (state.audioContext?.state === 'suspended') {
            state.audioContext.resume();
          }

          // Auto-stop on silence logic
          if (level < 0.01) { // Threshold for silence (increased from 0.005 to account for background noise)
            const now = Date.now();
            if (!state.silenceStartAt) state.silenceStartAt = now;

            // Dialogue Mode: Auto-stop after 2.0s silence
            // User requested: "Don't stop immediately on pause" -> 2.0s buffer
            if (currentPracticeMode === 'dialogue' && (now - state.silenceStartAt > 2000) && (now - state.recordingStartAt > 3000)) {
              stopAutoRecording();
              state.silenceStartAt = null; // Reset
            }
          } else {
            state.silenceStartAt = null; // Reset on sound
          }

          if (level < 0.001 && (Date.now() - state.recordingStartAt > 5000)) { // Increased to 5s to avoid false positives at start
            // If silent for > 5 seconds
            if (!state.silenceWarningShown) {
              console.warn('[AudioMonitor] ⚠️ No audio detected! Check mic permissions.');
              updatePracticeFeedback('⚠️ 未检测到声音，请检查麦克风或静音开关', '#d97706');
              updateRecordingStatus('未检测到声音', '请检查麦克风权限/设备选择/物理静音', '#d97706');
              try {
                window.Feedback && Feedback.showToast('warning', '未检测到麦克风声音，请检查权限或切换设备', 4000);
              } catch (_) { }
              state.silenceWarningShown = true;
            }
          } else if (level > 0.01) {
            state.silenceWarningShown = false;
            updatePracticeFeedback('🎤 正在录音...', '#28a745');
          }
        }, 500);

      } catch (err) {
        console.error('[录音] 启动失败:', err);
        updateAutoStatus('❌', '麦克风权限被拒绝');
      }
    }

    function stopAutoRecording() {
      if (!state.isRecording) return;

      state.isRecording = false;
      const startRecFab = document.getElementById('start-recording-fab');
      const fabBtn = document.getElementById('fab-record-btn');
      if (startRecFab) startRecFab.classList.remove('recording');
      if (fabBtn) fabBtn.classList.remove('recording');
      stopVADMonitoring();
      state.dialogueMinDurationMs = null;
      state.dialogueMaxDurationMs = null;
      state.silenceStartTime = null;

      if (state.audioLevelCheckInterval) {
        clearInterval(state.audioLevelCheckInterval);
        state.audioLevelCheckInterval = null;
      }

      // 清理对话录音的定时器
      if (state.dialogueRecordingTimers) {
        if (state.dialogueRecordingTimers.silenceCheckInterval) {
          clearInterval(state.dialogueRecordingTimers.silenceCheckInterval);
        }
        if (state.dialogueRecordingTimers.maxTimeoutId) {
          clearInterval(state.dialogueRecordingTimers.maxTimeoutId);  // Now using interval, not timeout
        }
        state.dialogueRecordingTimers = null;
      }

      if (vadIndicatorEl) { vadIndicatorEl.hidden = true; }
      updateRecordingStatus(null, null);

      if (state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.stop();
      }

      updateAutoStatus('⏳', '正在评分...');
    }

    // 保存录音并上传到服务器
    function saveUserRecording(segmentIndex, blob, metadata = {}) {
      return new Promise((resolve, reject) => {
        const videoId = state.videoId;
        if (!videoId) {
          resolve(null);
          return;
        }

        try {
          const reader = new FileReader();
          reader.onloadend = async () => {
            try {
              const base64data = reader.result;
              const key = buildSegmentKey(segmentIndex);
              if (!key) {
                resolve(null);
                return;
              }
              const uploadIndex = normalizeSegmentIndex(segmentIndex);
              const payloadSegmentIndex = uploadIndex !== null ? uploadIndex : segmentIndex;
              const storageKey = `user_recordings_${videoId}`;
              const storedData = localStorage.getItem(storageKey);
              let recordings = {};
              if (storedData && storedData !== 'undefined' && storedData !== 'null') {
                try {
                  recordings = JSON.parse(storedData);
                } catch (e) {
                  console.warn('[录音] Failed to parse recordings from localStorage:', e);
                  recordings = {};
                }
              }

              if (!recordings.recordings) {
                recordings = {
                  videoId,
                  selectedSpeaker: state.selectedSpeaker,
                  recordings: {},
                };
              }

              const speaker = state.selectedSpeaker || recordings.selectedSpeaker || null;
              recordings.selectedSpeaker = speaker;

              recordings.recordings[key] = {
                audioData: base64data,
                timestamp: new Date().toISOString(),
                duration: 0,
                speaker,
                startOffset: metadata.startOffset || 0,  // 静音裁剪的开头偏移
                endOffset: metadata.endOffset || 0,      // 静音裁剪的结尾偏移
              };

              try {
                localStorage.setItem(storageKey, JSON.stringify(recordings));
              } catch (storageErr) {
                console.warn('[录音保存] 无法写入本地缓存:', storageErr);
              }

              let uploadedRecording = null;
              try {
                if (speaker) {
                  uploadedRecording = await uploadRecordingToServer({
                    videoId,
                    segmentIndex: payloadSegmentIndex,
                    speaker,
                    audioData: base64data,
                    durationSec: blob?.duration || null,
                  });
                  if (uploadedRecording) {
                    state.serverRecordings = Array.isArray(state.serverRecordings)
                      ? state.serverRecordings.filter(
                        (item) => {
                          const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
                          const itemSpeaker = item.speaker ?? '';
                          const uploadedSpeaker = uploadedRecording.speaker ?? '';
                          return !(itemKey === key && itemSpeaker === uploadedSpeaker);
                        },
                      )
                      : [];
                    state.serverRecordings.push(uploadedRecording);
                    audioModeManager.addOrUpdateRecording(uploadedRecording);
                  }
                } else {
                  console.warn('[录音上传] 未选择角色，跳过服务器上传');
                }
              } catch (uploadErr) {
                console.warn('[录音上传] 失败，使用本地录音作为备用:', uploadErr);
                // 回退到本地缓存
                audioModeManager.loadUserRecordings(videoId, state.serverRecordings || []);
              }

              ensureAudioModeAvailability();
              audioModeManager.setMode(currentAudioMode);
              updateAudioModeButtons();

              // 对话模式：确保selectedSpeaker保持为用户选择的角色
              if (currentPracticeMode === 'dialogue' && dialoguePracticeState.selectedRole) {
                audioModeManager.selectedSpeaker = dialoguePracticeState.selectedRole;
              }

              // 实战场模式：更新按钮状态
              if (typeof updateArenaModeButtons === 'function') {
                updateArenaModeButtons();
              }

              resolve(state.serverRecordings);
            } catch (err) {
              console.error('[录音保存] 处理失败:', err);
              reject(err);
            }
          };
          reader.onerror = (err) => {
            console.error('[录音保存] 读取数据失败:', err);
            reject(err);
          };
          reader.readAsDataURL(blob);
        } catch (err) {
          console.error('[录音保存] 保存失败:', err);
          reject(err);
        }
      });
    }

    /**
     * 裁剪音频前后的静音部分
     * @param {Blob} blob - 原始音频blob
     * @param {number} silenceThreshold - 静音阈值 (0-1)，默认0.01
     * @param {boolean} isMobile - 是否为移动设备
     * @returns {Promise<{blob: Blob, trimmedDuration: number, startOffset: number, endOffset: number}>} - 裁剪后的blob和时长，以及偏移量
     */
    async function trimSilence(blob, silenceThreshold = 0.01, isMobile = false) {
      try {

        // 创建AudioContext（如果还没有的话）
        const audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        if (!state.audioContext) {
          state.audioContext = audioContext;
        }

        // 将blob转换为ArrayBuffer - 使用FileReader以避免移动端Safari的安全限制
        let arrayBuffer;
        try {
          arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsArrayBuffer(blob);
          });
        } catch (readerErr) {
          console.error('[静音裁剪] FileReader失败:', readerErr);
          // 回退到blob.arrayBuffer()
          arrayBuffer = await blob.arrayBuffer();
        }

        // 解码音频数据
        let audioBuffer;
        try {
          audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        } catch (decodeErr) {
          console.error('[静音裁剪] 音频解码失败:', decodeErr);
          // 移动端解码失败是常见问题，直接返回原始blob
          return {
            blob,
            trimmedDuration: null,
            startOffset: 0,
            endOffset: 0
          };
        }

        // 获取音频数据（只处理第一个声道，如果是立体声则混合）
        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const numSamples = channelData.length;

        // 查找开始位置（第一个非静音样本）
        let startIndex = 0;
        for (let i = 0; i < numSamples; i++) {
          if (Math.abs(channelData[i]) > silenceThreshold) {
            startIndex = i;
            break;
          }
        }

        // 查找结束位置（最后一个非静音样本）
        let endIndex = numSamples - 1;
        for (let i = numSamples - 1; i >= startIndex; i--) {
          if (Math.abs(channelData[i]) > silenceThreshold) {
            endIndex = i + 1; // +1 因为我们要包含这个样本
            break;
          }
        }

        // 如果整个音频都是静音，返回原始blob
        if (startIndex >= endIndex) {
          console.warn('[静音裁剪] 整个音频都是静音，返回原始音频');
          return {
            blob,
            trimmedDuration: audioBuffer.duration,
            startOffset: 0,
            endOffset: 0
          };
        }

        // 添加一点缓冲（避免切得太紧）
        const bufferSamples = Math.floor(sampleRate * 0.05); // 50ms缓冲
        startIndex = Math.max(0, startIndex - bufferSamples);
        endIndex = Math.min(numSamples, endIndex + bufferSamples);

        const trimmedLength = endIndex - startIndex;
        const trimmedDuration = trimmedLength / sampleRate;
        const startOffset = startIndex / sampleRate;
        const endOffset = (numSamples - endIndex) / sampleRate;

        // 移动端优化：跳过重新编码，只返回偏移量信息
        // 在播放时通过 currentTime 跳过静音部分即可
        if (isMobile) {
          return {
            blob, // 返回原始blob
            trimmedDuration,
            startOffset, // 开头需要跳过的时间
            endOffset    // 结尾需要跳过的时间
          };
        }

        // PC端：完整裁剪并重新编码
        // 创建新的AudioBuffer
        const trimmedBuffer = audioContext.createBuffer(
          audioBuffer.numberOfChannels,
          trimmedLength,
          sampleRate
        );

        // 复制裁剪后的数据到所有声道
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          const sourceData = audioBuffer.getChannelData(channel);
          const targetData = trimmedBuffer.getChannelData(channel);
          for (let i = 0; i < trimmedLength; i++) {
            targetData[i] = sourceData[startIndex + i];
          }
        }

        // 将AudioBuffer转换回blob
        // 使用MediaRecorder进行编码
        const trimmedBlob = await encodeAudioBuffer(trimmedBuffer, audioContext);

        return {
          blob: trimmedBlob,
          trimmedDuration,
          startOffset: 0, // 已经物理裁剪，无需偏移
          endOffset: 0
        };

      } catch (err) {
        console.error('[静音裁剪] 处理失败:', err);
        // 如果裁剪失败，返回原始blob
        return {
          blob,
          trimmedDuration: null,
          startOffset: 0,
          endOffset: 0
        };
      }
    }

    /**
     * 将AudioBuffer编码为音频blob
     * @param {AudioBuffer} audioBuffer
     * @param {AudioContext} audioContext
     * @returns {Promise<Blob>}
     */
    async function encodeAudioBuffer(audioBuffer, audioContext) {
      return new Promise((resolve, reject) => {
        // 创建离线渲染的MediaStreamDestination
        const numberOfChannels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const sampleRate = audioBuffer.sampleRate;

        // 创建一个离线AudioContext来播放buffer
        const offlineContext = new OfflineAudioContext(numberOfChannels, length, sampleRate);
        const source = offlineContext.createBufferSource();
        source.buffer = audioBuffer;

        // 创建MediaStreamDestination（在在线AudioContext中）
        const dest = audioContext.createMediaStreamDestination();
        const onlineSource = audioContext.createBufferSource();
        onlineSource.buffer = audioBuffer;
        onlineSource.connect(dest);

        // 选择兼容的音频格式
        const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;
        let mimeType = 'audio/webm';

        if (isMobile) {
          // 优先尝试 webm (服务器支持更好)，如果不支持再回退到 mp4
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
          } else if (MediaRecorder.isTypeSupported('audio/webm')) {
            mimeType = 'audio/webm';
          } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4';
          } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
            mimeType = 'audio/mpeg';
          }
        }

        // 使用MediaRecorder录制
        let mediaRecorder;
        try {
          mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
        } catch (err) {
          console.warn(`[音频编码] ${mimeType} 不支持，使用默认格式`, err);
          mediaRecorder = new MediaRecorder(dest.stream);
        }

        const chunks = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          resolve(blob);
        };

        mediaRecorder.onerror = (err) => {
          reject(err);
        };

        // 开始录制和播放
        mediaRecorder.start();
        onlineSource.start(0);

        // 在音频播放完毕后停止录制
        onlineSource.onended = () => {
          // 稍微延迟一下，确保所有数据都被捕获
          setTimeout(() => {
            mediaRecorder.stop();
          }, 100);
        };
      });
    }

    async function evaluateRecording(line, blob) {
      // 这里简化处理：假设总是需要评分
      // 实际应该调用语音识别API进行评分

      updateAutoStatus('🤔', '正在分析发音...');
      setAnalysisStage('analyzing');
      // 让出一帧，确保「正在分析」状态先绘制，再开始主线程音频处理
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

      // 裁剪静音
      let processedBlob = blob;
      let trimmedDuration = null;
      let startOffset = 0;
      let endOffset = 0;

      try {
        // 对话模式：完全禁用静音裁剪，保留用户完整的录音
        if (currentPracticeMode === 'dialogue') {
          // 不进行裁剪，直接使用原始录音
          processedBlob = blob;
          trimmedDuration = null;
          startOffset = 0;
          endOffset = 0;
        } else {
          // 跟读模式：启用静音裁剪
          const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;

          const result = await trimSilence(blob, 0.01, isMobile);
          processedBlob = result.blob;
          trimmedDuration = result.trimmedDuration;
          startOffset = result.startOffset || 0;
          endOffset = result.endOffset || 0;

          if (trimmedDuration !== null) {
          } else {
          }
        }
      } catch (err) {
        console.error('[录音处理] 静音裁剪失败:', err);
        console.warn('[录音处理] 使用原始录音');
        processedBlob = blob;
        trimmedDuration = null;
        startOffset = 0;
        endOffset = 0;
      }

      // 验证处理后的blob
      if (!processedBlob || processedBlob.size === 0) {
        console.error('[录音评估] 处理后的录音无效！');
        handleRecordingFailed();
        return;
      }

      // 保存录音（使用裁剪后的），并附带偏移信息
      const segmentIndex = line.index != null ? line.index : line.segmentIndex;
      let recordingSavePromise = Promise.resolve(null);
      if (segmentIndex != null) {
        if (currentPracticeMode === 'dialogue') {
          recordingSavePromise = saveUserRecording(
            segmentIndex,
            processedBlob,
            { startOffset, endOffset },
          ).catch((err) => {
            console.error('[录音保存] 保存失败:', err);
            return null;
          });
        } else {
          try {
            await saveUserRecording(segmentIndex, processedBlob, { startOffset, endOffset });
          } catch (err) {
            console.error('[录音保存] 保存失败:', err);
          }
        }
      } else {
        console.warn('[录音评估] 缺少 segmentIndex，无法保存录音');
      }

      if (currentPracticeMode !== 'dialogue') {
        updateAutoStatus('✓', '分析完成，正在加载评分');
        setAnalysisStage('complete');
        await new Promise(resolve => setTimeout(resolve, 600));
        setAnalysisStage('none');
      }
      updateAutoStatus('⏳', currentPracticeMode === 'dialogue' ? '正在识别...' : '正在评分...');

      // 对话模式下：调用ASR识别而不是简单评分
      if (currentPracticeMode === 'dialogue') {

        // 保存录音blob供回放使用
        dialoguePracticeState.currentRecording = processedBlob;

        // 调用ASR识别并显示对比结果
        try {
          await performASR(processedBlob, line.text);
          await recordingSavePromise;

          // 保存录音用于完整回放
          if (segmentIndex != null) {
            saveRecordingForPlayback(segmentIndex, processedBlob);
          }

          // 更新进度
          if (segmentIndex != null) {
            dialoguePracticeState.recordedSentences.add(segmentIndex);
            updateDialogueProgress();
          }
        } catch (err) {
          console.error('[Dialogue] ASR识别失败:', err);
          updatePracticeFeedback('❌ 识别失败: ' + err.message, '#dc2626');
        }
        return; // 对话模式下在这里结束，不执行后面的shadowing逻辑
      }

      // Shadowing模式：调用真实的发音评估API
      let score = 1.0;
      let passed = true;
      let words = [];
      let hypothesis = '';
      let metrics = null;

      const referenceText = line?.text || line?.content || '';
      if (referenceText && processedBlob) {
        try {
          updateAutoStatus('🎯', '正在评估发音...');

          // 将 blob 转换为 base64
          const audioData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read audio'));
            reader.readAsDataURL(processedBlob);
          });

          // 调用发音评估 API
          const token = getAuthToken();
          if (!token) {
            const speechRate = computeSpeechRateWpm(referenceText, trimmedDuration);
            updatePracticeScorePanel({
              accuracy: null,
              fluency: null,
              prosody: null,
              speedWpm: speechRate,
              overall: null,
              phonemes: [],
              recordingBlob: processedBlob,
              summaryText: '评分服务需登录'
            });
            showToast('请先登录后获取评分', 'warn');
            return;
          }
          const response = await fetch('/pronunciation/assess', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: referenceText,
              audio_data: audioData,
              duration_seconds: trimmedDuration,
              video_id: state.videoId || new URLSearchParams(window.location.search).get('videoId') || null,
            }),
          });

          if (response.ok) {
            const result = await response.json();
            if (result && result.assessment) {
              const assessment = result.assessment || {};
              const accuracy = Number(assessment.accuracy || 0);
              const fluency = Number(assessment.fluency ?? assessment.fluency_score ?? assessment.fluencyScore ?? 0);
              const prosody = Number(assessment.prosody ?? assessment.completeness ?? assessment.completenessScore ?? assessment.overall ?? accuracy);
              const overall = Number(assessment.overall ?? assessment.score ?? accuracy);
              score = accuracy / 100; // 0-100 转换为 0-1
              words = result.assessment.words || [];
              hypothesis = result.hypothesis || '';
              passed = score >= 0.8; // 80% 阈值
              metrics = {
                pronunciation: accuracy,
                fluency,
                prosody,
                overall,
                coaching: assessment.coaching || null,
                assessmentId: assessment.id || null,
              };
              const phonemes = result.assessment?.phonemes || [];
              metrics.phonemes = phonemes;
              const speechRate = computeSpeechRateWpm(referenceText, trimmedDuration);
              metrics.speedWpm = speechRate;
              updatePracticeScorePanel({
                accuracy,
                fluency,
                prosody,
                speedWpm: speechRate,
                overall,
                phonemes,
                coaching: metrics.coaching,
                assessmentId: metrics.assessmentId,
                skillUpdate: result.skill_update || null,
                recordingBlob: processedBlob
              });
              showAchievementToast({ accuracy });

              // 检查是否检测到非英语内容
              if (result.assessment.warning === 'NON_ENGLISH_DETECTED') {
                console.warn('[评分] 检测到非英语内容，请用英语朗读');
                hypothesis = '（未检测到英语语音）';
              }

              console.log(`[评分] API结果: 准确度=${accuracy}%, 通过=${passed}`);
            }
          } else if (response.status === 402) {
            const errorData = await response.json().catch(() => ({}));
            const quota = errorData.quota || {};
            const tier = String(quota.tier || 'free').toLowerCase();
            const paywall = errorData.paywall || null;
            const quotaMessage = errorData.code === 'PRONUNCIATION_DAILY_LIMIT_REACHED'
              ? (paywall?.message || (tier === 'free'
                ? `今日免费发音评测 ${quota.limit || 0} 次已用完，升级会员可继续练习。`
                : '今日发音评测额度已用完，明天会自动恢复。'))
              : '评分额度暂不可用';
            const speechRate = computeSpeechRateWpm(referenceText, trimmedDuration);
            updatePracticeScorePanel({
              accuracy: null,
              fluency: null,
              prosody: null,
              speedWpm: speechRate,
              overall: null,
              phonemes: [],
              recordingBlob: processedBlob,
              summaryText: quotaMessage
            });
            showToast(quotaMessage, 'warn');
          } else {
            const speechRate = computeSpeechRateWpm(referenceText, trimmedDuration);
            updatePracticeScorePanel({
              accuracy: null,
              fluency: null,
              prosody: null,
              speedWpm: speechRate,
              overall: null,
              phonemes: [],
              recordingBlob: processedBlob,
              summaryText: '评分服务暂不可用'
            });
            console.warn('[评分] API 调用失败，状态码:', response.status);
          }
        } catch (apiErr) {
          console.error('[评分] API 调用出错:', apiErr);
          // API 出错时默认通过，避免阻塞用户
          passed = true;
          score = 1.0;
          const speechRate = computeSpeechRateWpm(referenceText, trimmedDuration);
          updatePracticeScorePanel({
            accuracy: null,
            fluency: null,
            prosody: null,
            speedWpm: speechRate,
            overall: null,
            phonemes: [],
            recordingBlob: processedBlob,
            summaryText: '评分服务暂不可用'
          });
        }
      }

      state.lastPronunciationEval = {
        score,
        referenceText,
        words,
        hypothesis,
        metrics,
        recordingBlob: processedBlob
      };

      // 记录评分到会话历史（用于计算平均分）
      if (Number.isFinite(score)) {
        state.sessionScoreHistory = state.sessionScoreHistory || [];
        state.sessionScoreHistory.push(score);
      }

      if (passed) {
        handleRecordingPassed(line);
      } else {
        // 传递评估结果用于显示详细反馈
        handleRecordingFailed({ score, words, hypothesis, referenceText, metrics });
      }
    }

    function handleRecordingPassed(line) {
      updateAutoStatus('✅', '太棒了！继续下一句');

      // quick positive feedback
      if (window.Feedback) {
        const msg = (typeof i18n !== 'undefined' && i18n?.t) ? (i18n.t('feedback.line_passed') || '本句通过！') : '本句通过！';
        Feedback.showToast('success', `✅ ${msg}`);
        Feedback.playSfx('success');
      }

      if (state.lastPronunciationEval && state.lastPronunciationEval.score != null) {
        const lastEval = state.lastPronunciationEval;
        const feedback = generatePronunciationFeedback(lastEval.score, lastEval.words || []);
        updatePracticeFeedback(feedback.text, '#0f766e');
        showPronunciationFeedbackModal({
          score: lastEval.score,
          referenceText: lastEval.referenceText || '',
          words: lastEval.words || [],
          hypothesis: lastEval.hypothesis || '',
          feedback,
          metrics: lastEval.metrics || null,
          recordingBlob: lastEval.recordingBlob || null,
          options: { showRetry: false, autoCloseMs: 1200 }
        });
      }

      state.currentRetry = 0; // 重置重试计数

      // 标记当前segment为成功 - 使用segment index而不是practiceIndex
      const currentLine = state.currentSegments[state.autoSegmentCursor];
      if (currentLine) {
        const segmentIndex = currentLine.index != null ? currentLine.index : state.autoSegmentCursor;
        const key = buildSegmentKey(segmentIndex);
        if (key) {
          state.practiceLineResults[key] = 'success';
        }
      }

      // 进度更新 + 徽章
      try {
        state.consecutiveSuccess = (state.consecutiveSuccess || 0) + 1;
        if (state.consecutiveSuccess === 3) {
          window.Feedback && Feedback.awardBadgeOnce('flow-3', '流畅三连');
        } else if (state.consecutiveSuccess === 5) {
          window.Feedback && Feedback.awardBadgeOnce('flow-5', '五连击');
        }
      } catch (_) { }
      updatePracticeProgress();

      // 延迟后自动进入下一句（如果没有暂停）
      if (!state.isPaused) {
        setTimeout(() => {
          moveToNextLine();
        }, 1500);
      }
    }

    async function handleRecordingFailed(evalResult = null) {
      state.consecutiveSuccess = 0;

      // 如果有评估结果且准确度 < 80%，显示详细反馈模态框
      if (evalResult && evalResult.score < 0.8 && evalResult.referenceText) {
        console.log(`[评分] 显示详细反馈，准确度: ${Math.round(evalResult.score * 100)}%`);

        const feedback = generatePronunciationFeedback(evalResult.score, evalResult.words || []);
        updatePracticeFeedback(feedback.text, '#0f766e');
        updateAutoStatus(feedback.emoji, feedback.text);

        // 显示反馈模态框（评分越高自动关闭越快）
        const autoCloseTime = evalResult.score >= 0.6 ? 3000 : 4000;
        const userChoice = await showPronunciationFeedbackModal({
          score: evalResult.score,
          referenceText: evalResult.referenceText,
          words: evalResult.words || [],
          hypothesis: evalResult.hypothesis || '',
          feedback,
          metrics: evalResult.metrics || null,
          recordingBlob: evalResult.recordingBlob || null,
          options: { autoCloseMs: autoCloseTime }
        });

        if (userChoice === 'retry') {
          state.currentRetry++;
          console.log(`[评分] 用户选择重试，第${state.currentRetry}次尝试`);
          updateAutoStatus('🎤', '准备重新录音...');
          if (!state.isPaused) {
            setTimeout(() => {
              startAutoRecording();
            }, 500);
          }
        } else {
          // 用户选择继续下一句
          console.log('[评分] 用户选择继续下一句');
          state.currentRetry = 0;
          if (!state.isPaused) {
            setTimeout(() => {
              moveToNextLine();
            }, 500);
          }
        }
        return;
      }

      // 传统逻辑（无评估结果时）
      state.currentRetry++;

      if (state.currentRetry >= state.maxRetries) {
        // 3次都失败，播放原声
        updateAutoStatus('📢', '让我们听听原声...');
        if (!state.isPaused) {
          setTimeout(() => {
            playOriginalThenNext();
          }, 1000);
        }
      } else {
        // 还有机会，再试一次
        updateAutoStatus('🔄', `再试一次！(${state.currentRetry}/${state.maxRetries})`);
        if (!state.isPaused) {
          setTimeout(() => {
            startAutoRecording();
          }, 2000);
        }
      }
    }

    // 生成发音反馈
    function generatePronunciationFeedback(score, words = []) {
      const missing = words.filter(w => w.type === 'missing').map(w => w.word).slice(0, 3);
      const extra = words.filter(w => w.type === 'extra').map(w => w.word).slice(0, 2);
      let text = '意思接近了。注意词和词连在一起的地方，再跟一遍。';
      if (score >= 0.9) text = '这一句说清楚了，可以跟下一句。';
      else if (score >= 0.8) text = '大体说对了。再跟一遍，把没咬清的词放慢。';
      else if (missing.length) text = `这句里 ${missing.join('、')} 没说出来。先听原句，再只跟这几个词。`;
      else if (extra.length) text = `多说了 ${extra.join('、')}。对着原句再跟一遍。`;
      else if (score < 0.5) text = '先把这一句听完，放慢，再跟着说一遍。';
      const type = score >= 0.8 ? 'success' : 'warning';
      return { emoji: score >= 0.8 ? '✓' : '听', text, type, details: text };
    }

    function getCurrentSentenceForPlayback() {
      if (currentPracticeMode === 'dialogue' && dialoguePracticeState.currentSentence) {
        const s = dialoguePracticeState.currentSentence;
        return {
          text: s.text || '',
          start: Number(s.start ?? s.startTime ?? s.start_sec ?? s.startSec ?? 0),
          end: Number(s.end ?? s.endTime ?? s.end_sec ?? s.endSec ?? 0)
        };
      }
      if (currentPracticeMode === 'shadowing' && Array.isArray(shadowingSentences) && shadowingSentences.length) {
        const s = shadowingSentences[shadowingCurrentIndex] || {};
        return {
          text: s.text || '',
          start: Number(s.start ?? s.startTime ?? s.start_sec ?? s.startSec ?? 0),
          end: Number(s.end ?? s.endTime ?? s.end_sec ?? s.endSec ?? 0)
        };
      }
      const seg = state.currentSegments?.[state.autoSegmentCursor] || {};
      return {
        text: seg.text || '',
        start: Number(seg.start ?? seg.startTime ?? seg.start_sec ?? seg.startSec ?? 0),
        end: Number(seg.end ?? seg.endTime ?? seg.end_sec ?? seg.endSec ?? 0)
      };
    }

    function getLatestRecordingBlob() {
      return dialoguePracticeState.currentRecording || state.lastRecordingBlob || null;
    }

    function notifyCompareMessage(message) {
      if (window.Feedback && Feedback.showToast) {
        Feedback.showToast('info', message, 2400);
        return;
      }
      if (typeof showSimpleToast === 'function') {
        showSimpleToast(message, 'info');
        return;
      }
      updatePracticeFeedback(message, '#2dd4bf');
    }

    // 显示发音反馈模态框
    function showPronunciationFeedbackModal({ score, referenceText, words, hypothesis, feedback, metrics, recordingBlob = null, options = {} }) {
      return new Promise((resolve) => {
        // 构建高亮文本
        let highlightedText = '';
        if (words && words.length > 0) {
          highlightedText = words.map(w => {
            const escaped = w.word.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            if (w.type === 'correct') return `<span class="word-correct">${escaped}</span>`;
            if (w.type === 'missing') return `<span class="word-missing">${escaped}</span>`;
            if (w.type === 'extra') return `<span class="word-extra">${escaped}</span>`;
            return `<span class="word-neutral">${escaped}</span>`;
          }).join(' ');
        } else {
          highlightedText = `<span class="word-neutral">${referenceText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`;
        }

        // 分数等级
        const percent = Math.round(score * 100);
        let levelClass = 'poor', levelLabel = 'D';
        if (score >= 0.9) { levelClass = 'excellent'; levelLabel = 'A'; }
        else if (score >= 0.8) { levelClass = 'good'; levelLabel = 'B'; }
        else if (score >= 0.6) { levelClass = 'fair'; levelLabel = 'C'; }

        const metricValues = metrics || {};
        const pronunciationScore = Number.isFinite(metricValues.pronunciation) ? Math.round(metricValues.pronunciation) : null;
        const fluencyScore = Number.isFinite(metricValues.fluency) ? Math.round(metricValues.fluency) : null;
        const prosodyScore = Number.isFinite(metricValues.prosody) ? Math.round(metricValues.prosody) : null;

        const breakdownHTML = (pronunciationScore != null || fluencyScore != null || prosodyScore != null)
          ? `
            <div class="feedback-score-breakdown">
              <div class="score-metric">
                <div class="metric-label">词级准确</div>
                <div class="metric-value">${pronunciationScore ?? '--'}%</div>
              </div>
              <div class="score-metric">
                <div class="metric-label">流畅估算</div>
                <div class="metric-value">${fluencyScore ?? '--'}%</div>
              </div>
              <div class="score-metric">
                <div class="metric-label">完整估算</div>
                <div class="metric-value">${prosodyScore ?? '--'}%</div>
              </div>
            </div>
          `
          : '';
        const waveformHTML = `
          <div class="feedback-waveforms">
            <div class="waveform-card">
              <div class="waveform-title">原声波形</div>
              <canvas class="waveform-canvas" id="waveform-original" width="320" height="54"></canvas>
            </div>
            <div class="waveform-card">
              <div class="waveform-title">我的录音</div>
              <canvas class="waveform-canvas" id="waveform-recording" width="320" height="54"></canvas>
            </div>
          </div>
        `;

        // 创建模态框
        const overlay = document.createElement('div');
        overlay.className = 'pronunciation-feedback-overlay';
        overlay.id = 'pronunciationFeedbackOverlay';
        const showRetry = options.showRetry !== false;
        const showNext = options.showNext !== false;
        const actionHTML = (showRetry || showNext) ? `
            <div class="feedback-actions">
              ${showRetry ? `
                <button class="feedback-btn retry-btn" id="feedbackRetryBtn">
                  <span class="btn-icon">🔄</span>
                  <span class="btn-text">再试一次</span>
                </button>` : ''}
              ${showNext ? `
                <button class="feedback-btn next-btn" id="feedbackNextBtn">
                  <span class="btn-icon">▶️</span>
                  <span class="btn-text">继续下一句</span>
                </button>` : ''}
            </div>
          ` : '';

        overlay.innerHTML = `
          <div class="pronunciation-feedback-card">
            <div class="feedback-header">
              <span class="feedback-emoji">${feedback.emoji}</span>
              <span class="feedback-title">${feedback.text}</span>
            </div>
            <div class="feedback-score-section">
              <div class="score-circle ${levelClass}">
                <span class="score-label">${levelLabel}</span>
                <span class="score-percent">${percent}%</span>
              </div>
            </div>
            ${breakdownHTML}
            <div class="feedback-text-section">
              <div class="text-label">发音对比</div>
              <div class="highlighted-text">${highlightedText}</div>
              ${hypothesis ? `<div class="hypothesis-text">你说的: "${hypothesis.replace(/</g, '&lt;').replace(/>/g, '&gt;')}"</div>` : ''}
            </div>
            ${waveformHTML}
            <div class="feedback-compare">
              <button class="feedback-compare-btn" id="feedbackPlayOriginal">对比原声</button>
              <button class="feedback-compare-btn" id="feedbackPlayRecording">播放我的录音</button>
            </div>
            ${feedback.details ? `
            <div class="feedback-tip">
              <span class="tip-icon">💡</span>
              <span class="tip-text">${feedback.details.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
            </div>` : ''}
            <div class="feedback-legend">
              <span class="legend-item"><span class="word-correct">单词</span> 正确</span>
              <span class="legend-item"><span class="word-missing">单词</span> 缺失</span>
              <span class="legend-item"><span class="word-extra">单词</span> 多余</span>
            </div>
            ${actionHTML}
          </div>
        `;

        document.body.appendChild(overlay);

        const feedbackCard = overlay.querySelector('.pronunciation-feedback-card');
        renderPronunciationCoaching(feedbackCard, metrics?.coaching || null, {
          beforeNode: overlay.querySelector('.feedback-actions'),
          impressionId: metrics?.assessmentId || null,
          track: false,
        });

        // 绑定事件
        const retryBtn = overlay.querySelector('#feedbackRetryBtn');
        const nextBtn = overlay.querySelector('#feedbackNextBtn');
        const playOriginalBtn = overlay.querySelector('#feedbackPlayOriginal');
        const playRecordingBtn = overlay.querySelector('#feedbackPlayRecording');

        const closeModal = (action) => {
          overlay.classList.remove('visible');
          overlay.classList.add('closing');
          setTimeout(() => {
            overlay.remove();
            resolve(action);
          }, 250);
        };

        retryBtn?.addEventListener('click', () => {
          recordPronunciationCoachingRetry(metrics?.coaching || null);
          closeModal('retry');
        });
        nextBtn?.addEventListener('click', () => closeModal('next'));
        if (playOriginalBtn) {
          playOriginalBtn.addEventListener('click', () => {
            const sentence = getCurrentSentenceForPlayback();
            if (!sentence || !sentence.start || !sentence.end) {
              notifyCompareMessage('当前句子无原声片段可播放');
              return;
            }
            playOriginalAudio(sentence).catch(() => notifyCompareMessage('原声播放失败'));
          });
        }
        if (playRecordingBtn) {
          playRecordingBtn.addEventListener('click', () => {
            const blob = getLatestRecordingBlob();
            if (!blob) {
              notifyCompareMessage('暂无录音可对比，请先录音');
              return;
            }
            playUserRecording(blob).catch(() => notifyCompareMessage('录音播放失败'));
          });
        }
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal('next');
        });

        if (options.autoCloseMs && Number.isFinite(options.autoCloseMs)) {
          setTimeout(() => closeModal('next'), options.autoCloseMs);
        }

        // 动画显示
        requestAnimationFrame(() => {
          overlay.classList.add('visible');
        });

        // Render waveforms after layout
        setTimeout(() => {
          const originalCanvas = overlay.querySelector('#waveform-original');
          const recordingCanvas = overlay.querySelector('#waveform-recording');
          if (recordingCanvas) {
            const blob = recordingBlob || getLatestRecordingBlob();
            if (blob) {
              drawWaveformFromBlob(recordingCanvas, blob).catch(() => drawPlaceholderWaveform(recordingCanvas));
            } else {
              drawPlaceholderWaveform(recordingCanvas);
            }
          }
          if (originalCanvas) {
            const cachedWave = state.lastOriginalWaveform;
            if (isWaveformUsable(cachedWave)) {
              drawWaveform(originalCanvas, normalizeWaveformSamples(cachedWave));
            } else {
              const samples = getWaveformSamplesFromMediaElement(videoPlayer);
              if (isWaveformUsable(samples)) {
                state.lastOriginalWaveform = samples;
                drawWaveform(originalCanvas, normalizeWaveformSamples(samples));
              } else {
                const sentence = getCurrentSentenceForPlayback();
                const start = Number(sentence?.start ?? 0);
                const end = Number(sentence?.end ?? 0);
                const afterLocal = (wave) => {
                  if (isWaveformUsable(wave)) {
                    state.lastOriginalWaveform = wave;
                    drawWaveform(originalCanvas, normalizeWaveformSamples(wave));
                    return;
                  }
                  fetchOriginalWaveformFromServer(start, end, 320)
                    .then((remoteWave) => {
                      if (isWaveformUsable(remoteWave)) {
                        state.lastOriginalWaveform = remoteWave;
                        drawWaveform(originalCanvas, normalizeWaveformSamples(remoteWave));
                      } else {
                        drawPlaceholderWaveform(originalCanvas);
                      }
                    })
                    .catch(() => drawPlaceholderWaveform(originalCanvas));
                };
                loadOriginalAudioBuffer()
                  .then((buffer) => afterLocal(getOriginalWaveformSamplesFromBuffer(buffer, start, end)))
                  .catch(() => afterLocal(null));
              }
            }
          }
        }, 200);
      });
    }

    async function decodeAudioBlobToBuffer(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
      if (!state.audioContext) state.audioContext = ctx;
      return ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    async function loadOriginalAudioBuffer() {
      if (isYouTubeVideo || !videoPlayer) return null;
      const src = videoPlayer.currentSrc || videoPlayer.src || '';
      if (!src) return null;
      const videoId = state.videoId || new URLSearchParams(window.location.search).get('videoId') || src;
      if (state.originalAudioBuffer && state.originalAudioBufferVideoId === videoId) {
        return state.originalAudioBuffer;
      }
      if (state.originalAudioBufferPromise) {
        return state.originalAudioBufferPromise;
      }
      state.originalAudioBufferPromise = (async () => {
        try {
          const res = await fetch(src);
          if (!res.ok) return null;
          const arrayBuffer = await res.arrayBuffer();
          const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
          if (!state.audioContext) state.audioContext = ctx;
          const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
          state.originalAudioBuffer = buffer;
          state.originalAudioBufferVideoId = videoId;
          return buffer;
        } catch (_) {
          return null;
        } finally {
          state.originalAudioBufferPromise = null;
        }
      })();
      return state.originalAudioBufferPromise;
    }

    async function fetchOriginalWaveformFromServer(startSec, endSec, points = 240, timeoutMs = 2000) {
      const videoId = state.videoId || new URLSearchParams(window.location.search).get('videoId') || null;
      if (!videoId) return null;
      const token = refreshAuthToken();
      const key = `${videoId}:${Number(startSec || 0).toFixed(2)}:${Number(endSec || 0).toFixed(2)}:${Number(points || 240)}`;
      if (state.originalWaveformCache.has(key)) {
        return state.originalWaveformCache.get(key);
      }
      if (typeof AbortController === 'undefined') return null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const params = new URLSearchParams();
        params.set('start', String(startSec || 0));
        params.set('end', String(endSec || 0));
        params.set('points', String(points || 240));
        const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(String(videoId))}/waveform?${params.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !Array.isArray(data.samples)) return null;
        const arr = Float32Array.from(data.samples);
        state.originalWaveformCache.set(key, arr);
        if (debugMode) {
          console.log('[Waveform] fetched', { videoId, startSec, endSec, points, samples: arr.length });
        }
        return arr;
      } catch (_) {
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function getOriginalWaveformSamplesFromBuffer(buffer, startSec, endSec) {
      if (!buffer || !Number.isFinite(startSec)) return null;
      const end = Number.isFinite(endSec) && endSec > startSec ? endSec : startSec + 2.5;
      const sampleRate = buffer.sampleRate || 44100;
      const startIdx = Math.max(0, Math.floor(startSec * sampleRate));
      const endIdx = Math.min(buffer.length, Math.floor(end * sampleRate));
      if (endIdx <= startIdx) return null;
      const channel = buffer.getChannelData(0);
      const slice = channel.subarray(startIdx, endIdx);
      return Float32Array.from(slice);
    }

    function normalizeWaveformSamples(samples) {
      if (!samples || !samples.length) return samples;
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
      }
      if (!peak) return samples;
      const scale = Math.min(8, 0.9 / peak);
      if (scale <= 1) return samples;
      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        out[i] = samples[i] * scale;
      }
      return out;
    }

    function getWaveformPeak(samples) {
      if (!samples || !samples.length) return 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
      }
      return peak;
    }

    function isWaveformUsable(samples) {
      if (!samples || !samples.length) return false;
      return getWaveformPeak(samples) >= 0.005;
    }

    function drawWaveform(canvas, data) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const slice = Math.max(1, Math.floor(data.length / width));
      for (let x = 0; x < width; x++) {
        const start = x * slice;
        let min = 1.0;
        let max = -1.0;
        for (let i = 0; i < slice; i++) {
          const v = data[start + i] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const y1 = (1 + min) * 0.5 * height;
        const y2 = (1 + max) * 0.5 * height;
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
      }
      ctx.stroke();
    }

    async function drawWaveformFromBlob(canvas, blob) {
      const buffer = await decodeAudioBlobToBuffer(blob);
      const channel = buffer.getChannelData(0);
      const samples = new Float32Array(channel.length);
      samples.set(channel);
      drawWaveform(canvas, samples);
    }

    function drawWaveformFromMediaElement(canvas, mediaEl) {
      if (!mediaEl) return false;
      try {
        if (!audioModeManager || typeof audioModeManager.ensureAnalyser !== 'function') return false;
        const analyser = audioModeManager.ensureAnalyser(mediaEl);
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        const normalized = Float32Array.from(data, v => (v - 128) / 128);
        drawWaveform(canvas, normalized);
        return true;
      } catch (_) {
        return false;
      }
    }

    function drawPlaceholderWaveform(canvas) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#eef2f7';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const y = height / 2 + Math.sin(x / 8) * (height / 4);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /**
     * 自然边界：计算字幕段更自然的停止时间。
     * 字幕时间戳（尤其 YouTube）常在最后一个词说完前就结束，硬切会吃掉尾词。
     * 尾部缓冲 = 时长的 12%（0.25–0.6s）；紧贴下一句时允许最多溢出 0.3s，
     * 有静音间隙时不超过下一句开始。
     */
    function computeNaturalStopTime(start, end, nextStart) {
      const duration = end - start;
      const buffer = Math.min(0.6, Math.max(0.25, duration * 0.12));
      if (!Number.isFinite(nextStart)) return end + buffer;
      const gap = nextStart - end;
      if (gap < 0.3) {
        return Math.min(end + buffer, nextStart + 0.3);
      }
      return Math.min(end + buffer, nextStart);
    }

    function playOriginalThenNext() {
      const line = state.currentSegments[state.autoSegmentCursor];
      if (!line) return;

      const start = Number(line.start) || 0;
      const end = Number(line.end);
      const effectiveEnd = Number.isFinite(end) ? end : start + 4;
      const nextSeg = state.currentSegments[state.autoSegmentCursor + 1];
      const nextSegStart = nextSeg ? Number(nextSeg.start) : NaN;

      state.segmentPlaybackEnd = computeNaturalStopTime(start, effectiveEnd, nextSegStart);
      state.segmentPlaybackCallback = () => {
        safePauseVideo();
        state.currentRetry = 0; // 重置重试
        moveToNextLine();
      };

      videoPlayer.currentTime = start;

      // 清除上一段录音的覆盖状态，避免保持静音到上一段的 unmuteTime
      try { if (audioModeManager && audioModeManager.overlayPlaybackState) { audioModeManager.overlayPlaybackState = null; } } catch (_) { }

      // 移动端优先使用“静音启动 → 渐入音量”，提高自动播放成功率
      const isMobile = (audioModeManager?.isMobileEnvironment) || isLikelyMobileDevice;
      if (isMobile) {
        const targetVol = Number.isFinite(videoPlayer.volume) ? (videoPlayer.volume || 1) : 1;
        const prevMuted = videoPlayer.muted;
        videoPlayer.muted = true;
        safePlayVideo({ preferUnmuted: false }).then((ok) => {
          setTimeout(() => { captureOriginalWaveformSnapshot(); }, 240);
          setTimeout(() => { try { smoothUnmute(videoPlayer, targetVol, DUCK_FADE_MS); } catch (_) { videoPlayer.muted = prevMuted === false ? false : false; } }, 140);
        });
        // 多次温和重试（部分设备策略较严）
        [260, 800, 1500].forEach((ms) => {
          setTimeout(() => { if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false }); }, ms);
        });
      } else {
        safePlayVideo();
        setTimeout(() => { captureOriginalWaveformSnapshot(); }, 180);
        // 回退：若失败，再次以静音方式启动
        setTimeout(() => { if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false }); }, 220);
      }
      updateAutoStatus('🎵', '播放原声中...');
    }

    function moveToNextLine() {
      if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
        // 已经是最后一句
        updateAutoStatus('🎉', '恭喜完成所有对话！');
        state.autoMode = false;
        updateAudioModeButtonsAvailability(); // 练习完成，重新启用音频模式按钮
        if (autoStartBtn) {
          autoStartBtn.hidden = false;
          autoStartBtn.textContent = '▶';
        }
        if (autoPauseBtn) autoPauseBtn.hidden = true;
        return;
      }

      const prevLineSeg = state.currentSegments[state.autoSegmentCursor];
      state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
      state.currentRetry = 0;

      // 高亮当前segment - 使用实际的segment index而不是practiceIndex
      const nextLine = state.currentSegments[state.autoSegmentCursor];
      if (nextLine) {
        const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
        highlightCurrentSegment(segmentIndex, true);
      }

      // 继续自动流程（如果没有暂停）
      // 自然边界：句间停顿跟随原对话节奏 —— 紧贴时只留 150ms，有自然停顿时最多 500ms
      let interDelay = 500;
      if (prevLineSeg && nextLine) {
        const prevEnd = Number(prevLineSeg.end);
        const nextStart = Number(nextLine.start);
        if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
          interDelay = Math.min(500, Math.max(150, (nextStart - prevEnd) * 1000));
        }
      }
      if (!state.isPaused) {
        setTimeout(() => {
          autoPlayCurrentSegment();
        }, interDelay);
      }
    }

    function autoPlayCurrentSegment() {
      // 检查是否暂停
      if (state.isPaused) return;

      // 从所有segments中获取当前要播放的
      const allSegments = state.currentSegments;
      if (!allSegments || !allSegments.length) return;

      // 使用 autoSegmentCursor 作为 currentSegments 的索引
      const pointer = state.autoSegmentCursor;

      if (pointer >= allSegments.length) {
        // 已经播放完所有segment
        updateAutoStatus('🎉', '恭喜完成所有对话！');
        if (window.Feedback) {
          const msg = (typeof i18n !== 'undefined' && i18n?.t) ? (i18n.t('feedback.session_done') || '本场已完成！') : '本场已完成！';
          Feedback.showToast('success', `🎉 ${msg}`);
          Feedback.awardBadgeOnce('session-complete', '本场完成');
        }
        state.autoMode = false;
        updateAudioModeButtonsAvailability(); // 练习完成，重新启用音频模式按钮
        return;
      }

      const currentLine = allSegments[pointer];
      if (!currentLine) return;

      const speaker = currentLine.speaker || '';
      const rawSegmentIndex = currentLine.index != null ? currentLine.index : pointer;
      const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
      const segmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
      const segmentKey = buildSegmentKey(rawSegmentIndex);

      // 高亮当前segment
      highlightCurrentSegment(segmentIndex, true);

      // 检查这个segment是否是用户的台词
      // 优先使用 speaker 字段直接比较，其次使用 segmentSpeakerMap
      let isUserLine = false;

      // 方法1: 直接比较 speaker 名称
      if (speaker && state.selectedSpeaker && speaker === state.selectedSpeaker) {
        isUserLine = true;
      }

      // 方法2: 检查是否在 practiceLines 中（用户选择的角色的台词）
      if (!isUserLine) {
        const matchingPracticeLine = state.practiceLines.find(line => {
          const lineSegmentIndex = line.index != null ? line.index : line.segmentIndex;
          const lineKey = buildSegmentKey(lineSegmentIndex);
          if (segmentKey && lineKey) {
            return lineKey === segmentKey;
          }
          const normalizedLine = normalizeSegmentIndex(lineSegmentIndex);
          return normalizedLine !== null && normalizedSegmentIndex !== null && normalizedLine === normalizedSegmentIndex;
        });
        if (matchingPracticeLine) {
          isUserLine = true;
        }
      }

      // 方法3: 使用 segmentSpeakerMap（后备方案）
      if (!isUserLine && segmentKey && state.segmentSpeakerMap.has(segmentKey)) {
        isUserLine = state.segmentSpeakerMap.get(segmentKey) === state.selectedSpeaker;
      }

      if (isUserLine) {
        // 是用户的台词，等待录音
        updateAutoStatus('🎭', '准备说话...');
        if (window.Feedback) Feedback.playSfx('prompt');
        setTimeout(() => {
          if (!state.isPaused) {
            startAutoRecording();
          }
        }, USER_PREP_MS);
      } else {
        // 不是用户的台词，自动播放
        playNonUserLine(currentLine);
      }
    }

    function playNonUserLine(line) {
      const start = Number(line.start) || 0;
      const end = Number(line.end);
      const effectiveEnd = Number.isFinite(end) ? end : start + 4;

      // 查找下一句的开始时间
      let nextSegmentStart = null;
      for (const seg of state.currentSegments) {
        const segStart = Number(seg.start);
        if (Number.isFinite(segStart) && segStart >= effectiveEnd - 0.01) {
          nextSegmentStart = segStart;
          break;
        }
      }

      // 自然边界：加尾部缓冲避免硬切尾词（紧贴时最多溢出 0.3s）
      state.segmentPlaybackEnd = computeNaturalStopTime(
        start,
        effectiveEnd,
        Number.isFinite(nextSegmentStart) ? nextSegmentStart : NaN
      );
      state.segmentPlaybackCallback = () => {
        safePauseVideo();
        // 播放完其他角色的台词，继续下一句
        moveToNextLine();
      };

      unifiedPlayer.setCurrentTime(start);
      safePlayVideo();
      setTimeout(() => { captureOriginalWaveformSnapshot(); }, 200);
      // Watchdog: if autoplay policy blocked, retry with muted
      setTimeout(() => {
        try {
          if (unifiedPlayer.isPaused()) {
            safePlayVideo({ preferUnmuted: false });
          }
        } catch (_) { }
      }, 220);
      updateAutoStatus('🎬', `${line.speaker || '其他角色'}正在说话...`);
    }

    function startAutoMode() {
      if (!state.selectedSpeaker) {
        alert('请先选择你要扮演的角色');
        return;
      }

      if (!state.currentSegments || state.currentSegments.length === 0) {
        alert('没有可用的对话内容');
        return;
      }

      state.autoMode = true;
      state.isPaused = false;
      updateAudioModeButtonsAvailability(); // 禁用音频模式按钮防止误触
      state.autoSegmentCursor = 0;
      state.practiceIndex = 0;
      state.currentRetry = 0;

      // 隐藏独立的开始录音按钮
      if (startRecordingFab) startRecordingFab.hidden = true;

      // 显示自动控制面板，隐藏开始按钮，显示暂停按钮
      if (autoPracticeStatus) autoPracticeStatus.hidden = false;
      if (autoStartBtn) autoStartBtn.hidden = true;
      if (autoPauseBtn) autoPauseBtn.hidden = false;

      // 暂停视频（用户台词时无需播放）；隐藏覆盖层，避免用户再点一次
      safePauseVideo();
      if (playOverlay) playOverlay.style.display = 'none';

      // 重新渲染以显示正确的高亮（在auto模式下）
      renderPracticeLines();

      updateAutoStatus('🎬', '开始角色扮演...');

      setTimeout(() => {
        autoPlayCurrentSegment();
      }, 1000);
    }

    function pauseAutoMode() {
      state.isPaused = true;

      // 停止录音
      if (state.isRecording) {
        stopVADMonitoring();
        if (state.recorder && state.recorder.state !== 'inactive') {
          state.recorder.stop();
        }
        state.isRecording = false;
      }

      // 暂停视频
      safePauseVideo();

      // 更新按钮状态
      if (autoStartBtn) {
        autoStartBtn.hidden = false;
        autoStartBtn.textContent = '▶';
      }
      if (autoPauseBtn) autoPauseBtn.hidden = true;

      updateAutoStatus('⏸', '已暂停');
      updateAudioModeButtonsAvailability(); // 暂停后允许切换音频模式试听
    }

    function resumeAutoMode() {
      if (!state.autoMode) return;

      state.isPaused = false;
      updateAudioModeButtonsAvailability(); // 继续练习，禁用音频模式按钮

      // 更新按钮状态
      if (autoStartBtn) autoStartBtn.hidden = true;
      if (autoPauseBtn) autoPauseBtn.hidden = false;

      updateAutoStatus('▶', '继续...');

      setTimeout(() => {
        autoPlayCurrentSegment();
      }, 500);
    }

    function gotoPrevLine() {
      if (state.autoSegmentCursor <= 0) {
        updateAutoStatus('ℹ️', '已经是第一句了');
        return;
      }

      // 停止当前操作
      if (state.isRecording) {
        stopVADMonitoring();
        if (state.recorder && state.recorder.state !== 'inactive') {
          state.recorder.stop();
        }
        state.isRecording = false;
      }

      videoPlayer.pause();

      // 回到上一句
      state.autoSegmentCursor = Math.max(0, state.autoSegmentCursor - 1);
      state.currentRetry = 0;

      // 高亮当前segment
      const prevLine = state.currentSegments[state.autoSegmentCursor];
      if (prevLine) {
        const segmentIndex = prevLine.index != null ? prevLine.index : state.autoSegmentCursor;
        highlightCurrentSegment(segmentIndex, true);
      }

      updateAutoStatus('⏮', '回到上一句');

      // 如果没有暂停，继续播放
      if (!state.isPaused) {
        setTimeout(() => {
          autoPlayCurrentSegment();
        }, 1000);
      }
    }

    function gotoNextLine() {
      if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
        updateAutoStatus('ℹ️', '已经是最后一句了');
        return;
      }

      // 停止当前操作
      if (state.isRecording) {
        stopVADMonitoring();
        if (state.recorder && state.recorder.state !== 'inactive') {
          state.recorder.stop();
        }
        state.isRecording = false;
      }

      videoPlayer.pause();

      // 跳到下一句
      state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
      state.currentRetry = 0;

      // 高亮当前segment
      const nextLine = state.currentSegments[state.autoSegmentCursor];
      if (nextLine) {
        const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
        highlightCurrentSegment(segmentIndex, true);
      }

      updateAutoStatus('⏭', '跳到下一句');

      // 如果没有暂停，继续播放
      if (!state.isPaused) {
        setTimeout(() => {
          autoPlayCurrentSegment();
        }, 1000);
      }
    }

    // ===== 自动流程核心函数结束 =====

    function buildPracticeLineClass({ isStudentLine, isCurrent, isCompleted, isOtherSpeaker }) {
      const classes = ['line-item'];
      if (isStudentLine) classes.push('my-role');
      if (isCurrent) classes.push('current');
      if (isCompleted) classes.push('practice-success');
      if (isOtherSpeaker) classes.push('other-speaker');
      return classes.join(' ');
    }

    const PRACTICE_STOPWORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'them', 'my', 'your', 'his', 'their',
      'this', 'that', 'these', 'those', 'there', 'here', 'as', 'if', 'then', 'than', 'because', 'about', 'from',
      'can', 'could', 'should', 'would', 'will', 'just', 'not', 'no', 'yes', 'what', 'when', 'where', 'why', 'how'
    ]);

    function getLineTranslation(segment = {}) {
      return String(segment.translation || segment.cn || segment.zh || segment.text_cn || '').trim();
    }

    function pickHighlightWords(text) {
      const tokens = String(text || '').match(/[A-Za-z']+/g) || [];
      const candidates = [];
      const seen = new Set();
      tokens.forEach(token => {
        const lower = token.toLowerCase();
        if (lower.length < 5) return;
        if (PRACTICE_STOPWORDS.has(lower)) return;
        if (seen.has(lower)) return;
        seen.add(lower);
        candidates.push({ word: lower, weight: lower.length });
      });
      candidates.sort((a, b) => b.weight - a.weight);
      return new Set(candidates.slice(0, 4).map(c => c.word));
    }

    function highlightLineText(text) {
      const raw = String(text || '');
      if (!raw.trim()) return '';
      const highlightSet = pickHighlightWords(raw);
      if (!highlightSet.size) return escapeHtml(raw);
      const regex = /[A-Za-z']+/g;
      let lastIndex = 0;
      let match = null;
      const parts = [];
      while ((match = regex.exec(raw)) !== null) {
        if (match.index > lastIndex) {
          parts.push(escapeHtml(raw.slice(lastIndex, match.index)));
        }
        const token = match[0];
        const lower = token.toLowerCase();
        if (highlightSet.has(lower)) {
          parts.push(`<span class="vocab-word" data-word="${escapeHtml(lower)}">${escapeHtml(token)}</span>`);
        } else {
          parts.push(escapeHtml(token));
        }
        lastIndex = match.index + token.length;
      }
      if (lastIndex < raw.length) {
        parts.push(escapeHtml(raw.slice(lastIndex)));
      }
      return parts.join('');
    }

    function isDifficultLine(text) {
      const raw = String(text || '').trim();
      if (!raw) return false;
      const wordCount = (raw.match(/[A-Za-z']+/g) || []).length;
      return wordCount >= 16 || raw.length >= 95;
    }

    let practiceDictReady = false;

    function ensurePracticeDictModal() {
      if (practiceDictReady) return;
      const modal = document.getElementById('practice-dict-modal');
      const backdrop = document.getElementById('practice-dict-backdrop');
      const closeBtn = document.getElementById('practice-dict-close');
      if (!modal) return;

      // 重挂到 body：逃出 .card 的 backdrop-filter 包含块（Chrome 会把
      // position:fixed 钉在该祖先上）和 overflow:hidden 裁剪，
      // 否则平板上弹层被压在左栏内、✕/背景都点不到
      if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
      }

      const close = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
      };

      if (backdrop) backdrop.addEventListener('click', close);
      if (closeBtn) closeBtn.addEventListener('click', close);
      // Esc 关闭
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && modal.style.display !== 'none') close();
      });
      practiceDictReady = true;
    }

    async function openPracticeDictionary(word) {
      const target = String(word || '').trim().toLowerCase();
      if (!target) return;
      ensurePracticeDictModal();
      const modal = document.getElementById('practice-dict-modal');
      const content = document.getElementById('practice-dict-content');
      if (!modal || !content) return;

      modal.style.display = 'grid';
      modal.setAttribute('aria-hidden', 'false');
      content.innerHTML = `<div style="padding: 12px; color: #64748b;">正在查询 <strong>${escapeHtml(target)}</strong>...</div>`;

      try {
        const result = await window.DictionaryLookup.lookupWord(target);
        const entry = result?.entry || null;
        const wordTranslation = result?.wordTranslation || '';
        if (window.DictionaryRender && typeof window.DictionaryRender.build === 'function') {
          content.innerHTML = window.DictionaryRender.build(target, entry, wordTranslation, { langMode: 'zh' });
          window.DictionaryLookup.attachTranslateButtonHandlers(content, target);
          // 绑定发音按钮事件
          attachDictSpeakHandlers(content);
        } else {
          content.innerHTML = `<div style="padding: 12px;">${escapeHtml(target)}：${escapeHtml(wordTranslation || '暂无释义')}</div>`;
        }
      } catch (err) {
        content.innerHTML = `<div style="padding: 12px; color: #ef4444;">查询失败，请稍后再试。</div>`;
      }
    }

    /**
     * 绑定词典弹窗中的发音按钮事件
     */
    function attachDictSpeakHandlers(container) {
      if (!container) return;
      const btns = container.querySelectorAll('.dict-speak-btn, .dict-def-speak');
      btns.forEach(btn => {
        if (btn.dataset.speakHandlerAttached) return;
        btn.dataset.speakHandlerAttached = 'true';

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          const audioUrl = (btn.dataset.audio || '').trim();
          const text = (btn.dataset.word || btn.dataset.text || '').trim();

          if (!text && !audioUrl) return;

          // 停止所有正在播放的声音
          try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (_) { }
          // 暂停视频播放，防止声音重叠
          try { if (videoPlayer && !videoPlayer.paused) videoPlayer.pause(); } catch (_) { }
          try { if (youtubePlayer && youtubePlayer.pauseVideo) youtubePlayer.pauseVideo(); } catch (_) { }

          // 优先使用 audio URL（如果有）
          if (audioUrl) {
            try {
              const audio = new Audio(audioUrl);
              audio.play().catch(() => speakWithBetterVoice(text));
              return;
            } catch (_) { }
          }

          // 使用浏览器语音合成
          if (text) {
            speakWithBetterVoice(text);
          }
        });
      });
    }

    function speakWithBetterVoice(text) {
      if (!text || !window.speechSynthesis) return;

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = 'en-US';
      utt.rate = 0.85;      // 稍慢，更清晰
      utt.pitch = 1.0;      // 正常音调
      utt.volume = 0.9;     // 适中音量

      // 尝试选择更自然的语音
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        // 优先选择自然/高质量语音
        const preferredVoice = voices.find(v =>
          v.lang.startsWith('en') && (
            v.name.includes('Samantha') ||    // macOS 高质量语音
            v.name.includes('Alex') ||         // macOS
            v.name.includes('Karen') ||        // macOS Australian
            v.name.includes('Daniel') ||       // macOS British
            v.name.includes('Google') ||       // Chrome 高质量
            v.name.includes('Microsoft') ||    // Edge 高质量
            v.name.includes('Natural') ||
            v.name.includes('Neural') ||
            v.name.includes('Premium')
          )
        ) || voices.find(v => v.lang === 'en-US' && !v.localService)
          || voices.find(v => v.lang === 'en-US')
          || voices.find(v => v.lang.startsWith('en'));

        if (preferredVoice) {
          utt.voice = preferredVoice;
        }
      }

      speechSynthesis.speak(utt);
    }

    function fallbackSpeak(text) {
      speakWithBetterVoice(text);
    }

    function renderPracticeLines() {
      if (!practiceLineList) return;
      practiceLineList.innerHTML = '';

      if (!state.currentSegments.length) {
        const li = document.createElement('li');
        li.className = 'script-empty';
        li.textContent = '这段视频还没有字幕。换一段有字幕的视频，就能逐句跟读。';
        practiceLineList.appendChild(li);
        practiceLineEls = [];
        lastHighlightedArrayIndex = -2;
        return;
      }

      // 🔍 Debug: 显示渲染前的状态

      const studentLineIndexMap = new Map();
      state.practiceLines.forEach((line, idx) => {
        if (!line) return;
        const rawIndex = line.index != null ? line.index : line.segmentIndex;
        const key = buildSegmentKey(rawIndex);
        if (key) {
          studentLineIndexMap.set(key, idx);
        }
      });

      const total = state.currentSegments.length;
      let foundCurrentHighlight = false; // 🔍 Track if we found and applied highlight

      state.currentSegments.forEach((segment, idx) => {
        const rawSegmentIndex = segment.index != null ? segment.index : idx;
        const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
        const resultKey = buildSegmentKey(rawSegmentIndex);
        const studentIdx = resultKey ? studentLineIndexMap.get(resultKey) : undefined;
        const practiceLine = studentIdx != null ? state.practiceLines[studentIdx] : null;
        const isStudentLine = practiceLine != null;
        const canonicalSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
        // 在dialogue模式下，也允许高亮当前正在练习的句子（如果practiceIndex匹配）
        // 修正：在对话模式下，优先使用 video-time based (state.currentSegmentIndex) 来高亮，
        // 这样可以跟随对话流（包括对方角色的台词）。
        // 仅在录音/准备录音状态下，强制锁定在 practiceIndex
        const isDialogue = currentPracticeMode === 'dialogue';
        const isCurrent = (state.autoMode && !isDialogue)
          ? canonicalSegmentIndex === state.currentSegmentIndex
          : (isDialogue
            ? ((state.isRecording || dialoguePracticeState.isPreparingRecording)
              ? (isStudentLine && studentIdx === state.practiceIndex)
              : canonicalSegmentIndex === state.currentSegmentIndex)
            : (isStudentLine && studentIdx === state.practiceIndex));
        const isCompleted = resultKey ? state.practiceLineResults[resultKey] === 'success' : false;

        // 🔍 Debug: 对于学生句子，显示详细信息
        if (isStudentLine) {
          if (isCurrent) {
            foundCurrentHighlight = true;
          }
        }

        const li = document.createElement('li');
        li.className = buildPracticeLineClass({
          isStudentLine,
          isCurrent,
          isCompleted,
          isOtherSpeaker: !isStudentLine,
        });

        // 🔍 Debug: 显示最终的 className
        if (isStudentLine) {
        }

        const speakerName = isStudentLine
          ? `[${practiceLine.speaker || state.selectedSpeaker}] - 你的角色`
          : (segment.speaker ? `[${segment.speaker}]` : '');
        if (speakerName) {
          const speakerEl = document.createElement('div');
          speakerEl.className = 'line-speaker';
          speakerEl.textContent = speakerName;
          li.appendChild(speakerEl);
        }

        const header = document.createElement('div');
        header.className = 'line-header';

        const lineNumber = document.createElement('span');
        lineNumber.className = 'line-number';
        lineNumber.textContent = `Line ${idx + 1} of ${total}`;
        header.appendChild(lineNumber);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'line-time';
        const start = Number(segment.start) || 0;
        const end = Number(segment.end != null ? segment.end : start);
        timeSpan.textContent = `${formatTime(start)} – ${formatTime(end)}`;
        const metaWrap = document.createElement('div');
        metaWrap.className = 'line-meta';
        metaWrap.appendChild(timeSpan);
        const lineText = (practiceLine && practiceLine.text) || segment.text || '';
        if (isDifficultLine(lineText)) {
          const difficulty = document.createElement('span');
          difficulty.className = 'line-difficulty';
          difficulty.textContent = '⚡ 难度较高';
          metaWrap.appendChild(difficulty);
        }
        header.appendChild(metaWrap);

        li.appendChild(header);

        // timestamps for shadowing mode
        li.dataset.start = String(start);
        li.dataset.end = String(end);

        const textEl = document.createElement('div');
        textEl.className = 'line-text';
        textEl.innerHTML = highlightLineText(lineText);
        li.appendChild(textEl);

        const translation = getLineTranslation(segment);
        if (translation) {
          const translationEl = document.createElement('div');
          translationEl.className = 'line-translation';
          translationEl.textContent = translation;
          li.appendChild(translationEl);
        }

        // 分享模式：为有录音的句子添加播放按钮
        if (isShareMode() && isStudentLine) {
          const hasRecording = audioModeManager && audioModeManager.userRecordings && audioModeManager.userRecordings[resultKey];
          const playBtn = document.createElement('button');
          playBtn.className = 'share-play-recording-btn';
          playBtn.style.cssText = `
            margin-top: 8px;
            padding: 6px 14px;
            background: ${hasRecording ? 'linear-gradient(135deg, #059669, #10b981)' : '#e5e7eb'};
            color: ${hasRecording ? 'white' : '#9ca3af'};
            border: none;
            border-radius: 20px;
            font-size: 13px;
            cursor: ${hasRecording ? 'pointer' : 'default'};
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s;
          `;
          playBtn.innerHTML = hasRecording
            ? '🎧 <span>播放分享者录音</span>'
            : '⏳ <span>未录制</span>';
          if (hasRecording) {
            playBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              playShareRecording(resultKey);
            });
          }
          li.appendChild(playBtn);
        }

        // 点击交互由 practiceLineList 上的事件委托统一处理（见 renderPracticeLines 之后）
        li.dataset.segmentIndex = resultKey || '';
        li.dataset.arrayIndex = String(idx);
        if (translation) li.dataset.hasTranslation = '1';
        if (isStudentLine) li.dataset.studentIdx = String(studentIdx);
        if (canonicalSegmentIndex != null) li.dataset.canonicalIndex = String(canonicalSegmentIndex);
        practiceLineList.appendChild(li);
      });

      // 缓存行元素引用，供 highlightCurrentSegment 每 tick 直取，避免反复 querySelectorAll
      practiceLineEls = Array.from(practiceLineList.children).filter((el) => el.classList.contains('line-item'));
      lastHighlightedArrayIndex = -2;

      // 🔍 Debug: 总结渲染结果

      let targetSegmentIndex = null;
      if (state.practiceLines.length) {
        const boundedIndex = Math.min(state.practiceIndex, state.practiceLines.length - 1);
        const currentLine = state.practiceLines[boundedIndex];
        if (currentLine) {
          targetSegmentIndex = currentLine.index != null ? currentLine.index : currentLine.segmentIndex;
          state.practiceIndex = boundedIndex;
        }
      } else if (state.currentSegments.length) {
        const fallback = state.currentSegments[Math.min(state.currentSegmentIndex || 0, state.currentSegments.length - 1)];
        if (fallback) {
          targetSegmentIndex = fallback.index != null ? fallback.index : state.currentSegments.indexOf(fallback);
        }
      }

      // 对话模式下，不在这里添加高亮（主循环中已经通过 buildPracticeLineClass 正确设置了 className）
      if (currentPracticeMode !== 'dialogue') {
        if (targetSegmentIndex != null) {
          highlightCurrentSegment(targetSegmentIndex, false);
        } else {
          practiceLineList.querySelectorAll('.line-item').forEach((item) => item.classList.remove('current'));
        }
      }
      // 🎯 对话模式：主循环中的 buildPracticeLineClass 已经根据 state.practiceIndex 正确设置了 'current' class
      // 不需要再调用 highlightCurrentSegment(),避免两种方式混用导致冲突

      // 🔍 Debug: 同步检查DOM(不用setTimeout,立即检查主循环创建的DOM)
      if (currentPracticeMode === 'dialogue') {
        const allItems = practiceLineList.querySelectorAll('.line-item');
        const currentItems = practiceLineList.querySelectorAll('.line-item.current');

        // 打印所有student line的className
        let studentCount = 0;
        allItems.forEach((item, i) => {
          const hasMyRole = item.classList.contains('my-role');
          const hasCurrent = item.classList.contains('current');
          const hasOtherSpeaker = item.classList.contains('other-speaker');
          if (hasMyRole) {
            studentCount++;
          }
        });

        // 如果有.current元素,打印它们的详细信息
        if (currentItems.length > 0) {
          currentItems.forEach((item, i) => {
            const text = item.querySelector('.line-text')?.textContent || '';
          });
        } else {
        }
      }

      renderPracticeCurrentLine();
    }

    function buildHighlightedPracticeHTML(originalText, correctIndexes) {
      if (!originalText) return '';
      const correctSet = new Set(correctIndexes || []);
      const segments = [];
      const wordRegex = /[A-Za-z0-9']+/g;
      let lastIndex = 0;
      let match = null;
      let wordIndex = 0;

      while ((match = wordRegex.exec(originalText)) !== null) {
        if (match.index > lastIndex) {
          segments.push(escapeHtml(originalText.slice(lastIndex, match.index)));
        }
        const wordText = match[0];
        const escapedWord = escapeHtml(wordText);
        if (correctSet.has(wordIndex)) {
          segments.push(`<span class="practice-word-correct">${escapedWord}</span>`);
        } else {
          segments.push(escapedWord);
        }
        lastIndex = match.index + wordText.length;
        wordIndex += 1;
      }

      if (lastIndex < originalText.length) {
        segments.push(escapeHtml(originalText.slice(lastIndex)));
      }

      return segments.join('');
    }

    function renderPracticeCurrentLine() {
      if (!practiceCurrentLine) return;
      const line = state.practiceLines[state.practiceIndex];
      if (!line) {
        practiceCurrentLine.hidden = true;
        return;
      }

      const rawKey = line.index != null ? line.index : line.segmentIndex;
      const key = buildSegmentKey(rawKey);
      const isSuccessful = key ? state.practiceLineResults[key] === 'success' : false;
      const wordResult = key ? (state.practiceLineWordResults[key] || {}) : {};
      const highlighted = buildHighlightedPracticeHTML(line.text, wordResult.correctIndexes);
      practiceCurrentLine.hidden = false;
      practiceCurrentLine.className = `practice-current-line${isSuccessful ? ' practice-successful' : ''}`;
      practiceCurrentLine.innerHTML = `
        <div class="practice-current-meta">Line ${state.practiceIndex + 1} of ${state.practiceLines.length}</div>
        <div class="practice-current-text">${highlighted || escapeHtml(line.text || '')}</div>
        <div class="practice-current-time">${formatTime(line.start)} – ${formatTime(line.end)}</div>
      `;
    }

    // Throttle for scroll behavior to prevent flickering
    let lastScrollTime = 0;
    const SCROLL_THROTTLE_MS = 200;

    function isItemVisibleInContainer(item, container, padding = 40) {
      if (!item || !container) return true;
      const containerRect = container.getBoundingClientRect();
      const containerHeight = containerRect.height;
      if (!containerHeight) return true;

      const itemRect = item.getBoundingClientRect();
      const itemHeight = itemRect.height;

      const viewTop = containerRect.top + padding;
      const viewBottom = containerRect.bottom - padding;
      const viewHeight = viewBottom - viewTop;

      // 1. Fully contained (strict check for small items)
      if (itemRect.top >= viewTop && itemRect.bottom <= viewBottom) return true;

      // 2. Center check (for items larger than view or just partially visible)
      // If the center of the item is within the view, consider it visible (matches scrollIntoView center alignment)
      const itemCenter = itemRect.top + itemHeight / 2;
      const viewCenter = viewTop + viewHeight / 2;

      // Allow a reasonable tolerance (e.g., 25% of view or fixed pixels)
      // If the centers are close, we don't need to scroll.
      if (Math.abs(itemCenter - viewCenter) < (viewHeight / 4)) return true;

      // 3. Fallback: If item is huge and covers the whole view
      if (itemRect.top <= viewTop && itemRect.bottom >= viewBottom) return true;

      return false;
    }

    function scrollItemIntoView(item) {
      if (!item) return;
      const container = item.closest('.lines-container');
      if (isItemVisibleInContainer(item, container)) return;
      item.scrollIntoView({ block: 'center', behavior: 'auto' });
    }

    function isElementVisibleInViewport(el, padding = 24) {
      if (!el) return true;
      const rect = el.getBoundingClientRect();
      if (!rect.height) return true;
      return rect.top >= padding && rect.bottom <= (window.innerHeight - padding);
    }

    let lastAsrAutoScroll = 0;
    const ASR_SCROLL_COOLDOWN_MS = 800;

    function highlightCurrentSegment(segmentIndex, scroll = true) {
      const normalizedSegmentIndex = normalizeSegmentIndex(segmentIndex);
      const segmentKey = buildSegmentKey(segmentIndex);
      let targetArrayIndex = -1;
      if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
        targetArrayIndex = state.currentSegments.findIndex((segment, idx) => {
          const idxValue = segment.index != null ? segment.index : idx;
          const normalizedIdxValue = normalizeSegmentIndex(idxValue);
          if (normalizedSegmentIndex !== null) {
            return normalizedIdxValue === normalizedSegmentIndex;
          }
          const candidateKey = buildSegmentKey(idxValue);
          if (segmentKey && candidateKey) {
            return candidateKey === segmentKey;
          }
          return normalizedIdxValue === null && idxValue === segmentIndex;
        });
        if (state.autoMode && targetArrayIndex >= 0) {
          state.autoSegmentCursor = targetArrayIndex;
        }
      }

      state.currentSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : segmentIndex;
      const studentIdx = segmentKey ? state.practiceLineIndexMap.get(segmentKey) : undefined;
      const practiceIndexChanged = studentIdx != null && state.practiceIndex !== studentIdx;

      // 快速路径：高亮目标未变化时跳过整列表 DOM 扫描（timeupdate/轮询每 tick 都会调用本函数）
      if (targetArrayIndex >= 0 && targetArrayIndex === lastHighlightedArrayIndex && !practiceIndexChanged) {
        if (scroll) {
          const currentItem = practiceLineEls[targetArrayIndex];
          const now = Date.now();
          if (currentItem && now - lastScrollTime >= SCROLL_THROTTLE_MS) {
            lastScrollTime = now;
            scrollItemIntoView(currentItem);
          }
        }
        return;
      }
      lastHighlightedArrayIndex = targetArrayIndex;

      const lineItems = practiceLineEls.length
        ? practiceLineEls
        : Array.from(practiceLineList.querySelectorAll('.line-item'));
      lineItems.forEach((item) => {
        const itemKey = item.dataset.segmentIndex;
        const itemArrayIndex = Number(item.dataset.arrayIndex);
        const normalizedItemKey = normalizeSegmentIndex(itemKey);
        const matchByNormalized = normalizedSegmentIndex !== null && normalizedItemKey === normalizedSegmentIndex;
        const matchByKey = normalizedSegmentIndex === null && segmentKey && itemKey === segmentKey;
        const matchByArrayIndex = Number.isInteger(itemArrayIndex) && itemArrayIndex === targetArrayIndex;
        if (matchByNormalized || matchByKey || matchByArrayIndex) {
          item.classList.add('current');
          if (scroll) {
            // Throttle scrolling to prevent visual flickering
            const now = Date.now();
            if (now - lastScrollTime >= SCROLL_THROTTLE_MS) {
              lastScrollTime = now;
              scrollItemIntoView(item);
            }
          }
        } else {
          item.classList.remove('current');
        }
      });

      if (practiceIndexChanged) {
        // 在 Dialogue 模式下，practiceIndex 由对话流程严格控制，
        // 不要因为视频播放进度的变化而自动更改它，否则会导致 cursor 跳动或逻辑冲突。
        if (currentPracticeMode !== 'dialogue') {
          state.practiceIndex = studentIdx;
        }
        renderPracticeCurrentLine();
        // Update progress chip
        updatePracticeProgress();
      }

      // Update Progress Bar
      if (targetArrayIndex >= 0 && state.currentSegments.length > 0) {
        const progress = ((targetArrayIndex + 1) / state.currentSegments.length) * 100;
        const progressBar = document.getElementById('practice-progress-bar');
        if (progressBar) {
          progressBar.style.width = `${progress}%`;
        }
      }
    }

    function setPracticeSpeaker(speakerName) {
      if (state.recorder && state.recorder.state !== 'inactive') {
        try { state.recorder.stop(); } catch (err) { console.warn(err); }
      }
      state.selectedSpeaker = speakerName;
      const speakerData = state.speakers.find((item) => item.speaker === speakerName);
      const rawLines = Array.isArray(speakerData?.lines) ? speakerData.lines : [];

      // If speakers come from a different segmentation (e.g. legacy unmerged transcript),
      // rebuild the selected role lines from merged currentSegments via time overlap.
      const totalSpeakerLines = Array.isArray(state.speakers)
        ? state.speakers.reduce((sum, s) => sum + (Array.isArray(s?.lines) ? s.lines.length : 0), 0)
        : 0;
      const forceAlignSegments = currentPracticeMode === 'dialogue';
      const hasIndexMismatch = Array.isArray(state.currentSegments) && state.currentSegments.length
        ? rawLines.some((line) => {
          const idx = line?.index != null ? line.index : line?.segmentIndex;
          return Number.isFinite(Number(idx)) && Number(idx) >= state.currentSegments.length;
        }) || (totalSpeakerLines > state.currentSegments.length * 1.2)
        : false;

      if ((hasIndexMismatch || forceAlignSegments) && Array.isArray(state.currentSegments) && state.currentSegments.length && Array.isArray(state.speakers) && state.speakers.length) {
        const spans = [];
        state.speakers.forEach((sp) => {
          const name = (sp?.speaker || '').trim();
          if (!name || !Array.isArray(sp?.lines)) return;
          sp.lines.forEach((line) => {
            const start = Number(line?.start);
            const endRaw = Number(line?.end);
            if (!Number.isFinite(start)) return;
            const end = Number.isFinite(endRaw) ? endRaw : start + 4;
            spans.push({ speaker: name, start, end });
          });
        });

        let aligned = false;
        if (spans.length) {
          spans.sort((a, b) => a.start - b.start);
          let spanPtr = 0;
          state.currentSegments = state.currentSegments.map((seg) => {
            const segStart = Number(seg?.start) || 0;
            const segEndRaw = Number(seg?.end);
            const segEnd = Number.isFinite(segEndRaw) ? segEndRaw : segStart + 4;

            while (spanPtr < spans.length && spans[spanPtr].end < segStart - 0.25) spanPtr++;
            const overlapBySpeaker = new Map();
            for (let j = spanPtr; j < spans.length; j++) {
              const span = spans[j];
              if (span.start > segEnd + 0.25) break;
              const overlap = Math.max(0, Math.min(segEnd, span.end) - Math.max(segStart, span.start));
              if (overlap <= 0) continue;
              overlapBySpeaker.set(span.speaker, (overlapBySpeaker.get(span.speaker) || 0) + overlap);
            }

            let bestSpeaker = null;
            let bestOverlap = 0;
            overlapBySpeaker.forEach((ov, name) => {
              if (ov > bestOverlap) {
                bestOverlap = ov;
                bestSpeaker = name;
              }
            });

            return bestSpeaker ? { ...seg, speaker: bestSpeaker } : seg;
          });
          aligned = true;
        } else if (forceAlignSegments) {
          const speakerByIndex = new Map();
          state.speakers.forEach((sp) => {
            const name = (sp?.speaker || '').trim();
            if (!name || !Array.isArray(sp?.lines)) return;
            sp.lines.forEach((line) => {
              const idx = line?.index != null ? line.index : line?.segmentIndex;
              if (idx == null) return;
              if (!speakerByIndex.has(idx)) speakerByIndex.set(idx, name);
            });
          });
          if (speakerByIndex.size) {
            state.currentSegments = state.currentSegments.map((seg, i) => {
              const segIdx = seg?.index != null ? seg.index : i;
              const speaker = speakerByIndex.get(segIdx);
              return speaker ? { ...seg, speaker } : seg;
            });
            aligned = true;
          }
        }

        if (aligned) {
          state.practiceLines = state.currentSegments
            .filter((seg) => (seg?.speaker || '').trim() === speakerName)
            .map((seg, i) => {
              const idx = seg?.index != null ? seg.index : i;
              return {
                index: idx,
                segmentIndex: idx,
                start: seg.start,
                end: seg.end,
                text: seg.text,
                speaker: speakerName,
              };
            });

          if (state.practiceLines.length) {
            state.practiceIndex = 0;
            state.autoSegmentCursor = 0;
            state.practiceAttempts = 0;
            state.practiceLineResults = {};
            state.practiceLineWordResults = {};
            state.practiceLineIndexMap = new Map();
            state.segmentSpeakerMap = new Map();

            state.practiceLines.forEach((line, idx) => {
              const rawIndex = line.index != null ? line.index : line.segmentIndex;
              const segmentKey = buildSegmentKey(rawIndex);
              const normalizedIndex = normalizeSegmentIndex(rawIndex);
              if (segmentKey) {
                state.practiceLineIndexMap.set(segmentKey, idx);
                if (line.speaker) state.segmentSpeakerMap.set(segmentKey, line.speaker);
              }
              if (normalizedIndex !== null) {
                const numericKey = normalizedIndex;
                const stringKey = String(normalizedIndex);
                state.practiceLineIndexMap.set(stringKey, idx);
                state.practiceLineIndexMap.set(numericKey, idx);
                if (line.speaker) {
                  state.segmentSpeakerMap.set(stringKey, line.speaker);
                  state.segmentSpeakerMap.set(numericKey, line.speaker);
                }
              }
            });

            synchronizeSegmentSpeakers();
            rebuildSegmentRoleMap();
            return;
          }
        }
      }
      // 过滤仅保留确属该角色的台词：优先使用行内 speaker；否则查当前字幕的 segment.speaker
      let validLines = rawLines.filter((line) => {
        if (line && line.speaker) return line.speaker === speakerName;
        const idx = line?.index != null ? line.index : line?.segmentIndex;
        if (idx == null) return false;
        try {
          const keys = getSegmentLookupKeys(idx);
          let segSpeaker = null;
          if (Array.isArray(state.currentSegments)) {
            const match = state.currentSegments.find((seg, i) => {
              const v = seg?.index != null ? seg.index : i;
              const k = buildSegmentKey(v);
              return k && keys.includes(k);
            });
            segSpeaker = match?.speaker || null;
          }
          return segSpeaker ? (segSpeaker === speakerName) : false;
        } catch (_) { return false; }
      });

      // 第二步补漏：遍历 state.currentSegments，如果 segment.speaker === speakerName 且不在 validLines 中，补充进去
      // 这确保即使 rawLines（来自VTT解析聚合）有遗漏，只要 segment 明确标记了 speaker，就不会被跳过
      if (Array.isArray(state.currentSegments)) {
        const existingIndices = new Set(validLines.map(l => l.index != null ? l.index : l.segmentIndex));
        state.currentSegments.forEach((seg, i) => {
          // 检查 speaker 是否匹配
          if (seg.speaker === speakerName) {
            const segIdx = seg.index != null ? seg.index : i;
            // 如果 validLines 里没包含这个 index，就补上去
            if (!existingIndices.has(segIdx)) {
              // 构造一个兼容的 line 对象
              validLines.push({
                index: segIdx,
                segmentIndex: segIdx,
                start: seg.start,
                end: seg.end,
                text: seg.text,
                speaker: seg.speaker
              });
              existingIndices.add(segIdx);
            }
          }
        });
        // 重新按时间或 index 排序，确保顺序正确
        validLines.sort((a, b) => {
          const idxA = a.index != null ? a.index : a.segmentIndex;
          const idxB = b.index != null ? b.index : b.segmentIndex;
          return idxA - idxB;
        });
      }

      // Normalize practice lines to the (possibly merged) currentSegments text/timing.
      // Some speaker sources provide split fragments; align by index first, then fall back to time match.
      if (Array.isArray(state.currentSegments) && state.currentSegments.length && validLines.length) {
        const segmentByKey = new Map();
        state.currentSegments.forEach((seg, i) => {
          const segIdx = seg?.index != null ? seg.index : i;
          const key = buildSegmentKey(segIdx);
          if (key) {
            segmentByKey.set(key, seg);
          }
        });

        const findSegmentByTime = (start, end) => {
          if (!Number.isFinite(start)) return null;
          const startNum = Number(start) || 0;
          const endNum = Number.isFinite(Number(end)) ? Number(end) : startNum + 4;
          let best = null;
          let bestScore = Infinity;

          // currentSegments are typically ordered by start; keep scan window small.
          for (let i = 0; i < state.currentSegments.length; i++) {
            const seg = state.currentSegments[i];
            const segStart = Number(seg?.start) || 0;
            const segEndRaw = Number(seg?.end);
            const segEnd = Number.isFinite(segEndRaw) ? segEndRaw : segStart + 4;
            if (segStart > endNum + 2.5) break;
            if (segEnd < startNum - 2.5) continue;
            const score = Math.abs(segStart - startNum) + Math.abs(segEnd - endNum);
            if (score < bestScore) {
              bestScore = score;
              best = seg;
            }
          }

          return bestScore <= 6.0 ? best : null;
        };

        validLines = validLines.map((line) => {
          if (!line) return line;
          const idx = line.index != null ? line.index : line.segmentIndex;
          const key = buildSegmentKey(idx);
          const directSeg = key ? segmentByKey.get(key) : null;
          const seg = directSeg || findSegmentByTime(line.start, line.end);
          if (!seg) return line;

          const segText = String(seg.text || '').trim();
          const lineText = String(line.text || '').trim();
          const shouldReplaceText = segText && (!lineText || segText.length > lineText.length + 2);
          return {
            ...line,
            start: seg.start,
            end: seg.end,
            text: shouldReplaceText ? seg.text : (line.text || seg.text),
          };
        });
      }

      state.practiceLines = validLines;

      // 如果经过严格过滤及补漏后台词过少（或皆无），启用“交替推断”作为兜底：
      // 思路：基于 currentSegments 顺序奇偶为两方，优先根据已有带 speaker 的行推断奇偶，否则默认偶数段为 Speaker 1
      const totalSegs = Array.isArray(state.currentSegments) ? state.currentSegments.length : 0;
      const needInferFallback = state.practiceLines.length < Math.max(3, Math.floor(totalSegs * 0.15));
      if (needInferFallback && totalSegs > 0) {
        const names = (Array.isArray(state.speakers) ? state.speakers.map(s => s.speaker) : []).filter(Boolean);
        const otherName = names.find(n => n !== speakerName) || 'Other';
        // 计算 selectedSpeaker 的多数奇偶
        let evenCount = 0, oddCount = 0;
        if (rawLines.length) {
          rawLines.forEach((line) => {
            if (line && line.speaker === speakerName) {
              const idx = line.index != null ? line.index : line.segmentIndex;
              const pos = state.currentSegments.findIndex((seg, i) => (seg?.index != null ? seg.index : i) === idx);
              if (pos >= 0) { (pos % 2 === 0 ? evenCount++ : oddCount++); }
            }
          });
        }
        const preferEven = evenCount >= oddCount;
        // 用推断映射重建 practiceLines 与 segmentSpeakerMap
        const inferredLines = [];
        const newMap = new Map();
        state.currentSegments.forEach((seg, i) => {
          const idx = seg?.index != null ? seg.index : i;
          const k = buildSegmentKey(idx);
          const assignToSelected = (i % 2 === 0) === preferEven;
          const name = assignToSelected ? speakerName : otherName;
          if (k) newMap.set(k, name);
          const normalized = normalizeSegmentIndex(idx);
          if (normalized !== null) {
            newMap.set(String(normalized), name);
            newMap.set(normalized, name);
          }
          if (assignToSelected) {
            inferredLines.push({
              index: idx,
              segmentIndex: idx,
              start: seg.start,
              end: seg.end,
              text: seg.text,
              speaker: speakerName,
            });
          }
        });
        state.practiceLines = inferredLines;
        // 合并到 segmentSpeakerMap，但不覆盖已有明确标注
        if (!(state.segmentSpeakerMap instanceof Map)) state.segmentSpeakerMap = new Map();
        newMap.forEach((val, key) => { if (!state.segmentSpeakerMap.has(key)) state.segmentSpeakerMap.set(key, val); });
      }
      state.practiceIndex = 0;
      state.autoSegmentCursor = 0;
      state.practiceAttempts = 0;
      state.practiceLineResults = {};
      state.practiceLineWordResults = {};
      state.practiceLineIndexMap = new Map();
      state.segmentSpeakerMap = new Map();

      state.practiceLineIndexMap = new Map();
      state.segmentSpeakerMap = new Map();

      state.practiceLines.forEach((line, idx) => {
        const rawIndex = line.index != null ? line.index : line.segmentIndex;
        const segmentKey = buildSegmentKey(rawIndex);
        const normalizedIndex = normalizeSegmentIndex(rawIndex);
        if (segmentKey) {
          state.practiceLineIndexMap.set(segmentKey, idx);
          // 仅当该行自带 speaker 时才写入 speaker 映射，避免把未知行误判为当前角色
          if (line.speaker) {
            state.segmentSpeakerMap.set(segmentKey, line.speaker);
          }
        }
        if (normalizedIndex !== null) {
          const numericKey = normalizedIndex;
          const stringKey = String(normalizedIndex);
          state.practiceLineIndexMap.set(stringKey, idx);
          state.practiceLineIndexMap.set(numericKey, idx);
          if (line.speaker) {
            state.segmentSpeakerMap.set(stringKey, line.speaker);
            state.segmentSpeakerMap.set(numericKey, line.speaker);
          }
        }
      });

      synchronizeSegmentSpeakers();
      rebuildSegmentRoleMap();

      if (debugMode) {
        console.log('[实践模式] 角色选中', {
          speakerName,
          practiceSummary: state.practiceSummary,
          mapping: Array.from(state.segmentSpeakerMap.entries()),
        });
      }

      audioModeManager.selectedSpeaker = speakerName;
      audioModeManager.loadUserRecordings(state.videoId, state.serverRecordings || []);
      ensureAudioModeAvailability();
      audioModeManager.setMode(currentAudioMode);
      updateAudioModeButtons();

      renderPracticeLines();
      renderPracticeCurrentLine();
      updatePracticeHint();
      updatePracticeFeedback(state.practiceLines.length ? '选择一个台词开始练习。' : '该角色暂时没有可用台词。');

      // 如果选择了角色，按模式决定是否自动启用 practice mode
      if (speakerName) {
        const isDialogMode = (audioModeManager?.mode === 'mixed');
        if (!isDialogMode) {
          // 非对话模式：自动启用 practice mode，遇到你的台词会暂停
          if (!state.practiceArmed) {
            state.practiceArmed = true;
            if (practiceArmBtn) {
              practiceArmBtn.textContent = 'Disable Practice Mode';
              practiceArmBtn.classList.add('enabled');
            }
            updatePracticeHint();
          }
        } else {
          // 对话模式：默认不断播，不自动启用 practice mode
          state.practiceArmed = false;
          if (practiceArmBtn) {
            practiceArmBtn.classList.remove('enabled');
            practiceArmBtn.classList.remove('active');
            practiceArmBtn.textContent = 'Enable Practice Mode';
          }
          updatePracticeHint();
        }

        // 准备控制按钮状态（但不显示面板，由startAutoMode控制显示）
        if (autoStartBtn) {
          autoStartBtn.hidden = false;
          autoStartBtn.textContent = '▶';
        }
        if (autoPauseBtn) autoPauseBtn.hidden = true;
        updateAutoStatus('🎭', '准备就绪，点击▶开始');

        // 显示独立的开始录音按钮
        if (startRecordingFab) startRecordingFab.hidden = false;
      } else {
        // 没有选择角色时隐藏按钮
        if (startRecordingFab) startRecordingFab.hidden = true;
      }
    }

    function populateSpeakerSelect() {
      if (!practiceSpeakerSelect) return; // Not available in dialogue mode

      const defaultOption = '<option value="">选择你要扮演的角色</option>';
      if (!state.speakers.length) {
        practiceSpeakerSelect.innerHTML = defaultOption;
        practiceSpeakerSelect.disabled = true;
        return;
      }

      const options = state.speakers
        .map((speaker, idx) => `<option value="${escapeHtml(speaker.speaker)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(speaker.speaker)}</option>`)
        .join('');
      practiceSpeakerSelect.innerHTML = defaultOption + options;
      practiceSpeakerSelect.disabled = false;
    }

    async function loadPracticeSpeakers(videoId) {
      const token = refreshAuthToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      let data = null;

      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}/speakers`, { headers });
        if (res.ok) {
          const payload = await res.json();
          if (payload && Array.isArray(payload.speakers) && payload.speakers.length) {
            data = payload;
          }
        }
      } catch (err) {
        console.warn('Failed to load speakers via /video-resources/:id/speakers:', err);
      }

      if (!data) {
        try {
          const res = await fetch(`${API_BASE}/practice/speakers?videoId=${videoId}`, { headers });
          if (res.ok) {
            data = await res.json();
          }
        } catch (err) {
          console.warn('Failed to load speakers via legacy endpoint:', err);
        }
      }

      state.speakers = Array.isArray(data?.speakers) ? data.speakers : [];
      state.hasServerSpeakers = state.speakers.length > 0;
      populateSpeakerSelect();
      updatePracticeHint();

      // 如果后端没有提供 speakers，基于字幕做一次“交替推断”生成两位角色作为兜底
      if (!state.speakers.length && Array.isArray(state.currentSegments) && state.currentSegments.length > 0) {
        buildInferredSpeakers();
        populateSpeakerSelect();
      }

      // 加载并应用个人角色配置（数量、轮换、命名）
      try {
        const prof = await loadRoleProfile(videoId);
        state.roleProfile = prof || null;
        if (prof) {
          if (Number.isFinite(Number(prof.role_rotation))) {
            state.roleRotation = Number(prof.role_rotation) || 0;
          }
          if (Number.isFinite(Number(prof.role_count)) && prof.role_count >= 2 && prof.role_count <= 5) {
            state.roleCount = String(prof.role_count);
          }
          // infer mode → strict alternation
          if (typeof prof.infer_mode === 'string' && prof.infer_mode.toLowerCase() === 'round_robin') {
            state.strictAlternate = true;
            state.roleCount = '2';
          } else {
            state.strictAlternate = false;
          }
          // 如果是推断模式，按照保存的数量和旋转重建一次 speakers
          if (!state.hasServerSpeakers) {
            buildInferredSpeakers();
          }
          // 应用命名（按顺序覆盖）
          if (Array.isArray(prof.role_names) && prof.role_names.length) {
            const k = Math.min(state.speakers.length, prof.role_names.length);
            for (let i = 0; i < k; i += 1) {
              const newName = String(prof.role_names[i] || '').trim();
              if (!newName) continue;
              const sp = state.speakers[i];
              const old = sp.speaker;
              sp.speaker = newName;
              // 同步行内 speaker
              (sp.lines || []).forEach((ln) => { ln.speaker = newName; });
              // 替换 segment->speaker 映射值
              if (state.segmentSpeakerMap instanceof Map) {
                const nm = new Map();
                state.segmentSpeakerMap.forEach((val, key) => {
                  nm.set(key, val === old ? newName : val);
                });
                state.segmentSpeakerMap = nm;
              }
            }
          }
          populateSpeakerSelect();
        }
      } catch (e) {
        console.warn('[Practice] apply role profile failed:', e);
      }

      if (state.speakers.length) {
        const firstSpeaker = state.speakers[0].speaker;
        if (practiceSpeakerSelect) {
          practiceSpeakerSelect.value = firstSpeaker;
        }
        setPracticeSpeaker(firstSpeaker);
        updatePracticeFeedback('选择台词后点击 ▶ Original 开始。');
        if (practiceArmBtn) practiceArmBtn.disabled = false;
        if (strictAltToggle) {
          strictAltToggle.checked = !!state.strictAlternate;
          if (state.strictAlternate && roleCountSelect) roleCountSelect.value = '2';
        }
      } else {
        updatePracticeFeedback('未找到角色台词，先浏览完整字幕。');
        if (practiceArmBtn) practiceArmBtn.disabled = true;
      }

      try {
        await fetchRoleHistoryForVideo(videoId);
      } catch (_) { }

      // 生成角色选择按钮
      generateRoleButtons();
    }

    function togglePracticeMode(forceState) {
      if (!state.speakers.length || !state.selectedSpeaker) {
        alert('请先选择角色');
        return;
      }
      const next = typeof forceState === 'boolean' ? forceState : !state.practiceArmed;
      state.practiceArmed = next;
      if (state.practiceArmed) {
        practiceArmBtn.classList.add('active');
        practiceArmBtn.textContent = '✓ Practice Mode Enabled';
        updatePracticeFeedback('Practice mode 已启用。视频将自动在你的台词前暂停。', '#3b82f6');
      } else {
        practiceArmBtn.classList.remove('active');
        practiceArmBtn.textContent = 'Enable Practice Mode';
        updatePracticeFeedback('Practice mode disabled. 使用播放器自由播放。');
        state.segmentPlaybackEnd = null;
        state.segmentPlaybackCallback = null;
      }
      updatePracticeHint();
    }

    function disablePracticeModeForPlayback(message) {
      if (state.practiceArmed) {
        state.practiceArmed = false;
        if (practiceArmBtn) {
          practiceArmBtn.classList.remove('active');
          practiceArmBtn.classList.remove('enabled');
          practiceArmBtn.textContent = 'Enable Practice Mode';
        }
        state.segmentPlaybackEnd = null;
        state.segmentPlaybackCallback = null;
        updatePracticeHint();
        if (message) {
          updatePracticeFeedback(message, '#3b82f6');
        }
      }

      if (state.autoMode) {
        pauseAutoMode();
        state.autoMode = false;
        state.isPaused = false;
        updateAudioModeButtonsAvailability(); // 练习模式关闭，重新启用音频模式按钮
        if (autoPracticeStatus) autoPracticeStatus.hidden = true;
        // 如果有选择角色，显示独立的开始录音按钮
        if (state.selectedSpeaker && startRecordingFab) {
          startRecordingFab.hidden = false;
        }
      }
    }

    function handleVideoTimeUpdate() {
      const current = unifiedPlayer.getCurrentTime();

      // 手动点段保护窗口：窗口内抑制自动暂停/静音；过期后自动清除，练习逻辑恢复
      if (state.manualPlayUntil != null && current >= state.manualPlayUntil) {
        state.manualPlayUntil = null;
      }
      const manualPlayActive = state.manualPlayUntil != null && current < state.manualPlayUntil;

      // Bypass monitor if explicitly requested (e.g. "Play Original" in Dialogue mode)
      if (state.bypassStudentGuard) return;

      // Restore volume if overlay ended (supports both HTML5 and YouTube now)
      audioModeManager.maybeRestoreVideoVolume(videoPlayer, current);

      // Student pre-duck guard: mute original shortly BEFORE student's segment start to avoid first-word leak
      try {
        if (Array.isArray(state.currentSegments) && state.currentSegments.length && audioModeManager?.mode === 'mixed' && state.selectedSpeaker) {
          const idx = state.currentSegments.findIndex((seg) => {
            const s = Number(seg.start) || 0; const e = Number(seg.end); const end = Number.isFinite(e) ? e : s + 4;
            return current >= s - (STUDENT_PREDUCK_LEAD_MS / 1000) && current < end; // window around active segment
          });
          const seg = idx >= 0 ? state.currentSegments[idx] : null;
          if (seg) {
            const rawIdx = seg.index != null ? seg.index : idx;
            const key = buildSegmentKey(rawIdx);
            let isStudentLine = false;
            if (seg.speaker && seg.speaker === state.selectedSpeaker) isStudentLine = true;
            if (!isStudentLine && key && state.practiceLineIndexMap?.has(key)) isStudentLine = true;
            if (!isStudentLine && key && state.segmentSpeakerMap?.get(key) === state.selectedSpeaker) isStudentLine = true;

            if (isStudentLine) {
              const segStart = Number(seg.start) || 0;
              const segEndVal = Number(seg.end);
              const segEnd = Number.isFinite(segEndVal) ? segEndVal : segStart + 4;
              const guard = state.studentGuard;
              const guardActive = guard && guard.key === key;
              const shouldArm = current >= (segStart - (STUDENT_PREDUCK_LEAD_MS / 1000)) && current < segStart && !guardActive && !manualPlayActive;
              if (shouldArm) {
                // Hard mute immediately to avoid leaking first phoneme (e.g., "Yes")
                if (!isYouTubeVideo) {
                  try { videoPlayer.muted = true; videoPlayer.volume = 0; } catch (_) { }
                } else {
                  unifiedPlayer.mute();
                }
                state.studentGuard = { key, start: segStart, setAt: performance.now(), fallbackAt: segStart + (STUDENT_PREDUCK_GRACE_MS / 1000) };
                // Also set overlay to ensure later logic won't unmute prematurely
                audioModeManager.overlayPlaybackState = {
                  startTime: segStart,
                  pauseTime: current,
                  segmentRef: seg,
                  unmuteTime: segEnd,
                  volumeRestored: false,
                  previousMuted: true,
                  previousPaused: unifiedPlayer.isPaused(),
                  videoPausedForRecording: false,
                };
              }
              // If guard active and we've passed graceful window without user audio, allow unmute fallback
              if (guardActive) {
                const now = performance.now();
                const t = current;
                if (t > state.studentGuard.fallbackAt) {
                  // No user audio kicked in; allow original
                  if (!isYouTubeVideo) {
                    try { smoothUnmute(videoPlayer, audioModeManager.originalVolume || 1, RESTORE_FADE_MS); } catch (_) { videoPlayer.muted = false; }
                  } else {
                    unifiedPlayer.unmute();
                  }
                  state.studentGuard = null;
                }
              }
            } else {
              // Not student line; clear guard if any
              if (state.studentGuard) state.studentGuard = null;
            }
          }
        }
      } catch (_) { }

      // Autoplay watchdog during non-user playback: if paused unexpectedly, try resume (muted)
      if (state.autoMode && state.segmentPlaybackEnd != null && unifiedPlayer.isPaused()) {
        const end = Number(state.segmentPlaybackEnd);
        if (Number.isFinite(end) && current < end - 0.05) {
          const now = performance.now();
          if (!state.autoplayNudgeAt || (now - state.autoplayNudgeAt) > 1000) {
            state.autoplayNudgeAt = now;
            safePlayVideo({ preferUnmuted: false });
          }
        }
      }

      if (state.segmentPlaybackEnd != null && current >= state.segmentPlaybackEnd - 0.02) {
        safePauseVideo();
        const callback = state.segmentPlaybackCallback;
        state.segmentPlaybackEnd = null;
        state.segmentPlaybackCallback = null;
        if (typeof callback === 'function') {
          callback();
        }
      }

      const activeIndex = state.currentSegments.findIndex((segment) => {
        const start = Number(segment.start) || 0;
        const end = Number(segment.end);
        const effectiveEnd = Number.isFinite(end) ? end : start + 4;
        return current >= start && current < effectiveEnd;
      });

      if (activeIndex >= 0) {
        const segment = state.currentSegments[activeIndex];
        const rawSegmentIndex = segment.index != null ? segment.index : activeIndex;
        const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
        const segmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
        const segmentKey = buildSegmentKey(rawSegmentIndex);

        // Cleanup playedGuard entries whose guard time passed
        try {
          if (audioModeManager?.playedGuard && segmentKey) {
            for (const [k, until] of audioModeManager.playedGuard.entries()) {
              if (Number.isFinite(until) && current >= until + 0.05) {
                audioModeManager.playedGuard.delete(k);
              }
            }
          }
        } catch (_) { }

        if (audioModeManager.shouldPlayUserRecording(segmentIndex, segment, current)) {
          const segmentStart = Number(segment.start) || 0;
          const timeIntoSegment = current - segmentStart;
          const windowStart =
            audioModeManager.playbackWindow?.startOffset ?? -0.2;
          const windowEnd =
            audioModeManager.playbackWindow?.endOffset ?? 1.5;
          if (timeIntoSegment >= windowStart && timeIntoSegment < windowEnd) {
            audioModeManager.syncPlayUserRecording(segmentIndex, videoPlayer, segment);
          }
        }

        // 在非自动模式下才高亮当前segment
        if (!state.autoMode) {
          // Optimization: Only call highlight if index changed to prevent redundant scrolling/flashing
          if (state.currentSegmentIndex !== segmentIndex) {
            highlightCurrentSegment(segmentIndex, true);
          }
        }

        // 只在手动模式下才自动暂停
        const studentIdx = segmentKey ? state.practiceLineIndexMap.get(segmentKey) : undefined;
        // 修正：对话模式下不要触发这里的自动暂停，由专门的 monitor 控制
        // Ensure we check unifiedPlayer.isPaused() to handle YouTube state correctly
        if (!state.autoMode && state.practiceArmed && !manualPlayActive && (audioModeManager?.mode !== 'mixed') && state.selectedSpeaker && studentIdx != null && !unifiedPlayer.isPaused() && currentPracticeMode !== 'dialogue') {
          const practiceLine = state.practiceLines[studentIdx];
          const offset = Math.max(practiceLine.start || 0, 0);
          if (current >= offset && current <= (practiceLine.end || offset + 4)) {
            safePauseVideo();
            updatePracticeFeedback('轮到你了！按 🎙 Record 开始录音。', '#f59e0b');
            state.practiceIndex = studentIdx;
            renderPracticeLines();
            renderPracticeCurrentLine();
          }
        }
      }
    }

    function stopPracticeRecording() {
      if (state.recorder && state.recorder.state !== 'inactive') {
        try {
          state.recorder.stop();
        } catch (err) {
          console.warn('Unable to stop recorder:', err);
        }
      }
      if (practiceStartBtn) {
        practiceStartBtn.classList.remove('recording');
        practiceStartBtn.textContent = '🎤 Record';
      }
    }

    async function startPracticeRecording() {
      if (state.recorder && state.recorder.state !== 'inactive') {
        stopPracticeRecording();
        return;
      }

      const currentLineAtStart = state.practiceLines[state.practiceIndex] || null;

      try {
        if (!state.mediaStream) {
          state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        state.recordingChunks = [];
        const preferredMimeTypes = [
          'audio/mp4;codecs=mp4a.40.2',
          'audio/mp4',
          'audio/aac',
          'audio/mpeg',
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg',
        ];
        let recorderOptions = null;
        let requestedMimeType = null;
        if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
          requestedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || null;
          if (requestedMimeType) {
            recorderOptions = { mimeType: requestedMimeType };
          }
        }
        try {
          state.recorder = recorderOptions
            ? new MediaRecorder(state.mediaStream, recorderOptions)
            : new MediaRecorder(state.mediaStream);
        } catch (err) {
          console.warn('[录音] 首选编码不可用，使用默认设置:', err);
          state.recorder = new MediaRecorder(state.mediaStream);
        }
        state.recorderMimeType = state.recorder?.mimeType || requestedMimeType || 'audio/webm';
        if (debugMode) {
          console.log('[录音] MIME Type & Tracks', {
            requested: requestedMimeType,
            actual: state.recorderMimeType,
            streamActive: state.mediaStream.active,
            tracks: state.mediaStream.getAudioTracks().map(t => ({
              label: t.label,
              readyState: t.readyState,
              enabled: t.enabled,
              muted: t.muted,
              id: t.id
            }))
          });
        }
        state.recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) {
            state.recordingChunks.push(event.data);
            if (!state.recorderMimeType && event.data.type) {
              state.recorderMimeType = event.data.type;
            }
            if (debugMode) {
              console.log('[录音] Chunk received', { size: event.data.size, type: event.data.type, time: Date.now() });
            }
          } else {
            console.warn('[Practice录音数据] 收到空数据块！');
          }
        });
        state.recorder.addEventListener('stop', async () => {

          // 用户主动取消：不评分、不弹结果面板
          if (state.recordingCancelled) {
            state.recordingCancelled = false;
            state.recordingChunks = [];
            return;
          }

          if (!state.recordingChunks.length) {
            console.error('[Practice录音] 没有录音数据！');
            console.error('  检查：麦克风是否有声音输入？录音时间是否太短？');
            updatePracticeFeedback('录音失败：没有收集到音频数据', '#dc2626');
            return;
          }

          const effectiveType = state.recorderMimeType || state.recorder?.mimeType || state.recordingChunks[0]?.type || 'audio/webm';
          const blob = new Blob(state.recordingChunks, { type: effectiveType });
          state.lastRecordingBlob = blob;

          // 🔍 检查 blob 是否真的有数据
          if (blob.size === 0) {
            console.error('[Practice录音] ⚠️ Blob 大小为 0！');
            updatePracticeFeedback('录音失败：音频数据为空', '#dc2626');
            return;
          }

          // 保存到对话练习状态（用于ASR）
          dialoguePracticeState.currentRecording = blob;

          updatePracticeFeedback('录音完成，正在识别...', '#3b82f6');
          if (practiceStartBtn) {
            practiceStartBtn.classList.remove('recording');
            practiceStartBtn.textContent = '🎤 Record';
          }
          if (currentLineAtStart) {
            const segmentIndex = currentLineAtStart.index != null ? currentLineAtStart.index : currentLineAtStart.segmentIndex;
            if (segmentIndex != null) {
              try {
                await saveUserRecording(segmentIndex, blob);

                // 对话模式下，录音完成后自动调用ASR识别
                if (currentPracticeMode === 'dialogue' && currentLineAtStart.text) {

                  // 调用ASR识别
                  await performASR(blob, currentLineAtStart.text);

                  // 更新当前索引
                  dialoguePracticeState.currentIndex = segmentIndex;

                  // 保存录音用于完整回放
                  saveRecordingForPlayback(segmentIndex, blob);

                  updatePracticeFeedback('识别完成，请查看对比结果', '#16a34a');
                } else {
                  updatePracticeFeedback('录音完成，可点击 🔄 Compare 对比。', '#16a34a');
                }
              } catch (err) {
                console.warn('[录音保存] 失败:', err);
              }
            }
          }

          // 非对话模式下才自动进入下一句
          if (currentLineAtStart && currentPracticeMode !== 'dialogue') {
            scheduleNextLine(currentLineAtStart, '录音完成，进入下一句。');
          }
        });

        // 🔧 设置 timeslice 为 100ms，确保定期收集数据
        state.recorder.start(100);  // 每100ms触发一次 dataavailable

        updatePracticeFeedback('录音中... 再次点击 🎤 Record 停止。', '#2dd4bf');
        if (practiceStartBtn) {
          practiceStartBtn.classList.add('recording');
          practiceStartBtn.textContent = '⏹ Stop';
        }
      } catch (err) {
        console.error('Failed to start recording:', err);
        alert('无法访问麦克风，请检查权限设置。');
      }
    }

    function scheduleNextLine(currentLine, message) {
      if (!currentLine) return;

      const resultKey = buildSegmentKey(currentLine.index != null ? currentLine.index : currentLine.segmentIndex);
      if (resultKey) {
        state.practiceLineResults[resultKey] = 'success';
      }

      const nextLine = state.practiceLines[state.practiceIndex + 1] || null;
      const resumeFrom = currentLine.end && currentLine.end > currentLine.start ? currentLine.end : (currentLine.start || 0) + 0.1;

      state.practicePlaybackLock = false;
      state.waitingForPractice = false;

      if (nextLine) {
        state.practiceIndex = Math.min(state.practiceIndex + 1, state.practiceLines.length - 1);
        renderPracticeLines();
        renderPracticeCurrentLine();

        if (state.practiceArmed) {
          const nextStart = Number(nextLine.start);
          // 自然边界：根据下一句之前的实际间隙决定停止点 ——
          // 有静音间隙时停在间隙里（提前 0.1s），字幕紧贴时停在下一句开始处，避免切掉对方尾词
          let stopBeforeStart = resumeFrom + 0.5;
          if (Number.isFinite(nextStart) && nextStart > resumeFrom) {
            let prevSegEnd = -Infinity;
            for (const seg of state.currentSegments) {
              const segEndT = Number(seg.end);
              if (Number.isFinite(segEndT) && segEndT <= nextStart + 0.01 && segEndT > prevSegEnd) {
                prevSegEnd = segEndT;
              }
            }
            const gapBefore = Number.isFinite(prevSegEnd) ? (nextStart - prevSegEnd) : Infinity;
            stopBeforeStart = gapBefore >= 0.3 ? (nextStart - 0.1) : nextStart;
          }
          state.segmentPlaybackEnd = stopBeforeStart;
          state.segmentPlaybackCallback = () => {
            safePauseVideo();
            updatePracticeFeedback(message || '继续下一句练习', '#2563eb');
          };
          videoPlayer.currentTime = resumeFrom;
          safePlayVideo();
        } else {
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
          updatePracticeFeedback(message || '继续下一句练习', '#2563eb');
        }
      } else {
        state.segmentPlaybackEnd = null;
        state.segmentPlaybackCallback = null;
        updatePracticeFeedback(message ? `${message} 已完成该角色全部台词！` : '已完成该角色全部台词！', '#155724');
      }
    }

    // 当前过滤状态
    let currentTagFilter = null;
    let currentCollectionFilter = null;
    let currentDifficultyFilter = null; // 难度筛选: null=全部, beginner=A1–A2, intermediate=B1–B2, advanced=C1–C2

    function coarseDifficulty(raw) {
      const value = String(raw || '').trim().toLowerCase();
      if (['beginner', 'a1', 'a2'].includes(value)) return 'beginner';
      if (['intermediate', 'b1', 'b2'].includes(value)) return 'intermediate';
      if (['advanced', 'c1', 'c2'].includes(value)) return 'advanced';
      return null;
    }
    let showFavoritesOnly = false;
    let currentSearchQuery = '';
    let tagFiltersExpanded = false;
    let allVideoList = [];
    let practiceCatalog = [];

    async function showVideoSelectModal(videoList, defaultLevel = null) {
      const modal = document.getElementById('video-select-modal');
      const title = document.getElementById('video-select-title');
      if (title) title.textContent = currentPracticeMode === 'shadowing' ? '选择跟读视频' : '选择对话视频';
      const container = document.getElementById('video-list-container');
      const filterContainer = document.getElementById('filter-container');
      const tagFilterContainer = document.getElementById('tag-filter-container');
      const difficultyFiltersContainer = document.getElementById('difficulty-filters');
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;

      // 显示模态框
      if (modal) {
        modal.style.display = 'flex';
      }

      allVideoList = videoList || [];
      // 设置默认难度筛选（用户等级）
      currentDifficultyFilter = defaultLevel;

      if (!videoList || videoList.length === 0) {
        if (filterContainer) filterContainer.style.display = 'none';
        container.innerHTML = `
          <div style="text-align: center; padding: 40px; color: #999;">
            <div style="font-size: 48px; margin-bottom: 16px;">📹</div>
            <div style="font-size: 16px; margin-bottom: 8px;">${t('practice.no_videos')}</div>
            <div style="font-size: 14px;"><a href="./video-upload.html" style="color: #667eea;">${t('practice.go_upload')}</a></div>
          </div>
        `;
        return;
      }

      const activateVideoSelectList = () => {
        if (filterContainer) filterContainer.style.display = 'block';
        renderDifficultyFilters();
        if (typeof VideoTagSystem !== 'undefined') {
          renderTagFilters(tagFilterContainer);
        }
        setupFilterButtons();
        setupVideoSearch();
        renderVideoList();
      };


      activateVideoSelectList();

      // Optional labels enrich the already usable list.
      if (typeof VideoTagSystem !== 'undefined') {
        Promise.resolve().then(async () => {
          const authToken = refreshAuthToken();
          await VideoTagSystem.loadFromServer('', authToken);
          await VideoTagSystem.syncVideoTagsFromServer('', authToken, videoList.map(v => v.id), { force: true });
          if (allVideoList === videoList && modal.style.display !== 'none') {
            renderTagFilters(tagFilterContainer);
            renderVideoList();
          }
        }).catch(error => console.warn('[Practice] Optional video labels unavailable:', error));
      }
    }

    function renderTagFilters(container) {
      if (!container || typeof VideoTagSystem === 'undefined') return;

      const tags = VideoTagSystem.getVisibleTags ? VideoTagSystem.getVisibleTags({ includePersonal: false }) : VideoTagSystem.getAllTags();
      const maxVisible = 8;
      const hasOverflow = tags.length > maxVisible;
      let visibleTags = tagFiltersExpanded ? tags : tags.slice(0, maxVisible);
      if (!tagFiltersExpanded && currentTagFilter) {
        const activeTag = tags.find(tag => tag.id === currentTagFilter);
        if (activeTag && !visibleTags.some(tag => tag.id === activeTag.id)) {
          visibleTags = visibleTags.slice(0, Math.max(0, maxVisible - 1));
          visibleTags.push(activeTag);
        }
      }

      // 基于难度筛选后的视频列表计算标签统计
      const filteredVideos = getDifficultyFilteredVideos();
      const stats = VideoTagSystem.getTagStatistics ? VideoTagSystem.getTagStatistics(filteredVideos) : {};

      container.innerHTML = visibleTags.map(tag => {
        const count = (stats[tag.id] && stats[tag.id].count) || 0;
        const isActive = currentTagFilter === tag.id;
        return `
        <button class="tag-filter-btn" data-tag-id="${tag.id}" style="
          padding: 4px 10px;
          border: 1px solid ${isActive ? '#667eea' : '#e2e8f0'};
          border-radius: 15px;
          background: ${isActive ? 'linear-gradient(135deg, #667eea, #764ba2)' : 'white'};
          color: ${isActive ? 'white' : '#1e293b'};
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 3px;
          transition: all 0.2s;
        ">
          <span>${tag.icon || '🏷️'}</span>
          <span>${tag.displayName || tag.name}</span>
          <span style="opacity: 0.7; font-size: 11px;">(${count})</span>
        </button>
      `;
      }).join('');

      if (hasOverflow) {
        container.innerHTML += `
          <button class="tag-filter-btn" data-action="toggle-tags" style="
            padding: 4px 10px;
            border: 1px dashed #cbd5f5;
            border-radius: 15px;
            background: #f8fafc;
            color: #475569;
            cursor: pointer;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          ">
            ${tagFiltersExpanded ? '收起' : `+${tags.length - maxVisible}个`}
          </button>
        `;
      }

      // 绑定标签点击事件
      container.querySelectorAll('.tag-filter-btn').forEach(btn => {
        if (btn.dataset.action === 'toggle-tags') {
          btn.addEventListener('click', () => {
            tagFiltersExpanded = !tagFiltersExpanded;
            renderTagFilters(container);
          });
          return;
        }
        btn.addEventListener('click', () => {
          const tagId = btn.dataset.tagId;
          if (currentTagFilter === tagId) {
            // 取消选中
            currentTagFilter = null;
            currentCollectionFilter = null;
          } else {
            // 选中新标签
            currentTagFilter = tagId;
            currentCollectionFilter = null;
          }
          // 重新渲染标签筛选器和视频列表
          renderTagFilters(container);
          renderVideoList();
        });
      });
    }

    // ===== 难度筛选器 =====
    function renderDifficultyFilters() {
      const container = document.getElementById('difficulty-filters');
      if (!container) return;

      const videos = allVideoList || [];
      const stats = {
        beginner: videos.filter(v => coarseDifficulty(v.difficulty_level) === 'beginner').length,
        intermediate: videos.filter(v => coarseDifficulty(v.difficulty_level) === 'intermediate').length,
        advanced: videos.filter(v => coarseDifficulty(v.difficulty_level) === 'advanced').length
      };

      const levels = [
        { key: null, label: '全部', count: videos.length },
        { key: 'beginner', label: 'A1–A2', count: stats.beginner },
        { key: 'intermediate', label: 'B1–B2', count: stats.intermediate },
        { key: 'advanced', label: 'C1–C2', count: stats.advanced }
      ];

      container.innerHTML = levels.map(level => {
        const isActive = currentDifficultyFilter === level.key;
        return `<button class="difficulty-chip${isActive ? ' active' : ''}" data-difficulty="${level.key || ''}">${level.label} <span class="difficulty-count">(${level.count})</span></button>`;
      }).join('');

      // 绑定点击事件
      container.querySelectorAll('.difficulty-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const newLevel = chip.dataset.difficulty || null;
          currentDifficultyFilter = newLevel;
          // 切换难度时重置标签筛选
          currentTagFilter = null;
          currentCollectionFilter = null;
          // 重新渲染
          renderDifficultyFilters();
          renderTagFilters(document.getElementById('tag-filter-container'));
          updateFilterButtonCounts();
          renderVideoList();
          // 保存用户偏好
          if (newLevel) {
            try { localStorage.setItem('linglish_active_level', newLevel); } catch (_) { }
          }
        });
      });
    }

    // 获取当前难度筛选后的视频列表
    function getDifficultyFilteredVideos() {
      if (!currentDifficultyFilter) return allVideoList;
      return allVideoList.filter(v => coarseDifficulty(v.difficulty_level) === currentDifficultyFilter);
    }

    // 清除筛选的辅助函数（用于空状态按钮）
    function clearAllFilters() {
      showFavoritesOnly = false;
      currentTagFilter = null;
      currentCollectionFilter = null;
      currentDifficultyFilter = null;
      renderDifficultyFilters();
      renderTagFilters(document.getElementById('tag-filter-container'));
      updateFilterButtonCounts();
      // 重置收藏/全部按钮样式
      const favBtn = document.getElementById('filter-favorites');
      const allBtn = document.getElementById('filter-all');
      if (favBtn) {
        favBtn.style.background = 'white';
        favBtn.style.color = '#1e293b';
      }
      if (allBtn) {
        allBtn.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
        allBtn.style.color = 'white';
      }
      renderVideoList();
    }

    function clearTagFilter() {
      currentTagFilter = null;
      currentCollectionFilter = null;
      renderTagFilters(document.getElementById('tag-filter-container'));
      renderVideoList();
    }

    function clearDifficultyFilter() {
      currentDifficultyFilter = null;
      renderDifficultyFilters();
      renderTagFilters(document.getElementById('tag-filter-container'));
      updateFilterButtonCounts();
      renderVideoList();
    }

    function getVideoCollectionName(video) {
      try {
        const raw = video?.collection_name ?? video?.collection ?? video?.series ?? '';
        const name = String(raw || '').trim();
        return name || null;
      } catch (_) {
        return null;
      }
    }

    function renderCollectionFilters(container, baseVideos) {
      if (!container) return;

      if (!currentTagFilter || currentTagFilter === '_untagged') {
        currentCollectionFilter = null;
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      const list = Array.isArray(baseVideos) ? baseVideos : [];
      const counts = new Map();
      for (const v of list) {
        const name = getVideoCollectionName(v);
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }

      const collections = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh-Hans-CN'));

      if (!collections.length) {
        currentCollectionFilter = null;
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      if (currentCollectionFilter && !counts.has(currentCollectionFilter)) {
        currentCollectionFilter = null;
      }

      container.style.display = 'flex';
      container.innerHTML = '';

      const makeBtn = (label, active) => {
        const btn = document.createElement('button');
        btn.className = 'collection-filter-btn';
        btn.style.cssText = `
          padding: 4px 10px;
          border: 1px solid ${active ? '#667eea' : '#e2e8f0'};
          border-radius: 15px;
          background: ${active ? 'linear-gradient(135deg, #667eea, #764ba2)' : 'white'};
          color: ${active ? 'white' : '#1e293b'};
          cursor: pointer;
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: all 0.2s;
        `;
        btn.innerHTML = label;
        return btn;
      };

      const allBtn = makeBtn(`📚 合集 (${collections.reduce((s, c) => s + c.count, 0)})`, !currentCollectionFilter);
      allBtn.addEventListener('click', () => {
        currentCollectionFilter = null;
        renderVideoList();
      });
      container.appendChild(allBtn);

      collections.forEach(({ name, count }) => {
        const btn = makeBtn(`📚 ${name} (${count})`, currentCollectionFilter === name);
        btn.addEventListener('click', () => {
          currentCollectionFilter = name;
          renderVideoList();
        });
        container.appendChild(btn);
      });
    }

    function setupFilterButtons() {
      const favBtn = document.getElementById('filter-favorites');
      const allBtn = document.getElementById('filter-all');

      // 更新按钮显示的数量
      updateFilterButtonCounts();

      if (favBtn) {
        favBtn.addEventListener('click', () => {
          showFavoritesOnly = true;
          favBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
          favBtn.style.color = 'white';
          if (allBtn) {
            allBtn.style.background = 'white';
            allBtn.style.color = '#667eea';
          }
          renderVideoList();
        });
      }

      if (allBtn) {
        allBtn.addEventListener('click', () => {
          showFavoritesOnly = false;
          // 清除标签和合集过滤
          currentTagFilter = null;
          currentCollectionFilter = null;

          allBtn.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
          allBtn.style.color = 'white';
          if (favBtn) {
            favBtn.style.background = 'white';
            favBtn.style.color = '#1e293b';
          }

          // 重新渲染标签过滤器（更新选中状态）
          const tagFilterContainer = document.getElementById('tag-filter-container');
          if (tagFilterContainer) {
            renderTagFilters(tagFilterContainer);
          }

          renderVideoList();
        });
      }
    }

    function setupVideoSearch() {
      const searchInput = document.getElementById('practice-video-search');
      if (!searchInput) return;
      if (searchInput.dataset.bound === 'true') return;
      searchInput.dataset.bound = 'true';
      searchInput.value = currentSearchQuery;
      searchInput.addEventListener('input', () => {
        currentSearchQuery = searchInput.value.trim().toLowerCase();
        renderVideoList();
      });
    }

    function clearVideoSearch() {
      currentSearchQuery = '';
      const searchInput = document.getElementById('practice-video-search');
      if (searchInput) searchInput.value = '';
      renderVideoList();
    }

    function updateFilterButtonCounts() {
      const favBtn = document.getElementById('filter-favorites');
      const allBtn = document.getElementById('filter-all');

      // 基于难度筛选后的视频计算数量
      const filteredVideos = getDifficultyFilteredVideos();
      const totalCount = filteredVideos.length;
      const favCount = filteredVideos.filter(v => isFavorite(v.id)).length;

      if (allBtn) {
        allBtn.innerHTML = `全部 <span style="opacity: 0.8;">(${totalCount})</span>`;
      }
      if (favBtn) {
        favBtn.innerHTML = `<span>⭐</span><span>收藏 (${favCount})</span>`;
      }
    }

    // 获取视频缩略图 URL
    function getVideoThumbnail(video) {
      // 优先使用 thumbnail_path
      if (video.thumbnail_path) {
        if (typeof video.thumbnail_path === 'string' && video.thumbnail_path.includes('${')) {
          return null;
        }
        if (/^https?:\/\//i.test(video.thumbnail_path)) return video.thumbnail_path;
        return `${API_BASE}${video.thumbnail_path.startsWith('/') ? '' : '/'}${video.thumbnail_path}`;
      }

      // 尝试从 YouTube URL 提取缩略图
      let youtubeVideoId = video.youtube_video_id;
      if (!youtubeVideoId && video.youtube_url) {
        const patterns = [
          /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
          /^([a-zA-Z0-9_-]{11})$/
        ];
        for (const pattern of patterns) {
          const match = video.youtube_url.match(pattern);
          if (match && match[1]) {
            youtubeVideoId = match[1];
            break;
          }
        }
      }
      if (youtubeVideoId) {
        return `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`;
      }

      // 默认占位图
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="68"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#667eea"/><stop offset="100%" style="stop-color:#764ba2"/></linearGradient></defs><rect width="120" height="68" fill="url(#g)"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="white">🎬</text></svg>`)}`;
    }

    function renderVideoList() {
      const container = document.getElementById('video-list-container');
      const collectionFilterContainer = document.getElementById('collection-filter-container');
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;

      // 首先应用难度筛选
      let filteredList = getDifficultyFilteredVideos();

      // 调试：显示视频列表和标签映射状态
      console.log('[renderVideoList] allVideoList count:', allVideoList.length);
      console.log('[renderVideoList] currentDifficultyFilter:', currentDifficultyFilter);
      console.log('[renderVideoList] afterDifficultyFilter count:', filteredList.length);
      console.log('[renderVideoList] currentTagFilter:', currentTagFilter);

      // 收藏过滤
      if (showFavoritesOnly) {
        const favs = getFavorites();
        filteredList = filteredList.filter(v => favs.includes(String(v.id)));
      }

      // 标签过滤
      if (currentTagFilter && typeof VideoTagSystem !== 'undefined') {
        console.log('[renderVideoList] Before tag filter:', filteredList.length);
        filteredList = VideoTagSystem.filterVideosByTags(filteredList, currentTagFilter);
        console.log('[renderVideoList] After tag filter:', filteredList.length);
      }

      // 渲染合集（二级标签）过滤按钮（基于收藏+标签过滤后的列表）
      renderCollectionFilters(collectionFilterContainer, filteredList);

      // 合集过滤
      if (currentCollectionFilter) {
        filteredList = filteredList.filter(v => getVideoCollectionName(v) === currentCollectionFilter);
      }

      if (currentSearchQuery) {
        filteredList = filteredList.filter(v => {
          const title = (v.title || v.original_filename || '').toLowerCase();
          return title.includes(currentSearchQuery);
        });
      }

      if (filteredList.length === 0) {
        // 根据不同筛选条件显示不同的空状态
        let emptyState = { icon: '🔍', title: '没有匹配的视频', desc: '', actions: [] };

        if (currentSearchQuery) {
          emptyState = {
            icon: '🔎',
            title: `没有找到“${currentSearchQuery}”`,
            desc: '试试更短的关键词或清空搜索条件',
            actions: [
              { text: '清空搜索', primary: true, onclick: 'clearVideoSearch()' }
            ]
          };
        } else if (showFavoritesOnly) {
          emptyState = {
            icon: '⭐',
            title: '暂无收藏视频',
            desc: '点击视频卡片上的 ☆ 可以收藏喜欢的视频',
            actions: [
              { text: '浏览全部视频', primary: true, onclick: 'clearAllFilters()' }
            ]
          };
        } else if (currentTagFilter) {
          const tagName = (() => {
            if (typeof VideoTagSystem !== 'undefined') {
              const tags = VideoTagSystem.getAllTags();
              const tag = tags.find(t => t.id === currentTagFilter);
              return tag ? (tag.displayName || tag.name) : '该标签';
            }
            return '该标签';
          })();
          emptyState = {
            icon: '🏷️',
            title: `"${tagName}" 下暂无视频`,
            desc: currentDifficultyFilter ? `当前难度：${currentDifficultyFilter === 'beginner' ? 'A1–A2' : currentDifficultyFilter === 'intermediate' ? 'B1–B2' : 'C1–C2'}` : '',
            actions: [
              { text: '清除标签筛选', primary: false, onclick: 'clearTagFilter()' },
              { text: '查看全部视频', primary: true, onclick: 'clearAllFilters()' }
            ]
          };
        } else if (currentDifficultyFilter) {
          const levelNames = { beginner: 'A1–A2', intermediate: 'B1–B2', advanced: 'C1–C2' };
          emptyState = {
            icon: '📊',
            title: `${levelNames[currentDifficultyFilter] || currentDifficultyFilter} 级别暂无视频`,
            desc: '试试其他难度级别？',
            actions: [
              { text: '查看全部难度', primary: true, onclick: 'clearDifficultyFilter()' }
            ]
          };
        }

        container.innerHTML = `
          <div style="text-align: center; padding: 60px 20px; color: #64748b;">
            <div style="font-size: 64px; margin-bottom: 20px; opacity: 0.8;">${emptyState.icon}</div>
            <div style="font-size: 18px; font-weight: 600; color: #374151; margin-bottom: 8px;">${escapeHtml(emptyState.title)}</div>
            ${emptyState.desc ? `<div style="font-size: 14px; color: #9ca3af; margin-bottom: 20px;">${escapeHtml(emptyState.desc)}</div>` : '<div style="margin-bottom: 20px;"></div>'}
            <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
              ${emptyState.actions.map(action => `
                <button onclick="${action.onclick}" style="
                  padding: 10px 20px;
                  border-radius: 10px;
                  font-size: 14px;
                  font-weight: 600;
                  cursor: pointer;
                  transition: all 0.2s;
                  ${action.primary
            ? 'background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);'
            : 'background: white; color: #667eea; border: 2px solid #667eea;'}
                ">${action.text}</button>
              `).join('')}
            </div>
          </div>
        `;
        if (collectionFilterContainer) {
          collectionFilterContainer.style.display = 'none';
          collectionFilterContainer.innerHTML = '';
        }
        return;
      }

      container.innerHTML = filteredList.map(video => {
        const title = escapeHtml(video.title || video.original_filename || `视频 ${video.id}`);
        const seconds = Math.max(0, Math.floor(Number(video.duration_sec) || 0));
        const durationText = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        const hasTranscript = video.has_subtitles || video.has_transcript || Number(video.total_segments) > 0 || (video.transcript && video.transcript.length > 10);
        const fav = isFavorite(video.id);
        const thumbnail = getVideoThumbnail(video);
        const transcriptText = hasTranscript ? '有字幕' : '字幕准备中';

        // 获取视频标签
        let tagsHtml = '';
        if (typeof VideoTagSystem !== 'undefined') {
          const videoTags = VideoTagSystem.getVideoTagObjects(video.id);
          if (videoTags && videoTags.length > 0) {
            tagsHtml = `<div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
              ${videoTags.slice(0, 3).map(tag => `
                <span style="font-size: 11px; padding: 2px 6px; background: #f1f5f9; border-radius: 10px; color: #64748b;">
                  ${escapeHtml(tag.icon || '🏷️')} ${escapeHtml(tag.displayName || tag.name)}
                </span>
              `).join('')}
              ${videoTags.length > 3 ? `<span style="font-size: 11px; color: #94a3b8;">+${videoTags.length - 3}</span>` : ''}
            </div>`;
          }
        }

        if (debugMode) {
          if (thumbnail && thumbnail.includes('${')) {
            console.error('[VideoList] Thumbnail contains literal template syntax - INTERPOLATION FAILED', { id: video.id, thumbnail });
          }
        }

        return `
          <div class="video-select-item" data-video-id="${video.id}" style="
            padding: 12px;
            border: 2px solid ${fav ? '#f59e0b' : '#e0e0e0'};
            border-radius: 12px;
            margin-bottom: 12px;
            cursor: pointer;
            transition: all 0.2s;
            background: ${fav ? '#fffbeb' : 'white'};
          ">
            <div style="display: flex; align-items: flex-start; gap: 12px;">
              <img src="${escapeHtml(thumbnail || '')}" alt="" loading="lazy" referrerpolicy="no-referrer" style="
                width: 80px;
                height: 45px;
                object-fit: cover;
                border-radius: 6px;
                flex-shrink: 0;
                background: #f1f5f9;
              " onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
              <div style="
                width: 80px;
                height: 45px;
                border-radius: 6px;
                background: linear-gradient(135deg, #667eea, #764ba2);
                display: none;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                flex-shrink: 0;
              ">🎬</div>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <div style="font-weight: 600; font-size: 15px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</div>
                  <button class="tag-btn" data-video-id="${video.id}" onclick="event.stopPropagation(); showVideoTagSelector(${video.id})" style="
                    background: none;
                    border: none;
                    font-size: 16px;
                    cursor: pointer;
                    padding: 4px;
                    transition: transform 0.2s;
                    flex-shrink: 0;
                    opacity: 0.6;
                  " title="管理标签">🏷️</button>
                  <button class="fav-btn" data-video-id="${video.id}" onclick="event.stopPropagation(); toggleFavoriteAndRender(${video.id})" style="
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    padding: 4px;
                    transition: transform 0.2s;
                    flex-shrink: 0;
                  " title="${fav ? '取消收藏' : '收藏'}">
                    ${fav ? '⭐' : '☆'}
                  </button>
                </div>
                <div style="font-size: 12px; color: #666; display: flex; gap: 10px; margin-top: 4px;">
                  <span>⏱️ ${durationText}</span>
                  <span>${transcriptText}</span>
                </div>
                ${tagsHtml}
              </div>
              <div style="color: #667eea; font-size: 18px; align-self: center; flex-shrink: 0;">→</div>
            </div>
          </div>
        `;
      }).join('');

      // 添加点击事件（选择视频）
      container.querySelectorAll('.video-select-item').forEach(item => {
        item.addEventListener('click', (e) => {
          // 如果点击的是收藏按钮或标签按钮，不跳转
          if (e.target.closest('.fav-btn') || e.target.closest('.tag-btn')) return;
          const videoId = item.dataset.videoId;
          window.location.href = buildPracticeVideoHref(videoId);
        });
      });
    }

    function toggleFavoriteAndRender(videoId) {
      toggleFavorite(videoId);
      updateFilterButtonCounts();
      renderVideoList();
    }

    // ===== 视频标签选择器 =====
    let currentVideoForTagging = null;
    let tagSelectorInitialized = false;

    function getTagSelectorElements() {
      return {
        overlay: document.getElementById('video-tag-selector-overlay'),
        closeBtn: document.getElementById('video-tag-selector-close'),
        list: document.getElementById('video-tag-selector-list'),
        saveBtn: document.getElementById('save-video-tags-btn'),
        cancelBtn: document.getElementById('cancel-video-tags-btn')
      };
    }

    function initTagSelectorEvents() {
      if (tagSelectorInitialized) return;
      const els = getTagSelectorElements();
      if (!els.overlay) return;

      tagSelectorInitialized = true;

      // 关闭按钮
      if (els.closeBtn) {
        els.closeBtn.addEventListener('click', hideVideoTagSelector);
      }
      // 取消按钮
      if (els.cancelBtn) {
        els.cancelBtn.addEventListener('click', hideVideoTagSelector);
      }
      // 点击遮罩关闭
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) hideVideoTagSelector();
      });
      // 保存按钮
      if (els.saveBtn) {
        els.saveBtn.addEventListener('click', saveVideoTags);
      }
    }

    function showVideoTagSelector(videoId) {
      currentVideoForTagging = videoId;
      initTagSelectorEvents();
      renderVideoTagSelector();
      const els = getTagSelectorElements();
      if (els.overlay) {
        els.overlay.classList.add('show');
      }
    }

    function hideVideoTagSelector() {
      const els = getTagSelectorElements();
      if (els.overlay) {
        els.overlay.classList.remove('show');
      }
      currentVideoForTagging = null;
      renderVideoList();
    }

    function renderVideoTagSelector() {
      const els = getTagSelectorElements();
      if (!currentVideoForTagging || !els.list) return;
      if (typeof VideoTagSystem === 'undefined') {
        els.list.innerHTML = '<p style="color: #6b7280; text-align: center;">标签系统未加载</p>';
        return;
      }

      const allTags = VideoTagSystem.getVisibleTags ? VideoTagSystem.getVisibleTags() : VideoTagSystem.getAllTags();
      const videoTags = VideoTagSystem.getVideoTags(currentVideoForTagging);

      els.list.innerHTML = allTags.map(tag => {
        const isSelected = videoTags.includes(tag.id);
        return `
          <div class="video-tag-item ${isSelected ? 'selected' : ''}" data-tag-id="${tag.id}">
            <div class="video-tag-item-left">
              <span class="video-tag-item-icon">${tag.icon || '🏷️'}</span>
              <span class="video-tag-item-name">${tag.name}</span>
            </div>
            <div class="video-tag-checkbox">${isSelected ? '✓' : ''}</div>
          </div>
        `;
      }).join('');

      // 添加点击事件切换选择
      els.list.querySelectorAll('.video-tag-item').forEach(item => {
        item.addEventListener('click', () => {
          const tagId = item.dataset.tagId;
          VideoTagSystem.toggleVideoTag(currentVideoForTagging, tagId);
          renderVideoTagSelector();
        });
      });
    }

    // 简易 Toast 提示（当 GlobalUI 不可用时的降级方案）
    function showSimpleToast(message, type = 'info') {
      // 如果 GlobalUI 可用，优先使用
      if (typeof GlobalUI !== 'undefined' && GlobalUI.showToast) {
        GlobalUI.showToast(message, type);
        return;
      }

      // 降级方案：创建简单的 toast
      const existing = document.getElementById('simple-toast');
      if (existing) existing.remove();

      const colors = {
        success: { bg: '#10b981', icon: '✓' },
        error: { bg: '#ef4444', icon: '✗' },
        info: { bg: '#3b82f6', icon: 'ℹ' }
      };
      const color = colors[type] || colors.info;

      const toast = document.createElement('div');
      toast.id = 'simple-toast';
      toast.innerHTML = `
        <div style="
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(20px);
          background: ${color.bg};
          color: white;
          padding: 12px 24px;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          z-index: 99999;
          opacity: 0;
          transition: all 0.3s ease;
        ">
          <span style="font-size: 16px;">${color.icon}</span>
          <span>${message}</span>
        </div>
      `;
      document.body.appendChild(toast);

      // 动画显示
      requestAnimationFrame(() => {
        const inner = toast.querySelector('div');
        if (inner) {
          inner.style.opacity = '1';
          inner.style.transform = 'translateX(-50%) translateY(0)';
        }
      });

      // 自动消失
      setTimeout(() => {
        const inner = toast.querySelector('div');
        if (inner) {
          inner.style.opacity = '0';
          inner.style.transform = 'translateX(-50%) translateY(20px)';
        }
        setTimeout(() => toast.remove(), 300);
      }, 2500);
    }

    async function saveVideoTags() {
      if (!currentVideoForTagging) return;
      const els = getTagSelectorElements();
      const token = refreshAuthToken();
      if (!token) {
        showSimpleToast('请先登录后保存标签', 'error');
        return;
      }

      const tagIds = VideoTagSystem.getVideoTags(currentVideoForTagging);
      const allTags = VideoTagSystem.getAllTags();
      const globalIds = [];
      const personalIds = [];

      tagIds.forEach(id => {
        const t = allTags.find(tag => tag.id === id);
        if (!t) return;

        if (t.scope === 'personal' || t.custom) {
          personalIds.push(id);
        } else {
          const numericId = VideoTagSystem.getNumericId(id);
          if (numericId !== null) {
            globalIds.push(numericId);
          }
        }
      });

      // 保存原始按钮内容
      const originalBtnContent = els.saveBtn ? els.saveBtn.innerHTML : '';

      try {
        if (els.saveBtn) {
          els.saveBtn.disabled = true;
          // 添加 loading spinner
          els.saveBtn.innerHTML = `
            <span style="display: inline-flex; align-items: center; gap: 8px;">
              <span style="
                width: 14px;
                height: 14px;
                border: 2px solid rgba(255,255,255,0.3);
                border-top-color: white;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
              "></span>
              保存中...
            </span>
          `;
          // 添加动画样式（如果不存在）
          if (!document.getElementById('spinner-style')) {
            const style = document.createElement('style');
            style.id = 'spinner-style';
            style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
          }
        }

        const response = await fetch(`${API_BASE}/videos/${currentVideoForTagging}/tags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            global_tag_ids: globalIds,
            user_tag_ids: personalIds
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // 成功反馈
        showSimpleToast('标签保存成功！', 'success');
        hideVideoTagSelector();
      } catch (err) {
        console.error('Failed to save video tags:', err);
        showSimpleToast('保存失败，请重试', 'error');
      } finally {
        if (els.saveBtn) {
          els.saveBtn.disabled = false;
          els.saveBtn.innerHTML = originalBtnContent || '保存更改';
        }
      }
    }

    async function loadExternalCoachMedia(media) {
      const modal = document.getElementById('video-select-modal');
      if (modal) modal.style.display = 'none';
      state.videoId = media.id || 'external';
      window.LinglishStudyVideoId = '';
      window.LinglishStudyMedia = media;
      document.querySelector('.video-player-container')?.classList.remove('is-empty');
      state.currentSegments = Array.isArray(media.cues) ? media.cues.map((cue, index) => ({
        index: cue.index != null ? cue.index : index,
        text: cue.text || '',
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
      })).filter((cue) => cue.text && cue.end >= cue.start) : [];
      state.videoData = { id: state.videoId, title: media.title || '播客' };
      if (videoPlayer && media.audioUrl) {
        videoPlayer.poster = media.image || '';
        videoPlayer.src = media.audioUrl;
        videoPlayer.load();
      }
      const overlayCaption = document.querySelector('#play-overlay > div > div:last-child');
      if (overlayCaption) overlayCaption.textContent = media.title || '点击播放';
      rebuildSegmentRoleMap();
      renderPracticeLines();
      renderPracticeCurrentLine();
      updatePracticeFeedback(media.title ? `正在陪练：${media.title}` : '');
    }

    async function loadVideoData() {
      if (pageParams.get('source') === 'external') {
        let media = null;
        try { media = JSON.parse(sessionStorage.getItem('linglish.coach.media') || 'null'); } catch (_) { media = null; }
        if (!media || !media.audioUrl) {
          throw new Error('没有找到刚选的内容，请重新从视频库、频道库或播客里选一条。');
        }
        await loadExternalCoachMedia(media);
        return;
      }
      if (isShareMode()) {
        await loadShareVideoData(getShareToken());
        return;
      }
      const requestedId = pageParams.get('videoId');
      const token = refreshAuthToken();
      // 获取用户默认难度级别（URL参数 > localStorage > null）
      let defaultLevel = null;
      try {
        defaultLevel = pageParams.get('level') || localStorage.getItem('linglish_active_level') || null;
      } catch (_) {
        defaultLevel = pageParams.get('level') || null;
      }
      defaultLevel = (defaultLevel || '').toString().trim().toLowerCase();
      if (!coarseDifficulty(defaultLevel)) defaultLevel = null;
      else defaultLevel = coarseDifficulty(defaultLevel);

      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      // 检测是否是国内用户（用于跳过YouTube API）——与视频列表并行加载，
      // 仅在 loadVideoPlayer 之前 await（state.isMainlandUser 在那之前不会被读取）
      const mainlandCheckPromise = (async () => {
        try {
          const proxyCheck = await fetch('/youtube-proxy/check');
          const proxyData = await proxyCheck.json();
          state.isMainlandUser = proxyData.needsProxy || false;
          console.log('[Init] Mainland user:', state.isMainlandUser ? 'YES' : 'NO');
        } catch (e) {
          console.warn('[Init] Failed to check mainland user status');
          state.isMainlandUser = false;
        }
      })();

      let videoList = [];
      let videoListFailed = false;
      try {
        // 始终加载全部视频，然后在客户端筛选
        const res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers });
        if (res.ok) {
          const data = await res.json();
          videoList = data.items || [];
        } else {
          videoListFailed = true;
        }
      } catch (err) {
        console.warn('Failed to load video list:', err);
        videoListFailed = true;
      }
      practiceCatalog = videoList;

      // 视频列表加载失败且无法继续时，明确报错（由 init 错误处理统一展示重试入口）
      if (videoListFailed && !videoList.length && !requestedId) {
        throw new Error('视频列表加载失败，请检查网络后重试。');
      }

      // 如果没有指定videoId，显示选择列表
      if (!requestedId && videoList.length > 0) {
        await showVideoSelectModal(videoList, defaultLevel);
        return;
      }

      let chosen = null;
      if (requestedId) {
        chosen = videoList.find((v) => `${v.id}` === `${requestedId}`);
        if (!chosen) {
          try {
            const detailRes = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(String(requestedId))}`, { headers });
            if (detailRes.ok) {
              chosen = await detailRes.json();
            }
          } catch (err) {
            console.warn('Failed to load requested video:', err);
          }
        }
        if (!chosen) {
          updatePracticeFeedback('找不到该视频，请确认链接是否正确。', '#dc2626');
          return;
        }
      }
      if (!chosen) {
        chosen = videoList[0];
      }

      if (!chosen) {
        const emptyError = new Error('还没有可练习的视频');
        emptyError.code = 'empty';
        throw emptyError;
      }

      state.videoId = chosen.id;
      window.LinglishStudyVideoId = /^\d+$/.test(String(chosen.id)) ? String(chosen.id) : '';
      window.LinglishStudyMedia = null;
      document.querySelector('.video-player-container')?.classList.remove('is-empty');
      audioModeManager.cleanup(videoPlayer);
      // 录音列表与字幕/详情数据互不依赖——并行加载
      const recordingsPromise = (async () => {
        try {
          const remoteRecordings = await fetchPracticeRecordings(state.videoId);
          state.serverRecordings = remoteRecordings;
          audioModeManager.loadUserRecordings(state.videoId, remoteRecordings);
        } catch (err) {
          console.warn('Failed to load server recordings:', err);
          state.serverRecordings = [];
          audioModeManager.loadUserRecordings(state.videoId, []);
        }
        ensureAudioModeAvailability();
        audioModeManager.setMode(currentAudioMode);
        updateAudioModeButtons();
      })();

      if (!Array.isArray(chosen.transcript_segments) || !chosen.transcript_segments.length) {
        try {
          const detailRes = await fetch(`${API_BASE}/video-resources/${state.videoId}`, { headers });
          if (detailRes.ok) {
            const detail = await detailRes.json();
            chosen = { ...chosen, ...detail };
          }
        } catch (err) {
          console.warn('Failed to load video detail:', err);
        }
      }

      state.videoData = chosen;
      state.currentSegments = Array.isArray(chosen.transcript_segments)
        ? chosen.transcript_segments.map((seg, idx) => ({
          ...seg,
          index: seg.index != null ? seg.index : idx,
        }))
        : [];

      if (!state.currentSegments.length) {
        const fallbackResponse = await fetch(`${API_BASE}/video-resources/${state.videoId}/transcript`, { headers });
        if (fallbackResponse.ok) {
          const fallbackTranscript = await fallbackResponse.json();
          state.currentSegments = Array.isArray(fallbackTranscript.segments)
            ? fallbackTranscript.segments.map((seg, idx) => ({
              ...seg,
              index: seg.index != null ? seg.index : idx,
            }))
            : [];
        } else if (chosen && chosen.transcript_segments_url) {
          try {
            const altRes = await fetch(`${API_BASE}${chosen.transcript_segments_url}`, { headers });
            if (altRes.ok) {
              const altData = await altRes.json();
              state.currentSegments = Array.isArray(altData.segments)
                ? altData.segments.map((seg, idx) => ({
                  ...seg,
                  index: seg.index != null ? seg.index : idx,
                }))
                : [];
            }
          } catch (err) {
            console.warn('Unable to load transcript segments from alt url:', err);
          }
        }
      }

      // Keep segmentation consistent with the video reader:
      // - Preserve good 2~4s caption lines (avoid over-merging into long sentences)
      // - Only split truly coarse segments
      if (state.currentSegments.length > 0) {
        const segMode = getSegmentationMode();

        state.currentSegments = state.currentSegments
          .map((seg) => {
            const start = segStart(seg);
            const end = segEnd(seg);
            return {
              ...seg,
              start: (start != null ? start : seg.start),
              end: (end != null ? end : seg.end),
              start_sec: (start != null ? start : seg.start_sec),
              end_sec: (end != null ? end : seg.end_sec),
              text: stripPromptMarkers(getSegText(seg)),
            };
          })
          .filter((seg) => {
            const a = segStart(seg);
            const b = segEnd(seg);
            return a != null && b != null && b >= a;
          });

        if (segMode === 'smart') {
          // Smart mode: keep the old behavior for experiments (merge incomplete lines).
          // Note: this can change the line breaks, so it is NOT used in default caption mode.
          const mergedSegs = mergeIncompleteSentences(state.currentSegments);
          state.currentSegments = mergedSegs;
        } else {
          // Caption mode: 信任 Whisper 的原始断句，只做必要的修复
          // 1. 修复重叠时间戳
          state.currentSegments = makeCaptionSegmentsNonOverlapping(state.currentSegments);
          // 2. 去重和规范化
          state.currentSegments = normalizeAndDedupPracticeSegments(state.currentSegments, { dedupBoundaryWords: false });
          // 3. 只合并明显不完整的句子（以悬挂词结尾的、太短的片段）
          state.currentSegments = mergeCaptionFragmentsToSentences(state.currentSegments);
          // 4. 按波形静音段做轻量切句（不跨越字幕边界）
          state.currentSegments = await splitSegmentsByWaveformSilence(state.currentSegments);
          // 5. 最终规范化
          state.currentSegments = normalizeAndDedupPracticeSegments(state.currentSegments, { dedupBoundaryWords: false });
        }

        state.currentSegments.slice(0, 5).forEach((s, i) => {
        });
      }

      rebuildSegmentRoleMap();

      // loadVideoPlayer 内部会读取 state.isMainlandUser，确保检测已完成
      await mainlandCheckPromise;

      const rawVideoPath = chosen.video_path || '';
      await loadVideoPlayer(rawVideoPath, chosen.local_video_path, chosen.local_video_status);

      renderPracticeLines();
      renderPracticeCurrentLine();
      await Promise.all([
        loadPracticeSpeakers(state.videoId),
        recordingsPromise,
      ]);
    }

    function applyShareModeUI() {
      if (!isShareMode()) return;
      const hiddenIds = [
        'practice-arm-btn',
        'start-dialogue-btn',
        'start-dialogue-section',
        'play-my-recording-btn',
        'retry-recording-btn',
        'clear-recordings-btn',
        'start-recording-fab',
        'fab-record-container',
        'full-playback-btn',
        'stop-playback-btn',
        'export-report-btn',
        'role-rename-btn',
        'role-rotate-btn',
        'role-count-select',
        'strict-alt-toggle',
        'mic-select',
        'test-mic-btn',
        'share-playback-btn',
        'start-practice-btn',  // 隐藏开始练习按钮
        'practice-score-panel' // 隐藏评分面板（因为是回放不是练习）
      ];
      hiddenIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      const progressSection = document.getElementById('practice-progress-section');
      if (progressSection) progressSection.style.display = 'block';
      const modeSelector = document.getElementById('practice-mode-selector');
      if (modeSelector) modeSelector.style.display = 'none';
      const hintEl = document.getElementById('practice-hint');
      if (hintEl) {
        hintEl.textContent = '🎧 分享回放模式：点击绿色按钮播放分享者的录音';
      }

      // 添加"播放全部"按钮
      createSharePlayAllButton();

      // 监听视频播放/暂停状态来更新按钮
      setupSharePlaybackListeners();

      // 添加评论和打分面板
      createShareFeedbackPanel();
    }

    // 创建分享模式的"播放全部"按钮
    function createSharePlayAllButton() {
      if (document.getElementById('share-play-all-btn')) return;

      const btn = document.createElement('button');
      btn.id = 'share-play-all-btn';
      btn.innerHTML = '▶️ 播放全部对话';
      btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        padding: 14px 24px;
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        border: none;
        border-radius: 30px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        z-index: 1000;
        box-shadow: 0 8px 24px rgba(14, 165, 233, 0.4);
        transition: all 0.2s;
      `;
      btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.05)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
      });
      btn.addEventListener('click', startShareFullPlayback);
      document.body.appendChild(btn);
    }

    // 分享模式：播放全部对话
    let sharePlaybackActive = false;
    async function startShareFullPlayback() {
      const btn = document.getElementById('share-play-all-btn');

      if (sharePlaybackActive) {
        // 停止播放
        sharePlaybackActive = false;
        if (btn) btn.innerHTML = '▶️ 播放全部对话';
        try {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.pauseVideo();
          } else if (videoPlayer) {
            videoPlayer.pause();
          }
          // 停止所有录音播放
          audioModeManager.stopAllUserRecordingsExcept(null);
        } catch (_) {}
        updatePracticeFeedback('⏸️ 已暂停播放', '#6b7280');
        return;
      }

      // 开始播放
      sharePlaybackActive = true;
      if (btn) btn.innerHTML = '⏸️ 暂停播放';

      // 确保音频模式为 mixed（播放用户录音 + 原声）
      currentAudioMode = 'mixed';
      audioModeManager.setMode('mixed');
      updateAudioModeButtons();

      // 确保已选择分享者的角色
      const shareSpeaker = audioModeManager.selectedSpeaker || state.selectedSpeaker;
      if (shareSpeaker) {
        state.selectedSpeaker = shareSpeaker;
        audioModeManager.selectedSpeaker = shareSpeaker;
      }

      // 统计录音数量
      const recordingCount = audioModeManager.userRecordings
        ? Object.keys(audioModeManager.userRecordings).length
        : 0;

      console.log('[SharePlayback] Starting playback', {
        speaker: shareSpeaker,
        recordingCount,
        recordings: Object.keys(audioModeManager.userRecordings || {}),
        mode: audioModeManager.mode,
      });

      // 从头开始播放
      try {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.seekTo(0);
          youtubePlayer.playVideo();
        } else if (videoPlayer) {
          videoPlayer.currentTime = 0;
          await videoPlayer.play();
        }
        updatePracticeFeedback(`🎬 正在播放对话（${recordingCount} 条录音），有录音的句子将自动播放`, '#059669');
      } catch (err) {
        console.warn('[SharePlayback] Play failed:', err);
        updatePracticeFeedback('👆 请点击视频区域开始播放', '#f59e0b');
        sharePlaybackActive = false;
        if (btn) btn.innerHTML = '▶️ 播放全部对话';
      }
    }

    // 设置分享播放模式的监听器（同步按钮状态和视频播放状态）
    function setupSharePlaybackListeners() {
      const btn = document.getElementById('share-play-all-btn');

      // YouTube 视频的播放状态监听
      if (isYouTubeVideo) {
        // YouTube Player 的 onStateChange 已经在其他地方设置
        // 这里我们通过轮询来同步状态
        setInterval(() => {
          if (!btn) return;
          try {
            if (youtubePlayer && youtubePlayer.getPlayerState) {
              const state = youtubePlayer.getPlayerState();
              // YT.PlayerState: ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
              if (state === 1) {
                // 正在播放
                if (!sharePlaybackActive) {
                  sharePlaybackActive = true;
                  btn.innerHTML = '⏸️ 暂停播放';
                }
              } else if (state === 2 || state === 0) {
                // 暂停或结束
                if (sharePlaybackActive) {
                  sharePlaybackActive = false;
                  btn.innerHTML = '▶️ 播放全部对话';
                  if (state === 0) {
                    updatePracticeFeedback('🎉 播放完成！可以再听一遍或留下你的评分~', '#059669');
                  }
                }
              }
            }
          } catch (_) {}
        }, 500);
      } else if (videoPlayer) {
        // HTML5 视频播放事件
        videoPlayer.addEventListener('play', () => {
          if (!sharePlaybackActive) {
            sharePlaybackActive = true;
            if (btn) btn.innerHTML = '⏸️ 暂停播放';
          }
        });

        videoPlayer.addEventListener('pause', () => {
          if (sharePlaybackActive) {
            sharePlaybackActive = false;
            if (btn) btn.innerHTML = '▶️ 播放全部对话';
          }
        });

        videoPlayer.addEventListener('ended', () => {
          sharePlaybackActive = false;
          if (btn) btn.innerHTML = '▶️ 播放全部对话';
          updatePracticeFeedback('🎉 播放完成！可以再听一遍或留下你的评分~', '#059669');
        });
      }

      console.log('[SharePlayback] Listeners set up for', isYouTubeVideo ? 'YouTube' : 'HTML5 video');
    }

    // 创建分享反馈面板（评论和打分）
    function createShareFeedbackPanel() {
      // 检查是否已存在
      if (document.getElementById('share-feedback-panel')) return;

      const panel = document.createElement('div');
      panel.id = 'share-feedback-panel';
      panel.innerHTML = `
        <div style="
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: white;
          border-radius: 16px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15);
          padding: 16px;
          z-index: 1000;
          min-width: 280px;
          max-width: 350px;
        ">
          <div style="font-weight: 600; font-size: 15px; margin-bottom: 12px; color: #374151;">
            💬 为这段录音打分
          </div>
          <div style="font-size: 12px; color: #6b7280; margin-bottom: 10px;">
            听完录音后，给分享者一些鼓励和建议吧！
          </div>

          <!-- 星级评分 -->
          <div style="display: flex; gap: 8px; margin-bottom: 12px;" id="share-rating-stars">
            <button class="rating-star" data-rating="1" style="background: none; border: none; font-size: 28px; cursor: pointer; transition: transform 0.15s;">⭐</button>
            <button class="rating-star" data-rating="2" style="background: none; border: none; font-size: 28px; cursor: pointer; transition: transform 0.15s;">⭐</button>
            <button class="rating-star" data-rating="3" style="background: none; border: none; font-size: 28px; cursor: pointer; transition: transform 0.15s;">⭐</button>
            <button class="rating-star" data-rating="4" style="background: none; border: none; font-size: 28px; cursor: pointer; transition: transform 0.15s;">⭐</button>
            <button class="rating-star" data-rating="5" style="background: none; border: none; font-size: 28px; cursor: pointer; transition: transform 0.15s;">⭐</button>
          </div>

          <!-- 评论输入 -->
          <textarea id="share-comment-input" placeholder="写下你的评价和建议..." style="
            width: 100%;
            min-height: 60px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 10px;
            font-size: 14px;
            resize: vertical;
            margin-bottom: 12px;
            font-family: inherit;
          "></textarea>

          <!-- 提交按钮 -->
          <button id="submit-share-feedback" style="
            width: 100%;
            padding: 10px 16px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.2s;
          ">
            提交评价
          </button>

          <!-- 已提交提示 -->
          <div id="share-feedback-success" style="display: none; text-align: center; color: #059669; padding: 8px;">
            ✅ 感谢你的评价！
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      // 绑定星级评分事件
      let selectedRating = 0;
      const stars = panel.querySelectorAll('.rating-star');
      stars.forEach((star) => {
        star.addEventListener('click', () => {
          selectedRating = parseInt(star.dataset.rating, 10);
          updateStarDisplay(selectedRating);
        });
        star.addEventListener('mouseenter', () => {
          updateStarDisplay(parseInt(star.dataset.rating, 10), true);
        });
        star.addEventListener('mouseleave', () => {
          updateStarDisplay(selectedRating);
        });
      });

      function updateStarDisplay(rating, isHover = false) {
        stars.forEach((s, i) => {
          const starRating = i + 1;
          if (starRating <= rating) {
            s.style.filter = 'none';
            s.style.transform = isHover ? 'scale(1.15)' : 'scale(1)';
          } else {
            s.style.filter = 'grayscale(100%)';
            s.style.transform = 'scale(1)';
          }
        });
      }
      updateStarDisplay(0);

      // 提交按钮事件
      const submitBtn = panel.querySelector('#submit-share-feedback');
      submitBtn.addEventListener('click', async () => {
        const comment = panel.querySelector('#share-comment-input').value.trim();
        if (!selectedRating && !comment) {
          alert('请至少选择一个星级或写下评论');
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = '提交中...';

        try {
          await submitShareFeedback(selectedRating, comment);
          panel.querySelector('#share-feedback-success').style.display = 'block';
          submitBtn.style.display = 'none';
          panel.querySelector('#share-comment-input').style.display = 'none';
          panel.querySelector('#share-rating-stars').style.display = 'none';
        } catch (err) {
          alert('提交失败，请稍后再试');
          submitBtn.disabled = false;
          submitBtn.textContent = '提交评价';
        }
      });
    }

    // 提交分享反馈
    async function submitShareFeedback(rating, comment) {
      const shareToken = getShareToken();
      if (!shareToken) throw new Error('No share token');

      const res = await fetch(`${API_BASE}/api/practice-shares/${encodeURIComponent(shareToken)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment }),
      });

      if (!res.ok) {
        throw new Error('Failed to submit feedback');
      }
      return res.json();
    }

    function applyShareSpeakerSetup(shareSpeaker) {
      if (Array.isArray(state.speakers) && state.speakers.length) {
        // Keep existing speakers if already resolved.
      } else {
        buildInferredSpeakers();
      }

      if (shareSpeaker && !state.speakers.some((sp) => sp.speaker === shareSpeaker)) {
        state.speakers.unshift({ speaker: shareSpeaker, lines: [] });
      }

      populateSpeakerSelect();
      if (shareSpeaker) {
        selectRole(shareSpeaker);
        setPracticeSpeaker(shareSpeaker);
      } else if (state.speakers[0]) {
        selectRole(state.speakers[0].speaker);
        setPracticeSpeaker(state.speakers[0].speaker);
      }
      generateRoleButtons();
      const recorded = new Set();
      (state.serverRecordings || []).forEach((rec) => {
        const idx = rec?.segment_index ?? rec?.segmentIndex;
        if (idx !== null && idx !== undefined) {
          recorded.add(idx);
        }
      });
      dialoguePracticeState.recordedSentences = recorded;
      initDialoguePractice(dialoguePracticeState.selectedRole || shareSpeaker);
      updateDialogueProgress();
      generateSentenceStatusDots();
    }

    async function loadShareVideoData(token) {
      if (!token) {
        throw new Error('分享链接无效');
      }
      // 检测是否是国内用户（用于跳过YouTube API）——与分享数据并行加载
      const mainlandCheckPromise = (async () => {
        try {
          const proxyCheck = await fetch('/youtube-proxy/check');
          const proxyData = await proxyCheck.json();
          state.isMainlandUser = proxyData.needsProxy || false;
        } catch (_) {
          state.isMainlandUser = false;
        }
      })();
      const res = await fetch(`${API_BASE}/api/practice-shares/${encodeURIComponent(token)}`);
      if (!res.ok) {
        throw new Error('分享链接已失效或不存在');
      }
      const payload = await res.json();
      const chosen = payload?.video;
      if (!chosen) {
        throw new Error('分享内容不存在');
      }

      state.videoId = chosen.id;
      document.querySelector('.video-player-container')?.classList.remove('is-empty');
      state.videoData = chosen;
      state.serverRecordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
      audioModeManager.cleanup(videoPlayer);
      // 分享模式：清除 selectedSpeaker 以避免过滤录音
      audioModeManager.selectedSpeaker = null;
      audioModeManager.loadUserRecordings(state.videoId, state.serverRecordings);
      ensureAudioModeAvailability();
      currentAudioMode = 'mixed';
      audioModeManager.setMode(currentAudioMode);
      updateAudioModeButtons();

      state.currentSegments = Array.isArray(chosen.transcript_segments)
        ? chosen.transcript_segments.map((seg, idx) => ({
          ...seg,
          index: seg.index != null ? seg.index : idx,
        }))
        : [];

      if (!state.currentSegments.length) {
        throw new Error('分享视频暂无字幕，无法回放');
      }

      if (state.currentSegments.length > 0) {
        const segMode = getSegmentationMode();

        state.currentSegments = state.currentSegments
          .map((seg) => {
            const start = segStart(seg);
            const end = segEnd(seg);
            return {
              ...seg,
              start: (start != null ? start : seg.start),
              end: (end != null ? end : seg.end),
              start_sec: (start != null ? start : seg.start_sec),
              end_sec: (end != null ? end : seg.end_sec),
              text: stripPromptMarkers(getSegText(seg)),
            };
          })
          .filter((seg) => {
            const a = segStart(seg);
            const b = segEnd(seg);
            return a != null && b != null && b >= a;
          });

        if (segMode === 'smart') {
          const mergedSegs = mergeIncompleteSentences(state.currentSegments);
          state.currentSegments = mergedSegs;
        } else {
          state.currentSegments = makeCaptionSegmentsNonOverlapping(state.currentSegments);
          state.currentSegments = normalizeAndDedupPracticeSegments(state.currentSegments, { dedupBoundaryWords: false });
          state.currentSegments = mergeCaptionFragmentsToSentences(state.currentSegments);
          state.currentSegments = await splitSegmentsByWaveformSilence(state.currentSegments);
          state.currentSegments = normalizeAndDedupPracticeSegments(state.currentSegments, { dedupBoundaryWords: false });
        }
      }

      rebuildSegmentRoleMap();

      // loadVideoPlayer 内部会读取 state.isMainlandUser，确保检测已完成
      await mainlandCheckPromise;

      const rawVideoPath = chosen.video_path || '';
      await loadVideoPlayer(rawVideoPath, chosen.local_video_path, chosen.local_video_status);

      applyShareModeUI();
      switchPracticeMode('dialogue');
      applyShareSpeakerSetup(payload?.share?.speaker || null);
      renderPracticeLines();
      renderPracticeCurrentLine();

      // 分享模式：自动开始回放
      setTimeout(() => {
        startSharePlayback();
      }, 500);
    }

    // 分享模式：自动回放功能
    async function startSharePlayback() {
      if (!isShareMode()) return;

      // 确保音频模式为 mixed（播放用户录音 + 原声）
      currentAudioMode = 'mixed';
      audioModeManager.setMode('mixed');
      updateAudioModeButtons();

      // 统计有多少录音
      const recordingCount = audioModeManager && audioModeManager.userRecordings
        ? Object.keys(audioModeManager.userRecordings).length
        : 0;

      // 显示回放提示
      if (recordingCount > 0) {
        updatePracticeFeedback(`🎬 已加载 ${recordingCount} 条录音，点击绿色按钮播放`, '#059669');
      } else {
        updatePracticeFeedback('⚠️ 此分享暂无录音', '#f59e0b');
      }

      // 不自动播放视频，让用户手动点击
      // 因为用户主要想听录音，而不是看视频
    }

    // 播放分享者的录音
    let lastSharePlayTime = 0;
    let lastSharePlayKey = null;
    function playShareRecording(segmentKey) {
      // 防止重复点击（300ms 内忽略同一个 key 的重复调用）
      const now = Date.now();
      if (segmentKey === lastSharePlayKey && now - lastSharePlayTime < 300) {
        return;
      }
      lastSharePlayTime = now;
      lastSharePlayKey = segmentKey;

      if (!audioModeManager || !audioModeManager.userRecordings) {
        updatePracticeFeedback('录音数据未加载', '#dc2626');
        return;
      }

      const audio = audioModeManager.userRecordings[segmentKey];
      if (!audio) {
        updatePracticeFeedback('未找到该句录音', '#dc2626');
        return;
      }

      // 停止所有其他录音
      audioModeManager.stopAllUserRecordingsExcept(audio);

      // 暂停视频
      try {
        if (isYouTubeVideo && youtubePlayer) {
          youtubePlayer.pauseVideo();
        } else if (videoPlayer) {
          videoPlayer.pause();
        }
      } catch (_) {}

      // 确保音量正确
      audio.volume = 1.0;
      audio.muted = false;

      // 播放录音
      audio.currentTime = 0;
      audio.play().then(() => {
        updatePracticeFeedback('🎧 正在播放录音...', '#059669');
      }).catch((err) => {
        console.error('[SharePlayback] Failed to play:', err);
        updatePracticeFeedback('播放失败: ' + err.message, '#dc2626');
      });

      // 录音播放结束后的处理
      audio.onended = () => {
        updatePracticeFeedback('✅ 录音播放完成', '#059669');
      };
    }

    function registerEventHandlers() {
      if (playOverlay) {
        playOverlay.addEventListener('click', () => safePlayVideo());
      }

      videoPlayer.addEventListener('loadstart', () => {
        updatePracticeFeedback('正在加载视频...');
      });

      videoPlayer.addEventListener('loadedmetadata', () => {
        const startSec = Number(new URLSearchParams(window.location.search).get('startSec'));
        if (!Number.isFinite(startSec) || startSec <= 0) return;
        try { videoPlayer.currentTime = startSec; } catch (_) { }
      });

      videoPlayer.addEventListener('canplay', () => {
      });

      videoPlayer.addEventListener('error', (e) => {
        console.error('Video error:', e);
        console.error('Video error details:', videoPlayer.error);

        // Better error diagnostics
        const errorCode = videoPlayer.error?.code;
        const errorMessage = videoPlayer.error?.message || '';
        let userMessage = '视频加载失败';

        switch (errorCode) {
          case 1: // MEDIA_ERR_ABORTED
            userMessage += ': 加载已中止，可能是网络问题或浏览器设置';
            // Try to reload the video after a short delay
            setTimeout(() => {
              if (videoPlayer.src && videoPlayer.readyState === 0) {
                videoPlayer.load();
              }
            }, 1000);
            break;
          case 2: // MEDIA_ERR_NETWORK
            userMessage += ': 网络错误，请检查网络连接';
            break;
          case 3: // MEDIA_ERR_DECODE
            userMessage += ': 视频解码失败，格式可能不支持';
            break;
          case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
            userMessage += ': 视频格式不支持或路径错误';
            break;
          default:
            userMessage += errorMessage ? `: ${errorMessage}` : ': 未知错误';
        }

        updatePracticeFeedback(userMessage, '#dc2626');

        if (debugMode) {
          console.log('[视频错误] 详情', {
            code: errorCode,
            message: errorMessage,
            readyState: videoPlayer.readyState,
            networkState: videoPlayer.networkState,
          });
        }
      });

      videoPlayer.addEventListener('timeupdate', handleVideoTimeUpdate);
      videoPlayer.addEventListener('pause', () => {
        // Don't cleanup if video was paused to wait for recording playback
        const isPausedForRecording = audioModeManager.overlayPlaybackState?.videoPausedForRecording;
        if (!isPausedForRecording) {
          audioModeManager.cleanup(videoPlayer);
        } else if (debugMode) {
          console.log('[音频模式] 视频暂停用于录音', {
            videoPausedForRecording: true,
            overlayAudio: !!audioModeManager.overlayAudio,
          });
        }
      });
      videoPlayer.addEventListener('ended', () => audioModeManager.cleanup(videoPlayer));
      videoPlayer.addEventListener('seeking', () => audioModeManager.cleanup(videoPlayer));

      audioModeBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const mode = btn.dataset.mode || 'original';
          currentAudioMode = mode;
          audioModeManager.setMode(currentAudioMode);
          updateAudioModeButtons();
          if (mode !== 'original') {
            disablePracticeModeForPlayback('已切换到连续播放模式，视频会直接播放你的配音。');
          }
          if (videoPlayer.paused || videoPlayer.ended) {
            if (videoPlayer.ended) {
              videoPlayer.currentTime = 0;
            }
            safePlayVideo();
          }
        });
      });

      ensureAudioModeAvailability();
      audioModeManager.setMode(currentAudioMode);
      updateAudioModeButtons();
      updateAudioModeButtonsAvailability(); // 初始化按钮可用性状态

      practiceArmBtn.addEventListener('click', () => togglePracticeMode());

      // Practice speaker select (may not exist in dialogue mode)
      if (practiceSpeakerSelect) {
        practiceSpeakerSelect.addEventListener('change', (event) => {
          const selectedSpeaker = event.target.value;
          setPracticeSpeaker(selectedSpeaker);

          // 选择角色后，自动启用practice mode（但不显示控制面板）
          if (selectedSpeaker) {
            // 自动启用practice mode
            if (!state.practiceArmed) {
              state.practiceArmed = true;
              if (practiceArmBtn) {
                practiceArmBtn.textContent = 'Disable Practice Mode';
                practiceArmBtn.classList.add('enabled');
              }
              updatePracticeHint();
            }

            // 准备控制按钮状态（但不显示面板，由startAutoMode控制显示）
            if (autoStartBtn) {
              autoStartBtn.hidden = false;
              autoStartBtn.textContent = '▶';
            }
            if (autoPauseBtn) autoPauseBtn.hidden = true;
            updateAutoStatus('🎭', '准备就绪，点击▶开始');

            // 显示独立的开始录音按钮
            if (startRecordingFab) startRecordingFab.hidden = false;
          } else {
            // 没有选择角色时隐藏按钮
            if (startRecordingFab) startRecordingFab.hidden = true;
          }
        });
      }

      // 添加独立开始录音按钮事件
      if (startRecordingFab) {
        startRecordingFab.addEventListener('click', () => {
          // 首次开始或重新开始
          state.practiceIndex = 0;
          state.currentRetry = 0;
          startAutoMode();
        });
      }

      // 添加自动模式控制按钮事件
      if (autoStartBtn) {
        autoStartBtn.addEventListener('click', () => {
          if (!state.autoMode) {
            // 首次开始或重新开始
            state.practiceIndex = 0;
            state.currentRetry = 0;
            startAutoMode();
          } else if (state.isPaused) {
            // 继续
            resumeAutoMode();
          }
        });
      }

      if (autoPauseBtn) {
        autoPauseBtn.addEventListener('click', () => {
          pauseAutoMode();
        });
      }

      if (autoPrevBtn) {
        autoPrevBtn.addEventListener('click', () => {
          gotoPrevLine();
        });
      }

      if (autoNextBtn) {
        autoNextBtn.addEventListener('click', () => {
          gotoNextLine();
        });
      }
    }

    window.addEventListener('DOMContentLoaded', async () => {
      try {
        // 初始化多语言
        if (typeof i18n !== 'undefined') {
          i18n.init();

          // 设置语言选择器
          const currentLangEl = document.getElementById('current-lang-practice');
          const langBtn = document.getElementById('lang-btn-practice');
          const langDropdown = document.getElementById('lang-dropdown-practice');
          const langNames = { zh: '中文', en: 'English' };

          if (currentLangEl) {
            currentLangEl.textContent = langNames[i18n.currentLang] || '中文';
          }

          langBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (langDropdown) {
              langDropdown.style.display = langDropdown.style.display === 'none' ? 'block' : 'none';
            }
          });

          document.addEventListener('click', () => {
            if (langDropdown) langDropdown.style.display = 'none';
          });

          langDropdown?.addEventListener('click', (e) => {
            e.stopPropagation();
          });

          document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(option => {
            option.addEventListener('click', () => {
              const lang = option.dataset.lang;
              if (lang) {
                i18n.setLang(lang);
                if (currentLangEl) {
                  currentLangEl.textContent = langNames[lang] || lang;
                }
                document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(opt => {
                  const isActive = opt.dataset.lang === lang;
                  opt.classList.toggle('active', isActive);
                  opt.style.background = isActive ? '#0ea5e9' : '';
                  opt.style.color = isActive ? 'white' : '';
                });
                if (langDropdown) langDropdown.style.display = 'none';
              }
            });
          });

          document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(opt => {
            const isActive = opt.dataset.lang === i18n.currentLang;
            opt.classList.toggle('active', isActive);
            opt.style.background = isActive ? '#0ea5e9' : '';
            opt.style.color = isActive ? 'white' : '';
          });
        }

        // 初始化语音选择器
        (function initVoiceSelector() {
          // Haptic Feedback Helper
          function triggerHaptic() {
            if (navigator.vibrate) {
              navigator.vibrate(10);
            }
          }

          // FAB Logic
          const fabBtn = document.getElementById('fab-record-btn');
          const fabContainer = document.getElementById('fab-record-container');

          if (fabBtn) {
            fabBtn.addEventListener('click', () => {
              triggerHaptic();

              // 对话模式下：直接开始/停止录音，不启动auto mode
              if (currentPracticeMode === 'dialogue') {
                if (!state.isRecording) {
                  startAutoRecording();
                } else {
                  stopAutoRecording();
                }
                return;
              }

              if (!state.autoMode) {
                // 1. Ensure Practice Mode is Armed
                if (!state.practiceArmed) {
                  const armBtn = document.getElementById('practice-arm-btn');
                  if (armBtn) {
                    armBtn.click();
                  }
                }

                // 2. Start Auto Mode (if armed successfully)
                // We use a small timeout to allow UI updates if any, though click() is sync.
                setTimeout(() => {
                  if (state.practiceArmed) {
                    const startRecFab = document.getElementById('start-recording-fab');
                    if (startRecFab && !startRecFab.hidden) {
                      startRecFab.click();
                    } else {
                      // Fallback: try calling startAutoMode directly if available
                      if (typeof startAutoMode === 'function') {
                        state.practiceIndex = 0;
                        state.currentRetry = 0;
                        startAutoMode();
                      } else {
                        const startBtn = document.getElementById('auto-start-btn');
                        if (startBtn) startBtn.click();
                      }
                    }
                    fabBtn.classList.add('recording');
                  } else {
                    console.warn('[FAB] Failed to arm practice mode (maybe no speaker selected?)');
                  }
                }, 50);
                return;
              }

              // In auto mode, toggle start/pause
              const startBtn = document.getElementById('auto-start-btn');
              const pauseBtn = document.getElementById('auto-pause-btn');

              if (startBtn && !startBtn.hidden) {
                startBtn.click();
                fabBtn.classList.add('recording');
              } else if (pauseBtn && !pauseBtn.hidden) {
                pauseBtn.click();
                fabBtn.classList.remove('recording');
              }
            });
          }

          // Show/Hide FAB based on mode
          function updateFabVisibility() {
            if (state.autoMode) {
              if (fabContainer) fabContainer.hidden = false;
              // Update FAB state based on recording
              if (state.isRecording) {
                fabBtn.classList.add('recording');
              } else {
                fabBtn.classList.remove('recording');
              }
            } else {
              // Show FAB if "Enable Practice" is available? 
              // Or hide it until practice starts?
              // Let's show it if practice arm button is visible
              const armBtn = document.getElementById('practice-arm-btn');
              if (fabContainer) fabContainer.hidden = !armBtn || armBtn.hidden;
            }
          }

          // Hook into state updates (simple polling or modify update functions)
          // For now, we'll add a periodic check or hook into existing update functions if possible.
          // Since we can't easily hook into all state changes, we'll rely on the button clicks updating the UI.
          // But we should update visibility when mode changes.
          // Let's hook into `updatePracticeButtons` if possible, but we can't easily replace it.
          // We'll add a MutationObserver to the auto-practice-controls to sync FAB state.

          const autoControls = document.getElementById('auto-practice-status');
          if (autoControls) {
            const observer = new MutationObserver(() => {
              if (fabContainer) fabContainer.hidden = autoControls.hidden;

              // Sync recording state
              const statusIcon = document.getElementById('status-icon');
              const statusText = document.getElementById('status-text');
              // Check for microphone icon OR text indicating recording/speaking
              const isRecording = (statusIcon && statusIcon.textContent.includes('🎤')) ||
                (statusText && (statusText.textContent.includes('说话') || statusText.textContent.includes('录音')));

              if (isRecording) {
                fabBtn.classList.add('recording');
              } else {
                fabBtn.classList.remove('recording');
              }
            });
            observer.observe(autoControls, { attributes: true, childList: true, subtree: true });
          }

        })();

        ensureToken();

        const libraries = document.querySelector('.topbar');
        libraries?.addEventListener('click', (event) => {
          const choice = event.target.closest('[data-library]');
          if (!choice) return;
          event.preventDefault();
          const library = choice.dataset.library;
          if (library === 'saved') {
            showVideoSelectModal(practiceCatalog.length ? practiceCatalog : allVideoList, null);
            return;
          }
          const mode = currentPracticeMode === 'dialogue' ? 'dialogue' : 'shadowing';
          const next = new URLSearchParams({ library, returnTo: 'coach', mode });
          window.location.href = `./video-reader-desktop.html?${next.toString()}`;
        });

        function renderCoachMembership(user) {
          const badge = document.getElementById('vip-badge');
          if (!badge || !user) return;
          const email = String(user.email || '');
          const guest = user.is_guest || user.isGuest || /^guest_.*@temp\.linglish\.local$/i.test(email);
          if (guest) {
            badge.hidden = true;
            return;
          }
          const type = String(user.membership_type || 'free').toLowerCase();
          const names = { svip: 'SVIP', vip: 'VIP', family: '家庭版', free: '免费' };
          const level = names[type] || '会员';
          const text = badge.querySelector('.vip-text');
          if (text) text.textContent = user.is_admin ? `${level} · 管理员` : `${level} 会员`;
          const known = ['vip', 'svip', 'family', 'free'];
          badge.className = 'vip-badge ' + (known.includes(type) ? type : 'free');
          badge.hidden = false;
        }

        const authToken = refreshAuthToken();
        if (authToken) {
          fetch('/users/me', { headers: { Authorization: `Bearer ${authToken}` } })
            .then((res) => res.ok ? res.json() : null)
            .then((user) => renderCoachMembership(user))
            .catch(() => {});
        }

        const dailyGoalLabel = document.getElementById('daily-goal-label');
        const dailyGoalFill = document.getElementById('daily-goal-fill');
        if (dailyGoalLabel && dailyGoalFill) {
          let completed = 0;
          try {
            const email = localStorage.getItem('userEmail') || sessionStorage.getItem('userEmail') || 'anon';
            const raw = localStorage.getItem(`video_progress_${email}`);
            const entries = raw ? Object.values(JSON.parse(raw)) : [];
            const now = new Date();
            completed = entries.filter((entry) => {
              const percent = Number(entry && entry.percent || 0);
              const updated = new Date(Number(entry && entry.updatedAt || 0));
              return percent >= 90
                && updated.getFullYear() === now.getFullYear()
                && updated.getMonth() === now.getMonth()
                && updated.getDate() === now.getDate();
            }).length;
          } catch (_) {}
          completed = Math.min(3, completed);
          dailyGoalLabel.textContent = `今日目标：${completed}/3视频`;
          dailyGoalFill.style.width = `${Math.round((completed / 3) * 100)}%`;
        }

        // 如果有videoId参数或share参数，隐藏选择模态框
        const params = new URLSearchParams(window.location.search);
        const hasVideoId = params.has('videoId');
        const hasShare = params.has('share') || params.has('share_token');
        const modal = document.getElementById('video-select-modal');
        if ((hasVideoId || hasShare) && modal) {
          modal.style.display = 'none';
        }

        registerEventHandlers();
        initDialogueSetupToggle();
        await initPracticeData();
      } catch (err) {
        console.error('Failed to initialize practice session:', err);
        showPracticeLoadError(err);
      }
    });

    // 可重试的数据加载流程（一次性 UI 初始化不在此处，避免重复绑定事件）
    async function initPracticeData() {
      updatePracticeFeedback('正在加载视频数据...');
      await loadVideoData();
      updatePracticeHint();
      updatePracticeFeedback('');
      applyPronunciationFocusDeepLink().catch(() => {});

      // 如果已经选择了角色，启用practice mode（但不显示控制面板）
      if (state.selectedSpeaker) {
        if (!state.practiceArmed) {
          state.practiceArmed = true;
          if (practiceArmBtn) {
            practiceArmBtn.textContent = 'Disable Practice Mode';
            practiceArmBtn.classList.add('enabled');
          }
          updatePracticeHint();
        }

        // 准备控制按钮状态（但不显示面板，由startAutoMode控制显示）
        if (autoStartBtn) {
          autoStartBtn.hidden = false;
          autoStartBtn.textContent = '▶';
        }
        if (autoPauseBtn) autoPauseBtn.hidden = true;
        updateAutoStatus('🎭', '准备就绪，点击▶开始');

        // 显示独立的开始录音按钮
        if (startRecordingFab) startRecordingFab.hidden = false;
      }
    }

    async function applyPronunciationFocusDeepLink() {
      const profileUI = window.LinglishPronunciationProfile;
      if (!profileUI?.createFocusController) return;
      const focusAssessment = pageParams.get('focusAssessment');
      if (!/^\d+$/.test(focusAssessment || '') || Number(focusAssessment) <= 0) return;
      const controller = profileUI.createFocusController({
        assessmentId: focusAssessment,
        getLoadedVideoId: () => state.videoId,
        getSegments: () => state.currentSegments,
        fetchFocus: async (assessmentId) => {
          const authToken = refreshAuthToken();
          if (!authToken) throw new Error('Authentication required');
          const response = await fetch(`${API_BASE}/pronunciation/assessments/${assessmentId}/focus`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        },
        apply: ({ segmentIndex, seekTime }) => {
          state.currentSegmentIndex = segmentIndex;
          if (isYouTubeVideo && youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
            youtubePlayer.seekTo(seekTime, true);
          } else if (videoPlayer) {
            videoPlayer.currentTime = seekTime;
          }
          renderPracticeLines();
          highlightCurrentSegment(segmentIndex, true);
          renderPracticeCurrentLine();
        },
        feedback: (message, kind) => {
          updatePracticeFeedback(message, kind === 'success' ? '#059669' : '#64748b');
        },
      });
      await controller.markTranscriptReady();
      if (!await waitForPracticePlayerReady()) {
        updatePracticeFeedback('暂时无法定位发音重点，你仍可正常练习', '#64748b');
        return;
      }
      await controller.markPlayerReady();
    }

    function waitForPracticePlayerReady(timeoutMs = 8000) {
      if (isYouTubeVideo) {
        return new Promise((resolve) => {
          const startedAt = Date.now();
          const check = () => {
            if (youtubePlayer && !youtubePlayerInitializing
              && typeof youtubePlayer.getPlayerState === 'function') return resolve(true);
            if (Date.now() - startedAt >= timeoutMs) return resolve(false);
            setTimeout(check, 50);
          };
          check();
        });
      }
      if (!videoPlayer) return Promise.resolve(false);
      if (videoPlayer.readyState >= 2) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ready) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          videoPlayer.removeEventListener('canplay', onReady);
          videoPlayer.removeEventListener('loadedmetadata', onReady);
          videoPlayer.removeEventListener('error', onError);
          resolve(ready);
        };
        const onReady = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        videoPlayer.addEventListener('canplay', onReady, { once: true });
        videoPlayer.addEventListener('loadedmetadata', onReady, { once: true });
        videoPlayer.addEventListener('error', onError, { once: true });
      });
    }

    // 加载失败：在台词区域展示错误 + 重试按钮
    function showPracticeLoadError(err) {
      const empty = err && (err.code === 'empty' || err.message === '还没有可练习的视频');
      updatePracticeFeedback(err.message || '加载练习页面失败，请稍后再试。', empty ? '#64748b' : '#dc2626');
      if (practiceArmBtn) practiceArmBtn.disabled = true;
      if (empty) {
        document.querySelector('.video-player-container')?.classList.add('is-empty');
        const caption = document.querySelector('#play-overlay > div > div:last-child');
        if (caption) caption.textContent = '选好片段后从这里播放原声';
      }
      const lineList = document.getElementById('practice-line-list');
      if (!lineList) return;
      lineList.innerHTML = '';
      const li = document.createElement('li');
      li.className = empty ? 'practice-load-error is-empty' : 'practice-load-error';
      const msg = document.createElement('p');
      msg.textContent = empty
        ? '还没有可练习的视频。准备好之后，先听原声，再跟着说。'
        : (err.message || '加载失败，请检查网络后重试。');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重新加载';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '加载中...';
        if (practiceArmBtn) practiceArmBtn.disabled = false;
        try {
          await initPracticeData();
        } catch (retryErr) {
          console.error('Retry failed:', retryErr);
          showPracticeLoadError(retryErr);
        }
      });
      li.appendChild(msg);
      li.appendChild(btn);
      lineList.appendChild(li);
    }

    // ==================== 对话模式优化功能 ====================

    // 对话练习状态
    const dialoguePracticeState = {
      selectedRole: null,      // 用户选择的角色
      sentences: [],           // 所有句子
      currentIndex: 0,         // 当前句子索引
      recordedSentences: new Set(), // 已录制句子的索引
      currentRecording: null,  // 当前录音blob
      currentRecordingAudio: null, // 当前播放的录音Audio对象
      currentASRText: null,    // 当前ASR识别文本
      currentSentence: null,   // 当前正在录制/查看的句子对象
      asrDisplayedAt: null,    // 🛡️ ASR结果显示时间戳，用于防抖保护
      isPlayingOriginalSample: false,
      originalPlaybackRafId: null,
      originalPlaybackTimeoutId: null,
      roleDisplayMap: new Map(),
      roleHistoryCache: new Map()
    };

    let originalAudioReplayController = null;

    function getOriginalAudioReplayController() {
      if (originalAudioReplayController) return originalAudioReplayController;
      const factory = window.LinglishOriginalAudioReplay?.createOriginalAudioReplayController;
      if (!factory || !unifiedPlayer) return null;
      originalAudioReplayController = factory({
        getTime: () => unifiedPlayer.getCurrentTime(),
        setTime: (value) => unifiedPlayer.setCurrentTime(value),
        play: () => safePlayVideo({ preferUnmuted: true }),
        pause: () => unifiedPlayer.pause(),
        unmute: () => unifiedPlayer.unmute(),
        setVolume: (value) => {
          if (unifiedPlayer.setVolume) unifiedPlayer.setVolume(value);
        },
        onStateChange: (playing) => {
          dialoguePracticeState.isPlayingOriginalSample = playing;
          state.bypassStudentGuard = playing;
          const buttons = [
            document.getElementById('play-original-btn'),
            document.getElementById('focus-replay-btn')
          ].filter(Boolean);
          buttons.forEach((button) => {
            button.classList.toggle('is-playing', playing);
            button.setAttribute('aria-pressed', String(playing));
          });
        },
        onError: () => notifyCompareMessage('原声暂未播放成功，请点击重播重试')
      });
      return originalAudioReplayController;
    }

    function replayOriginalSentence(sentence) {
      const start = Number(sentence?.start ?? sentence?.startTime ?? sentence?.start_sec);
      const end = Number(sentence?.end ?? sentence?.endTime ?? sentence?.end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return Promise.reject(new Error('当前句子无有效原声时间'));
      }
      const all = Array.isArray(dialoguePracticeState.sentences) ? dialoguePracticeState.sentences : [];
      const exactIndex = all.indexOf(sentence);
      const next = exactIndex >= 0 ? all[exactIndex + 1] : null;
      const controller = getOriginalAudioReplayController();
      if (!controller) return Promise.reject(new Error('播放器尚未就绪'));
      state.bypassStudentGuard = true;
      return controller.replay({
        start,
        end,
        nextStart: Number(next?.start ?? next?.startTime ?? next?.start_sec)
      });
    }

    const ROLE_KEYWORDS = [
      { zh: '面试官', en: 'Interviewer', keys: ['interviewer', '面试官', '面试'] },
      { zh: '候选人', en: 'Candidate', keys: ['candidate', 'interviewee', '候选人', '求职者'] },
      { zh: '老板', en: 'Boss', keys: ['boss', 'manager', 'supervisor', '老板', '经理', '主管'] },
      { zh: '员工', en: 'Employee', keys: ['employee', 'staff', 'assistant', '员工', '同事'] },
      { zh: '老师', en: 'Teacher', keys: ['teacher', 'professor', '老师'] },
      { zh: '学生', en: 'Student', keys: ['student', '学生'] },
      { zh: '医生', en: 'Doctor', keys: ['doctor', '医生'] },
      { zh: '病人', en: 'Patient', keys: ['patient', '病人', '患者'] },
      { zh: '主持人', en: 'Host', keys: ['host', '主持人'] },
      { zh: '嘉宾', en: 'Guest', keys: ['guest', '嘉宾'] },
      { zh: '顾客', en: 'Customer', keys: ['customer', 'client', '顾客', '客户'] },
      { zh: '客服', en: 'Support', keys: ['support', 'service', '客服'] }
    ];

    function isGenericSpeakerName(name) {
      if (!name) return true;
      return /^speaker\\s*\\d+$/i.test(String(name).trim());
    }

    function findRoleByKeywords(text) {
      if (!text) return null;
      const raw = String(text);
      const lower = raw.toLowerCase();
      for (const role of ROLE_KEYWORDS) {
        for (const key of role.keys) {
          const isLatin = /[a-z]/i.test(key);
          if (isLatin && lower.includes(key)) return role;
          if (!isLatin && raw.includes(key)) return role;
        }
      }
      return null;
    }

    function countQuestions(lines = []) {
      return lines.reduce((sum, line) => {
        const text = String(line?.text || '');
        if (/[?？]/.test(text) || /吗/.test(text)) return sum + 1;
        return sum;
      }, 0);
    }

    function buildRoleDisplayMap() {
      const speakers = Array.isArray(state.speakers) ? state.speakers : [];
      if (!speakers.length) {
        dialoguePracticeState.roleDisplayMap = new Map();
        return;
      }

      const videoId = state.videoId || new URLSearchParams(window.location.search).get('videoId') || null;
      const history = getRoleHistoryForVideo(videoId);
      const historyCounts = history.counts || {};

      const stats = speakers.map((sp, index) => {
        const lines = Array.isArray(sp?.lines) ? sp.lines : [];
        const questionCount = countQuestions(lines);
        const avgWords = computeAvgWords(lines);
        const avgLen = computeAvgLength(lines);
        const difficultyScore = computeRoleDifficultyScore(lines.length, questionCount, avgWords, avgLen);
        return {
          name: String(sp?.speaker || `Speaker ${index + 1}`),
          index,
          lineCount: lines.length,
          questionCount,
          avgWords,
          avgLen,
          difficultyScore,
          sampleLines: lines.map(l => l?.text).filter(Boolean).slice(0, 3)
        };
      });

      const difficultyScores = stats.map(s => s.difficultyScore).filter(v => Number.isFinite(v));
      const sortedScores = difficultyScores.slice().sort((a, b) => a - b);
      const getTier = (score) => {
        if (!Number.isFinite(score) || sortedScores.length === 0) return { label: '适中', cls: 'medium' };
        if (sortedScores.length === 1) return { label: '适中', cls: 'medium' };
        if (sortedScores.length === 2) {
          return score <= sortedScores[0] ? { label: '简单', cls: 'simple' } : { label: '挑战', cls: 'hard' };
        }
        const p33 = sortedScores[Math.floor(sortedScores.length * 0.33)];
        const p66 = sortedScores[Math.floor(sortedScores.length * 0.66)];
        if (score <= p33) return { label: '简单', cls: 'simple' };
        if (score <= p66) return { label: '适中', cls: 'medium' };
        return { label: '挑战', cls: 'hard' };
      };

      const minLines = stats.reduce((min, item) => Math.min(min, item.lineCount || 0), Number.POSITIVE_INFINITY);
      let interviewerIndex = null;
      if (stats.length === 2) {
        const diff = Math.abs(stats[0].questionCount - stats[1].questionCount);
        if (diff >= 2) {
          interviewerIndex = stats[0].questionCount > stats[1].questionCount ? 0 : 1;
        }
      }

      let recommendedName = null;
      const hasHistory = Object.values(historyCounts).some(count => count > 0) || !!history.lastSpeaker;
      if (history.lastSpeaker && stats.some(s => s.name === history.lastSpeaker)) {
        recommendedName = history.lastSpeaker;
      } else if (stats.length) {
        const ranked = stats.slice().sort((a, b) => {
          const countA = historyCounts[a.name] || 0;
          const countB = historyCounts[b.name] || 0;
          if (countA !== countB) return countA - countB;
          return a.difficultyScore - b.difficultyScore;
        });
        recommendedName = ranked[0].name;
      }

      const map = new Map();
      stats.forEach((stat) => {
        let label = findRoleByKeywords(stat.name);
        if (!label && stat.sampleLines.length) {
          label = findRoleByKeywords(stat.sampleLines.join(' '));
        }
        if (!label && isGenericSpeakerName(stat.name) && stats.length === 2 && interviewerIndex != null) {
          label = interviewerIndex === stat.index
            ? { zh: '面试官', en: 'Interviewer' }
            : { zh: '候选人', en: 'Candidate' };
        }
        if (!label) {
          label = {
            zh: `角色${stat.index + 1}`,
            en: `Role ${stat.index + 1}`
          };
        }

        const hasCjk = /[\\u4e00-\\u9fff]/.test(stat.name);
        const hasLatin = /[a-z]/i.test(stat.name);
        const zh = hasCjk ? stat.name : label.zh;
        const en = hasLatin ? stat.name : label.en;
        const tier = getTier(stat.difficultyScore);
        const practiceCount = Number(historyCounts[stat.name] || 0);
        const recommendReason = stat.name === recommendedName
          ? (history.lastSpeaker === stat.name
            ? '上次练习角色'
            : (hasHistory ? '建议继续补练' : '适合新手起步'))
          : '';

        map.set(stat.name, {
          name: stat.name,
          zh,
          en,
          lineCount: stat.lineCount,
          questionCount: stat.questionCount,
          recommended: stat.name === recommendedName,
          recommendReason,
          difficultyLabel: tier.label,
          difficultyClass: tier.cls,
          practiceCount,
          sampleLines: stat.sampleLines
        });
      });

      dialoguePracticeState.roleDisplayMap = map;
    }

    async function fetchRoleHistoryForVideo(videoId) {
      if (!videoId) return null;
      const token = refreshAuthToken();
      if (!token) return null;
      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}/role-history`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || typeof data !== 'object') return null;
        const payload = {
          counts: data.counts || {},
          lastSpeaker: data.lastSpeaker || null,
          lastAt: data.lastAt || null
        };
        dialoguePracticeState.roleHistoryCache.set(String(videoId), payload);
        return payload;
      } catch (_) {
        return null;
      }
    }

    function getRoleHistoryForVideo(videoId) {
      const result = { counts: {}, lastSpeaker: null };
      if (!videoId) return result;
      const cached = dialoguePracticeState.roleHistoryCache.get(String(videoId));
      if (cached) return cached;
      try {
        const raw = localStorage.getItem(`user_recordings_${videoId}`);
        if (!raw) return result;
        const data = JSON.parse(raw);
        if (data && data.selectedSpeaker) result.lastSpeaker = data.selectedSpeaker;
        const recordings = data && data.recordings ? data.recordings : {};
        Object.values(recordings).forEach((rec) => {
          const name = rec?.speaker || data?.selectedSpeaker || null;
          if (!name) return;
          result.counts[name] = (result.counts[name] || 0) + 1;
        });
      } catch (_) { }
      return result;
    }

    function computeAvgWords(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return 0;
      const counts = lines.map(l => countWords(String(l?.text || ''))).filter(Boolean);
      if (!counts.length) return 0;
      return counts.reduce((sum, v) => sum + v, 0) / counts.length;
    }

    function computeAvgLength(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return 0;
      const lengths = lines.map(l => String(l?.text || '').trim().length).filter(Boolean);
      if (!lengths.length) return 0;
      return lengths.reduce((sum, v) => sum + v, 0) / lengths.length;
    }

    function countWords(text) {
      const words = String(text || '').match(/[A-Za-z']+/g);
      if (words && words.length) return words.length;
      const cjk = String(text || '').match(/[\u4e00-\u9fff]/g);
      return cjk ? Math.max(1, Math.round(cjk.length / 2)) : 0;
    }

    function computeRoleDifficultyScore(lineCount, questionCount, avgWords, avgLen) {
      const lines = Number(lineCount) || 0;
      const questions = Number(questionCount) || 0;
      const words = Number(avgWords) || 0;
      const length = Number(avgLen) || 0;
      return (lines * 1.2) + (questions * 0.8) + (words * 0.6) + (length * 0.08);
    }

    function getRoleDisplayLabel(speakerName) {
      const display = dialoguePracticeState.roleDisplayMap.get(speakerName);
      if (!display) return speakerName;
      if (display.zh && display.en) return `${display.zh} (${display.en})`;
      return display.zh || display.en || speakerName;
    }

    function getSpeakerPreviewLines(speakerName) {
      const speaker = Array.isArray(state.speakers)
        ? state.speakers.find(sp => sp.speaker === speakerName)
        : null;
      let lines = Array.isArray(speaker?.lines) ? speaker.lines : [];
      if (!lines.length && Array.isArray(state.currentSegments)) {
        lines = state.currentSegments.filter(seg => seg.speaker === speakerName);
      }
      return lines.map(line => line?.text).filter(Boolean).slice(0, 3);
    }

    function updateRolePreview(speakerName) {
      const panel = document.getElementById('role-preview-panel');
      const nameEl = document.getElementById('role-preview-name');
      const countEl = document.getElementById('role-preview-count');
      const tipEl = document.getElementById('role-preview-tip');
      const linesEl = document.getElementById('role-preview-lines');
      if (!panel || !nameEl || !countEl || !linesEl) return;

      const display = dialoguePracticeState.roleDisplayMap.get(speakerName) || {};
      const label = getRoleDisplayLabel(speakerName);
      const lines = getSpeakerPreviewLines(speakerName);

      panel.style.display = 'grid';
      nameEl.textContent = label;
      const difficultyLabel = display.difficultyLabel || '适中';
      const practiceCount = Number(display.practiceCount || 0);
      countEl.textContent = `共${display.lineCount || lines.length}句 · ${difficultyLabel} · 已练${practiceCount}次`;
      if (tipEl) {
        tipEl.textContent = display.recommended ? `💡 ${display.recommendReason || '推荐角色'}` : '';
      }
      linesEl.innerHTML = lines.length
        ? lines.map((line, idx) => `
          <div class="role-preview-line">
            <strong>句子 ${idx + 1}</strong>${escapeHtml(line)}
          </div>
        `).join('')
        : '<div class="role-preview-line">暂无台词预览</div>';
    }

    /**
     * 生成角色选择按钮
     */
    function generateRoleButtons() {
      const container = document.getElementById('role-buttons-container');
      if (!container || !state.speakers || state.speakers.length === 0) return;

      buildRoleDisplayMap();
      container.innerHTML = '';

      state.speakers.forEach((speaker, index) => {
        const button = document.createElement('button');
        button.className = 'role-button';
        button.dataset.speaker = speaker.speaker;

        // 角色图标（循环使用emoji）
        const icons = ['🎬', '🎭', '🎤', '👤', '👥'];
        const icon = icons[index % icons.length];
        const display = dialoguePracticeState.roleDisplayMap.get(speaker.speaker) || {};
        const nameZh = escapeHtml(display.zh || speaker.speaker || `角色${index + 1}`);
        const nameEn = display.en ? escapeHtml(display.en) : '';
        const lineCount = Number.isFinite(display.lineCount) ? display.lineCount : 0;
        const questionCount = Number.isFinite(display.questionCount) ? display.questionCount : 0;
        const recommendBadge = display.recommended ? `<span class="role-badge recommended">推荐</span>` : '';
        const difficultyBadge = display.difficultyLabel
          ? `<span class="role-badge ${escapeHtml(display.difficultyClass || 'medium')}">${escapeHtml(display.difficultyLabel)}</span>`
          : '';
        const practiceCount = Number.isFinite(display.practiceCount) && display.practiceCount > 0
          ? `<span class="role-badge practice">已练 ${display.practiceCount}</span>`
          : '';
        const badges = [recommendBadge, difficultyBadge, practiceCount].filter(Boolean).join('');

        button.innerHTML = `
          <div class="role-head">
            <span class="role-icon">${icon}</span>
            <span style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">${badges}</span>
          </div>
          <span class="role-name-zh">${nameZh}</span>
          ${nameEn ? `<span class="role-name-en">${nameEn}</span>` : ''}
          <span class="role-meta">
            <span>台词 ${lineCount}</span>
            <span>提问 ${questionCount}</span>
          </span>
        `;

        button.addEventListener('click', () => {
          selectRole(speaker.speaker, button);
        });

        container.appendChild(button);
      });

      if (dialoguePracticeState.selectedRole) {
        updateRolePreview(dialoguePracticeState.selectedRole);
      }
    }

    /**
     * 选择角色
     */
    function selectRole(speakerName, buttonElement) {

      // 更新按钮状态
      document.querySelectorAll('.role-button').forEach(btn => {
        btn.classList.remove('selected');
      });
      if (buttonElement) {
        buttonElement.classList.add('selected');
      }

      // 保存选择的角色到状态
      dialoguePracticeState.selectedRole = speakerName;
      updateRolePreview(speakerName);

      const roleNameEl = document.getElementById('selected-role-name');
      if (roleNameEl) roleNameEl.textContent = getRoleDisplayLabel(speakerName);

      // 显示"开始练习"按钮
      const startDialogueSection = document.getElementById('start-dialogue-section');
      if (startDialogueSection) {
        startDialogueSection.style.display = isShareMode() ? 'none' : 'block';
      }

      // 设置选中的角色（但不触发change事件）
      const speakerSelect = document.getElementById('practice-speaker');
      if (speakerSelect) {
        speakerSelect.value = speakerName;
      }

    }

    /**
     * 初始化对话设置折叠功能
     */
    function initDialogueSetupToggle() {
      const toggleBtn = document.getElementById('toggle-setup-btn');
      const container = document.getElementById('dialogue-setup-container');

      if (toggleBtn && container) {
        toggleBtn.addEventListener('click', () => {
          const isCollapsed = container.classList.contains('collapsed');
          if (isCollapsed) {
            container.classList.remove('collapsed');
            toggleBtn.classList.remove('collapsed');
            toggleBtn.querySelector('span:first-child').textContent = '收起';
          } else {
            container.classList.add('collapsed');
            toggleBtn.classList.add('collapsed');
            toggleBtn.querySelector('span:first-child').textContent = '展开';
          }
        });
      }
    }

    /**
     * 开始对话练习（点击"开始练习"按钮后调用）
     */
    function startDialoguePractice() {
      const speakerName = dialoguePracticeState.selectedRole;
      if (!speakerName) {
        console.error('[Dialogue] No role selected');
        return;
      }

      // 设置练习模式为对话模式
      switchPracticeMode('dialogue');

      const onboardCard = document.getElementById('dialogue-onboard-card');
      if (onboardCard) onboardCard.style.display = 'none';

      // 收起设置区域
      const setupContainer = document.getElementById('dialogue-setup-container');
      const toggleBtn = document.getElementById('toggle-setup-btn');
      if (setupContainer) setupContainer.classList.add('collapsed');
      if (toggleBtn) {
        toggleBtn.classList.add('collapsed');
        toggleBtn.querySelector('span:first-child').textContent = '展开';
      }

      // 确保内容是可见的（只是被折叠了）
      const roleSelection = document.getElementById('role-selection-section');
      const startDialogueSection = document.getElementById('start-dialogue-section');
      if (roleSelection) roleSelection.style.display = 'block';
      // startDialogueSection 可以保持显示，因为它在折叠容器内

      // 显示进度区域
      const progressSection = document.getElementById('practice-progress-section');
      if (progressSection) progressSection.style.display = 'block';

      // 🎯 练习开始后隐藏不再需要的介绍信息和控制按钮，让用户专注于练习内容
      const modeSelectorCard = document.getElementById('practice-mode-selector');
      if (modeSelectorCard) modeSelectorCard.style.display = 'none';

      const modeLiveHeader = document.getElementById('mode-live-header');
      if (modeLiveHeader) modeLiveHeader.style.display = 'none';

      // 隐藏 "Disable Practice Mode" 按钮和提示（练习已开始，不需要这些控制了）
      const controlSection = document.getElementById('practice-control-section');
      if (controlSection) controlSection.style.display = 'none';

      // 对话模式下隐藏"导出报告"按钮（简化界面）
      const exportBtn = document.getElementById('export-report-btn');
      if (exportBtn) exportBtn.style.display = 'none';

      // 更新进度区域的角色名称
      const roleNameEl = document.getElementById('selected-role-name');
      if (roleNameEl) roleNameEl.textContent = getRoleDisplayLabel(speakerName);

      // 设置练习角色（确保state.selectedSpeaker和state.practiceLines被正确设置）
      setPracticeSpeaker(speakerName);

      // 同步到 AudioModeManager，让对话模式知道用户的角色
      if (audioModeManager) {
        audioModeManager.selectedSpeaker = speakerName;
      }

      // 初始化练习数据
      initDialoguePractice(speakerName);

      // 设置完角色后，清除所有高亮（对话模式下高亮由录音流程控制）
      setTimeout(() => {
        const practiceLineList = document.getElementById('practice-line-list');
        if (practiceLineList) {
          practiceLineList.querySelectorAll('.line-item').forEach(item => {
            item.classList.remove('current');
          });
        }
      }, 100);

      // 触发practice-speaker的change事件以启用现有练习逻辑
      const speakerSelect = document.getElementById('practice-speaker');
      if (speakerSelect) {
        speakerSelect.dispatchEvent(new Event('change'));
      }

      // 自动点击"开始练习"按钮
      const practiceArmBtn = document.getElementById('practice-arm-btn');
      if (practiceArmBtn && !state.practiceArmed) {
        practiceArmBtn.click();
      }

      try {
        if (!localStorage.getItem(PRACTICE_GUIDE_KEY)) {
          setTimeout(showPracticeGuide, 400);
        }
      } catch (_) { }

      // 启动自动对话练习流程
      startAutoDialogueFlow();
    }

    /**
     * 自动对话练习流程控制器
     */
    function startAutoDialogueFlow() {
      setDialogueFocusLayout(true);
      if (typeof requestPracticeFullscreen === 'function') requestPracticeFullscreen();

      // 重置到第一个用户句子
      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
      if (userSentences.length === 0) {
        updatePracticeFeedback('❌ 没有找到你的台词', '#dc2626');
        return;
      }

      dialoguePracticeState.currentIndex = 0;
      const firstUserSentence = userSentences[0];

      // 播放视频从头开始

      // 移除播放覆盖层（如果存在）
      const playOverlay = document.getElementById('play-overlay');
      if (playOverlay) {
        playOverlay.style.display = 'none';
      }

      if (!unifiedPlayer) {
        console.error('[Dialogue Flow] unifiedPlayer is not available!');
        updatePracticeFeedback('❌ 播放器未准备好', '#dc2626');
        return;
      }

      try {
        unifiedPlayer.setCurrentTime(0);

        const playPromise = unifiedPlayer.play();

        if (playPromise && playPromise.then) {
          // play() 返回 Promise，等待它完成
          playPromise.then(() => {
            updatePracticeFeedback('🎬 视频播放中，将在你的台词前自动暂停并开始录音...', '#3b82f6');

            // 监听播放进度，在用户台词前暂停并录音
            setupDialoguePlaybackMonitor();
          }).catch(error => {
            console.error('[Dialogue Flow] ✗ Autoplay blocked:', error);

            // 浏览器阻止了自动播放，需要用户交互
            updatePracticeFeedback('⚠️ 浏览器阻止了自动播放，请点击视频播放按钮', '#f59e0b');

            // 显示播放覆盖层，引导用户手动点击
            if (playOverlay) {
              playOverlay.style.display = 'flex';
              playOverlay.innerHTML = `
                <div style="text-align: center; color: white;">
                  <div style="font-size: 48px; margin-bottom: 16px;">▶️</div>
                  <div style="font-size: 18px; font-weight: 500;">点击播放对话练习</div>
                  <div style="font-size: 14px; margin-top: 8px; opacity: 0.8;">
                    浏览器需要您的互动才能播放视频
                  </div>
                </div>
              `;

              // 点击后开始播放并设置监控
              playOverlay.addEventListener('click', () => {
                unifiedPlayer.play().then(() => {
                  playOverlay.style.display = 'none';
                  updatePracticeFeedback('🎬 视频播放中，将在你的台词前自动暂停并开始录音...', '#3b82f6');
                  setupDialoguePlaybackMonitor();
                }).catch(err => {
                  console.error('[Dialogue Flow] Failed to play after click:', err);
                  updatePracticeFeedback('❌ 播放失败: ' + err.message, '#dc2626');
                });
              }, { once: true });
            }
          });
        } else {
          // 不是 Promise（可能是 YouTube player），直接设置监控
          updatePracticeFeedback('🎬 视频播放中，将在你的台词前自动暂停并开始录音...', '#3b82f6');
          setupDialoguePlaybackMonitor();
        }
      } catch (error) {
        console.error('[Dialogue Flow] Error starting playback:', error);
        updatePracticeFeedback('❌ 播放失败: ' + error.message, '#dc2626');
        return;
      }
    }

    /**
     * 设置对话模式的播放监控
     */
    let dialogueMonitorInterval = null;
    const dialogueFocusPanelHome = {
      parent: null,
      nextSibling: null
    };

    /**
     * 对话专注布局：左侧保留沉浸视频，右侧展示当前字幕、识别结果和操作按钮。
     */
    function setDialogueFocusLayout(active) {
      const asrSection = document.getElementById('asr-comparison-section');
      const focusColumn = document.querySelector('.practice-right');

      if (active && asrSection && focusColumn) {
        if (!dialogueFocusPanelHome.parent) {
          dialogueFocusPanelHome.parent = asrSection.parentNode;
          dialogueFocusPanelHome.nextSibling = asrSection.nextSibling;
        }
        if (asrSection.parentNode !== focusColumn) {
          focusColumn.appendChild(asrSection);
        }
      } else if (!active && asrSection && dialogueFocusPanelHome.parent) {
        const home = dialogueFocusPanelHome.parent;
        const anchor = dialogueFocusPanelHome.nextSibling;
        if (anchor && anchor.parentNode === home) {
          home.insertBefore(asrSection, anchor);
        } else {
          home.appendChild(asrSection);
        }
      }

      document.body.classList.toggle('dialogue-focus-layout', Boolean(active));
      syncPracticeFocusChrome();
      if (!active) return;
      const practiceGrid = document.querySelector('.practice-grid');
      if (practiceGrid && !isElementVisibleInViewport(practiceGrid)) {
        practiceGrid.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }

    /** AI 陪练 / 实战场共享：开练自动专注，可 Esc 或「退出专注」回来。 */
    function isPracticeFocusActive() {
      return document.body.classList.contains('dialogue-focus-layout')
        || document.body.classList.contains('immersive-active');
    }

    function syncPracticeFocusChrome() {
      const active = isPracticeFocusActive();
      document.body.classList.toggle('practice-focus-active', active);
      const badge = document.getElementById('practice-focus-badge');
      const exitBtn = document.getElementById('practice-focus-exit');
      const toggleBtn = document.getElementById('practice-focus-toggle');
      const toggleLabel = toggleBtn && toggleBtn.querySelector('.practice-focus-toggle__label');
      const scriptHint = document.getElementById('practice-script-hint');
      const hint = document.getElementById('mode-top-hint');
      if (badge) badge.hidden = !active;
      if (exitBtn) exitBtn.hidden = !active;
      if (toggleBtn) {
        toggleBtn.classList.toggle('is-active', active);
        toggleBtn.setAttribute('aria-pressed', String(active));
      }
      if (toggleLabel) toggleLabel.textContent = active ? '专注中' : '专注';
      if (scriptHint) {
        scriptHint.textContent = active
          ? '专注中 · Esc 或再点「专注中」退出 · 点句子可跳转'
          : '点「专注」进入沉浸练习；点列表里的句子可以跳过去。';
      }
      if (!hint) return;
      if (active) {
        if (!hint.dataset.prevHint) hint.dataset.prevHint = hint.textContent || '';
        hint.textContent = currentPracticeMode === 'dialogue'
          ? '对话专注中 · Esc 退出专注 · 空格播放/暂停 · ←/→ 换句'
          : '跟读专注中 · Esc 退出专注 · 空格播放/暂停 · ←/→ 换句';
      } else if (hint.dataset.prevHint != null) {
        hint.textContent = hint.dataset.prevHint;
        delete hint.dataset.prevHint;
      }
    }

    function requestPracticeFullscreen() {
      const root = document.documentElement;
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!request || document.fullscreenElement || document.webkitFullscreenElement) return;
      Promise.resolve(request.call(root)).catch(() => { });
    }

    function exitPracticeFullscreen() {
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => { });
    }

    function enterPracticeFocus(options = {}) {
      const { fullscreen = true } = options;
      if (isPracticeFocusActive()) {
        syncPracticeFocusChrome();
        if (fullscreen) requestPracticeFullscreen();
        return true;
      }
      if (currentPracticeMode === 'dialogue') {
        setDialogueFocusLayout(true);
      } else {
        // AI 陪练：进入沉浸专注（不强制自动开播，由播放键控制）
        document.body.classList.add('immersive-active');
        syncPracticeFocusChrome();
      }
      if (fullscreen) requestPracticeFullscreen();
      return true;
    }

    function exitPracticeFocus(options = {}) {
      const { fullscreen = true } = options;
      if (state.isRecording || dialoguePracticeState?.isPreparingRecording) {
        try { updatePracticeFeedback('录音中，结束后可退出专注', '#0f766e'); } catch (_) { }
        return false;
      }
      if (document.body.classList.contains('immersive-active')) {
        if (typeof shadowingAutoMode !== 'undefined' && shadowingAutoMode) {
          pauseAutoShadowing();
        } else {
          document.body.classList.remove('immersive-active');
        }
      }
      if (document.body.classList.contains('dialogue-focus-layout')) {
        try { if (unifiedPlayer && typeof unifiedPlayer.pause === 'function') unifiedPlayer.pause(); } catch (_) { }
        if (dialogueMonitorInterval) {
          clearInterval(dialogueMonitorInterval);
          dialogueMonitorInterval = null;
        }
        setDialogueFocusLayout(false);
      }
      syncPracticeFocusChrome();
      if (fullscreen) exitPracticeFullscreen();
      return true;
    }

    function togglePracticeFocus() {
      if (isPracticeFocusActive()) return exitPracticeFocus();
      return enterPracticeFocus();
    }

    document.addEventListener('fullscreenchange', () => {
      if (!(document.fullscreenElement || document.webkitFullscreenElement) && isPracticeFocusActive()) {
        // Esc 退出浏览器全屏时，同步退出专注（与视频学习一致）
        exitPracticeFocus({ fullscreen: false });
      }
    });

    function handlePracticeFocusEscape() {
      if (currentPracticeMode === 'dialogue') {
        const asrSection = document.getElementById('asr-comparison-section');
        const asrActions = document.querySelector('.asr-actions');
        const reviewOpen = asrSection
          && asrSection.style.display !== 'none'
          && asrActions
          && asrActions.style.display !== 'none'
          && !state.isRecording;
        if (reviewOpen) {
          cancelAsrPractice();
          return true;
        }
      }
      if (isPracticeFocusActive()) {
        exitPracticeFocus();
        return true;
      }
      return false;
    }

    /**
     * 录音阶段也保留操作按钮的位置，识别完成后再开放点击。
     */
    function setDialogueReviewActionsReady(ready, stage = 'recording') {
      const asrSection = document.getElementById('asr-comparison-section');
      const asrActions = asrSection?.querySelector('.asr-actions');
      if (asrSection) {
        asrSection.dataset.stage = stage;
      }
      if (!asrActions) return;

      asrActions.style.display = 'grid';
      asrActions.querySelectorAll('button').forEach((button) => {
        button.disabled = !ready;
        button.setAttribute('aria-disabled', String(!ready));
      });
    }

    function setupDialoguePlaybackMonitor(startIndex) {
      // 清除之前的监控
      if (dialogueMonitorInterval) {
        clearInterval(dialogueMonitorInterval);
      }
      if (dialoguePracticeState.isPlayingOriginalSample) return;

      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
      // 使用传入的 startIndex，或者回退到当前 recordedSentences 数量
      let currentUserIndex = startIndex !== undefined ? startIndex : dialoguePracticeState.recordedSentences.size;
      // 如果当前索引已经超过了句子数量，就不再监控
      if (currentUserIndex >= userSentences.length) return;

      dialoguePracticeState.currentIndex = currentUserIndex;

      let hasTriggered = false; // 防止重复触发

      dialogueMonitorInterval = setInterval(() => {
        if (!unifiedPlayer || currentUserIndex >= userSentences.length) {
          clearInterval(dialogueMonitorInterval);
          return;
        }
        if (dialoguePracticeState.isPlayingOriginalSample) {
          return;
        }

        // 🛡️ 如果正在录音或准备录音，跳过检测，等待录音完成后由 continueToNextSentence 继续
        if (state.isRecording || dialoguePracticeState.isPreparingRecording) {
          return;
        }

        const currentTime = unifiedPlayer.getCurrentTime();
        const targetSentence = userSentences[currentUserIndex];

        // 计算暂停/触发窗口
        // NOTE: YouTube getCurrentTime() may jump in larger steps on some browsers; keep a wider trigger window
        // so we don't miss the pause after the first sentence.
        // 自然边界：若上一句字幕与用户台词紧贴（无静音间隙），提前 0.6s 暂停会把对方
        // 最后一个词切掉。根据实际间隙动态决定提前量：有间隙时停在静音中，紧贴时只提前 0.15s。
        let leadIn = 0.6;
        const allSentences = dialoguePracticeState.sentences;
        const tPos = allSentences.indexOf(targetSentence);
        if (tPos > 0) {
          const prevSeg = allSentences[tPos - 1];
          if (Number.isFinite(prevSeg.end)) {
            const gapBefore = targetSentence.start - prevSeg.end;
            leadIn = Math.min(0.6, Math.max(0.15, gapBefore));
          }
        }
        const pauseThreshold = Math.max(0, targetSentence.start - leadIn);
        const latestThreshold = Number.isFinite(targetSentence.end)
          ? (targetSentence.end + 0.5)
          : (targetSentence.start + 2.0);

        // 手动点段保护窗口内不触发自动暂停（先完整播放用户点击的段落）
        const manualPlayActive = state.manualPlayUntil != null && currentTime < state.manualPlayUntil;

        // 在用户台词开始前暂停；如果错过开始时间，也允许在句子结束后短暂窗口内触发
        if (!hasTriggered && !manualPlayActive && currentTime >= pauseThreshold && currentTime <= latestThreshold) {
          hasTriggered = true;
          unifiedPlayer.pause();

          // 🛑 立即停止监控器，防止在录音期间继续检测
          // 注意：监控器会在 continueToNextSentence() 中重新启动
          clearInterval(dialogueMonitorInterval);
          dialogueMonitorInterval = null;

          // 暂停后等待0.3秒再开始录音
          setTimeout(() => {
            // 再次检查是否正在录音，避免重复触发
            if (state.isRecording || dialoguePracticeState.isPreparingRecording) {
              return;
            }
            startDialogueRecording(targetSentence);
          }, 300);
        }

        // 实时更新高亮（无论是否是用户角色）
        updateDialogueHighlighting(currentTime);

      }, 50); // 每50ms检查一次 (reduced from 30ms to avoid flickering)
    }

    // Throttle for dialogue highlighting to prevent flickering
    let lastDialogueHighlightTime = 0;
    const DIALOGUE_HIGHLIGHT_THROTTLE_MS = 100;

    /**
     * 根据当前时间更新对话模式的高亮
     */
    function updateDialogueHighlighting(currentTime) {
      if (!Array.isArray(state.currentSegments) || !Array.isArray(state.practiceLines)) return;

      // Throttle updates to prevent visual flickering
      const now = Date.now();
      if (now - lastDialogueHighlightTime < DIALOGUE_HIGHLIGHT_THROTTLE_MS) return;
      lastDialogueHighlightTime = now;

      // 🎯 录音期间不自动更新高亮，避免覆盖录音时手动设置的高亮
      if (state.isRecording || dialoguePracticeState.isPreparingRecording) {
        return;
      }

      // 🎯 修正策略：
      // 在对话播放期间（对方角色说话时），高亮应当跟随视频进度（Video Time），
      // 从而展示当前正在说的台词（即使是对方角色）。
      // 只有当轮到用户说话（视频暂停，进入录音准备状态）时，高亮才应当停留在用户句子上。

      // 1. 找到当前时间对应的 segment
      const activeIndex = state.currentSegments.findIndex((segment) => {
        const start = Number(segment.start) || 0;
        const end = Number(segment.end);
        const effectiveEnd = Number.isFinite(end) ? end : start + 4;
        return currentTime >= start && currentTime < effectiveEnd;
      });

      if (activeIndex >= 0) {
        const segment = state.currentSegments[activeIndex];
        const rawSegmentIndex = segment.index != null ? segment.index : activeIndex;
        // 2. 调用通用高亮函数（它会处理 state.currentSegmentIndex 更新）
        // 第二个参数为 false (no scroll) 以避免播放时页面剧烈跳动，
        // 或者可以设为 true 但依赖 CSS smooth scrolling。
        // 用户反馈"上下乱跳"，建议播放期间仅高亮不强制滚动，或者仅当 index 变化时滚动。
        if (state.currentSegmentIndex !== rawSegmentIndex) {
          highlightCurrentSegment(rawSegmentIndex, true);
        }
      }
    }

    /**
     * 开始对话录音
     */
    async function startDialogueRecording(sentence) {
      setDialogueFocusLayout(true);

      // 🛑 停止监控器，防止在录音/评审期间自动触发下一句
      // 只有用户点击"下一句"调用 continueToNextSentence() 时才会重新启动监控器
      if (dialogueMonitorInterval) {
        clearInterval(dialogueMonitorInterval);
        dialogueMonitorInterval = null;
      }

      // 🎯 设置对话录音准备标志,阻止 updateDialogueHighlighting() 干扰高亮
      dialoguePracticeState.isPreparingRecording = true;

      // 保存当前句子到状态（用于重录）
      dialoguePracticeState.currentSentence = sentence;

      // 设置当前练习索引（找到该句子在practiceLines中的索引）
      const sentenceIndex = state.practiceLines.findIndex(line => {
        // 优先使用索引匹配 (Reliable)
        if (line.index != null && sentence.index != null) {
          return line.index === sentence.index;
        }
        // 回退到文本和时间戳匹配
        return line.text.trim() === sentence.text.trim() &&
          Math.abs((line.start || 0) - sentence.start) < 0.5; // Relaxed tolerance
      });

      if (sentenceIndex !== -1) {
        state.practiceIndex = sentenceIndex;
      } else {
        console.warn('[Dialogue Recording] Could not find sentence in practiceLines', {
          sentence,
          practiceLinesCount: state.practiceLines.length
        });
      }

      // 对话模式：使用 renderPracticeLines 来更新高亮
      // 因为 renderPracticeLines 已经更新了逻辑，会根据 state.practiceIndex 正确高亮
      const practiceLineList = document.getElementById('practice-line-list');
      if (practiceLineList) {
        renderPracticeLines();

        // 滚动到高亮行
        setTimeout(() => {
          const currentItem = practiceLineList.querySelector('.line-item.current');
          if (currentItem) {
            scrollItemIntoView(currentItem);
          } else {
            console.warn('[Dialogue Recording] Current item not found after render');
          }
        }, 50); // 短暂延迟确保渲染完成
      }

      updatePracticeFeedback(`🎤 正在录音: ${sentence.text}`, '#dc2626');

      // 提前显示ASR区域和原文，让用户看着读
      const asrSection = document.getElementById('asr-comparison-section');
      if (asrSection) {
        asrSection.style.display = 'block';
      }

      // 简化标题：录音时只显示"请跟读"
      const asrTitle = document.querySelector('.asr-title');
      if (asrTitle) {
        asrTitle.innerHTML = '<span>📖 请跟读</span>';
      }

      // 显示原文（移除"原文:"标签，更简洁）
      const originalTextEl = document.getElementById('original-text-content');
      if (originalTextEl) {
        originalTextEl.innerHTML = `<div style="font-size: 18px; line-height: 1.6; color: #1e293b; font-weight: 500;">${sentence.text}</div>`;
      }

      // 更新原文标签（添加图标）
      const originalTextDiv = document.querySelector('.original-text');
      const originalLabel = originalTextDiv?.querySelector('label');
      if (originalLabel) {
        originalLabel.style.display = 'flex';
        originalLabel.innerHTML = '<i class="fas fa-quote-left"></i> 原文';
      }

      // 更新录音标签（添加图标）
      const asrTextDiv = document.querySelector('.asr-text');
      const asrLabel = asrTextDiv?.querySelector('label');
      if (asrLabel) {
        asrLabel.innerHTML = '<i class="fas fa-microphone-alt"></i> 你的录音';
      }

      // 隐藏"你的录音"部分，等ASR完成后再显示
      if (asrTextDiv) {
        asrTextDiv.style.display = 'none';
      }

      // 操作按钮常驻，录音/识别期间禁用，避免用户来回滚动寻找。
      setDialogueReviewActionsReady(false, 'recording');

      // 显示录音状态
      const recordBtn = document.getElementById('fab-record-btn');
      if (recordBtn) {
        recordBtn.classList.add('recording');
        const icon = recordBtn.querySelector('i');
        if (icon) {
          icon.className = 'fas fa-stop-circle';
        }
      }

      // 触发录音按钮（使用现有录音逻辑）
      if (recordBtn && !state.isRecording) {
        // 使用静音检测自动停止，而不是固定时长
        const recordingPolicy = window.DialogueRecordingPolicy
          ? window.DialogueRecordingPolicy.getDialogueRecordingPolicy(sentence)
          : { minimumMs: 900, maximumMs: 6000 };
        const minDuration = recordingPolicy.minimumMs;
        const maxDuration = recordingPolicy.maximumMs;

        state.dialogueMinDurationMs = Number.isFinite(minDuration) ? minDuration : null;
        state.dialogueMaxDurationMs = Number.isFinite(maxDuration) ? maxDuration : null;
        state.activeMaxRecordingMs = Number.isFinite(maxDuration) ? maxDuration : null;

        let recordingStartTime = null;  // Will be set when recording actually starts
        let silenceCheckInterval = null;
        let maxTimeoutId = null;

        // 对话模式：静音停止由全局 VAD 负责（并尊重 state.dialogueMinDurationMs），这里仅等待录音真正开始以更新 UI。
        silenceCheckInterval = setInterval(() => {
          if (recordingStartTime) return;
          if (state.recorder && state.recorder.state === 'recording') {
            recordingStartTime = Date.now();
            // 🎯 清除准备录音标志,允许 updateDialogueHighlighting() 在录音结束后恢复
            dialoguePracticeState.isPreparingRecording = false;
            updateRecordingStatus('🎤 正在录音', '开口吧，最长还剩 ~' + (Math.round(maxDuration / 100) / 10) + ' 秒', '#16a34a');
            // 不再需要轮询
            clearInterval(silenceCheckInterval);
          }
        }, 200);

        // 最大时长保护 - 使用动态检测而不是固定setTimeout
        // 这样可以确保maxDuration是从录音真正开始计时，而不是从按钮点击开始
        const maxTimeoutChecker = setInterval(() => {
          if (recordingStartTime) {
            const elapsed = Date.now() - recordingStartTime;
            if (elapsed >= maxDuration) {
              clearInterval(silenceCheckInterval);
              clearInterval(maxTimeoutChecker);
              if (state.isRecording) {
                recordBtn.click();
              }
            }
          }
        }, 200);

        // 保存定时器ID，以便手动停止时清理
        state.dialogueRecordingTimers = {
          silenceCheckInterval,
          maxTimeoutId: maxTimeoutChecker  // Store interval instead of timeout
        };

        // 点击录音按钮
        recordBtn.click();
      } else {
        console.warn('[Dialogue Recording] Cannot start recording - button not found or already recording');
        // 清除 isPreparingRecording 标志，否则会阻塞后续的高亮更新
        dialoguePracticeState.isPreparingRecording = false;
      }
    }

    /**
     * 继续播放到下一句
     */
    function continueToNextSentence() {
      // 🛡️ 确保 isPreparingRecording 标志被清除，防止残留状态阻塞下一句
      dialoguePracticeState.isPreparingRecording = false;

      // 🛡️ Ensure any previous "Play Original" RAF loop is cancelled
      if (dialoguePracticeState.originalPlaybackRafId) {
        cancelAnimationFrame(dialoguePracticeState.originalPlaybackRafId);
        dialoguePracticeState.originalPlaybackRafId = null;
      }
      // Also ensure bypass guard is off
      if (typeof state !== 'undefined' && state.bypassStudentGuard) state.bypassStudentGuard = false;

      // 🛡️ Stop any active user recording playback
      if (dialoguePracticeState.currentRecordingAudio) {
        dialoguePracticeState.currentRecordingAudio.pause();
        dialoguePracticeState.currentRecordingAudio.currentTime = 0;
        dialoguePracticeState.currentRecordingAudio = null;
      }

      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
      // 使用 state.currentIndex 来追踪进度
      dialoguePracticeState.currentIndex++;

      if (dialoguePracticeState.currentIndex >= userSentences.length) {
        // 全部完成
        updatePracticeFeedback('🎉 恭喜！所有台词录制完成！', '#16a34a');

        if (dialogueMonitorInterval) {
          clearInterval(dialogueMonitorInterval);
        }
        return;
      }

      const nextSentence = userSentences[dialoguePracticeState.currentIndex];

      // 播放到下一句的开始位置

      if (unifiedPlayer) {
        // 提前2秒播放，但不要超过上一个句子的结束时间
        const prevSentence = userSentences[dialoguePracticeState.currentIndex - 1];
        let seekTime = Math.max(0, nextSentence.start - 2);

        // If there was a previous user sentence, start shortly before the *end* of that user sentence
        // (effectively playing the "Other Speaker" segment with a slight lead-in)
        if (prevSentence) {
          // Use a 0.2s lead-in buffer relative to the previous sentence end
          // ensuring we don't cut off the start of the next segment.
          seekTime = Math.max(0, prevSentence.end - 0.2);
        }

        // 确保 seekTime 不会小于当前时间太远，或者是视频开始
        if (seekTime < 0) seekTime = 0;

        unifiedPlayer.setCurrentTime(seekTime);
        unifiedPlayer.setCurrentTime(seekTime);
        const playPromise = unifiedPlayer.play();
        if (playPromise && playPromise.catch) {
          playPromise.catch(err => {
            console.error('[Dialogue Flow] Autoplay failed in continueToNextSentence:', err);
            updatePracticeFeedback('⚠️ 无法自动播放，请点击视频播放按钮继续', '#f59e0b');
            // Show overlay or other recovery mechanism if needed
          });
        }
      }

      // 重新启动监控，传入当前索引
      setupDialoguePlaybackMonitor(dialoguePracticeState.currentIndex);

      updatePracticeFeedback('🎬 播放下一段...', '#3b82f6');
    }

    /**
     * 初始化对话练习数据
     */
    function initDialoguePractice(speakerName) {
      // 获取所有句子（使用现有的state.currentSegments）
      if (!state.currentSegments || state.currentSegments.length === 0) {
        console.warn('[Dialogue] No segments available');
        return;
      }

      // 调试：输出前5个segment的speaker信息
      if (debugMode) {
        console.log('[Dialogue] Init segments', state.currentSegments.slice(0, 5).map(s => ({
          text: s.text?.substring(0, 30),
          speaker: s.speaker,
          index: s.index
        })));
      }

      // 使用 segmentSpeakerMap 来获取 speaker 信息（更可靠）
      dialoguePracticeState.sentences = state.currentSegments
        .map((seg, arrayIndex) => {
          const segmentIndex = seg.index != null ? seg.index : arrayIndex;

          // 尝试从多个来源获取 speaker 信息
          let speakerValue = seg.speaker;

          // 如果 segment 没有 speaker，尝试从 segmentSpeakerMap 获取
          if (!speakerValue && state.segmentSpeakerMap) {
            const keys = getSegmentLookupKeys(segmentIndex);
            for (const key of keys) {
              if (state.segmentSpeakerMap.has(key)) {
                speakerValue = state.segmentSpeakerMap.get(key);
                break;
              }
            }
          }

          // 使用 practiceLineIndexMap 来判断是否为用户角色，确保与 practiceLines 保持一致
          const segKey = buildSegmentKey(segmentIndex);
          const practiceLineIdx = (segKey && state.practiceLineIndexMap)
            ? state.practiceLineIndexMap.get(segKey)
            : undefined;
          const practiceLine = (practiceLineIdx != null && state.practiceLines && state.practiceLines[practiceLineIdx])
            ? state.practiceLines[practiceLineIdx]
            : null;
          const hasIndexMap = state.practiceLineIndexMap instanceof Map && state.practiceLineIndexMap.size;
          // isUserRole 如果该 segment 存在于 practiceLineIndexMap 中，说明被 setPracticeSpeaker 判定为用户行
          const isUserRole = hasIndexMap ? (practiceLine != null) : (speakerValue === speakerName);

          return {
            index: segmentIndex,
            // For user-role sentences, always use the exact text shown in the practice list (practiceLines)
            text: (practiceLine?.text || seg.text || ''),
            speaker: speakerValue || '',
            start: (practiceLine?.start ?? seg.start),
            end: (practiceLine?.end ?? seg.end),
            isUserRole: isUserRole
          };
        })
        .filter(s => s.text.trim() !== '');

      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);

      // 更新进度显示
      updateDialogueProgress();

      // 生成句子状态点
      generateSentenceStatusDots();

      if (debugMode) {
        console.log('[对话模式] 句子统计', {
          totalSentences: dialoguePracticeState.sentences.length,
          userSentences: userSentences.length,
          speaker: speakerName
        });
      }
    }

    /**
     * 更新对话练习进度
     */
    function updateDialogueProgress() {
      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
      const recorded = userSentences.filter(s => dialoguePracticeState.recordedSentences.has(s.index)).length;
      const total = userSentences.length;
      const percentage = total > 0 ? (recorded / total * 100) : 0;

      // 更新进度计数
      const progressCount = document.getElementById('progress-count');
      if (progressCount) {
        progressCount.textContent = `已跟读 ${recorded}/${total} 句`;
      }

      // 更新进度条
      const progressFill = document.getElementById('dialogue-progress-fill');
      if (progressFill) {
        progressFill.style.width = `${percentage}%`;
      }
    }

    /**
     * 生成句子状态点
     */
    function generateSentenceStatusDots() {
      const container = document.getElementById('sentence-status-row');
      if (!container) return;

      container.innerHTML = '';

      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);

      userSentences.forEach((sentence, displayIndex) => {
        const dot = document.createElement('div');
        dot.className = 'sentence-status-dot pending';
        dot.dataset.index = sentence.index;
        dot.title = `第${displayIndex + 1}句: ${sentence.text.substring(0, 20)}...`;

        // 更新状态
        if (dialoguePracticeState.recordedSentences.has(sentence.index)) {
          dot.classList.remove('pending');
          dot.classList.add('recorded');
          dot.textContent = '✓';
        } else {
          dot.textContent = displayIndex + 1;
        }

        // 点击跳转到该句
        dot.addEventListener('click', () => {
          jumpToSentence(sentence.index);
        });

        container.appendChild(dot);
      });
    }

    /**
     * 跳转到指定句子
     */
    function jumpToSentence(index) {
      dialoguePracticeState.currentIndex = index;

      // 实现跳转逻辑
      // 1. 停止当前的所有播放/监控
      if (dialogueMonitorInterval) {
        clearInterval(dialogueMonitorInterval);
        dialogueMonitorInterval = null;
      }
      if (dialoguePracticeState.originalPlaybackRafId) {
        cancelAnimationFrame(dialoguePracticeState.originalPlaybackRafId);
        dialoguePracticeState.originalPlaybackRafId = null;
      }
      if (dialoguePracticeState.currentRecordingAudio) {
        dialoguePracticeState.currentRecordingAudio.pause();
        dialoguePracticeState.currentRecordingAudio = null;
      }
      if (typeof stopVADMonitoring === 'function') stopVADMonitoring();

      // 2. 找到该 segment 在 userSentences 中的位置
      const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
      const userIndex = userSentences.findIndex(s => s.index === index);
      if (userIndex === -1) {
        console.warn('[Dialogue] Jump target is not a user sentence');
        return;
      }

      dialoguePracticeState.currentIndex = userIndex;

      // 3. 重新启动监控（播放之前的引导原声）
      monitorDialogueProgress(userIndex);

      // 4. 跳转视频进度到前一句结束前一点点
      const nextSentence = userSentences[userIndex];
      let seekTime = Math.max(0, nextSentence.start - 2);
      if (userIndex > 0) {
        const prevSentence = userSentences[userIndex - 1];
        seekTime = Math.max(0, prevSentence.end - 0.2);
      }
      if (unifiedPlayer) {
        unifiedPlayer.setCurrentTime(seekTime);
        unifiedPlayer.play().catch(e => console.warn('Play failed on jump', e));
      }

      updatePracticeFeedback(`🔄 已跳转到第 ${userIndex + 1} 句`, '#3b82f6');
    }

    /**
     * 录音完成后调用ASR识别（使用现有的pronunciation API）
     */
    async function performASR(audioBlob, originalText) {

      // 显示ASR对比区域
      const asrSection = document.getElementById('asr-comparison-section');
      if (asrSection) asrSection.style.display = 'block';

      // 显示原文
      const originalTextEl = document.getElementById('original-text-content');
      if (originalTextEl) {
        originalTextEl.textContent = originalText;
      }

      // 显示加载状态
      const asrTextEl = document.getElementById('asr-text-content');
      if (asrTextEl) {
        asrTextEl.innerHTML = '<div class="asr-loading"><i class="fas fa-spinner fa-spin"></i> 正在识别中...</div>';
      }
      setDialogueReviewActionsReady(false, 'processing');

      try {
        let measuredDuration = null;
        try {
          const decoded = await decodeAudioBlobToBuffer(audioBlob);
          measuredDuration = Number.isFinite(decoded?.duration) ? decoded.duration : null;
        } catch (_) { }

        // 将audioBlob转换为base64 data URL
        const audioBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });

        // 调用现有的pronunciation API
        const headers = {
          'Content-Type': 'application/json'
        };
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        console.log('[ASR] Sending request', {
          textLength: originalText ? originalText.length : 0,
          textPreview: originalText ? originalText.substring(0, 20) : 'null/empty',
          blobSize: audioBlob ? audioBlob.size : 0,
          base64Length: audioBase64 ? audioBase64.length : 0
        });

        const response = await fetch(`${API_BASE}/pronunciation/assess`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            text: originalText,
            audio_data: audioBase64,
            fast_asr: true,
            duration_seconds: measuredDuration,
            lemma: null,
            video_id: state.videoId || new URLSearchParams(window.location.search).get('videoId') || null
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `ASR API error: ${response.status}`);
        }

        const data = await response.json();
        const asrText = data.hypothesis || '';
        const assessment = data.assessment || {};
        const accuracy = assessment.accuracy || 0;
        const phonemes = assessment.phonemes || [];
        const coaching = assessment.coaching || null;

        if (debugMode) {
          console.log('[ASR] Result', {
            hypothesis: asrText,
            accuracy: accuracy,
            originalText: originalText
          });
        }

        // 保存ASR结果和准确度
        dialoguePracticeState.currentASRText = asrText;
        dialoguePracticeState.currentAccuracy = accuracy;

        // 显示对比结果
        displayASRComparison(originalText, asrText);

        // 更新标题和准确度显示
        const asrTitle = document.querySelector('.asr-title');
        if (asrTitle) {
          if (currentPracticeMode === 'dialogue') {
            const accuracyClass = accuracy >= 80 ? 'high' : accuracy >= 60 ? 'medium' : 'low';
            const emoji = accuracy >= 80 ? '✅' : accuracy >= 60 ? '⚠️' : '❌';

            asrTitle.innerHTML = `
                <span>${emoji} 识别结果</span>
                <span class="asr-accuracy-badge ${accuracyClass}">
                  <i class="fas fa-bullseye"></i> 准确度: ${accuracy}%
                </span>
              `;
          } else {
            // 其他模式
            asrTitle.innerHTML = `📝 录音识别结果 <span style="color: ${accuracy >= 80 ? '#059669' : accuracy >= 60 ? '#f59e0b' : '#dc2626'}; font-size: 14px;">(准确度: ${accuracy}%)</span>`;
          }
        }

        const speechRate = Number.isFinite(Number(assessment.speech_rate_wpm))
          ? Number(assessment.speech_rate_wpm)
          : computeSpeechRateWpm(originalText, measuredDuration);
        updatePracticeScorePanel({
          accuracy,
          fluency: null,
          prosody: null,
          speedWpm: speechRate,
          overall: accuracy,
          phonemes,
          coaching,
          assessmentId: assessment.id || null,
          skillUpdate: data.skill_update || null,
          recordingBlob: audioBlob
        });
        showAchievementToast({ accuracy });

        // 对话模式下自动播放用户录音进行回放
        if (currentPracticeMode === 'dialogue' && dialoguePracticeState.currentRecording) {
          setTimeout(() => {
            updatePracticeFeedback('🔊 正在播放你的录音...', '#2dd4bf');

            // Ensure any previous audio is stopped
            if (dialoguePracticeState.currentRecordingAudio) {
              dialoguePracticeState.currentRecordingAudio.pause();
              dialoguePracticeState.currentRecordingAudio = null;
            }

            const audio = new Audio(URL.createObjectURL(dialoguePracticeState.currentRecording));
            dialoguePracticeState.currentRecordingAudio = audio; // STORE IN GLOBAL STATE

            audio.onended = () => {
              URL.revokeObjectURL(audio.src);
              if (dialoguePracticeState.currentRecordingAudio === audio) {
                dialoguePracticeState.currentRecordingAudio = null;
              }
              // 如果准确度高，自动跳转下一句
              if (accuracy >= 80) {
                updatePracticeFeedback('✅ 太棒了！即将进入下一句...', '#10b981');
                setTimeout(() => {
                  // 再次检查是否还在当前状态（在此期间用户可能点击了重录）
                  if (dialoguePracticeState.currentASRText === asrText) {
                    const nextBtn = document.getElementById('next-sentence-btn');
                    if (nextBtn) nextBtn.click();
                  }
                }, 1500);
              } else {
                updatePracticeFeedback('✅ 录音播放完成，请查看识别结果', '#16a34a');
              }
              // 不再清除高亮，保持当前句子的上下文
            };
            audio.play().catch(err => {
              console.error('[Dialogue] Failed to play recording:', err);
              // Fallback for auto-advance if playback fails
              if (accuracy >= 80) {
                const nextBtn = document.getElementById('next-sentence-btn');
                if (nextBtn) nextBtn.click();
              }
            });
          }, 500); // 等待500ms后播放
        }

        return asrText;
      } catch (error) {
        console.error('[ASR] Recognition failed:', error);
        setDialogueReviewActionsReady(true, 'error');
        const nextSentenceButton = document.getElementById('next-sentence-btn');
        if (nextSentenceButton) {
          nextSentenceButton.disabled = true;
          nextSentenceButton.setAttribute('aria-disabled', 'true');
        }

        if (asrTextEl) {
          asrTextEl.innerHTML = `<span style="color: #dc2626;">识别失败: ${error.message}</span>`;
        }
        const speechRate = (() => {
          try { return computeSpeechRateWpm(originalText, null); } catch (_) { return null; }
        })();
        updatePracticeScorePanel({
          accuracy: null,
          fluency: null,
          prosody: null,
          speedWpm: speechRate,
          overall: null,
          phonemes: [],
          recordingBlob: audioBlob,
          summaryText: '评分服务暂不可用'
        });

        // 如果是权限错误，提示用户
        if (error.message.includes('MEMBERSHIP_REQUIRED') || error.message.includes('403')) {
          if (asrTextEl) {
            asrTextEl.innerHTML = '<span style="color: #dc2626;">需要会员权限才能使用语音识别功能</span>';
          }
        }

        return null;
      }
    }

    /**
     * 数字-单词映射表
     */
    const numberWordMap = {
      '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
      '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
      '10': 'ten', '11': 'eleven', '12': 'twelve', '13': 'thirteen', '14': 'fourteen',
      '15': 'fifteen', '16': 'sixteen', '17': 'seventeen', '18': 'eighteen', '19': 'nineteen',
      '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty',
      '60': 'sixty', '70': 'seventy', '80': 'eighty', '90': 'ninety',
      '100': 'hundred', '1000': 'thousand'
    };

    // 反向映射（单词到数字）
    const wordNumberMap = {};
    Object.entries(numberWordMap).forEach(([num, word]) => {
      wordNumberMap[word] = num;
    });

    /**
     * 归一化单词（移除标点符号并处理数字/单词等价）
     */
    function normalizeWord(word) {
      const cleaned = word.replace(/[^a-z0-9']/gi, '').toLowerCase();

      // 如果是数字，也返回对应的单词形式
      if (numberWordMap[cleaned]) {
        return [cleaned, numberWordMap[cleaned]];
      }

      // 如果是表示数字的单词，也返回数字形式
      if (wordNumberMap[cleaned]) {
        return [cleaned, wordNumberMap[cleaned]];
      }

      return [cleaned];
    }

    /**
     * 检查两个归一化单词数组是否有任何匹配
     */
    function wordsMatch(normalizedWords1, normalizedWords2) {
      return normalizedWords1.some(w1 => normalizedWords2.includes(w1));
    }

    /**
     * 显示ASR文本对比（绿色匹配，红色不匹配）
     */
    function displayASRComparison(originalText, asrText) {
      const asrTextEl = document.getElementById('asr-text-content');
      if (!asrTextEl) return;

      // 简单的单词级对比，带标点符号和数字归一化
      const originalWords = originalText.toLowerCase().split(/\s+/);
      const asrWords = asrText.toLowerCase().split(/\s+/);

      // 归一化单词用于对比（返回数组以处理数字/单词等价）
      const originalWordsNormalized = originalWords.map(normalizeWord);
      const asrWordsNormalized = asrWords.map(normalizeWord);

      // 展平以便搜索
      const originalWordsFlat = originalWordsNormalized.flat().filter(Boolean);
      const asrWordsFlat = asrWordsNormalized.flat().filter(Boolean);

      let html = '';
      const maxLength = Math.max(originalWords.length, asrWords.length);

      for (let i = 0; i < asrWords.length; i++) {
        const word = asrWords[i];
        const normalizedWordArray = asrWordsNormalized[i];
        // 检查此单词的任何变体是否存在于原文中
        const isMatch = normalizedWordArray.length > 0 && wordsMatch(normalizedWordArray, originalWordsFlat);
        const className = isMatch ? 'match' : 'mismatch';
        html += `<span class="word ${className}">${word}</span> `;
      }

      asrTextEl.innerHTML = html || '<span style="color: #94a3b8;">无识别结果</span>';

      // 同时在原文中高亮匹配的词
      const originalTextEl = document.getElementById('original-text-content');
      if (originalTextEl) {
        let originalHtml = '';
        for (let i = 0; i < originalWords.length; i++) {
          const word = originalWords[i];
          const normalizedWordArray = originalWordsNormalized[i];
          // 检查此单词的任何变体是否存在于ASR结果中
          const isMatch = normalizedWordArray.length > 0 && wordsMatch(normalizedWordArray, asrWordsFlat);
          const className = isMatch ? 'match' : '';
          originalHtml += `<span class="word ${className}">${word}</span> `;
        }
        originalTextEl.innerHTML = originalHtml;
      }

      // 对话模式：显示"你的录音"部分和操作按钮
      if (currentPracticeMode === 'dialogue') {
        // 恢复显示"原文:"标签
        const originalTextDiv = document.querySelector('.original-text');
        const originalLabel = originalTextDiv?.querySelector('label');
        if (originalLabel) {
          originalLabel.style.display = 'block';
        }

        // 显示"你的录音"部分
        const asrTextDiv = document.querySelector('.asr-text');
        if (asrTextDiv) {
          asrTextDiv.style.display = 'block';
        }

        // 显示操作按钮区域
        const asrActions = document.querySelector('.asr-actions');
        if (asrActions) {
          asrActions.style.display = 'grid';
        }
        setDialogueReviewActionsReady(true, 'review');

        // 🛡️ 记录ASR显示时间，用于防抖保护
        dialoguePracticeState.asrDisplayedAt = Date.now();

        // 对话模式：显示播放按钮（原声/录音）
        const playMyRecordingBtn = document.getElementById('play-my-recording-btn');
        const playOriginalBtn = document.getElementById('play-original-btn');
        if (playMyRecordingBtn) playMyRecordingBtn.style.display = '';
        if (playOriginalBtn) playOriginalBtn.style.display = '';
      }

      // 🎯 自动滚动到ASR结果区域，让用户立即看到识别结果
      setTimeout(() => {
        const asrSection = document.getElementById('asr-comparison-section');
        if (asrSection && asrSection.style.display !== 'none') {
          if (document.body.classList.contains('dialogue-focus-layout')) return;
          const now = Date.now();
          if (now - lastAsrAutoScroll < ASR_SCROLL_COOLDOWN_MS) return;
          if (!isElementVisibleInViewport(asrSection)) {
            lastAsrAutoScroll = now;
            asrSection.scrollIntoView({
              behavior: 'auto',
              block: 'nearest',
              inline: 'nearest'
            });
          }
        }
      }, 300); // 短暂延迟确保DOM更新完成
    }

    /**
     * 标记当前句子为已录制
     */
    function markSentenceAsRecorded(index) {
      dialoguePracticeState.recordedSentences.add(index);
      updateDialogueProgress();
      generateSentenceStatusDots();
    }

    /**
     * 取消当前跟读练习（✕ 按钮 / Esc 共用）：
     * 不评分、不弹结果面板，对话模式下直接继续下一句
     */
    function cancelAsrPractice() {
      // 正在录音：先短路 recorder stop 回调再停止，避免取消后仍弹评分
      if (state.isRecording) {
        state.recordingCancelled = true;
        stopAutoRecording();
      }

      // 清除 ASR 防抖时间戳并隐藏面板
      dialoguePracticeState.asrDisplayedAt = null;
      const asrSection = document.getElementById('asr-comparison-section');
      if (asrSection) asrSection.style.display = 'none';

      updateAutoStatus(null, null);
      updatePracticeFeedback('已取消本句练习', '#64748b');

      // 对话模式：跳过本句，恢复播放到下一句
      if (currentPracticeMode === 'dialogue') {
        continueToNextSentence();
      }
    }

    function playShadowingSentence(index) {
      if (state.isRecording || !shadowingSentences[index]) return;
      pauseAutoShadowing();
      shadowingCurrentIndex = index;
      shadowingLastStopIndex = null;
      shadowingLastStopTime = null;
      updateShadowingDisplay();
      startAutoShadowing();
    }

    function togglePracticePlayback() {
      if (state.isRecording) return;
      if (currentPracticeMode === 'shadowing') {
        if (unifiedPlayer.isPaused()) startAutoShadowing({ resume: true });
        else pauseAutoShadowing();
        return;
      }
      if (unifiedPlayer.isPaused()) safePlayVideo();
      else safePauseVideo();
    }

    function handleFocusPrevSentence() {
      if (state.isRecording) return;
      if (currentPracticeMode === 'shadowing') {
        playShadowingSentence(Math.max(0, shadowingCurrentIndex - 1));
        return;
      }
      if (currentPracticeMode === 'dialogue') {
        dialoguePracticeState.currentIndex = Math.max(0, dialoguePracticeState.currentIndex - 1) - 1;
        continueToNextSentence();
        return;
      }
      document.getElementById('auto-prev-btn')?.click();
    }

    function handleFocusNextSentence() {
      if (state.isRecording) return;
      if (currentPracticeMode === 'shadowing') {
        if (shadowingCurrentIndex < shadowingSentences.length - 1) playShadowingSentence(shadowingCurrentIndex + 1);
        else goToNextSentence();
        return;
      }
      if (currentPracticeMode === 'dialogue') {
        continueToNextSentence();
        return;
      }
      document.getElementById('auto-next-btn')?.click();
    }

    // ASR按钮事件监听 - 参考移动版使用 onclick 替代 addEventListener
    document.addEventListener('DOMContentLoaded', () => {
      // Playback tracking variables
      // originalPlaybackRafId & currentRecordingAudio moved to dialoguePracticeState for global access

      const focusPrevBtn = document.getElementById('focus-prev-btn');
      const focusPlayBtn = document.getElementById('focus-play-btn');
      const focusReplayBtn = document.getElementById('focus-replay-btn');
      const focusNextBtn = document.getElementById('focus-next-btn');
      const practiceFocusExitBtn = document.getElementById('practice-focus-exit');
      if (focusPrevBtn) {
        focusPrevBtn.onclick = handleFocusPrevSentence;
      }
      if (focusPlayBtn) focusPlayBtn.onclick = togglePracticePlayback;
      if (focusNextBtn) {
        focusNextBtn.onclick = () => handleFocusNextSentence();
      }
      if (focusReplayBtn) {
        focusReplayBtn.onclick = () => {
          const visibleOriginalButton = document.getElementById('play-original-btn');
          const asrPanel = document.getElementById('asr-comparison-section');
          if (visibleOriginalButton && asrPanel && asrPanel.style.display !== 'none') {
            visibleOriginalButton.click();
            return;
          }
          const sentence = getCurrentSentenceForPlayback();
          replayOriginalSentence(sentence).catch(() => notifyCompareMessage('原声播放失败'));
        };
      }
      if (practiceFocusExitBtn) {
        practiceFocusExitBtn.onclick = () => exitPracticeFocus();
      }
      const practiceFocusToggleBtn = document.getElementById('practice-focus-toggle');
      if (practiceFocusToggleBtn) {
        practiceFocusToggleBtn.onclick = () => togglePracticeFocus();
      }
      const practiceIntensiveNoteBtn = document.getElementById('practice-intensive-note');
      if (practiceIntensiveNoteBtn) {
        practiceIntensiveNoteBtn.addEventListener('click', () => {
          if (!window.WorkbenchImport) {
            showToast('精读笔记组件未加载', 'warn');
            return;
          }
          const fromPractice = state.practiceLines?.[state.practiceIndex]?.text;
          const segIdx = Number.isInteger(state.autoSegmentCursor)
            ? state.autoSegmentCursor
            : state.currentSegmentIndex;
          const fromSeg = Array.isArray(state.currentSegments) && Number.isInteger(segIdx)
            ? state.currentSegments[segIdx]?.text
            : '';
          const fromDom = practiceCurrentLine && !practiceCurrentLine.hidden
            ? practiceCurrentLine.querySelector('.practice-current-text')?.innerText
            : '';
          const text = String(fromPractice || fromSeg || fromDom || '').trim();
          const title = String(document.getElementById('current-title')?.textContent
            || document.getElementById('coach-brand-title')?.textContent
            || '陪练精读').trim();
          const ok = window.WorkbenchImport.openIntensiveNote({
            text,
            title: /陪练|实战|Linglish/.test(title) ? title : title,
            template: 'intensive-note',
            orient: 'story',
            source: 'practice-session',
            onEmpty: () => showToast('请先选中一句练习字幕', 'warn'),
          });
          if (ok) showToast('已打开精读笔记', 'success');
        });
      }
      syncPracticeFocusChrome();

      // 播放我的录音
      const playMyRecordingBtn = document.getElementById('play-my-recording-btn');
      if (playMyRecordingBtn) {
        playMyRecordingBtn.onclick = function onPlayMyRecording() {

          // 1. Stop Original Video Playback (if running)
          if (dialoguePracticeState.originalPlaybackRafId) {
            cancelAnimationFrame(dialoguePracticeState.originalPlaybackRafId);
            dialoguePracticeState.originalPlaybackRafId = null;
          }
          if (unifiedPlayer && !unifiedPlayer.isPaused()) {
            unifiedPlayer.pause();
            unifiedPlayer.mute();
            if (typeof state !== 'undefined' && state.bypassStudentGuard) state.bypassStudentGuard = false;
          }

          // 2. Play Audio
          if (dialoguePracticeState.currentRecordingAudio) {
            dialoguePracticeState.currentRecordingAudio.pause();
            dialoguePracticeState.currentRecordingAudio = null;
          }

          if (dialoguePracticeState.currentRecording) {
            const audio = new Audio(URL.createObjectURL(dialoguePracticeState.currentRecording));
            dialoguePracticeState.currentRecordingAudio = audio;
            audio.onended = () => { dialoguePracticeState.currentRecordingAudio = null; };
            audio.play();
          }
        };
      }

      // 播放原声对比
      const playOriginalBtn = document.getElementById('play-original-btn');
      if (playOriginalBtn) {
        playOriginalBtn.onclick = async function onPlayOriginal() {
          // 跟读模式：使用专门的重播逻辑
          if (currentPracticeMode === 'shadowing') {
            // 停止录音回放（如果正在播放）
            if (dialoguePracticeState.currentRecordingAudio) {
              dialoguePracticeState.currentRecordingAudio.pause();
              dialoguePracticeState.currentRecordingAudio.currentTime = 0;
              dialoguePracticeState.currentRecordingAudio = null;
            }
            // 调用跟读模式的重播函数
            replayCurrentSentence();
            return;
          }

          const replaySentence = getCurrentSentenceForPlayback();
          if (replaySentence && Number.isFinite(replaySentence.start) && Number.isFinite(replaySentence.end)) {
            replayOriginalSentence(replaySentence)
              .catch(() => notifyCompareMessage('原声播放失败'));
            return;
          }

          if (dialoguePracticeState.isPlayingOriginalSample) return;
          const originalBtnText = playOriginalBtn.textContent;
          playOriginalBtn.disabled = true;
          playOriginalBtn.textContent = '🎵 原声…';

          // 1. Stop Recording Playback (if running)
          // 1. Stop Recording Playback (if running)
          if (dialoguePracticeState.currentRecordingAudio) {
            dialoguePracticeState.currentRecordingAudio.pause();
            dialoguePracticeState.currentRecordingAudio.currentTime = 0; // Reset
            dialoguePracticeState.currentRecordingAudio = null;
          }

          if (unifiedPlayer && !unifiedPlayer.isPaused()) {
            unifiedPlayer.pause();
          }

          dialoguePracticeState.isPlayingOriginalSample = true;

          if (dialoguePracticeState.originalPlaybackTimeoutId) {
            clearTimeout(dialoguePracticeState.originalPlaybackTimeoutId);
            dialoguePracticeState.originalPlaybackTimeoutId = null;
          }

          // 2. Clear previous RAF if any
          if (dialoguePracticeState.originalPlaybackRafId) {
            cancelAnimationFrame(dialoguePracticeState.originalPlaybackRafId);
            dialoguePracticeState.originalPlaybackRafId = null;
          }
          if (dialogueMonitorInterval) {
            clearInterval(dialogueMonitorInterval);
            dialogueMonitorInterval = null;
          }

          // 跟读模式：优先使用 shadowingSentences
          const shadowingSentence = (currentPracticeMode === 'shadowing' && Array.isArray(shadowingSentences) && shadowingSentences.length > 0)
            ? shadowingSentences[shadowingCurrentIndex]
            : null;

          // Prefer the sentence that just produced the ASR result; fall back to current user index.
          const userSentences = dialoguePracticeState.sentences.filter(s => s.isUserRole);
          const fallbackLine = Array.isArray(state.practiceLines) ? state.practiceLines[state.practiceIndex] : null;
          const fallbackSeg = (() => {
            if (!Array.isArray(state.currentSegments) || !fallbackLine) return null;
            const rawIdx = fallbackLine.index != null ? fallbackLine.index : fallbackLine.segmentIndex;
            return state.currentSegments.find((seg, i) => (seg?.index != null ? seg.index : i) === rawIdx) || null;
          })();
          const segByTime = (() => {
            if (!Array.isArray(state.currentSegments)) return null;
            const now = unifiedPlayer ? unifiedPlayer.getCurrentTime() : 0;
            const hit = state.currentSegments.find((seg, i) => {
              const s = Number(seg?.start ?? seg?.startTime ?? 0);
              const eRaw = Number(seg?.end ?? seg?.endTime);
              const e = Number.isFinite(eRaw) ? eRaw : s + 4;
              return now >= s - 0.05 && now <= e + 0.05;
            });
            if (hit) return hit;
            let best = null;
            let bestDiff = Infinity;
            state.currentSegments.forEach((seg, i) => {
              const s = Number(seg?.start ?? seg?.startTime);
              if (!Number.isFinite(s)) return;
              const diff = Math.abs((unifiedPlayer ? unifiedPlayer.getCurrentTime() : 0) - s);
              if (diff < bestDiff) {
                bestDiff = diff;
                best = seg;
              }
            });
            return best;
          })();
          // 跟读模式优先使用 shadowingSentence
          const currentSentence = shadowingSentence || dialoguePracticeState.currentSentence || userSentences[dialoguePracticeState.currentIndex] || fallbackLine || fallbackSeg || segByTime;
          const startTime = Number(currentSentence?.start ?? currentSentence?.startTime);
          let endTime = Number(currentSentence?.end ?? currentSentence?.endTime);

          if (Number.isFinite(startTime)) {
            const findSegmentByIndex = () => {
              if (!Array.isArray(state.currentSegments)) return null;
              const rawIdx = currentSentence?.index ?? currentSentence?.segmentIndex;
              if (rawIdx == null) return null;
              return state.currentSegments.find((seg, i) => (seg?.index != null ? seg.index : i) === rawIdx) || null;
            };
            const resolvedSeg = findSegmentByIndex();
            const nextSegStart = Array.isArray(state.currentSegments)
              ? (() => {
                const sorted = state.currentSegments
                  .map((seg, i) => ({
                    start: Number(seg?.start ?? seg?.startTime),
                    index: seg?.index != null ? seg.index : i
                  }))
                  .filter(s => Number.isFinite(s.start))
                  .sort((a, b) => a.start - b.start);
                const target = Number.isFinite(Number(resolvedSeg?.start)) ? Number(resolvedSeg.start) : startTime;
                const next = sorted.find(s => s.start > target + 0.05);
                return next ? next.start : null;
              })()
              : null;

            // 使用跟读模式优化过的结束时间计算逻辑
            // 确保最后一个词能完整播放
            const text = String(currentSentence?.text || '');
            const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
            const segMode = getSegmentationMode();
            const baseEndTime = Number.isFinite(endTime) && endTime > startTime ? endTime : startTime + 3;

            // 计算下一句的开始时间
            const hasNext = Number.isFinite(nextSegStart);
            const gapToNext = hasNext ? (nextSegStart - baseEndTime) : Infinity;

            if (segMode === 'caption') {
              // Caption 模式：缓冲根据时长计算
              // 缓冲 = 时长的 15%，最少 0.3 秒，最多 0.6 秒
              const duration = baseEndTime - startTime;
              const dynamicBuffer = Math.min(0.6, Math.max(0.3, duration * 0.15));

              // 如果下一句紧接着（间隔 < 0.3 秒），允许进入下一句最多 0.4 秒
              // 确保最后一个词能完整播放
              if (gapToNext < 0.3) {
                endTime = Math.min(baseEndTime + dynamicBuffer, nextSegStart + 0.4);
              } else {
                // 有间隔的句子：播放到结束时间 + 缓冲，但不超过下一句开始
                const maxEnd = hasNext ? nextSegStart : baseEndTime + 1;
                endTime = Math.min(baseEndTime + dynamicBuffer, maxEnd);
              }
            } else {
              // 非 caption 模式：使用更大的缓冲
              const safetyGap = 0.05;
              const OVERLAP_TAIL_SEC = 0.22;
              const maxPossibleEnd = (hasNext && gapToNext <= safetyGap)
                ? (nextSegStart + OVERLAP_TAIL_SEC)
                : (hasNext ? nextSegStart - safetyGap : baseEndTime + 2);

              // 增加缓冲时间：基础 0.8 秒，长句子额外 0.3 秒
              const baseTail = 0.8;
              const extraTail = wordCount > 10 ? 0.3 : (wordCount > 6 ? 0.15 : 0);
              const desiredTarget = baseEndTime + baseTail + extraTail;
              endTime = Math.max(baseEndTime, Math.min(desiredTarget, maxPossibleEnd));
            }

            // 最大不超过 startTime + 12 秒
            endTime = Math.min(endTime, startTime + 12);
            const duration = Math.max(0.6, endTime - startTime);
            // Disable interference from monitoring loop
            state.bypassStudentGuard = true;

            // 播放原声片段 (with slight lead-in to prevent clipping)
            const seekTime = Math.max(0, startTime - 0.2);
            unifiedPlayer.setCurrentTime(seekTime);
            const playOk = await safePlayVideo({ preferUnmuted: true });
            if (!playOk) {
              console.error('[Dialogue] Video play failed: safePlayVideo returned false');
              state.bypassStudentGuard = false;
              dialoguePracticeState.isPlayingOriginalSample = false;
              playOriginalBtn.disabled = false;
              playOriginalBtn.textContent = originalBtnText;
              setupDialoguePlaybackMonitor(dialoguePracticeState.currentIndex);
              return;
            }

            // Ensure audio is on after play (some browsers ignore unmute before play)
            unifiedPlayer.unmute();
            if (unifiedPlayer.setVolume) unifiedPlayer.setVolume(1); // Force volume up

            // YouTube sometimes needs a nudge to exit buffering after seek.
            if (isYouTubeVideo && youtubePlayer) {
              const ensurePlaying = () => {
                const state = youtubePlayer.getPlayerState && youtubePlayer.getPlayerState();
                if (state !== 1 && state !== 3) {
                  youtubePlayer.seekTo(seekTime, true);
                  youtubePlayer.playVideo();
                }
              };
              setTimeout(ensurePlaying, 200);
              setTimeout(ensurePlaying, 600);
            }

            const stopPlayback = () => {
              unifiedPlayer.pause();
              unifiedPlayer.mute();
              if (isYouTubeVideo && youtubePlayer && typeof youtubePlayer.pauseVideo === 'function') {
                youtubePlayer.pauseVideo();
                setTimeout(() => {
                  try { youtubePlayer.pauseVideo(); } catch (_) { }
                }, 120);
              }
              state.bypassStudentGuard = false;
              dialoguePracticeState.originalPlaybackRafId = null;
              if (dialoguePracticeState.originalPlaybackTimeoutId) {
                clearTimeout(dialoguePracticeState.originalPlaybackTimeoutId);
                dialoguePracticeState.originalPlaybackTimeoutId = null;
              }
              dialoguePracticeState.isPlayingOriginalSample = false;
              playOriginalBtn.disabled = false;
              playOriginalBtn.textContent = originalBtnText;
            };

            // 在结束时暂停 - 使用 precise monitoring
            const monitorStartTime = Date.now();
            const checkEndTime = () => {
              const now = unifiedPlayer.getCurrentTime();
              const elapsedMs = Date.now() - monitorStartTime;
              // Buffer logic: Stop at exact end time (removing -0.1s cushion which cuts off words)
              // Industry standard: play full duration.
              if (now >= endTime || now - startTime >= duration + 0.2) {
                stopPlayback();
              } else {
                // Continue monitoring
                // Grace period: Don't stop for "paused" state in first 500ms (YouTube state may not update immediately)
                const isPaused = unifiedPlayer.isPaused();
                const inGracePeriod = elapsedMs < 500;
                if (!isPaused || inGracePeriod) {
                  dialoguePracticeState.originalPlaybackRafId = requestAnimationFrame(checkEndTime);
                } else {
                  // If paused manually after grace period, still ensure cleanup
                  stopPlayback();
                }
              }
            };

            // Start precise monitoring loop
            dialoguePracticeState.originalPlaybackRafId = requestAnimationFrame(checkEndTime);
            dialoguePracticeState.originalPlaybackTimeoutId = setTimeout(() => {
              stopPlayback();
            }, (duration + 0.6) * 1000);
          } else {
            console.warn('[Dialogue] Invalid sentence data for playback');
            dialoguePracticeState.isPlayingOriginalSample = false;
            playOriginalBtn.disabled = false;
            playOriginalBtn.textContent = originalBtnText;
          }
        };
      }

      // 满意，下一句 - 参考移动版的实现模式
      const nextSentenceBtn = document.getElementById('next-sentence-btn');
      if (nextSentenceBtn) {
        // 使用 onclick 替代 addEventListener，避免重复绑定
        nextSentenceBtn.onclick = function onNextSentenceClick(e) {
          if (debugMode) {
            console.log('[Dialogue] Next sentence click', {
              isTrusted: e.isTrusted,
              type: e.type,
              target: e.target?.id,
              timeStamp: e.timeStamp
            });
          }

          // 🛡️ 防抖保护：ASR显示后0.3秒内忽略点击，防止误触发
          const timeSinceDisplay = dialoguePracticeState.asrDisplayedAt
            ? Date.now() - dialoguePracticeState.asrDisplayedAt
            : Infinity;

          if (timeSinceDisplay < 300) {
            console.warn('[Dialogue] ⚠️ Click ignored - too soon after ASR display:', timeSinceDisplay, 'ms');
            console.warn('[Dialogue] This might be an accidental trigger. isTrusted:', e.isTrusted);
            e.preventDefault();
            e.stopPropagation();
            return false; // 忽略过早的点击
          }

          // 标记当前句子为已录制
          if (dialoguePracticeState.currentSentence) {
            markSentenceAsRecorded(dialoguePracticeState.currentSentence.index);
          }

          // 清除时间戳
          dialoguePracticeState.asrDisplayedAt = null;

          // 隐藏ASR区域
          const asrSection = document.getElementById('asr-comparison-section');
          if (asrSection) asrSection.style.display = 'none';

          // 继续到下一句
          continueToNextSentence();
        };
      }

      // 重录 - 参考移动版的实现模式
      const retryRecordingBtn = document.getElementById('retry-recording-btn');
      if (retryRecordingBtn) {
        retryRecordingBtn.onclick = function onRetryClick() {

          // 清除ASR时间戳
          dialoguePracticeState.asrDisplayedAt = null;

          // 隐藏ASR区域
          const asrSection = document.getElementById('asr-comparison-section');
          if (asrSection) asrSection.style.display = 'none';

          // 对话模式：重新录制当前句子
          if (currentPracticeMode === 'dialogue') {
            const currentSentence = dialoguePracticeState.currentSentence;

            if (currentSentence) {

              // 从已录制集合中移除当前句子（允许重录）
              dialoguePracticeState.recordedSentences.delete(currentSentence.index);

              // 延迟一点再开始录音
              setTimeout(() => {
                startDialogueRecording(currentSentence);
              }, 500);

              updatePracticeFeedback('🔄 准备重新录音...', '#f59e0b');
            } else {
              console.warn('[Dialogue] No current sentence to retry');
            }
          }
        };
      }

      // 取消练习 ✕ - 使用 onclick 避免重复绑定
      const asrCancelBtn = document.getElementById('asr-cancel-btn');
      if (asrCancelBtn) {
        asrCancelBtn.onclick = function onAsrCancelClick(e) {
          e.preventDefault();
          e.stopPropagation();
          cancelAsrPractice();
        };
      }

      // 完整回放按钮
      const fullPlaybackBtn = document.getElementById('full-playback-btn');
      if (fullPlaybackBtn) {
        fullPlaybackBtn.addEventListener('click', startFullPlayback);
      }

      // 停止回放按钮
      const stopPlaybackBtn = document.getElementById('stop-playback-btn');
      if (stopPlaybackBtn) {
        stopPlaybackBtn.addEventListener('click', stopFullPlayback);
      }

      // 导出报告按钮
      const exportReportBtn = document.getElementById('export-report-btn');
      if (exportReportBtn) {
        exportReportBtn.addEventListener('click', exportPracticeReport);
      }

      // 分享回放按钮
      const sharePlaybackBtn = document.getElementById('share-playback-btn');
      if (sharePlaybackBtn) {
        sharePlaybackBtn.addEventListener('click', createPracticeShareLink);
      }

      // 开始对话练习按钮
      const startDialogueBtn = document.getElementById('start-dialogue-btn');
      if (startDialogueBtn) {
        startDialogueBtn.addEventListener('click', startDialoguePractice);
      }
    });

    // ============================================================
    // 完整对话回放功能
    // ============================================================

    function notifyUser(message, type = 'info') {
      if (typeof showToast === 'function') {
        showToast(message, type);
        return;
      }
      if (typeof GlobalUI !== 'undefined' && typeof GlobalUI.showToast === 'function') {
        GlobalUI.showToast(message, type);
        return;
      }
      alert(message);
    }

    async function createPracticeShareLink() {
      if (isShareMode()) {
        return;
      }
      const token = refreshAuthToken();
      if (!token) {
        notifyUser('请先登录后再分享回放', 'warn');
        return;
      }
      if (!state.videoId) {
        notifyUser('请先加载练习视频', 'warn');
        return;
      }
      let speaker = dialoguePracticeState.selectedRole || state.selectedSpeaker;
      if (!speaker && Array.isArray(state.serverRecordings) && state.serverRecordings.length) {
        const counts = new Map();
        state.serverRecordings.forEach((rec) => {
          const name = rec?.speaker;
          if (!name) return;
          counts.set(name, (counts.get(name) || 0) + 1);
        });
        let best = null;
        let bestCount = 0;
        counts.forEach((count, name) => {
          if (count > bestCount) {
            bestCount = count;
            best = name;
          }
        });
        speaker = best;
      }
      if (!speaker) {
        notifyUser('请先录制至少一句再分享', 'warn');
        return;
      }
      const shareText = (() => {
        const title = state.videoData?.title ? `「${state.videoData.title}」` : '';
        return `对话回放${title} - ${speaker}`;
      })();
      try {
        const res = await fetch(`${API_BASE}/api/practice-shares`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            video_id: state.videoId,
            speaker,
            publish_to_community: true,
            text: shareText
          })
        });
        if (!res.ok) {
          const errMsg = res.status === 400 ? '该角色暂无录音，无法分享' : '分享失败，请稍后重试';
          notifyUser(errMsg, 'error');
          return;
        }
        const data = await res.json();
        const shareUrl = data?.share_url;
        if (!shareUrl) {
          notifyUser('分享链接生成失败', 'error');
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(shareUrl);
          notifyUser('已发布到广场，链接已复制', 'success');
        } else {
          prompt('复制分享链接', shareUrl);
        }
      } catch (err) {
        console.warn('[Share] Failed to create share link:', err);
        notifyUser('分享失败，请稍后重试', 'error');
      }
    }

    /**
     * 回放状态管理
     */
    const playbackState = {
      isPlaying: false,
      currentIndex: 0,
      recordingsMap: new Map(), // 存储用户录音 Map<sentenceIndex, Blob>
      timeoutId: null
    };

    /**
     * 保存用户录音到回放映射
     */
    function saveRecordingForPlayback(sentenceIndex, audioBlob) {
      playbackState.recordingsMap.set(sentenceIndex, audioBlob);
    }

    /**
     * 开始完整对话回放
     */
    async function startFullPlayback() {
      if (playbackState.isPlaying) {
        return;
      }

      playbackState.isPlaying = true;
      playbackState.currentIndex = 0;

      // 显示停止按钮
      const startBtn = document.getElementById('full-playback-btn');
      const stopBtn = document.getElementById('stop-playback-btn');
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'inline-flex';

      await playNextSentence();
    }

    /**
     * 停止回放
     */
    function stopFullPlayback() {
      playbackState.isPlaying = false;

      if (playbackState.timeoutId) {
        clearTimeout(playbackState.timeoutId);
        playbackState.timeoutId = null;
      }

      // 停止当前播放
      if (unifiedPlayer) {
        unifiedPlayer.pause();
      }

      // 显示开始按钮
      const startBtn = document.getElementById('full-playback-btn');
      const stopBtn = document.getElementById('stop-playback-btn');
      if (startBtn) startBtn.style.display = 'inline-flex';
      if (stopBtn) stopBtn.style.display = 'none';

      updatePracticeFeedback('回放已停止', '#64748b');
    }

    /**
     * 播放下一句
     */
    async function playNextSentence() {
      if (!playbackState.isPlaying) return;

      const sentences = dialoguePracticeState.sentences;
      if (playbackState.currentIndex >= sentences.length) {
        // 回放完成
        stopFullPlayback();
        updatePracticeFeedback('✅ 回放完成！', '#16a34a');
        return;
      }

      const sentence = sentences[playbackState.currentIndex];
      const isUserRole = !!sentence.isUserRole;

      updatePracticeFeedback(`🎬 回放中 (${playbackState.currentIndex + 1}/${sentences.length}): ${sentence.speaker}`, '#2dd4bf');

      // 高亮当前句子状态点
      highlightCurrentSentence(playbackState.currentIndex);

      if (isUserRole && playbackState.recordingsMap.has(playbackState.currentIndex)) {
        // 播放用户录音
        const audioBlob = playbackState.recordingsMap.get(playbackState.currentIndex);
        await playUserRecording(audioBlob);
      } else {
        // 播放原声
        await playOriginalAudio(sentence);
      }

      // 下一句：间隔跟随原对话节奏 —— 原句间紧贴时只留 150ms，有自然停顿时最多 800ms
      const nextSentence = sentences[playbackState.currentIndex + 1];
      let interGap = 800;
      if (nextSentence && Number.isFinite(sentence.end) && Number.isFinite(nextSentence.start)) {
        const realGapMs = (nextSentence.start - sentence.end) * 1000;
        interGap = Math.min(800, Math.max(150, realGapMs));
      }
      playbackState.currentIndex++;
      playbackState.timeoutId = setTimeout(() => playNextSentence(), interGap);
    }

    /**
     * 播放用户录音
     */
    function playUserRecording(audioBlob) {
      return new Promise((resolve) => {
        const audio = new Audio(URL.createObjectURL(audioBlob));
        audio.onended = () => {
          URL.revokeObjectURL(audio.src);
          resolve();
        };
        audio.onerror = () => {
          console.error('[Playback] Error playing user recording');
          resolve();
        };
        audio.play().catch(err => {
          console.error('[Playback] Play error:', err);
          resolve();
        });
      });
    }

    /**
     * 播放原声片段
     */
    function playOriginalAudio(sentence) {
      return replayOriginalSentence(sentence).then(() => {
        setTimeout(() => { captureOriginalWaveformSnapshot(); }, 200);
      });
    }

    /**
     * 高亮当前句子
     */
    function highlightCurrentSentence(index) {
      const dots = document.querySelectorAll('.sentence-status-dot');
      dots.forEach((dot, i) => {
        if (i === index) {
          dot.style.transform = 'scale(1.3)';
          dot.style.boxShadow = '0 0 0 4px rgba(139, 92, 246, 0.3)';
        } else {
          dot.style.transform = 'scale(1)';
          dot.style.boxShadow = 'none';
        }
      });
    }

    // ============================================================
    // 导出练习报告功能
    // ============================================================

    /**
     * 生成练习报告数据
     */
    function generatePracticeReport() {
      const sentences = dialoguePracticeState.sentences;
      const selectedRole = dialoguePracticeState.selectedRole;
      const recordedSentences = Array.from(dialoguePracticeState.recordedSentences);
      const totalSentences = sentences.filter(s => s.speaker === selectedRole).length;
      const completedSentences = recordedSentences.length;
      const completionRate = totalSentences > 0 ? ((completedSentences / totalSentences) * 100).toFixed(1) : 0;

      // 统计准确度（如果有记录）
      const accuracies = [];
      for (const [index, blob] of playbackState.recordingsMap) {
        // Note: 准确度数据需要从之前的ASR调用中获取
        // 这里简化处理，实际应该存储每句的准确度
      }

      const report = {
        metadata: {
          exportTime: new Date().toISOString(),
          exportDate: new Date().toLocaleString('zh-CN'),
          videoTitle: state.videoTitle || '未知视频',
          practiceMode: '对话练习',
          selectedRole: selectedRole
        },
        statistics: {
          totalSentences,
          completedSentences,
          completionRate: `${completionRate}%`,
          recordingCount: playbackState.recordingsMap.size
        },
        sentences: []
      };

      // 添加句子详情
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        if (sentence.speaker === selectedRole) {
          report.sentences.push({
            index: i + 1,
            text: sentence.text,
            speaker: sentence.speaker,
            recorded: recordedSentences.includes(i) ? '✓' : '✗',
            timeRange: `${sentence.start?.toFixed(2)}s - ${sentence.end?.toFixed(2)}s`
          });
        }
      }

      return report;
    }

    /**
     * 导出为HTML格式
     */
    function exportAsHTML(report) {
      const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>对话练习报告 - ${report.metadata.selectedRole}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      background: #f8fafc;
    }
    .report-header {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    .report-header h1 {
      margin: 0 0 10px;
      font-size: 28px;
    }
    .report-header p {
      margin: 5px 0;
      opacity: 0.9;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .stat-card h3 {
      margin: 0 0 10px;
      color: #64748b;
      font-size: 14px;
      font-weight: 600;
    }
    .stat-card .value {
      font-size: 32px;
      font-weight: 700;
      color: #1e293b;
    }
    .sentences-table {
      background: white;
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .sentences-table h2 {
      margin: 0 0 20px;
      font-size: 20px;
      color: #1e293b;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #f1f5f9;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #475569;
      border-bottom: 2px solid #e2e8f0;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
      color: #334155;
    }
    tr:hover {
      background: #f8fafc;
    }
    .recorded-yes {
      color: #16a34a;
      font-weight: 700;
    }
    .recorded-no {
      color: #dc2626;
    }
    @media print {
      body {
        background: white;
      }
    }
  </style>
</head>
<body>
  <div class="report-header">
    <h1>📊 对话练习报告</h1>
    <p>🎭 角色：${report.metadata.selectedRole}</p>
    <p>🎬 视频：${report.metadata.videoTitle}</p>
    <p>📅 导出时间：${report.metadata.exportDate}</p>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <h3>总句数</h3>
      <div class="value">${report.statistics.totalSentences}</div>
    </div>
    <div class="stat-card">
      <h3>已录制</h3>
      <div class="value">${report.statistics.completedSentences}</div>
    </div>
    <div class="stat-card">
      <h3>完成率</h3>
      <div class="value">${report.statistics.completionRate}</div>
    </div>
  </div>

  <div class="sentences-table">
    <h2>句子详情</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>台词内容</th>
          <th>时间范围</th>
          <th>录制状态</th>
        </tr>
      </thead>
      <tbody>
        ${report.sentences.map(s => `
          <tr>
            <td>${s.index}</td>
            <td>${s.text}</td>
            <td>${s.timeRange}</td>
            <td class="${s.recorded === '✓' ? 'recorded-yes' : 'recorded-no'}">${s.recorded}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>
      `;

      return html;
    }

    /**
     * 导出练习报告
     */
    function exportPracticeReport() {
      try {
        const report = generatePracticeReport();

        // 生成HTML报告
        const htmlContent = exportAsHTML(report);

        // 创建Blob并下载
        const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dialogue-practice-report-${Date.now()}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        updatePracticeFeedback('✅ 报告已导出', '#16a34a');
      } catch (error) {
        console.error('[Export] Failed to export report:', error);
        updatePracticeFeedback('❌ 导出失败', '#dc2626');
      }
    }

    // ============================================================
    // 键盘快捷键支持
    // ============================================================

    /**
     * 全局键盘快捷键处理
     */
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      // 如果用户正在输入框中打字，忽略快捷键
      if (e.target.closest?.('.topbar') || e.target.tagName === 'SUMMARY' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable || e.target.getAttribute?.('role') === 'slider') {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        handlePracticeFocusEscape();
        return;
      }
      if (key === ' ' || key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        if (e.repeat) return;
        if (key === ' ' && e.shiftKey && currentPracticeMode === 'dialogue') {
          const recordBtn = document.getElementById('record-btn');
          if (recordBtn && !recordBtn.disabled) recordBtn.click();
        } else if (key === ' ') {
          togglePracticePlayback();
        } else if (!state.isRecording) {
          if (key === 'arrowleft') handleFocusPrevSentence();
          else handleFocusNextSentence();
        }
        return;
      }

      // 只在对话模式下启用快捷键
      if (currentPracticeMode !== 'dialogue') {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'r': // R键：重录
          e.preventDefault();
          // 🛡️ 只有在非录音状态且按钮容器可见时才触发
          if (state.isRecording) {
            break;
          }
          const retryBtn = document.getElementById('retry-recording-btn');
          const asrSection2 = document.getElementById('asr-comparison-section');
          const asrActions3 = document.querySelector('.asr-actions');
          if (retryBtn && asrSection2 && asrSection2.style.display !== 'none'
            && asrActions3 && asrActions3.style.display !== 'none') {
            retryBtn.click();
          }
          break;

        case 'p': // P键：播放我的录音
          e.preventDefault();
          // 🛡️ 只有在非录音状态且按钮容器可见时才触发
          if (state.isRecording) {
            break;
          }
          const playMyBtn = document.getElementById('play-my-recording-btn');
          const asrSection4 = document.getElementById('asr-comparison-section');
          const asrActions4 = document.querySelector('.asr-actions');
          if (playMyBtn && asrSection4 && asrSection4.style.display !== 'none'
            && asrActions4 && asrActions4.style.display !== 'none') {
            playMyBtn.click();
          }
          break;

        case 'o': // O键：播放原声
          e.preventDefault();
          // 🛡️ 只有在非录音状态且按钮容器可见时才触发
          if (state.isRecording) {
            break;
          }
          const playOrigBtn = document.getElementById('play-original-btn');
          const asrSection5 = document.getElementById('asr-comparison-section');
          const asrActions5 = document.querySelector('.asr-actions');
          if (playOrigBtn && asrSection5 && asrSection5.style.display !== 'none'
            && asrActions5 && asrActions5.style.display !== 'none') {
            playOrigBtn.click();
          }
          break;

      }
    }, true);

    // 显示快捷键提示
    function showKeyboardShortcutsHint() {
      const hint = `
        ⌨️ 键盘快捷键：
        空格 - 播放/暂停
        ← / → - 上一句/下一句
        Shift+空格 - 开始/停止录音（对话模式）
        R - 重录
        P - 播放我的录音
        O - 播放原声
        Esc - 关闭面板
      `;
    }

    // 在speakers加载完成后生成角色按钮
    window.addEventListener('load', () => {
      // 延迟一点确保state.speakers已经加载
      setTimeout(() => {
        if (state.speakers && state.speakers.length > 0) {
          generateRoleButtons();
        }
        // 显示快捷键提示
        showKeyboardShortcutsHint();
      }, 1000);
    });

  
