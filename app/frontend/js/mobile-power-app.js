/**
 * Mobile Power App - Enhanced Vocabulary Learning with Scientific Methods
 *
 * Features:
 * - Active Recall with Flashcard flipping
 * - 4-level Spaced Repetition feedback (Again, Hard, Good, Easy)
 * - Daily learning progress tracking
 * - Achievement system
 * - Context highlighting
 * - Audio support
 *
 * @version 2.0
 * @date 2025-02-09
 */

(function () {
  'use strict';

  const API_BASE = (() => {
    if (typeof window !== 'undefined') {
      if (window.API_BASE) return window.API_BASE;
      if (window.API_PREFIX) return window.API_PREFIX;
    }
    if (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.port === '4000') {
      return 'http://localhost:4000';
    }
    return '';
  })();

  function persistTokenCache(token) {
    if (!token) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('linglish_token', token);
        localStorage.setItem('authToken', token);
      }
    } catch (_) { }
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('linglish_token', token);
        sessionStorage.setItem('authToken', token);
      }
    } catch (_) { }
  }

  function resolveExistingToken() {
    const returnWithCache = (t) => {
      if (!t) return null;
      persistTokenCache(t);
      return t;
    };

    try {
      if (typeof localStorage !== 'undefined') {
        const t = localStorage.getItem('linglish_token') || localStorage.getItem('authToken');
        if (t) return returnWithCache(t);
      }
    } catch (_) { }

    try {
      if (typeof sessionStorage !== 'undefined') {
        const t = sessionStorage.getItem('linglish_token') || sessionStorage.getItem('authToken');
        if (t) return returnWithCache(t);
      }
    } catch (_) { }

    try {
      const am = (typeof window !== 'undefined' && window.authManager) ? window.authManager : null;
      if (am && typeof am.getUserInfo === 'function') {
        const info = am.getUserInfo();
        if (info && info.token) return returnWithCache(info.token);
      }
      if (am && typeof am.getToken === 'function') {
        const t = am.getToken();
        if (t) return returnWithCache(t);
      }
    } catch (_) { }

    try {
      if (typeof window !== 'undefined' && window.AuthManager && typeof window.AuthManager.getToken === 'function') {
        const t = window.AuthManager.getToken();
        if (t) return returnWithCache(t);
      }
    } catch (_) { }

    try {
      if (typeof document !== 'undefined') {
        const match = document.cookie.match(/(?:^|;\s*)(linglish_token|authToken)=([^;]+)/);
        if (match && match[2]) {
          return returnWithCache(decodeURIComponent(match[2]));
        }
      }
    } catch (_) { }

    return null;
  }

  // ===== Audio Manager =====
  class AudioManager {
    constructor() {
      this.audioCache = new Map();
      this.currentPlayer = null;
      this.lastSpeakTime = 0;
      this.lastSpeakText = '';
    }

    async speak(text, token) {
      if (!text) return;

      // Debounce: ignore rapid clicks (within 500ms) for the same text
      const now = Date.now();
      if (this.lastSpeakText === text && now - this.lastSpeakTime < 500) {
        return;
      }
      this.lastSpeakTime = now;
      this.lastSpeakText = text;

      // Stop current audio
      this.stop();

      // Start a fallback timer for speechSynthesis (preserves user gesture context)
      // This ensures audio plays even if TTS API fails or audio playback is blocked
      let fallbackTimer = null;
      let played = false;
      const armFallback = () => {
        fallbackTimer = setTimeout(() => {
          if (!played) {
            played = true;
            this.speakWithSynthesis(text);
          }
        }, 800); // Give TTS audio 800ms to start playing
      };
      const clearFallback = () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
      };

      armFallback();

      // Check cache
      const selectedVoice = window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural';
      let audioUrl = this.audioCache.get(selectedVoice + '\n' + text);
      if (audioUrl) {
        try {
          await this.playAudio(audioUrl);
          played = true;
          clearFallback();
          return;
        } catch (e) {
          // Continue to generate new TTS
        }
      }

      // Generate TTS
      try {
        const voiceLang = 'en';

        const res = await fetch(`${API_BASE}/tts/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            text: text,
            lang: voiceLang,
            provider: 'edge',
            voice: selectedVoice
          })
        });

        if (res.ok) {
          const data = await res.json();
          if (data.audioUrl) {
            this.audioCache.set(selectedVoice + '\n' + text, data.audioUrl);
            try {
              await this.playAudio(data.audioUrl);
              played = true;
              clearFallback();
              return;
            } catch (e) {
              // Audio playback failed, let fallback handle it
            }
          }
        }

        // If we reach here and haven't played, fallback timer will trigger speechSynthesis
      } catch (err) {
        console.error('[AudioManager] TTS error:', err);
        // Fallback timer will trigger speechSynthesis
      }
    }

    playAudio(url) {
      return new Promise((resolve, reject) => {
        const audio = new Audio(url);
        this.currentPlayer = audio;

        audio.play().then(() => {
          resolve();
        }).catch(err => {
          console.warn('[AudioManager] Play failed:', err);
          this.currentPlayer = null;
          reject(err);
        });

        audio.addEventListener('ended', () => {
          this.currentPlayer = null;
          resolve();
        });
      });
    }

    speakWithSynthesis(text) {
      if ('speechSynthesis' in window) {
        try {
          const utterance = new SpeechSynthesisUtterance(text);
          const tts = window.LinglishTtsVoice;
          if (tts && typeof tts.synthesisLang === 'function') {
            utterance.lang = tts.synthesisLang();
            const systemVoice = typeof tts.findSystemVoice === 'function'
              ? tts.findSystemVoice(window.speechSynthesis.getVoices())
              : null;
            if (systemVoice) utterance.voice = systemVoice;
          } else {
            utterance.lang = 'en-US';
          }
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        } catch (e) {
          console.error('[AudioManager] speakWithSynthesis error:', e);
        }
      }
    }

    stop() {
      if (this.currentPlayer) {
        try {
          this.currentPlayer.pause();
          this.currentPlayer.currentTime = 0;
          this.currentPlayer = null;
        } catch (_) { }
      }

      try {
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      } catch (_) { }
    }
  }

  // ===== Progress Tracker =====
  class ProgressTracker {
    constructor() {
      this.storageKey = 'power_daily_progress';
      this.streakKey = 'power_learning_streak';
      this.loadProgress();
    }

    loadProgress() {
      const today = this.getToday();
      try {
        const stored = localStorage.getItem(this.storageKey);
        const data = stored ? JSON.parse(stored) : {};

        if (data.date !== today) {
          // New day, reset progress
          this.progress = {
            date: today,
            new: 0,
            review: 0,
            time: 0,
            startTime: Date.now()
          };
          this.saveProgress();
        } else {
          this.progress = data;
        }
      } catch (_) {
        this.progress = {
          date: today,
          new: 0,
          review: 0,
          time: 0,
          startTime: Date.now()
        };
      }

      // Load streak
      try {
        const streakData = localStorage.getItem(this.streakKey);
        this.streak = streakData ? JSON.parse(streakData) : { days: 0, lastDate: null };
        this.updateStreak();
      } catch (_) {
        this.streak = { days: 0, lastDate: null };
      }
    }

    getToday() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    saveProgress() {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.progress));
      } catch (_) { }
    }

    updateStreak() {
      const today = this.getToday();
      if (this.streak.lastDate === today) {
        return; // Already updated today
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      if (this.streak.lastDate === yesterdayStr) {
        // Continuing streak
        this.streak.days++;
      } else if (this.streak.lastDate === null || this.streak.days === 0) {
        // Starting new streak
        this.streak.days = 1;
      } else {
        // Streak broken
        this.streak.days = 1;
      }

      this.streak.lastDate = today;
      try {
        localStorage.setItem(this.streakKey, JSON.stringify(this.streak));
      } catch (_) { }
    }

    recordNew() {
      this.progress.new++;
      this.saveProgress();
      this.updateUI();
    }

    recordReview() {
      this.progress.review++;
      this.saveProgress();
      this.updateUI();
    }

    updateTime() {
      const elapsed = Math.floor((Date.now() - this.progress.startTime) / 60000);
      this.progress.time = elapsed;
      this.saveProgress();
      this.updateUI();
    }

    updateUI() {
      const newEl = document.getElementById('today-new');
      const reviewEl = document.getElementById('today-review');
      const timeEl = document.getElementById('today-time');
      const streakEl = document.getElementById('streak-days');
      const progressBar = document.querySelector('.progress-bar-fill');
      const progressText = document.getElementById('progress-text');

      if (newEl) newEl.textContent = this.progress.new;
      if (reviewEl) reviewEl.textContent = this.progress.review;
      if (timeEl) timeEl.textContent = this.progress.time;
      if (streakEl) streakEl.textContent = this.streak.days;

      // Update progress bar (daily goal: 20 words)
      const dailyGoal = 20;
      const total = this.progress.new + this.progress.review;
      const percentage = Math.min((total / dailyGoal) * 100, 100);

      if (progressBar) {
        progressBar.style.width = `${percentage}%`;
      }
      if (progressText) {
        progressText.textContent = `${total}/${dailyGoal} 今日目标`;
      }
    }
  }

  // ===== Review Manager with Flashcard and 4-level Feedback =====
  class ReviewManager {
    constructor(app) {
      this.app = app;
      this.currentReview = null;
      this.reviewQueue = [];
      this.currentIndex = 0;
      this.isFlipped = false;
      this.consecutiveCorrect = 0;
      this.isStarting = false;
      this.hasReviewQueue = null; // null: unknown, false: empty, true: has items
      this.overlayVisible = false;

      this.initElements();
      this.bindEvents();
    }

    initElements() {
      this.overlay = document.getElementById('review-overlay');
      this.flashcard = document.getElementById('flashcard');
      this.wordFrontEl = document.getElementById('review-word-front');
      this.wordBackEl = document.getElementById('review-word-back');
      this.phoneticEl = document.getElementById('review-phonetic');
      this.translationEl = document.getElementById('review-translation');
      this.definitionsEl = document.getElementById('review-definitions');
      this.contextPreviewEl = document.getElementById('context-sentence-preview');
      this.contextEl = document.getElementById('context-sentence');
      this.progressFillEl = document.getElementById('review-progress-fill');
      this.progressTextEl = document.getElementById('review-progress-text');
      this.showAnswerBtn = document.getElementById('show-answer-btn');
      this.qualityButtonsEl = document.getElementById('review-quality-buttons');
      this.speakFrontBtn = document.getElementById('review-speak-front');
      this.speakBackBtn = document.getElementById('review-speak-back');
      this.closeBtn = document.getElementById('review-close');
      this.achievementToast = document.getElementById('achievement-toast');
      this.achievementText = document.getElementById('achievement-text');

      // Debug: check if elements are found
      console.log('[ReviewManager] DOM elements initialized:', {
        overlay: !!this.overlay,
        flashcard: !!this.flashcard,
        wordFrontEl: !!this.wordFrontEl,
        wordBackEl: !!this.wordBackEl,
        phoneticEl: !!this.phoneticEl,
        translationEl: !!this.translationEl,
        definitionsEl: !!this.definitionsEl,
        contextPreviewEl: !!this.contextPreviewEl,
        contextEl: !!this.contextEl,
        showAnswerBtn: !!this.showAnswerBtn,
        qualityButtonsEl: !!this.qualityButtonsEl
      });
    }

    bindEvents() {
      if (this.showAnswerBtn) {
        this.showAnswerBtn.addEventListener('click', () => {
          if (!this.currentReview || !this.currentReview.lemma) {
            if (this.hasReviewQueue === false) {
              this.app.switchTab('full');
              this.app.showToast('暂无待复习词汇，先浏览全部词汇', 'info');
              return;
            }
            // Lazy-load queue on first interaction
            this.start();
            return;
          }
          this.flipCard();
        });
      }

      if (this.flashcard) {
        this.flashcard.addEventListener('click', () => {
          if (!this.currentReview || !this.currentReview.lemma) {
            if (this.hasReviewQueue === false) {
              this.app.switchTab('full');
              this.app.showToast('暂无待复习词汇，先浏览全部词汇', 'info');
              return;
            }
            // If user taps card before queue loads, auto-start review
            this.start();
            return;
          }
          if (!this.isFlipped) {
            this.flipCard();
          }
        });
      }

      if (this.speakFrontBtn) {
        this.speakFrontBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.currentReview && this.currentReview.lemma) {
            this.app.audioManager.speak(this.currentReview.lemma, this.app.token);
          }
        });
      }

      if (this.speakBackBtn) {
        this.speakBackBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.currentReview && this.currentReview.lemma) {
            this.app.audioManager.speak(this.currentReview.lemma, this.app.token);
          }
        });
      }

      if (this.closeBtn) {
        this.closeBtn.addEventListener('click', () => this.close({ toTab: 'my', toast: '已退出复习，返回词汇表' }));
      }

      // Quality buttons
      const qualityBtns = document.querySelectorAll('.quality-btn');
      qualityBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const quality = btn.getAttribute('data-quality');
          this.submitReview(quality);
        });
      });

      // Review dictionary language toggle buttons
      const reviewLangZh = document.getElementById('review-lang-zh');
      const reviewLangEn = document.getElementById('review-lang-en');
      if (reviewLangZh && reviewLangEn) {
        reviewLangZh.addEventListener('click', () => {
          this.setReviewDictLang('zh');
          this.refreshReviewDictDisplay();
        });
        reviewLangEn.addEventListener('click', () => {
          this.setReviewDictLang('en');
          this.refreshReviewDictDisplay();
        });
      }
    }

    getReviewDictLang() {
      try {
        return localStorage.getItem('dict_lang_mode') || localStorage.getItem('linglish_dict_lang') || 'en';
      } catch (_) {
        return 'en';
      }
    }

    setReviewDictLang(lang) {
      const mode = lang === 'zh' ? 'zh' : 'en';
      try {
        localStorage.setItem('dict_lang_mode', mode);
        // Backward compat
        localStorage.setItem('linglish_dict_lang', mode);
      } catch (_) { }
      // Keep existing review buttons visual behavior (these buttons are inline-styled in HTML)
      const reviewLangZh = document.getElementById('review-lang-zh');
      const reviewLangEn = document.getElementById('review-lang-en');
      if (reviewLangZh && reviewLangEn) {
        if (mode === 'zh') {
          reviewLangZh.style.background = '#0f766e';
          reviewLangZh.style.color = 'white';
          reviewLangEn.style.background = 'white';
          reviewLangEn.style.color = '#64748b';
        } else {
          reviewLangZh.style.background = 'white';
          reviewLangZh.style.color = '#64748b';
          reviewLangEn.style.background = '#0f766e';
          reviewLangEn.style.color = 'white';
        }
      }
    }

    refreshReviewDictDisplay() {
      // Re-render the dictionary with current language setting
      if (this.currentReview && this.currentReview.lemma) {
        this.loadDictionary(this.currentReview.lemma);
      }
    }

    async start() {
      if (this.isStarting) return;
      this.isStarting = true;
      try {
        if (this.hasReviewQueue === false) {
          this.close({ toTab: 'full', toast: '暂无待复习词汇，已为你展示全部词汇' });
          return;
        }

        const hardFirstMode = this.app.hardFirstMode;
        const url = `${API_BASE}/vocab/review-queue?limit=10${hardFirstMode ? '&hard=1' : ''}`;

        console.log('[ReviewManager] Fetching review queue:', url);

        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.app.token}` }
        });

        if (!res.ok) throw new Error('Failed to fetch review queue');

        const data = await res.json();
        console.log('[ReviewManager] Received data:', data);
        console.log('[ReviewManager] Data structure check:', {
          hasItems: !!data.items,
          isArray: Array.isArray(data.items),
          itemCount: data.items?.length || 0,
          firstItem: data.items?.[0]
        });

        // Normalize data structure (API may return 'word' instead of 'lemma')
        const rawItems = Array.isArray(data.items) ? data.items : [];
        this.reviewQueue = rawItems
          .map(item => {
            const normalized = {
              ...item,
              lemma: item.lemma || item.word,
              definitions: item.definitions || {},
              phonetic: item.phonetic || item.ipa || '',
              state: item.state || item.status || 'learning'
            };
            console.log('[ReviewManager] Normalizing item:', { original: item, normalized });
            return normalized;
          })
          .filter(item => {
            // Filter out items without a valid lemma
            const isValid = item.lemma && item.lemma.trim().length > 0;
            if (!isValid) {
              console.warn('[ReviewManager] Skipping invalid item without lemma:', item);
            }
            return isValid;
          });

        console.log('[ReviewManager] Normalized and filtered queue:', this.reviewQueue);

        if (this.reviewQueue.length === 0) {
          this.hasReviewQueue = false;
          this.close({ toTab: 'full', toast: '暂无待复习词汇，已为你展示全部词汇' });
          return;
        }
        this.hasReviewQueue = true;

        this.currentIndex = 0;
        this.consecutiveCorrect = 0;
        await this.showNext();
      } catch (err) {
        console.error('[ReviewManager] Start failed:', err);
        this.app.showToast('加载复习队列失败', 'warn');
      } finally {
        this.isStarting = false;
      }
    }

    async showNext() {
      console.log('[ReviewManager] showNext called, index:', this.currentIndex, 'queue length:', this.reviewQueue.length);

      if (this.currentIndex >= this.reviewQueue.length) {
        this.finish();
        return;
      }

      this.currentReview = this.reviewQueue[this.currentIndex];
      console.log('[ReviewManager] Current review item:', this.currentReview);

      if (!this.currentReview || !this.currentReview.lemma) {
        console.error('[ReviewManager] Invalid review item, skipping');
        this.currentIndex++;
        await this.showNext();
        return;
      }

      // Ensure overlay is visible when we actually have a card
      if (this.overlay) {
        this.overlay.hidden = false;
        this.overlay.style.display = 'flex';
        this.overlayVisible = true;
        document.body.classList.add('modal-open');
      }

      this.isFlipped = false;
      if (this.flashcard) {
        this.flashcard.classList.remove('flipped');
      }
      if (this.qualityButtonsEl) {
        this.qualityButtonsEl.style.display = 'none';
      }
      if (this.showAnswerBtn) {
        this.showAnswerBtn.style.display = 'flex';
      }

      // Update progress
      this.updateProgress();

      // Render front (question)
      this.renderFront();

      // Show overlay
      if (this.overlay) {
        this.overlay.hidden = false;
        this.overlay.style.display = 'flex';
        this.overlayVisible = true;
        document.body.classList.add('modal-open');
      }

      // Load additional data
      await this.loadReviewData();
    }

    renderFront() {
      console.log('[ReviewManager] Rendering front for:', this.currentReview);

      if (this.wordFrontEl) {
        this.wordFrontEl.textContent = this.currentReview.lemma || 'Unknown';
      }
      if (this.phoneticEl) {
        this.phoneticEl.textContent = this.currentReview.phonetic || '';
      }
      if (this.contextPreviewEl) {
        this.contextPreviewEl.textContent = '加载中...';
      }

      console.log('[ReviewManager] Front rendered:', {
        word: this.wordFrontEl?.textContent,
        phonetic: this.phoneticEl?.textContent
      });
    }

    async loadReviewData() {
      try {
        console.log('[ReviewManager] Loading review data for:', this.currentReview.lemma);

        // Fetch vocabulary detail
        const res = await fetch(`${API_BASE}/vocab/item?lemma=${encodeURIComponent(this.currentReview.lemma)}`, {
          headers: { 'Authorization': `Bearer ${this.app.token}` }
        });

        if (!res.ok) {
          console.warn('[ReviewManager] Failed to load detail, status:', res.status);
          throw new Error('Failed to load detail');
        }

        const data = await res.json();
        console.log('[ReviewManager] Loaded detail data:', data);

        const contexts = Array.isArray(data.contexts) ? data.contexts : [];

        // Update context preview (front)
        if (this.contextPreviewEl) {
          if (contexts.length > 0) {
            const ctx = contexts[0];
            const sentence = ctx.sentence || '';
            this.contextPreviewEl.textContent = this.highlightWord(sentence, this.currentReview.lemma);
          } else {
            this.contextPreviewEl.textContent = '暂无例句';
          }
        }

        // Prepare back side
        if (this.wordBackEl) {
          this.wordBackEl.textContent = this.currentReview.lemma;
        }

        const translation = data.item?.definitions?.zh || this.currentReview.definitions?.zh || '';
        if (this.translationEl) {
          this.translationEl.textContent = translation || '暂无翻译';
        }

        // Load dictionary definitions
        await this.loadDictionary(this.currentReview.lemma);

        // Update full context (back)
        if (this.contextEl) {
          if (contexts.length > 0) {
            const ctx = contexts[0];
            const sentence = ctx.sentence || '';
            this.contextEl.innerHTML = this.highlightWord(sentence, this.currentReview.lemma, true);
          } else {
            this.contextEl.textContent = '暂无例句';
          }
        }

        console.log('[ReviewManager] Review data loaded successfully');
      } catch (err) {
        console.error('[ReviewManager] Load data failed:', err);

        // Set fallback values
        if (this.contextPreviewEl) {
          this.contextPreviewEl.textContent = '暂无例句';
        }
        if (this.wordBackEl) {
          this.wordBackEl.textContent = this.currentReview.lemma;
        }
        if (this.translationEl) {
          const translation = this.currentReview.definitions?.zh || '';
          this.translationEl.textContent = translation || '暂无翻译';
        }
      }
    }

    async loadDictionary(word) {
      try {
        console.log('[ReviewManager] Loading dictionary for:', word);

        const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, {
          headers: { 'Authorization': `Bearer ${this.app.token}` }
        });

        if (!res.ok) {
          console.warn('[ReviewManager] Dictionary fetch failed, status:', res.status);
          return;
        }

        const data = await res.json();
        const entry = data.entry;

        if (entry && entry.meanings && this.definitionsEl) {
          const dictLang = this.getReviewDictLang();

          // Use DictionaryRender if available for better UI with translate buttons
          if (window.DictionaryRender) {
            const zh = this.currentReview?.definitions?.zh || '';
            const html = window.DictionaryRender.build(word, entry, zh, {
              speak: false, // We have our own speak buttons
              langMode: dictLang
            });
            this.definitionsEl.innerHTML = html;

            // Attach translate button handlers
            this.attachReviewTranslateHandlers(word);

            // Attach speak button handlers
            this.definitionsEl.querySelectorAll('.dict-def-speak').forEach(btn => {
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = btn.getAttribute('data-text') || word;
                this.speak(text);
              });
            });

            const mainSpeakBtn = this.definitionsEl.querySelector('.dict-speak-btn');
            if (mainSpeakBtn) {
              mainSpeakBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.speak(word);
              });
            }
          } else {
            // Fallback to simple rendering
            const showZh = !dictLang || dictLang === 'zh';
            const defsHtml = entry.meanings.slice(0, 2).map(meaning => {
              const defs = (meaning.definitions || []).slice(0, 2).map(def => {
                const enDef = `<div>${def.definition || ''}</div>`;
                const zhDef = (showZh && def.zh && def.zh.trim() && def.zh !== '[待翻译]')
                  ? `<div style="color:#64748b;margin-top:0.2rem;">${def.zh}</div>`
                  : '';
                return `<li>${enDef}${zhDef}</li>`;
              }).join('');
              return `<div><strong>${meaning.partOfSpeech || ''}</strong><ul>${defs}</ul></div>`;
            }).join('');
            this.definitionsEl.innerHTML = defsHtml || '暂无详细释义';
          }

          // Initialize language toggle buttons on first load
          const currentLang = this.getReviewDictLang();
          this.setReviewDictLang(currentLang);

          console.log('[ReviewManager] Dictionary loaded with lang:', dictLang);

          // Check if translations are pending and start polling
          const htmlContent = this.definitionsEl.innerHTML;
          const hasTranslating = htmlContent.includes('翻译中');
          if (hasTranslating) {
            console.log('[ReviewManager] Translation in progress, starting polling for', word);
            this.startReviewTranslationPolling(word);
          }
        }
      } catch (err) {
        console.error('[ReviewManager] Dictionary load error:', err);
        if (this.definitionsEl) {
          this.definitionsEl.textContent = '';
        }
      }
    }

    attachReviewTranslateHandlers(word) {
      if (!this.definitionsEl) return;

      const translateButtons = this.definitionsEl.querySelectorAll('.dict-translate-btn');
      translateButtons.forEach(btn => {
        // Avoid duplicate handlers
        if (btn.dataset.handlerAttached) return;
        btn.dataset.handlerAttached = 'true';

        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const btnWord = btn.dataset.word || word;
          const mIdx = parseInt(btn.dataset.mIdx);
          const dIdx = parseInt(btn.dataset.dIdx);
          const text = btn.dataset.text;
          const type = btn.dataset.type || 'definition';

          if (!text || isNaN(mIdx) || isNaN(dIdx)) {
            console.error('[ReviewManager] Invalid translate button data');
            return;
          }

          console.log(`[ReviewManager] Translating ${type} [${mIdx},${dIdx}]: ${text.substring(0, 50)}`);

          // Show loading state
          btn.disabled = true;
          const originalHTML = btn.innerHTML;
          btn.innerHTML = '<span style="opacity:0.5;">翻译中...</span>';

          try {
            const response = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(btnWord)}/translate-definition`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.app.token}`
              },
              body: JSON.stringify({
                meaningIndex: mIdx,
                definitionIndex: dIdx,
                text,
                type
              })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
              const errorMsg = result.message || `翻译失败: ${response.status}`;
              console.warn(`[ReviewManager] Translation failed:`, errorMsg);
              btn.disabled = false;
              btn.innerHTML = `<span style="color:#ef4444;font-size:.85rem;">${errorMsg}</span>`;
              setTimeout(() => { btn.innerHTML = originalHTML; }, 5000);
              return;
            }

            console.log(`[ReviewManager] Translation successful:`, result.translation);

            // Replace button with translation text
            const translationDiv = document.createElement('div');
            translationDiv.style.cssText = 'color:#64748b;font-size:.95rem;line-height:1.6;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;';
            translationDiv.textContent = result.translation;
            btn.parentNode.replaceChild(translationDiv, btn);

          } catch (error) {
            console.error('[ReviewManager] Translation failed:', error);
            btn.disabled = false;
            btn.innerHTML = '<span style="color:#ef4444;">翻译失败</span>';
            setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
          }
        });
      });

      console.log(`[ReviewManager] Attached ${translateButtons.length} translate button handlers`);
    }

    speak(text) {
      if (!text) return;
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        const tts = window.LinglishTtsVoice;
        if (tts && typeof tts.synthesisLang === 'function') {
          utterance.lang = tts.synthesisLang();
          const systemVoice = typeof tts.findSystemVoice === 'function'
            ? tts.findSystemVoice(speechSynthesis.getVoices())
            : null;
          if (systemVoice) utterance.voice = systemVoice;
        } else {
          utterance.lang = 'en-US';
        }
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
      } catch (err) {
        console.warn('[ReviewManager] Speech synthesis failed:', err);
      }
    }

    startReviewTranslationPolling(word) {
      // Clear existing timer
      if (this.reviewTranslationPollingTimer) {
        clearTimeout(this.reviewTranslationPollingTimer);
      }

      // Poll every 3 seconds, maximum 10 times (30 seconds total)
      let pollCount = 0;
      const maxPolls = 10;
      const pollInterval = 3000; // 3 seconds

      const poll = async () => {
        pollCount++;
        if (pollCount > maxPolls) {
          console.log('[ReviewManager] Translation polling timeout for', word);
          this.reviewTranslationPollingTimer = null;
          return;
        }

        // Check if still in review and word hasn't changed
        if (!this.currentReview || this.currentReview.lemma !== word) {
          console.log('[ReviewManager] Review word changed, stopping translation polling');
          this.reviewTranslationPollingTimer = null;
          return;
        }

        try {
          // Re-fetch dictionary
          const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, {
            headers: { 'Authorization': `Bearer ${this.app.token}` }
          });

          if (!res.ok) {
            this.reviewTranslationPollingTimer = setTimeout(poll, pollInterval);
            return;
          }

          const data = await res.json();
          const entry = data.entry;

          if (entry && entry.meanings && this.definitionsEl) {
            const dictLang = this.getReviewDictLang();

            // Check if still translating
            let hasTranslating = false;
            for (const m of entry.meanings) {
              for (const d of (m.definitions || [])) {
                if (d.zh && d.zh.includes('翻译中')) hasTranslating = true;
                if (d.exampleZh && d.exampleZh.includes('翻译中')) hasTranslating = true;
              }
            }

            if (hasTranslating) {
              // Still translating, continue polling
              console.log(`[ReviewManager] Still translating (poll ${pollCount}/${maxPolls})`);
              this.reviewTranslationPollingTimer = setTimeout(poll, pollInterval);
            } else {
              // Translation complete, update display using DictionaryRender
              console.log('[ReviewManager] Translation completed, updating display');
              if (window.DictionaryRender) {
                const zh = this.currentReview?.definitions?.zh || '';
                const html = window.DictionaryRender.build(word, entry, zh, {
                  speak: false,
                  langMode: dictLang
                });
                this.definitionsEl.innerHTML = html;

                // Re-attach handlers
                this.attachReviewTranslateHandlers(word);
                this.definitionsEl.querySelectorAll('.dict-def-speak').forEach(btn => {
                  btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const text = btn.getAttribute('data-text') || word;
                    this.speak(text);
                  });
                });
              } else {
                // Fallback
                const showZh = !dictLang || dictLang === 'zh';
                const defsHtml = entry.meanings.slice(0, 2).map(meaning => {
                  const defs = (meaning.definitions || []).slice(0, 2).map(def => {
                    const enDef = `<div>${def.definition || ''}</div>`;
                    const zhDef = (showZh && def.zh && def.zh.trim() && def.zh !== '[待翻译]')
                      ? `<div style="color:#64748b;margin-top:0.2rem;">${def.zh}</div>`
                      : '';
                    return `<li>${enDef}${zhDef}</li>`;
                  }).join('');
                  return `<div><strong>${meaning.partOfSpeech || ''}</strong><ul>${defs}</ul></div>`;
                }).join('');
                this.definitionsEl.innerHTML = defsHtml || '暂无详细释义';
              }
              this.reviewTranslationPollingTimer = null;
            }
          } else {
            // Continue polling
            this.reviewTranslationPollingTimer = setTimeout(poll, pollInterval);
          }
        } catch (err) {
          console.error('[ReviewManager] Translation polling error:', err);
          // Continue polling despite error
          this.reviewTranslationPollingTimer = setTimeout(poll, pollInterval);
        }
      };

      // Start first poll
      this.reviewTranslationPollingTimer = setTimeout(poll, pollInterval);
    }

    highlightWord(sentence, word, useHTML = false) {
      if (!sentence || !word) return sentence || '';

      const regex = new RegExp(`\\b(${word})\\b`, 'gi');
      if (useHTML) {
        return sentence.replace(regex, '<mark>$1</mark>');
      } else {
        return sentence.replace(regex, `**$1**`);
      }
    }

    flipCard() {
      if (!this.currentReview || !this.currentReview.lemma) {
        console.warn('[ReviewManager] Cannot flip card, no current review');
        return;
      }

      this.isFlipped = true;
      if (this.flashcard) {
        this.flashcard.classList.add('flipped');
      }
      if (this.showAnswerBtn) {
        this.showAnswerBtn.style.display = 'none';
      }
      if (this.qualityButtonsEl) {
        this.qualityButtonsEl.style.display = 'block';
      }

      // Auto-play pronunciation when flipped
      setTimeout(() => {
        if (this.currentReview && this.currentReview.lemma) {
          this.app.audioManager.speak(this.currentReview.lemma, this.app.token);
        }
      }, 300);
    }

    async submitReview(quality) {
      if (!this.currentReview) return;

      try {
        const res = await fetch(`${API_BASE}/vocab/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.app.token}`
          },
          body: JSON.stringify({
            lemma: this.currentReview.lemma,
            quality,
            outcome: this.mapQualityToOutcome(quality)
          })
        });

        if (!res.ok) throw new Error('Review submission failed');

        // Update progress tracker
        this.app.progressTracker.recordReview();

        // Track consecutive correct
        if (quality === 'good' || quality === 'easy') {
          this.consecutiveCorrect++;
          if (this.consecutiveCorrect === 5) {
            this.showAchievement('连续答对5个!🔥');
            this.consecutiveCorrect = 0;
          }
        } else {
          this.consecutiveCorrect = 0;
        }

        // Move to next
        this.currentIndex++;

        // Small delay for better UX
        setTimeout(() => {
          this.showNext();
        }, 300);

      } catch (err) {
        console.error('[ReviewManager] Submit failed:', err);
        this.app.showToast('提交失败', 'warn');
      }
    }

    mapQualityToOutcome(quality) {
      // Map 4-level quality to backend outcome
      switch (quality) {
        case 'again': return 'fail';
        case 'hard': return 'pass';
        case 'good': return 'pass';
        case 'easy': return 'pass';
        default: return 'pass';
      }
    }

    showAchievement(text) {
      this.achievementText.textContent = text;
      this.achievementToast.style.display = 'flex';

      setTimeout(() => {
        this.achievementToast.style.display = 'none';
      }, 2000);

      // Play success sound
      if (window.Feedback) {
        try {
          Feedback.playSfx('success');
        } catch (_) { }
      }
    }

    updateProgress() {
      const total = this.reviewQueue.length;
      const current = this.currentIndex + 1;
      const percentage = (this.currentIndex / total) * 100;

      if (this.progressFillEl) {
        this.progressFillEl.style.width = `${percentage}%`;
      }
      if (this.progressTextEl) {
        this.progressTextEl.textContent = `${current} / ${total}`;
      }
    }

    finish() {
      this.close({ toTab: 'my', toast: '本轮复习完成!🎉 已返回词汇表' });

      if (window.Feedback) {
        try {
          Feedback.playSfx('success');
        } catch (_) { }
      }

      // Refresh stats
      this.app.refreshHeaderStats();
    }

    close(options = {}) {
      const { toTab = null, toast = null } = options;
      this.hideOverlay();
      this.currentReview = null;
      this.reviewQueue = [];
      this.currentIndex = 0;
      if (toTab) {
        this.app.switchTab(toTab);
      }
      if (toast) {
        this.app.showToast(toast, 'info');
      }
    }

    hideOverlay() {
      if (!this.overlay) return;
      this.overlay.hidden = true;
      this.overlay.style.display = 'none';
      this.overlayVisible = false;
      if (this.qualityButtonsEl) {
        this.qualityButtonsEl.style.display = 'none';
      }
      // Clear translation polling timer when closing
      if (this.reviewTranslationPollingTimer) {
        clearTimeout(this.reviewTranslationPollingTimer);
        this.reviewTranslationPollingTimer = null;
      }
      try { document.body.classList.remove('modal-open'); } catch (_) { }
    }
  }

  // ===== Vocabulary List Manager =====
  class VocabularyListManager {
    constructor(app) {
      this.app = app;
      this.vocabIndex = new Map();
      this.allVocabItems = [];
      this.currentSearchQuery = '';

      this.initElements();
      this.bindEvents();
    }

    initElements() {
      this.listEl = document.getElementById('vocabulary-list');
      this.placeholderEl = document.getElementById('vocabulary-placeholder');
      this.emptyEl = document.getElementById('vocabulary-empty');
      this.countEl = document.querySelector('.vocab-count');
      this.searchContainer = document.getElementById('vocab-search-container');
      this.searchInput = document.getElementById('vocab-search-input');
      this.searchClearBtn = document.getElementById('search-clear-btn');
      this.searchToggleBtn = document.getElementById('search-toggle-btn');
      this.searchResultsInfo = document.getElementById('search-results-info');
      this.searchResultsCount = document.getElementById('search-results-count');
    }

    bindEvents() {
      // Search toggle
      if (this.searchToggleBtn) {
        this.searchToggleBtn.addEventListener('click', () => this.toggleSearch());
      }

      // Search input
      if (this.searchInput) {
        this.searchInput.addEventListener('input', (e) => {
          const query = e.target.value;
          if (this.searchClearBtn) {
            this.searchClearBtn.style.display = query ? 'block' : 'none';
          }
          this.performSearch(query);
        });
      }

      // Search clear
      if (this.searchClearBtn) {
        this.searchClearBtn.addEventListener('click', () => this.clearSearch());
      }

      // Vocab detail close button
      const detailCloseBtn = document.getElementById('vocab-detail-close');
      if (detailCloseBtn) {
        detailCloseBtn.addEventListener('click', () => {
          this.closeVocabDetail();
        });
      }

      // Vocab detail backdrop (click to close)
      const detailOverlay = document.getElementById('vocab-detail-overlay');
      if (detailOverlay) {
        const backdrop = detailOverlay.querySelector('.vocab-detail-backdrop');
        if (backdrop) {
          backdrop.addEventListener('click', () => {
            this.closeVocabDetail();
          });
        }
      }

      // Dictionary language toggle buttons (vocab detail)
      const dictLangZh = document.getElementById('dict-lang-zh');
      const dictLangEn = document.getElementById('dict-lang-en');
      if (dictLangZh && dictLangEn) {
        dictLangZh.addEventListener('click', () => {
          this.setDictLang('zh');
          this.refreshDictDisplay();
        });
        dictLangEn.addEventListener('click', () => {
          this.setDictLang('en');
          this.refreshDictDisplay();
        });
      }

      // Deep analysis tab buttons
      const mpTabDict = document.getElementById('mp-tab-dict');
      const mpTabDeep = document.getElementById('mp-tab-deep');
      if (mpTabDict) mpTabDict.addEventListener('click', () => this.switchMpDictTab('dict'));
      if (mpTabDeep) mpTabDeep.addEventListener('click', () => this.switchMpDictTab('deep'));
    }

    getDictLang() {
      try {
        return localStorage.getItem('dict_lang_mode') || localStorage.getItem('linglish_dict_lang') || 'en';
      } catch (_) {
        return 'en';
      }
    }

    setDictLang(lang) {
      const mode = lang === 'zh' ? 'zh' : 'en';
      try {
        localStorage.setItem('dict_lang_mode', mode);
        // Backward compat
        localStorage.setItem('linglish_dict_lang', mode);
      } catch (_) { }
      const dictLangZh = document.getElementById('dict-lang-zh');
      const dictLangEn = document.getElementById('dict-lang-en');
      if (dictLangZh && dictLangEn) {
        dictLangZh.classList.toggle('active', mode === 'zh');
        dictLangEn.classList.toggle('active', mode === 'en');
      }
    }

    refreshDictDisplay() {
      // Re-render the dictionary with current language setting
      const detailWordEl = document.getElementById('detail-word');
      if (detailWordEl && this.currentDetailWord) {
        this.openVocabDetail(this.currentDetailWord);
      }
    }

    switchMpDictTab(tab) {
      const isDeep = tab === 'deep';
      const tabDict = document.getElementById('mp-tab-dict');
      const tabDeep = document.getElementById('mp-tab-deep');
      const dictCard = document.getElementById('detail-dict-card');
      const deepCard = document.getElementById('detail-deep-card');
      const langToggle = document.getElementById('mp-dict-lang-toggle');
      if (tabDict) tabDict.classList.toggle('active', !isDeep);
      if (tabDeep) tabDeep.classList.toggle('active', isDeep);
      if (dictCard) dictCard.hidden = isDeep;
      if (deepCard) deepCard.hidden = !isDeep;
      if (langToggle) langToggle.style.display = isDeep ? 'none' : '';
      if (isDeep && this.currentDetailWord) {
        this.loadMpDeepAnalysis(this.currentDetailWord);
      }
    }

    _mpDeepActionStrip(container, word) {
      const daCard = container && container.querySelector('.da-card');
      if (!daCard) return;
      const item = this.vocabIndex && this.vocabIndex.get(word);
      const stateLabels = { learning: '学习中 📚', reviewing: '复习中 🔄', mastered: '已掌握 ⭐' };
      const statusHtml = (item && item.state && stateLabels[item.state])
        ? `<span style="font-size:.76rem;color:#64748b;">词汇状态：<strong style="color:#0f172a;">${stateLabels[item.state]}</strong></span>`
        : '<span style="font-size:.76rem;color:#94a3b8;"></span>';
      const strip = document.createElement('div');
      strip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:.5rem 1.1rem .75rem;border-top:1px solid #f1f5f9;';
      strip.innerHTML = statusHtml +
        '<button id="da-refresh-btn" title="重新生成" style="font-size:.76rem;color:#94a3b8;background:transparent;border:none;cursor:pointer;padding:.15rem .4rem;border-radius:6px;">↺ 刷新</button>';
      daCard.appendChild(strip);
      const refBtn = daCard.querySelector('#da-refresh-btn');
      if (refBtn) refBtn.addEventListener('click', () => { this.loadMpDeepAnalysis(word, true); });
    }

    loadMpDeepAnalysis(word, forceRefresh) {
      const deepCard = document.getElementById('detail-deep-card');
      if (!deepCard || !window.DeepAnalysis) return;
      deepCard.innerHTML = window.DeepAnalysis.renderLoading();
      const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : '') || '';
      const getHdrs = () => {
        const tok = this.app && this.app.token ? this.app.token : (localStorage.getItem('linglish_token') || '');
        return tok ? { 'Authorization': 'Bearer ' + tok } : {};
      };
      const opts = forceRefresh ? { refresh: true } : undefined;
      window.DeepAnalysis.load(word, apiBase, getHdrs, opts).then((data) => {
        deepCard.innerHTML = window.DeepAnalysis.render(word, data);
        window.DeepAnalysis.tryRenderMermaid(deepCard);
        try { this._mpDeepActionStrip(deepCard, word); } catch (e) { console.warn('[DeepAnalysis] strip err', e); }
      }).catch((err) => {
        if (err && err.paywall && window.DeepAnalysis && typeof window.DeepAnalysis.renderPaywall === 'function') {
          deepCard.innerHTML = window.DeepAnalysis.renderPaywall(err.paywall);
          return;
        }
        const message = err && err.message ? err.message : '加载失败，请稍后重试';
        deepCard.innerHTML =
          '<div style="padding:1.5rem;text-align:center;">' +
            `<p style="color:#ef4444;font-size:.86rem;margin:0 0 .9rem;">${this.escapeHtml(message)}</p>` +
            '<button id="da-retry-btn" style="padding:.38rem 1.2rem;background:#4f46e5;color:#fff;border:none;border-radius:999px;cursor:pointer;font-size:.82rem;font-weight:700;">🔄 重试</button>' +
          '</div>';
        const retryBtn = deepCard.querySelector('#da-retry-btn');
        if (retryBtn) retryBtn.addEventListener('click', () => { this.loadMpDeepAnalysis(word); });
        console.error('[DeepAnalysis] mp load error:', err);
      });
    }

    async load(state = '', searchQuery = '') {
      try {
        this.placeholderEl.classList.remove('hidden');
        this.emptyEl.classList.add('hidden');

        // 根据当前标签加载不同数据：我的词汇 or 全局词库
        const currentTab = this.app.currentTab || 'my';
        let endpoint;
        if (currentTab === 'full') {
          const params = new URLSearchParams({ limit: '1000' });
          if (searchQuery) params.set('search', searchQuery);
          endpoint = `${API_BASE}/vocab/full-library?${params.toString()}`;
        } else {
          endpoint = `${API_BASE}/vocab?limit=1000`;
        }

        const response = await fetch(endpoint, {
          headers: { 'Authorization': `Bearer ${this.app.token}` }
        });

        if (response.status === 401) {
          console.warn('[VocabList] Token expired');
          this.placeholderEl.classList.add('hidden');
          if (this.app.authManager && this.app.authManager.logout) {
            this.app.authManager.logout();
          }
          return;
        }

        if (!response.ok) throw new Error(`Request failed: ${response.status}`);

        const data = await response.json();
        const raw = Array.isArray(data.items) ? data.items : [];

        // 保存真实的总数（用于词汇库统计）
        if (currentTab === 'full' && data.totalCount) {
          this.fullLibraryTotalCount = data.totalCount;
        }

        // Process data
        const all = raw.map(it => {
          let translation = '';
          if (it.definitions) {
            if (typeof it.definitions === 'object' && it.definitions.zh) {
              translation = it.definitions.zh;
            } else if (typeof it.definitions === 'string') {
              translation = it.definitions;
            }
          }

          // 对于"我的词汇"标签，保留state信息
          // 对于"词汇库"标签，使用inMyVocabulary标记
          return {
            ...it,
            lemma: it.lemma || it.word,
            translation: translation,
            state: it.state || 'encountered',
            inMyVocabulary: currentTab === 'full' ? (it.inMyVocabulary || false) : true
          };
        });

        const items = state ? all.filter(it => this.matchesState(it, state)) : all;

        await this.updateStats(items);

        if (!items.length) {
          this.listEl.innerHTML = '';
          this.emptyEl.classList.remove('hidden');
          // 显示搜索结果为0
          if (searchQuery && this.searchResultsInfo) {
            this.searchResultsCount.textContent = '0';
            this.searchResultsInfo.style.display = 'block';
          }
        } else {
          this.emptyEl.classList.add('hidden');
          this.renderItems(items);

          // 词汇库服务器搜索后直接显示结果数量
          if (currentTab === 'full' && searchQuery && this.searchResultsInfo) {
            this.searchResultsCount.textContent = items.length;
            this.searchResultsInfo.style.display = 'block';
          } else if (this.currentSearchQuery && currentTab === 'my') {
            // 我的词汇使用本地过滤
            this.performSearch(this.currentSearchQuery);
          }
        }
      } catch (err) {
        console.error('[VocabList] Load failed:', err);
        this.listEl.innerHTML = '';
        this.emptyEl.textContent = '加载词汇失败,请稍后重试。';
        this.emptyEl.classList.remove('hidden');
      } finally {
        this.placeholderEl.classList.add('hidden');
      }
    }

    renderItems(items) {
      this.listEl.innerHTML = '';
      this.vocabIndex.clear();
      this.allVocabItems = items;

      const fragment = document.createDocumentFragment();

      items.forEach(item => {
        this.vocabIndex.set(item.lemma, item);
        const mapped = this.mapState(item.state);
        const level = Math.min(Math.max(mapped.level, 1), 3);
        const exposures = Number.isFinite(item.exposures) ? item.exposures : 0;
        const lastSeen = this.formatRelative(item.last_seen_at);

        const wrapper = document.createElement('div');
        wrapper.className = 'vocab-item-game';
        wrapper.setAttribute('data-lemma', item.lemma);

        let actionButtonHtml = '';
        if (this.app.currentTab === 'my') {
          actionButtonHtml = `<button class="vocab-action-btn" aria-label="查看详情">查看</button>`;
        } else {
          if (item.inMyVocabulary) {
            // 已添加的词也显示"查看"按钮，方便用户查看详情
            actionButtonHtml = `<button class="vocab-action-btn" aria-label="查看详情">查看</button>`;
          } else {
            actionButtonHtml = `<button class="vocab-action-btn vocab-add-btn" data-lemma="${item.lemma}" aria-label="添加到我的词汇">+ 添加</button>`;
          }
        }

        const translation = item.translation || (item.definitions?.zh) || '';

        wrapper.innerHTML = `
          <div class="vocab-level-badge level-${level}">${level}</div>
          <div class="vocab-content-game">
            <div class="vocab-word-row">
              <span class="vocab-word-text">${item.lemma}</span>
              <span class="vocab-ipa-text" aria-hidden="true"></span>
              <button class="sound-btn" aria-label="播放发音">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
              </button>
            </div>
            <div class="vocab-translation">${translation && !translation.startsWith('[待翻译]') ? translation : '未设置翻译'}</div>
            <div class="vocab-meta">
              <span class="vocab-stats">🕒 ${lastSeen} · 👀 ${exposures}</span>
              <span class="vocab-status ${mapped.className}">${mapped.label}</span>
            </div>
          </div>
          ${actionButtonHtml}
        `;

        // Bind sound button
        const soundBtn = wrapper.querySelector('.sound-btn');
        if (soundBtn) {
          soundBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.app.audioManager.speak(item.lemma, this.app.token);
          });
        }

        // Bind action button
        const actionBtn = wrapper.querySelector('.vocab-action-btn');
        if (actionBtn) {
          if (actionBtn.classList.contains('vocab-add-btn')) {
            actionBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this.addToMyVocabulary(item.lemma, actionBtn);
            });
          } else {
            actionBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this.openVocabDetail(item.lemma);
            });
          }
        }

        // Bind click to detail
        wrapper.addEventListener('click', () => {
          this.openVocabDetail(item.lemma);
        });

        // Set phonetic if available
        if (item.phonetic) {
          const ipaSpan = wrapper.querySelector('.vocab-ipa-text');
          if (ipaSpan) {
            ipaSpan.textContent = item.phonetic;
          }
        }

        fragment.appendChild(wrapper);
      });

      this.listEl.appendChild(fragment);
    }

    async addToMyVocabulary(word, btnElement) {
      try {
        const prevText = btnElement.textContent;
        btnElement.disabled = true;
        btnElement.textContent = '...';

        // 使用旧API的/vocab/mark接口添加词汇
        const res = await fetch(`${API_BASE}/vocab/mark`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.app.token}`
          },
          body: JSON.stringify({
            lemma: word,
            state: 'learning' // 新添加的词汇默认为learning状态
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '添加失败');

        this.app.showToast(`"${word}" 已添加到我的词汇`, 'success');
        if (window.Feedback) Feedback.playSfx('success');

        // Update local state
        const item = this.vocabIndex.get(word);
        if (item) {
          item.inMyVocabulary = true;
        }

        // Reload list
        this.load(this.app.currentFilterState);
      } catch (error) {
        this.app.showToast(error.message || '添加失败', 'warn');
        btnElement.disabled = false;
        btnElement.textContent = '+ 添加';
      }
    }

    async openVocabDetail(lemma) {
      const item = this.vocabIndex.get(lemma);
      if (!item) return;

      // Save current detail word for refresh
      this.currentDetailWord = lemma;

      // Clear any existing translation polling
      if (this.translationPollingTimer) {
        clearTimeout(this.translationPollingTimer);
        this.translationPollingTimer = null;
      }

      const detailOverlay = document.getElementById('vocab-detail-overlay');
      const detailWordEl = document.getElementById('detail-word');
      const detailTranslationEl = document.getElementById('detail-translation');
      const detailIpaEl = document.getElementById('detail-ipa');
      const detailStatusEl = document.getElementById('detail-status');
      const detailExposuresEl = document.getElementById('detail-exposures');
      const detailLastSeenEl = document.getElementById('detail-last-seen');
      const detailContextsEl = document.getElementById('detail-contexts');
      const detailDictCard = document.getElementById('detail-dict-card');

      if (!detailOverlay) return;

      // Silently prefetch deep analysis in background so it's instant when user switches tab
      if (window.DeepAnalysis) {
        const _tok = this.app && this.app.token ? this.app.token : (localStorage.getItem('linglish_token') || '');
        const _apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : '') || '';
        window.DeepAnalysis.load(lemma, _apiBase, () => (_tok ? { 'Authorization': 'Bearer ' + _tok } : {}))
          .catch(() => {});
      }

      // Initialize language toggle buttons
      const currentLang = this.getDictLang();
      this.setDictLang(currentLang);

      // Show overlay immediately with basic info
      const mapped = this.mapState(item.state);
      if (detailWordEl) detailWordEl.textContent = item.lemma;
      if (detailIpaEl) detailIpaEl.textContent = item.phonetic || '';
      if (detailTranslationEl) {
        const translation = item.translation || item.definitions?.zh || '';
        detailTranslationEl.textContent = (translation && !translation.startsWith('[待翻译]')) ? translation : '暂无翻译';
      }
      if (detailStatusEl) {
        detailStatusEl.textContent = mapped.label;
        detailStatusEl.className = `detail-status ${mapped.className}`;
      }
      if (detailExposuresEl) detailExposuresEl.textContent = `曝光 ${item.exposures || 0}`;
      if (detailLastSeenEl) detailLastSeenEl.textContent = `最近 ${this.formatRelative(item.last_seen_at)}`;

      detailOverlay.hidden = false;
      document.body.classList.add('modal-open');

      // Reset to dict tab and clear deep card on each open
      this.switchMpDictTab('dict');
      const deepCard = document.getElementById('detail-deep-card');
      if (deepCard) deepCard.innerHTML = '';

      // Load additional data
      try {
        const res = await fetch(`${API_BASE}/vocab/item?lemma=${encodeURIComponent(lemma)}`, {
          headers: { 'Authorization': `Bearer ${this.app.token}` }
        });

        if (!res.ok) throw new Error('Failed to load detail');

        const data = await res.json();
        const contexts = Array.isArray(data.contexts) ? data.contexts : [];

        // Update contexts
        if (detailContextsEl) {
          if (!contexts.length) {
            detailContextsEl.innerHTML = '<div class="detail-context-empty">暂无来源信息</div>';
          } else {
            const frag = document.createDocumentFragment();
            contexts.forEach(ctx => {
              const el = document.createElement('div');
              el.className = 'detail-context-item';
              const title = ctx.videoTitle || '未知来源';
              const sentence = ctx.sentence || '';
              el.innerHTML = `
                <div class="context-title">${this.escapeHtml(title)}</div>
                <div class="context-sentence">${this.escapeHtml(sentence)}</div>
              `;
              frag.appendChild(el);
            });
            detailContextsEl.innerHTML = '';
            detailContextsEl.appendChild(frag);
          }
        }

        // Load dictionary data
        if (detailDictCard && window.DictionaryUtil && window.DictionaryRender) {
          const entry = await window.DictionaryUtil.fetchEntry(API_BASE, lemma);
          if (entry) {
            const zh = item.translation || item.definitions?.zh || '';
            const dictLang = this.getDictLang();
            detailDictCard.innerHTML = window.DictionaryRender.build(lemma, entry, zh, {
              statusText: mapped.label,
              statusClass: mapped.className,
              langMode: dictLang
            });

            // Attach translate button click handlers
            this.attachTranslateButtonHandlers(detailDictCard, lemma);

            // Attach speak button click handlers
            this.attachSpeakButtonHandlers(detailDictCard, lemma);
          }
        }
      } catch (err) {
        console.error('[VocabList] Load detail failed:', err);
        if (detailContextsEl) {
          detailContextsEl.innerHTML = '<div class="detail-context-empty">加载详情失败</div>';
        }
      }
    }

    closeVocabDetail() {
      const detailOverlay = document.getElementById('vocab-detail-overlay');
      if (detailOverlay) {
        detailOverlay.hidden = true;
        document.body.classList.remove('modal-open');
      }
    }

    attachTranslateButtonHandlers(container, lemma) {
      if (!container) return;

      const translateButtons = container.querySelectorAll('.dict-translate-btn');
      translateButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const word = btn.dataset.word || lemma;
          const mIdx = parseInt(btn.dataset.mIdx);
          const dIdx = parseInt(btn.dataset.dIdx);
          const text = btn.dataset.text;
          const type = btn.dataset.type || 'definition';

          if (!text || mIdx === undefined || dIdx === undefined) {
            console.error('[VocabList] Invalid translate button data');
            return;
          }

          console.log(`[VocabList] Translating ${type} [${mIdx},${dIdx}]: ${text.substring(0, 50)}`);

          // Show loading state
          btn.disabled = true;
          const originalHTML = btn.innerHTML;
          btn.innerHTML = '<span style="opacity:0.5;">翻译中...</span>';

          try {
            const response = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}/translate-definition`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.app.token}`
              },
              body: JSON.stringify({
                meaningIndex: mIdx,
                definitionIndex: dIdx,
                text,
                type
              })
            });

            const result = await response.json();

            // Check if translation was successful
            if (!response.ok || !result.success) {
              const errorMsg = result.message || `Translation failed: ${response.status}`;
              console.warn(`[VocabList] Translation failed:`, errorMsg);

              // Show error message in UI
              btn.disabled = false;
              btn.innerHTML = `<span style="color:#ef4444;font-size:.85rem;">${errorMsg}</span>`;

              // Reset after 5 seconds
              setTimeout(() => {
                btn.innerHTML = originalHTML;
              }, 5000);
              return;
            }

            console.log(`[VocabList] Translation successful:`, result.translation);

            // Replace button with translation text
            const translationDiv = document.createElement('div');
            translationDiv.style.cssText = 'color:#64748b;font-size:.95rem;line-height:1.6;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;';
            translationDiv.textContent = result.translation;
            btn.parentNode.replaceChild(translationDiv, btn);

          } catch (error) {
            console.error('[VocabList] Translation failed:', error);
            btn.disabled = false;
            btn.innerHTML = originalHTML;
            // Show error message briefly
            btn.innerHTML = '<span style="color:#ef4444;">翻译失败</span>';
            setTimeout(() => {
              btn.innerHTML = originalHTML;
            }, 2000);
          }
        });
      });

      console.log(`[VocabList] Attached ${translateButtons.length} translate button handlers`);
    }

    attachSpeakButtonHandlers(container, lemma) {
      if (!container) return;

      // Attach main word speak button handler
      const mainSpeakBtn = container.querySelector('.dict-speak-btn');
      if (mainSpeakBtn) {
        mainSpeakBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.app.audioManager.speak(lemma, this.app.token);
        });
      }

      // Attach definition/example speak button handlers
      const defSpeakBtns = container.querySelectorAll('.dict-def-speak');
      defSpeakBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const text = btn.getAttribute('data-text') || lemma;
          this.app.audioManager.speak(text, this.app.token);
        });
      });
    }

    checkIfTranslating(entry) {
      // Check if any definition or example contains "翻译中..."
      if (!entry || !entry.meanings) return false;

      for (const meaning of entry.meanings) {
        if (!meaning.definitions) continue;
        for (const def of meaning.definitions) {
          if (def.zh && def.zh.includes('翻译中')) return true;
          if (def.exampleZh && def.exampleZh.includes('翻译中')) return true;
          if (def.examplesZh && def.examplesZh.some(zh => zh && zh.includes('翻译中'))) return true;
        }
      }
      return false;
    }

    startTranslationPolling(lemma, item, mapped) {
      // Poll every 3 seconds, maximum 10 times (30 seconds total)
      let pollCount = 0;
      const maxPolls = 10;
      const pollInterval = 3000; // 3 seconds

      const poll = async () => {
        pollCount++;
        if (pollCount > maxPolls) {
          console.log('[VocabList] Translation polling timeout for', lemma);
          this.translationPollingTimer = null;
          return;
        }

        // Check if detail is still open for this word
        const detailOverlay = document.getElementById('vocab-detail-overlay');
        if (!detailOverlay || detailOverlay.hidden || this.currentDetailWord !== lemma) {
          console.log('[VocabList] Detail closed, stopping translation polling');
          this.translationPollingTimer = null;
          return;
        }

        try {
          // Fetch updated dictionary entry (bypass cache)
          const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(lemma.toLowerCase())}?t=${Date.now()}`, {
            headers: {
              'Authorization': `Bearer ${this.app.token}`,
              'Cache-Control': 'no-cache'
            }
          });

          if (!res.ok) {
            console.error('[VocabList] Polling fetch failed:', res.status);
            this.translationPollingTimer = setTimeout(poll, pollInterval);
            return;
          }

          const data = await res.json();
          const entry = data.entry;

          if (!entry) {
            // Continue polling
            this.translationPollingTimer = setTimeout(poll, pollInterval);
            return;
          }

          const hasTranslating = this.checkIfTranslating(entry);
          if (hasTranslating) {
            // Still translating, continue polling
            console.log(`[VocabList] Still translating (poll ${pollCount}/${maxPolls})`);
            this.translationPollingTimer = setTimeout(poll, pollInterval);
          } else {
            // Translation complete, update display
            console.log('[VocabList] Translation completed, updating display');
            const detailDictCard = document.getElementById('detail-dict-card');
            if (detailDictCard) {
              const zh = item.translation || item.definitions?.zh || '';
              const dictLang = this.getDictLang();
              detailDictCard.innerHTML = window.DictionaryRender.build(lemma, entry, zh, {
                statusText: mapped.label,
                statusClass: mapped.className,
                langMode: dictLang
              });
            }
            this.translationPollingTimer = null;
          }
        } catch (err) {
          console.error('[VocabList] Translation polling error:', err);
          // Continue polling despite error
          this.translationPollingTimer = setTimeout(poll, pollInterval);
        }
      };

      // Start first poll
      this.translationPollingTimer = setTimeout(poll, pollInterval);
    }

    escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    mapState(itemState) {
      switch (itemState) {
        case 'mastered': return { label: '已掌握', className: 'mastered', level: 3 };
        case 'reviewing': return { label: '复习中', className: 'reviewing', level: 2 };
        case 'learning': return { label: '学习中', className: 'learning', level: 1 };
        default: return { label: '新词', className: 'new', level: 1 };
      }
    }

    matchesState(item, stateKey) {
      if (!stateKey) return true;
      const s = String(item?.state || '').toLowerCase();

      switch (stateKey) {
        case 'mastered':
          return s === 'mastered' || (s === 'reviewing' && (Number(item?.review_count) || 0) >= 1);
        case 'reviewing': return s === 'reviewing';
        case 'learning': return s === 'learning';
        case 'encountered': return s === 'encountered';
        default: return true;
      }
    }

    formatRelative(isoString) {
      if (!isoString) return '刚刚';
      const date = new Date(isoString);
      if (Number.isNaN(date.getTime())) return '刚刚';

      const diffMs = Date.now() - date.getTime();
      const seconds = Math.floor(diffMs / 1000);
      if (seconds < 60) return '刚刚';

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}分钟前`;

      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}小时前`;

      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}天前`;

      const months = Math.floor(days / 30);
      if (months < 12) return `${months}个月前`;

      const years = Math.floor(months / 12);
      return `${years}年前`;
    }

    async updateStats(items) {
      if (this.countEl) {
        const total = Array.isArray(items) ? items.length : 0;
        if (total) {
          this.countEl.innerHTML = `<span>共</span> ${total} <span>词</span>`;
        } else {
          this.countEl.textContent = '暂无词汇';
        }
      }
      // 更新头部统计信息
      if (this.app && this.app.refreshHeaderStats) {
        await this.app.refreshHeaderStats();
      }
    }

    toggleSearch() {
      const isVisible = this.searchContainer.style.display !== 'none';

      if (isVisible) {
        this.searchContainer.style.display = 'none';
        this.searchToggleBtn.classList.remove('active');
        this.clearSearch();
      } else {
        this.searchContainer.style.display = 'block';
        this.searchToggleBtn.classList.add('active');
        setTimeout(() => this.searchInput.focus(), 100);
      }
    }

    clearSearch() {
      this.searchInput.value = '';
      this.currentSearchQuery = '';
      this.searchClearBtn.style.display = 'none';
      this.searchResultsInfo.style.display = 'none';
      this.performSearch('');
    }

    performSearch(query) {
      this.currentSearchQuery = query.toLowerCase().trim();

      if (!this.currentSearchQuery) {
        document.querySelectorAll('.vocab-item-game').forEach(item => {
          item.classList.remove('search-hidden');
        });
        this.searchResultsInfo.style.display = 'none';
        // 词汇库清空搜索时重新加载全部数据
        if (this.app.currentTab === 'full') {
          this.load('', '');
        }
        return;
      }

      // 词汇库使用服务器端搜索（数据量大，本地过滤不完整）
      if (this.app.currentTab === 'full') {
        // 防抖：延迟执行服务器搜索
        if (this._searchDebounceTimer) {
          clearTimeout(this._searchDebounceTimer);
        }
        this._searchDebounceTimer = setTimeout(() => {
          this.load('', this.currentSearchQuery);
        }, 300);
        return;
      }

      // 我的词汇使用本地过滤（数据量小）
      let matchCount = 0;
      document.querySelectorAll('.vocab-item-game').forEach(item => {
        const lemma = item.getAttribute('data-lemma') || '';
        const vocabItem = this.vocabIndex.get(lemma);
        const translation = vocabItem?.definitions?.zh || '';

        const matchesLemma = lemma.toLowerCase().includes(this.currentSearchQuery);
        const matchesTranslation = translation.includes(this.currentSearchQuery);

        if (matchesLemma || matchesTranslation) {
          item.classList.remove('search-hidden');
          matchCount++;
        } else {
          item.classList.add('search-hidden');
        }
      });

      this.searchResultsCount.textContent = matchCount;
      this.searchResultsInfo.style.display = 'block';
    }
  }

  // ===== Main App =====
  class VocabularyApp {
    constructor() {
      this.token = null;
      this.currentTab = 'my';
      this.currentFilterState = '';
      this.hardFirstMode = false;

      this.audioManager = new AudioManager();
      this.progressTracker = new ProgressTracker();

      this.init();
    }

    async init() {
      // Get token - localStorage should be immediately available
      this.token = this.readToken();

      if (!this.token) {
        console.error('[VocabApp] No token found, cannot initialize');
        console.log('[VocabApp] Please ensure you are logged in');
        return;
      }

      console.log('[VocabApp] Initialized with token, length:', this.token.length);

      // Initialize managers
      this.listManager = new VocabularyListManager(this);
      this.reviewManager = new ReviewManager(this);

      console.log('[VocabApp] Managers initialized');

      // Initialize UI
      await this.initUI();

      console.log('[VocabApp] UI initialized');

      // Load vocabulary
      await this.loadVocabulary('');
      await this.refreshHeaderStats();

      console.log('[VocabApp] Data loaded');

      // Update progress tracker UI
      this.progressTracker.updateUI();

      // Update time periodically
      setInterval(() => {
        this.progressTracker.updateTime();
      }, 60000); // Every minute

      console.log('[VocabApp] Initialization complete');

      // Auto-start review when deep-linked from Today plan
      try {
        const params = new URLSearchParams(window.location.search || '');
        const flag = params.get('startReview');
        if (flag === '1' || flag === 'true') {
          this.reviewManager.start();
        }
      } catch (_) { }
    }

    readToken() {
      const token = resolveExistingToken();
      if (token) {
        console.log('[VocabApp] Token resolved for session');
        return token;
      }
      console.error('[VocabApp] No token found in any source');
      return null;
    }

    async initUI() {
      // User info
      await this.updateUserInfo();

      // Filter buttons
      this.bindFilterControls();

      // Tab switcher
      this.bindTabSwitcher();

      // Start review button
      const reviewBtn = document.getElementById('start-review-btn');
      if (reviewBtn) {
        reviewBtn.addEventListener('click', () => {
          this.reviewManager.start();
        });
      }

      // Hard first toggle
      try {
        this.hardFirstMode = localStorage.getItem('power_hard_first') === '1';
      } catch (_) { }

      const hardBtn = document.getElementById('hard-first-toggle');
      if (hardBtn) {
        hardBtn.classList.toggle('active', this.hardFirstMode);
        hardBtn.addEventListener('click', () => {
          this.hardFirstMode = !this.hardFirstMode;
          try {
            localStorage.setItem('power_hard_first', this.hardFirstMode ? '1' : '0');
          } catch (_) { }
          hardBtn.classList.toggle('active', this.hardFirstMode);
        });
      }
    }

    async updateUserInfo() {
      try {
        const userInfoEl = document.getElementById('mobile-user-info');
        const userNameEl = document.getElementById('mobile-user-name');
        const vipBadgeEl = document.getElementById('mobile-vip-badge');

        // Safely get authManager reference
        let authManager = null;
        try {
          authManager = window.authManager;
        } catch (_) {
          // Ignore if authManager is not accessible
        }

        if (userInfoEl && authManager && typeof authManager.isAuthenticated === 'function' && authManager.isAuthenticated()) {
          const res = await fetch(`${API_BASE}/users/me`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
          });

          if (res.ok) {
            const user = await res.json();
            let displayName = 'User';
            if (user.username) {
              displayName = user.username;
            } else if (user.email) {
              displayName = user.email.split('@')[0];
            }
            if (userNameEl) userNameEl.textContent = displayName;

            if (vipBadgeEl && user.membership_type && user.membership_type !== 'free') {
              vipBadgeEl.style.display = 'inline-flex';
              const isFamily = user.membership_type === 'family';
              vipBadgeEl.classList.toggle('family', isFamily);
              const vipText = vipBadgeEl.querySelector('.vip-text');
              if (vipText) vipText.textContent = isFamily ? 'Family' : 'VIP';
            }
            userInfoEl.style.display = 'flex';
          }
        }
      } catch (e) {
        console.warn('[VocabApp] Failed to update user info:', e);
      }
    }

    bindFilterControls() {
      document.querySelectorAll('.filter-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const stateKey = btn.dataset.state || '';
          this.setActiveFilter(stateKey);
          this.loadVocabulary(stateKey);
        });
      });
    }

    bindTabSwitcher() {
      const tabMyVocab = document.getElementById('tab-my-vocab');
      const tabFullLibrary = document.getElementById('tab-full-library');

      if (tabMyVocab) {
        tabMyVocab.addEventListener('click', () => this.switchTab('my'));
      }
      if (tabFullLibrary) {
        tabFullLibrary.addEventListener('click', () => this.switchTab('full'));
      }
    }

    async switchTab(tab) {
      this.currentTab = tab;

      const tabMyVocab = document.getElementById('tab-my-vocab');
      const tabFullLibrary = document.getElementById('tab-full-library');

      if (tab === 'my') {
        tabMyVocab.classList.add('active');
        tabFullLibrary.classList.remove('active');
      } else {
        tabMyVocab.classList.remove('active');
        tabFullLibrary.classList.add('active');
      }

      this.setActiveFilter('');
      await this.loadVocabulary('');
    }

    setActiveFilter(stateKey) {
      this.currentFilterState = stateKey || '';

      document.querySelectorAll('.filter-chip').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.state || '') === this.currentFilterState);
      });
    }

    async loadVocabulary(state = '') {
      await this.listManager.load(state);
    }

    async refreshHeaderStats() {
      try {
        const totalEl = document.getElementById('vocab-total-count');
        const masteredEl = document.getElementById('vocab-mastered-count');
        const reviewingEl = document.getElementById('vocab-reviewing-count');
        const learningEl = document.getElementById('vocab-learning-count');
        const encounteredEl = document.getElementById('vocab-encountered-count');
        const dueEl = document.getElementById('vocab-due-count');

        // 总是获取用户stats（词汇库标签需要用户总词汇数来显示"已添加"）
        const statsRes = await fetch(`${API_BASE}/vocab/stats-summary`, {
          headers: { 'Authorization': `Bearer ${this.token}` }
        });

        let s = {};
        if (statsRes.ok) {
          const data = await statsRes.json();
          s = data || {};  // 旧API直接返回stats对象
        }

        if (this.currentTab === 'full') {
          // 词汇库：显示全局词库统计
          const totalCount = this.listManager.fullLibraryTotalCount || 0;
          // "已添加"等于用户词汇总数，而不是从当前items中计算
          const addedCount = s.total || 0;
          const notAddedCount = totalCount - addedCount;

          if (totalEl) totalEl.textContent = totalCount;
          if (masteredEl) masteredEl.textContent = addedCount; // 复用显示"已添加"
          if (reviewingEl) reviewingEl.textContent = notAddedCount; // 复用显示"未添加"
          if (learningEl) learningEl.textContent = 0;
          if (encounteredEl) encounteredEl.textContent = 0;
          if (dueEl) dueEl.style.display = 'none';
        } else {
          // 我的词汇：使用后端返回的统计数据（旧API格式）
          const totalCount = s.total || 0;
          const masteredCount = (s.mastered || 0);
          const reviewingCount = (s.reviewing || 0);
          const learningCount = (s.learning || 0);
          const unknownCount = (s.encountered || 0);

          if (totalEl) totalEl.textContent = totalCount;
          if (masteredEl) masteredEl.textContent = masteredCount;
          if (reviewingEl) reviewingEl.textContent = reviewingCount;
          if (learningEl) learningEl.textContent = learningCount;
          if (encounteredEl) encounteredEl.textContent = unknownCount;

          if (dueEl) {
            dueEl.textContent = s.due ?? 0;
            dueEl.style.display = (s.due > 0) ? 'inline-block' : 'none';
          }
        }
      } catch (err) {
        console.error('[VocabApp] Refresh stats failed:', err);
      }
    }

    showToast(message, type = 'info') {
      if (window.Feedback) {
        Feedback.showToast(type, message);
        return;
      }

      let toast = document.getElementById('power-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'power-toast';
        toast.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:10px 14px;border-radius:12px;font-size:14px;z-index:2000;';
        document.body.appendChild(toast);
      }

      toast.textContent = message;
      toast.style.opacity = '1';
      setTimeout(() => (toast.style.opacity = '0'), 1600);
    }
  }

  // ===== Initialize App on DOMContentLoaded =====
  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 50; // Max 5 seconds (50 * 100ms)

  function initApp() {
    initAttempts++;
    console.log(`[VocabApp] Initializing app... (attempt ${initAttempts})`);

    // Check if token exists in any storage (authManager/localStorage/session/cookie)
    const token = resolveExistingToken();
    if (!token) {
      if (initAttempts < MAX_INIT_ATTEMPTS) {
        console.log('[VocabApp] No token yet, retrying in 100ms');
        setTimeout(initApp, 100);
        return;
      } else {
        console.error('[VocabApp] No token found after 50 attempts, cannot initialize');
        return;
      }
    }

    console.log('[VocabApp] Token found, creating VocabularyApp instance');
    window.vocabApp = new VocabularyApp();
  }

  // Initialize after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(initApp, 100); // Small delay to let auth initialize
    });
  } else {
    // DOM already loaded
    setTimeout(initApp, 100);
  }

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      try {
        navigator.serviceWorker.register('./sw.js');
      } catch (_) { }
    });
  }
})();
