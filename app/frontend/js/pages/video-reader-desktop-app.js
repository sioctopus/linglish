/**
 * Desktop video-reader app bootstrap (libraries + playback).
 * Restores video / channel / podcast browsers after the UTF-8 repair data loss.
 */
(function (root) {
  'use strict';

  const API_BASE = (root.location.hostname === 'localhost' || root.location.hostname === '127.0.0.1')
    ? ''
    : (root.API_BASE || '');

  const CHANNEL_STORE_KEY = 'linglish_channels_v1';
  const PODCAST_STORE_KEY = 'linglish_podcasts_v1';
  const CHANNEL_DEFAULTS_VERSION_KEY = 'linglish_channels_defaults_ver';
  const MEDIA_STORE_LIMIT = 80;

  const state = {
    videos: [],
    currentVideo: null,
    rawSegments: [],
    currentSegments: [],
  };
  root.state = state;
  root.API_BASE = API_BASE;

  const vbState = {
    libraryView: 'videos',
    channelKey: '',
    query: '',
    difficulty: '',
    scene: '',
    status: '',
    scope: 'all',
  };
  root.vbState = vbState;

  const podState = {
    feedUrl: '',
    query: '',
  };

  let youtubePlayer = null;
  let currentPlayerType = 'none';
  let playerEl = null;
  let overlayEl = null;
  let overlayTitle = null;
  let overlayDesc = null;
  let overlayRetry = null;
  let overlayRefresh = null;
  let transcriptListEl = null;
  let currentTitleEl = null;
  let selectionToken = 0;
  let podcastDialogMode = 'search';

  function getToken() {
    try { return root.localStorage.getItem('linglish_token') || ''; }
    catch (_) { return ''; }
  }
  root.getToken = getToken;

  function headers(json) {
    const h = { Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    const token = getToken();
    if (token && token !== 'null' && token !== 'undefined') h.Authorization = 'Bearer ' + token;
    return h;
  }
  root.headers = headers;

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, type) {
    if (typeof root.showToast === 'function' && root.showToast !== showToast) {
      try { root.showToast(message, type); return; } catch (_) {}
    }
    const host = document.getElementById('toast-container') || document.body;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }
  if (typeof root.showToast !== 'function') root.showToast = showToast;

  function readStore(key) {
    try {
      const raw = root.localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function writeStore(key, list) {
    try {
      root.localStorage.setItem(key, JSON.stringify((list || []).slice(0, MEDIA_STORE_LIMIT)));
    } catch (_) {}
  }

  function defaultsApi() {
    return root.LinglishMediaLibraryDefaults || null;
  }

  function ensureChannelDefaults() {
    const api = defaultsApi();
    if (!api || typeof api.mergeDefaults !== 'function') return readStore(CHANNEL_STORE_KEY);
    let existing = readStore(CHANNEL_STORE_KEY);
    try {
      const seenVer = root.localStorage.getItem(CHANNEL_DEFAULTS_VERSION_KEY);
      if (api.VERSION && seenVer !== api.VERSION && typeof api.reconcileChannelDefaults === 'function') {
        existing = api.reconcileChannelDefaults(existing);
        root.localStorage.setItem(CHANNEL_DEFAULTS_VERSION_KEY, api.VERSION);
      }
    } catch (_) {}
    const merged = api.mergeDefaults(existing, api.buildChannelDefaults(), 'channelId');
    writeStore(CHANNEL_STORE_KEY, merged);
    return merged;
  }

  function ensurePodcastDefaults() {
    const api = defaultsApi();
    if (!api || typeof api.mergeDefaults !== 'function') return readStore(PODCAST_STORE_KEY);
    const merged = api.mergeDefaults(readStore(PODCAST_STORE_KEY), api.buildPodcastDefaults(), 'feedUrl');
    writeStore(PODCAST_STORE_KEY, merged);
    return merged;
  }

  async function postMedia(path, body) {
    const res = await fetch(`${API_BASE}/media/${path}`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || '请求失败');
    return data;
  }

  function setOverlay(mode, title, desc) {
    if (!overlayEl) return;
    overlayEl.classList.remove('hidden', 'loading', 'error', 'idle');
    if (mode === 'hidden') {
      overlayEl.classList.add('hidden');
      return;
    }
    overlayEl.classList.add(mode || 'idle');
    if (overlayTitle) overlayTitle.textContent = title || '';
    if (overlayDesc) overlayDesc.textContent = desc || '';
    if (overlayRetry) {
      overlayRetry.disabled = mode === 'loading';
      overlayRetry.style.display = mode === 'idle' ? 'none' : '';
    }
  }

  function showIdleOverlay() {
    setOverlay('idle', '还没有选择视频', '打开顶部「视频库」「频道库」或「播客」，选一条开始学。');
  }

  function showLoadingOverlay() {
    setOverlay('loading', '正在加载视频…', '首次加载可能需要几秒，请耐心等待。');
  }

  function hideOverlay() {
    setOverlay('hidden');
  }

  function thumbUrl(video) {
    if (!video) return '';
    const path = video.thumbnail_path || video.image || video.thumb || '';
    if (!path) {
      if (video.youtube_video_id) return 'https://i.ytimg.com/vi/' + video.youtube_video_id + '/hqdefault.jpg';
      return '';
    }
    if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path;
    return API_BASE + (path.startsWith('/') ? '' : '/') + path;
  }

  function videoTitle(video) {
    return (video && (video.title || video.original_filename || video.name)) || '未命名视频';
  }

  function coerceRawSegments(raw) {
    let list = raw;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (_) { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    return list.map((seg, index) => ({
      ...(seg || {}),
      index,
      text: String(seg.text || seg.transcript || ''),
      translation: String(seg.translation || seg.cn || seg.zh || ''),
      start: Number(seg.start_sec ?? seg.start ?? seg.startTime ?? 0),
      end: Number(seg.end_sec ?? seg.end ?? seg.endTime ?? 0),
      source_indices: [index],
    })).filter((s) => s.text);
  }

  function coerceSegments(raw) {
    const api = root.LinglishSentenceSegments;
    const list = coerceRawSegments(raw);
    state.rawSegments = list;
    if (api && typeof api.toDisplayedSentences === 'function') {
      try {
        const display = api.toDisplayedSentences(list);
        if (Array.isArray(display) && display.length) return display;
      } catch (_) {}
    }
    return list;
  }

  function renderTranscript() {
    if (!transcriptListEl) return;
    const segs = state.currentSegments || [];
    if (!segs.length) {
      transcriptListEl.innerHTML = '<div class="empty-hint">选择视频后，这里滚动字幕</div>';
      return;
    }
    transcriptListEl.innerHTML = segs.map((seg, index) => {
      const start = Number(seg.start ?? seg.start_sec ?? 0);
      const text = escapeHtml(seg.text || '');
      const tr = escapeHtml(seg.translation || '');
      return `<div class="seg" data-index="${index}" data-start="${start}">
        <div class="text">${text}</div>
        ${tr ? `<div class="tr">${tr}</div>` : ''}
      </div>`;
    }).join('');
    transcriptListEl.querySelectorAll('.seg').forEach((el) => {
      el.addEventListener('click', () => {
        seekAndPlay(Number(el.dataset.start || 0));
        transcriptListEl.querySelectorAll('.seg').forEach((n) => n.classList.remove('active'));
        el.classList.add('active');
      });
    });
  }

  function seekAndPlay(seconds) {
    if (root.VRP && typeof root.VRP.seekAndPlay === 'function') {
      root.VRP.seekAndPlay(seconds);
      return;
    }
    if (currentPlayerType === 'youtube' && youtubePlayer) {
      try {
        youtubePlayer.seekTo && youtubePlayer.seekTo(seconds, true);
        youtubePlayer.playVideo && youtubePlayer.playVideo();
      } catch (_) {}
      return;
    }
    if (playerEl) {
      try {
        playerEl.currentTime = seconds;
        playerEl.play().catch(() => {});
      } catch (_) {}
    }
  }

  function materializeChannelVideo(channelTitle, item) {
    const existing = (state.videos || []).find((v) => v.youtube_video_id && v.youtube_video_id === item.videoId);
    if (existing) return existing;
    return {
      id: `yt:${item.videoId}`,
      title: item.title,
      original_filename: item.title,
      youtube_video_id: item.videoId,
      thumbnail_path: item.thumbnail,
      collection_name: channelTitle,
      published: item.published,
      duration_sec: Number(item.durationSec || item.duration_sec || 0),
      external_youtube: true,
      status: 'ready',
      language: 'en',
    };
  }

  function makeCard({ title, meta, thumb, active, square }, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vb-card' + (active ? ' active' : '') + (square ? ' pod-card' : '');
    const safeThumb = thumb ? escapeHtml(thumb) : '';
    const initial = escapeHtml(String(title || 'V').charAt(0).toUpperCase());
    btn.innerHTML = `
      <div class="vb-thumb-wrap">${safeThumb
        ? `<img class="vb-thumb" alt="" src="${safeThumb}" loading="lazy">`
        : `<div class="vb-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.4rem;color:#94a3b8;background:linear-gradient(135deg,#334155,#1e293b);">${initial}</div>`}
      </div>
      <div class="vb-card-body">
        <div class="vb-card-title">${escapeHtml(title || '未命名')}</div>
        ${meta ? `<div class="vb-card-channel">${escapeHtml(meta)}</div>` : ''}
      </div>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /* ---------- Video / Channel browser ---------- */

  function syncLibraryChrome() {
    const title = document.getElementById('vb-title');
    const search = document.getElementById('vb-search');
    const addChannel = document.getElementById('vb-add-channel');
    const podAddWrap = document.getElementById('vb-pod-add-wrap');
    const filterBtn = document.getElementById('vb-filter-toggle');
    const view = vbState.libraryView;
    if (title) {
      title.textContent = view === 'channels' ? '精选频道'
        : view === 'podcasts' ? '精选播客'
        : '精选视频';
    }
    if (search) {
      search.placeholder = view === 'channels' ? '搜索频道名称 / 把手…'
        : view === 'podcasts' ? '搜索播客名称 / 作者…'
        : '搜索视频标题 / 合集 / 标签…';
    }
    if (addChannel) addChannel.hidden = view !== 'channels';
    if (podAddWrap) podAddWrap.hidden = view !== 'podcasts';
    if (filterBtn) filterBtn.hidden = false;
    document.querySelectorAll('[data-vb-view]').forEach((btn) => {
      const on = btn.dataset.vbView === view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function setFilterPopOpen(open) {
    const pop = document.getElementById('vb-filter-pop');
    const btn = document.getElementById('vb-filter-toggle');
    if (!pop || !btn) return;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function resetCategoryChips() {
    vbState.difficulty = '';
    vbState.scene = '';
    vbState.status = '';
    vbState.scope = 'all';
    document.querySelectorAll('#vb-scope-chips .vb-chip').forEach((chip) => {
      chip.classList.toggle('active', (chip.getAttribute('data-scope') || 'all') === 'all');
    });
    document.querySelectorAll('#vb-diff-chips .vb-chip').forEach((chip) => {
      chip.classList.toggle('active', (chip.getAttribute('data-diff') || '') === '');
    });
    document.querySelectorAll('#vb-scene-chips .vb-chip').forEach((chip) => {
      chip.classList.toggle('active', (chip.getAttribute('data-scene') || '') === '');
    });
    document.querySelectorAll('#vb-status-chips .vb-chip').forEach((chip) => {
      chip.classList.toggle('active', (chip.getAttribute('data-status') || '') === '');
    });
    if (typeof root.setLibraryFilter === 'function') {
      try {
        root.setLibraryFilter({ difficulty: null, scene: null, scope: 'all', tagId: null });
      } catch (_) { /* ignore */ }
    }
  }

  function openVideoBrowser(view, opts) {
    const options = opts || {};
    const switching = view === 'channels' || view === 'podcasts' || view === 'videos';
    if (switching) {
      const changed = vbState.libraryView !== view;
      vbState.libraryView = view;
      // 入口/切库：先全览；分类筛选留给「分类」按钮
      if (changed || options.resetFilters !== false) resetCategoryChips();
    }
    if (vbState.libraryView !== 'channels') vbState.channelKey = '';
    if (vbState.libraryView !== 'podcasts') podState.feedUrl = '';
    const modal = document.getElementById('video-browser-modal');
    if (!modal) return;
    // keep legacy podcast modal closed
    const podModal = document.getElementById('podcast-browser-modal');
    if (podModal) {
      podModal.hidden = true;
      podModal.setAttribute('aria-hidden', 'true');
    }
    root.__podOpen = false;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('vb-open');
    root.__vbOpen = true;
    setFilterPopOpen(false);
    syncLibraryChrome();
    renderVideoBrowser();
    setTimeout(() => document.getElementById('vb-search')?.focus(), 40);
  }

  function closeVideoBrowser() {
    const modal = document.getElementById('video-browser-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('vb-open');
    root.__vbOpen = false;
    setFilterPopOpen(false);
    const menu = document.getElementById('pod-add-menu');
    if (menu) menu.hidden = true;
  }

  function openChannelBrowser() {
    openVideoBrowser('channels');
  }

  const SCENE_KEYWORDS = {
    work: ['职场', '商务', '工作', '会议', 'work', 'business', 'office'],
    daily: ['日常', '对话', '生活', 'daily', 'conversation', 'life'],
    interview: ['面试', '求职', 'interview', 'job'],
    travel: ['旅行', '旅游', '机场', '酒店', 'travel', 'airport', 'hotel'],
  };

  function readSharedFilters() {
    try {
      if (typeof root.getLibraryFilterState === 'function') return root.getLibraryFilterState() || {};
    } catch (_) { /* tag system may still be initializing */ }
    return {};
  }

  function matchesScene(blob, scene) {
    if (!scene) return true;
    const text = String(blob || '').toLowerCase();
    const keywords = SCENE_KEYWORDS[scene] || [scene];
    return keywords.some((k) => text.includes(String(k).toLowerCase()));
  }

  function filteredVideos() {
    const q = String(vbState.query || '').trim().toLowerCase();
    const shared = readSharedFilters();
    const difficulty = (shared.difficulty) || vbState.difficulty || '';
    const scene = (shared.scene) || vbState.scene || '';
    const scope = (shared.scope) || vbState.scope || 'all';
    return (state.videos || []).filter((v) => {
      if (scope === 'mine') {
        const mine = !!(v.owner_user_id || v.is_mine || v.source === 'upload' || v.uploaded_by);
        if (!mine) return false;
      }
      if (difficulty) {
        const level = String(v.difficulty || v.difficulty_level || v.level || '').toLowerCase();
        if (level && level !== String(difficulty).toLowerCase()) return false;
      }
      if (scene) {
        const blob = [v.title, v.collection_name, v.channel_title, ...(v.tags || [])].join(' ');
        if (!matchesScene(blob, scene)) return false;
      }
      if (!q) return true;
      const hay = [v.title, v.original_filename, v.collection_name, v.channel_title]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }

  function renderVideoCards(list) {
    const grid = document.getElementById('vb-grid');
    const empty = document.getElementById('vb-empty');
    const stats = document.getElementById('vb-stats');
    const hero = document.getElementById('vb-channel-hero');
    if (hero) hero.hidden = true;
    if (!grid) return;
    if (stats) stats.textContent = list.length ? `${list.length} 个视频` : '';
    if (!list.length) {
      grid.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        const title = empty.querySelector('.vb-empty-title');
        const hint = empty.querySelector('.vb-empty-hint');
        if (title) title.textContent = '没有找到匹配的视频';
        if (hint) hint.textContent = '试着清除筛选，或换个关键词；也可去频道库 / 播客看看';
      }
      return;
    }
    if (empty) empty.hidden = true;
    const currentId = state.currentVideo && String(state.currentVideo.id);
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.forEach((v) => {
      frag.appendChild(makeCard({
        title: videoTitle(v),
        meta: v.collection_name || v.channel_title || '',
        thumb: thumbUrl(v),
        active: currentId && String(v.id) === currentId,
      }, () => {
        closeVideoBrowser();
        selectVideo(v);
      }));
    });
    grid.appendChild(frag);
  }

  function renderChannelList() {
    const grid = document.getElementById('vb-grid');
    const empty = document.getElementById('vb-empty');
    const stats = document.getElementById('vb-stats');
    const hero = document.getElementById('vb-channel-hero');
    if (hero) hero.hidden = true;
    if (!grid) return;
    const q = String(vbState.query || '').trim().toLowerCase();
    const shared = readSharedFilters();
    const scene = shared.scene || vbState.scene || '';
    const channels = ensureChannelDefaults().filter((ch) => {
      const blob = [ch.title, ch.handle, ch.description].join(' ');
      if (scene && !matchesScene(blob, scene)) return false;
      if (!q) return true;
      return blob.toLowerCase().includes(q);
    });
    if (stats) stats.textContent = channels.length ? `${channels.length} 个频道` : '';
    if (!channels.length) {
      grid.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        const title = empty.querySelector('.vb-empty-title');
        const hint = empty.querySelector('.vb-empty-hint');
        if (title) title.textContent = '还没有频道';
        if (hint) hint.textContent = '点右上角添加 YouTube 频道';
      }
      return;
    }
    if (empty) empty.hidden = true;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    channels.forEach((ch) => {
      const thumb = (ch.videos && ch.videos[0] && ch.videos[0].thumbnail) || ch.image || '';
      frag.appendChild(makeCard({
        title: ch.title,
        meta: ch.handle ? '@' + ch.handle : (ch.description || 'YouTube 频道'),
        thumb,
      }, () => openChannelFeed(ch)));
    });
    grid.appendChild(frag);
  }

  async function openChannelFeed(channel) {
    const grid = document.getElementById('vb-grid');
    const empty = document.getElementById('vb-empty');
    const hero = document.getElementById('vb-channel-hero');
    const stats = document.getElementById('vb-stats');
    if (!grid) return;
    vbState.channelKey = channel.channelId || channel.handle || channel.title;
    if (empty) empty.hidden = true;
    if (stats) stats.textContent = '读取中…';
    grid.innerHTML = `<div class="vb-empty" style="grid-column:1/-1;padding:2rem;text-align:center;">
      <div class="vb-empty-title">正在读取频道…</div>
      <div class="vb-empty-hint">大约需要十几秒</div>
    </div>`;
    if (hero) {
      hero.hidden = false;
      const nameEl = document.getElementById('vb-channel-name');
      const descEl = document.getElementById('vb-channel-desc');
      const avatar = document.getElementById('vb-channel-avatar');
      if (nameEl) nameEl.textContent = channel.title || '频道';
      if (descEl) descEl.textContent = '加载中…';
      if (avatar) {
        avatar.textContent = String(channel.title || 'C').charAt(0).toUpperCase();
        avatar.style.backgroundImage = '';
      }
    }
    try {
      const live = await hydrateChannel(channel);
      const videos = (live.videos || []).map((item) => materializeChannelVideo(live.title, item));
      if (stats) stats.textContent = videos.length ? `${videos.length} 个视频` : '';
      const descEl = document.getElementById('vb-channel-desc');
      if (descEl) descEl.textContent = live.description || `来自 YouTube · ${videos.length} 个视频`;
      const avatar = document.getElementById('vb-channel-avatar');
      if (avatar && live.image) {
        avatar.textContent = '';
        avatar.style.backgroundImage = `url("${String(live.image).replace(/"/g, '')}")`;
        avatar.style.backgroundSize = 'cover';
      }
      if (!videos.length) {
        grid.innerHTML = `<div class="vb-empty" style="grid-column:1/-1;padding:2rem;text-align:center;">
          <div class="vb-empty-title">这个频道暂时没有可学视频</div>
        </div>`;
        return;
      }
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      videos.forEach((v) => {
        frag.appendChild(makeCard({
          title: videoTitle(v),
          meta: live.title || '频道视频',
          thumb: thumbUrl(v),
        }, () => {
          closeVideoBrowser();
          selectVideo(v);
        }));
      });
      grid.appendChild(frag);
    } catch (err) {
      if (stats) stats.textContent = '';
      grid.innerHTML = `<div class="vb-empty" style="grid-column:1/-1;padding:2rem;text-align:center;">
        <div class="vb-empty-title">频道读取失败</div>
        <div class="vb-empty-hint">${escapeHtml(err.message || '请稍后重试')}</div>
      </div>`;
      showToast(err.message || '频道读取失败', 'warn');
    }
  }

  async function hydrateChannel(channel) {
    if (!channel) return null;
    const cachedOk = Array.isArray(channel.videos) && channel.videos.length && !channel.seeded;
    if (cachedOk) return channel;
    const url = channel.pageUrl || (channel.handle ? `https://www.youtube.com/@${channel.handle}` : '');
    if (!url) return channel;
    const data = await postMedia('channels/preview', { url });
    const live = data.channel || {};
    const videos = Array.isArray(live.videos) ? live.videos : [];
    if (!videos.length) throw new Error('这个频道暂时没有可导入的视频');
    const list = ensureChannelDefaults().map((item) => (
      item.channelId === channel.channelId || item.defaultId === channel.defaultId
        ? {
          ...item,
          title: live.title || item.title,
          handle: live.handle || item.handle,
          pageUrl: live.pageUrl || item.pageUrl,
          youtubeChannelId: live.channelId || item.youtubeChannelId || '',
          image: live.image || item.image || '',
          description: live.description || `来自 YouTube · ${videos.length} 个视频`,
          videos,
          seeded: false,
        }
        : item
    ));
    writeStore(CHANNEL_STORE_KEY, list);
    return list.find((item) => item.channelId === channel.channelId || item.defaultId === channel.defaultId)
      || { ...channel, ...live, videos, seeded: false };
  }

  function renderVideoBrowser() {
    const grid = document.getElementById('vb-grid');
    if (!grid) return;
    syncLibraryChrome();

    if (vbState.libraryView === 'podcasts') {
      ensurePodcastDefaults();
      renderPodcastBrowser();
      return;
    }

    grid.classList.remove('pod-grid');
    if (vbState.libraryView === 'channels') {
      if (vbState.channelKey) {
        const ch = ensureChannelDefaults().find((c) =>
          String(c.channelId) === String(vbState.channelKey)
          || String(c.handle) === String(vbState.channelKey)
          || String(c.title) === String(vbState.channelKey));
        if (ch) {
          openChannelFeed(ch);
          return;
        }
        vbState.channelKey = '';
      }
      renderChannelList();
      return;
    }
    renderVideoCards(filteredVideos());
  }

  /* ---------- Podcast browser (same modal) ---------- */

  function openPodcastBrowser() {
    openVideoBrowser('podcasts');
  }

  function closePodcastBrowser() {
    podState.feedUrl = '';
    if (vbState.libraryView === 'podcasts') closeVideoBrowser();
  }

  async function hydratePodcast(show) {
    if (!show) return null;
    if (Array.isArray(show.episodes) && show.episodes.length && !String(show.feedUrl || '').startsWith('seed:')) {
      return show;
    }
    let feedUrl = show.feedUrl;
    if (String(feedUrl || '').startsWith('seed:podcast:')) {
      const data = await postMedia('podcasts/search', { query: show.query || show.title });
      const hit = (data.podcasts || data.results || data.items || [])[0];
      if (!hit || !hit.feedUrl) throw new Error('没有找到这个播客');
      feedUrl = hit.feedUrl;
      const list = ensurePodcastDefaults().map((item) => (
        item.defaultId === show.defaultId || item.feedUrl === show.feedUrl
          ? {
            ...item,
            feedUrl,
            title: hit.title || item.title,
            author: hit.author || item.author,
            image: hit.image || item.image,
            description: hit.description || item.description,
          }
          : item
      ));
      writeStore(PODCAST_STORE_KEY, list);
      show = list.find((item) => item.feedUrl === feedUrl) || { ...show, feedUrl };
    }
    const preview = await postMedia('podcasts/preview', {
      url: feedUrl,
      query: show.query || show.title,
    });
    const live = preview.podcast || preview.show || preview || {};
    const list = ensurePodcastDefaults().map((item) => (
      item.feedUrl === feedUrl || item.defaultId === show.defaultId
        ? {
          ...item,
          feedUrl,
          title: live.title || item.title,
          author: live.author || item.author,
          image: live.image || item.image,
          description: live.description || item.description,
          episodes: live.episodes || [],
        }
        : item
    ));
    writeStore(PODCAST_STORE_KEY, list);
    return list.find((item) => item.feedUrl === feedUrl) || { ...show, feedUrl, ...live };
  }

  function renderPodcastBrowser() {
    const grid = document.getElementById('vb-grid');
    const empty = document.getElementById('vb-empty');
    const hero = document.getElementById('vb-channel-hero');
    const stats = document.getElementById('vb-stats');
    const search = document.getElementById('vb-search');
    if (!grid) return;
    const q = String((search && search.value) || vbState.query || podState.query || '').trim().toLowerCase();
    podState.query = q;
    vbState.query = q;
    const shows = ensurePodcastDefaults();
    const show = shows.find((item) => item.feedUrl === podState.feedUrl) || null;

    if (hero) hero.hidden = !show;
    if (!show) {
      grid.classList.add('pod-grid');
      const shared = readSharedFilters();
      const scene = shared.scene || vbState.scene || '';
      const visible = shows.filter((item) => {
        const blob = [item.title, item.author, item.description].join(' ');
        if (scene && !matchesScene(blob, scene)) return false;
        if (!q) return true;
        return blob.toLowerCase().includes(q);
      });
      if (stats) stats.textContent = visible.length ? `${visible.length} 个播客` : '';
      if (!visible.length) {
        grid.innerHTML = '';
        if (empty) {
          empty.hidden = false;
          const title = empty.querySelector('.vb-empty-title');
          const hint = empty.querySelector('.vb-empty-hint');
          if (title) title.textContent = '还没有播客';
          if (hint) hint.textContent = '点右上角添加，或换个关键词搜索';
        }
        return;
      }
      if (empty) empty.hidden = true;
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      visible.forEach((item) => {
        frag.appendChild(makeCard({
          title: item.title,
          meta: item.author || '播客节目',
          thumb: item.image || '',
          square: true,
        }, () => openPodcastEpisodes(item)));
      });
      grid.appendChild(frag);
      return;
    }

    const nameEl = document.getElementById('vb-channel-name');
    const descEl = document.getElementById('vb-channel-desc');
    const avatar = document.getElementById('vb-channel-avatar');
    if (nameEl) nameEl.textContent = show.title || '播客';
    if (descEl) descEl.textContent = show.description || show.author || '';
    if (avatar) {
      avatar.textContent = '';
      if (show.image) {
        avatar.style.backgroundImage = `url("${String(show.image).replace(/"/g, '')}")`;
        avatar.style.backgroundSize = 'cover';
      } else {
        avatar.style.backgroundImage = '';
        avatar.textContent = String(show.title || 'P').trim().charAt(0).toUpperCase();
      }
    }

    let episodes = show.episodes || [];
    if (q) episodes = episodes.filter((ep) => String(ep.title || '').toLowerCase().includes(q));
    grid.classList.remove('pod-grid');
    if (stats) stats.textContent = episodes.length ? `${episodes.length} 集` : '';
    if (!episodes.length) {
      grid.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        const title = empty.querySelector('.vb-empty-title');
        const hint = empty.querySelector('.vb-empty-hint');
        if (title) title.textContent = '这个播客暂时没有节目';
        if (hint) hint.textContent = '稍后再试，或换一个播客';
      }
      return;
    }
    if (empty) empty.hidden = true;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    episodes.slice(0, 60).forEach((episode) => {
      frag.appendChild(makeCard({
        title: episode.title,
        meta: show.title || '播客',
        thumb: episode.image || show.image || '',
      }, () => playPodcastEpisode(show, episode)));
    });
    grid.appendChild(frag);
  }

  async function openPodcastEpisodes(show) {
    const grid = document.getElementById('vb-grid');
    const empty = document.getElementById('vb-empty');
    const stats = document.getElementById('vb-stats');
    if (empty) empty.hidden = true;
    if (stats) stats.textContent = '读取中…';
    if (grid) {
      grid.classList.remove('pod-grid');
      grid.innerHTML = `<div class="vb-empty" style="grid-column:1/-1;padding:2rem;text-align:center;">
        <div class="vb-empty-title">正在读取播客…</div>
        <div class="vb-empty-hint">首次打开可能需要十几秒</div>
      </div>`;
    }
    try {
      const live = await hydratePodcast(show);
      podState.feedUrl = live.feedUrl;
      renderPodcastBrowser();
    } catch (err) {
      if (stats) stats.textContent = '';
      if (grid) {
        grid.innerHTML = `<div class="vb-empty" style="grid-column:1/-1;padding:2rem;text-align:center;">
          <div class="vb-empty-title">播客读取失败</div>
          <div class="vb-empty-hint">${escapeHtml(err.message || '请稍后重试')}</div>
        </div>`;
      }
      showToast(err.message || '播客读取失败', 'warn');
    }
  }

  async function playPodcastEpisode(show, episode) {
    if (!episode || !episode.audioUrl) {
      showToast('这一集没有可播放的音频', 'warn');
      return;
    }
    closePodcastBrowser();
    const id = `pod:${episode.id || episode.audioUrl}`;
    const media = {
      id,
      title: episode.title || show.title,
      audioUrl: episode.audioUrl,
      image: episode.image || show.image,
      notes: episode.description || show.description || '',
      cues: [],
    };
    root.LinglishStudyMedia = media;
    root.LinglishStudyVideoId = '';

    const video = {
      id,
      title: media.title,
      original_filename: media.title,
      thumbnail_path: media.image,
      collection_name: show.title,
      external_podcast: true,
      audioUrl: media.audioUrl,
      status: 'ready',
      language: 'en',
    };

    const token = ++selectionToken;
    state.currentVideo = video;
    state.currentSegments = [];
    if (currentTitleEl) currentTitleEl.textContent = videoTitle(video);
    const introTitle = document.getElementById('intro-title');
    if (introTitle) introTitle.textContent = videoTitle(video);
    showLoadingOverlay();

    try {
      if (playerEl) {
        const yt = document.getElementById('youtube-player');
        if (yt) yt.style.display = 'none';
        playerEl.style.display = 'block';
        currentPlayerType = 'local';
        playerEl.src = media.audioUrl;
        playerEl.load();
        try { await playerEl.play(); } catch (_) {}
      }
      if (episode.transcriptUrl) {
        try {
          const data = await postMedia('cues', { url: episode.transcriptUrl });
          if (token !== selectionToken) return;
          const cues = (data.cues || []).map((cue, index) => ({
            index,
            text: cue.text,
            start: cue.start,
            end: cue.end,
          }));
          state.currentSegments = coerceSegments(cues);
          if (root.LinglishStudyMedia && root.LinglishStudyMedia.id === id) {
            root.LinglishStudyMedia.cues = state.currentSegments;
          }
          renderTranscript();
        } catch (_) {}
      } else {
        renderTranscript();
      }
      if (token !== selectionToken) return;
      hideOverlay();
    } catch (err) {
      setOverlay('error', '播客加载失败', err.message || '请重试');
      showToast(err.message || '播客加载失败', 'warn');
    }
  }

  /* ---------- Add dialogs ---------- */

  function openChannelDialog() {
    const dialog = document.getElementById('channel-dialog');
    const input = document.getElementById('channel-url');
    const error = document.getElementById('channel-dialog-error');
    if (error) error.textContent = '';
    if (input) input.value = '';
    if (dialog) dialog.hidden = false;
  }

  function closeChannelDialog() {
    const dialog = document.getElementById('channel-dialog');
    if (dialog) dialog.hidden = true;
  }

  async function submitChannelDialog() {
    const input = document.getElementById('channel-url');
    const error = document.getElementById('channel-dialog-error');
    const submit = document.getElementById('channel-submit');
    const url = String(input && input.value || '').trim();
    if (!url) {
      if (error) error.textContent = '请粘贴频道链接';
      return;
    }
    if (submit) submit.disabled = true;
    if (error) error.textContent = '正在读取…';
    try {
      const data = await postMedia('channels/preview', { url });
      const live = data.channel || {};
      const entry = {
        channelId: live.channelId || `yt:${Date.now()}`,
        youtubeChannelId: live.channelId || '',
        handle: live.handle || '',
        title: live.title || url,
        pageUrl: live.pageUrl || url,
        description: live.description || '',
        image: live.image || '',
        videos: live.videos || [],
      };
      const api = defaultsApi();
      const list = ensureChannelDefaults();
      if (api && api.findChannelDuplicate && api.findChannelDuplicate(list, entry)) {
        throw new Error('这个频道已经添加过了');
      }
      list.unshift(entry);
      writeStore(CHANNEL_STORE_KEY, list);
      closeChannelDialog();
      openVideoBrowser('channels');
      showToast('频道已添加', 'info');
    } catch (err) {
      if (error) error.textContent = err.message || '添加失败';
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function openPodcastDialog(mode) {
    podcastDialogMode = mode === 'rss' ? 'rss' : 'search';
    const dialog = document.getElementById('podcast-dialog');
    const title = document.getElementById('podcast-dialog-title');
    const label = document.getElementById('podcast-dialog-label');
    const input = document.getElementById('podcast-query');
    const results = document.getElementById('podcast-search-results');
    const error = document.getElementById('podcast-dialog-error');
    if (title) title.textContent = podcastDialogMode === 'rss' ? '通过 RSS 链接添加' : '搜索播客';
    if (label) label.textContent = podcastDialogMode === 'rss' ? 'RSS 链接' : '节目名称';
    if (input) {
      input.value = '';
      input.placeholder = podcastDialogMode === 'rss' ? 'https://example.com/feed.xml' : '例如 Spotlight English';
    }
    if (results) results.innerHTML = '';
    if (error) error.textContent = '';
    if (dialog) dialog.hidden = false;
  }

  function closePodcastDialog() {
    const dialog = document.getElementById('podcast-dialog');
    if (dialog) dialog.hidden = true;
  }

  async function submitPodcastDialog() {
    const input = document.getElementById('podcast-query');
    const results = document.getElementById('podcast-search-results');
    const error = document.getElementById('podcast-dialog-error');
    const submit = document.getElementById('podcast-submit');
    const value = String(input && input.value || '').trim();
    if (!value) {
      if (error) error.textContent = podcastDialogMode === 'rss' ? '请粘贴 RSS 链接' : '请输入节目名称';
      return;
    }
    if (submit) submit.disabled = true;
    if (error) error.textContent = '正在查找…';
    try {
      if (podcastDialogMode === 'rss') {
        await addPodcastByFeed(value);
        closePodcastDialog();
        openVideoBrowser('podcasts');
        showToast('播客已添加', 'info');
        return;
      }
      const data = await postMedia('podcasts/search', { query: value });
      const list = data.podcasts || data.results || data.items || [];
      if (!list.length) throw new Error('没有找到匹配的播客');
      if (results) {
        results.innerHTML = list.slice(0, 8).map((item, index) => `
          <button type="button" class="vb-chip" data-pod-pick="${index}" style="display:block;width:100%;margin:0.35rem 0;text-align:left;">
            <strong>${escapeHtml(item.title || '未命名')}</strong>
            <span style="display:block;opacity:0.7;font-size:0.85em;">${escapeHtml(item.author || item.feedUrl || '')}</span>
          </button>`).join('');
        results.querySelectorAll('[data-pod-pick]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const hit = list[Number(btn.getAttribute('data-pod-pick'))];
            if (!hit) return;
            try {
              await addPodcastByFeed(hit.feedUrl, hit);
              closePodcastDialog();
              openVideoBrowser('podcasts');
              showToast('播客已添加', 'info');
            } catch (err) {
              if (error) error.textContent = err.message || '添加失败';
            }
          });
        });
      }
      if (error) error.textContent = '';
    } catch (err) {
      if (error) error.textContent = err.message || '查找失败';
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function addPodcastByFeed(feedUrl, hint) {
    const preview = await postMedia('podcasts/preview', { url: feedUrl, query: hint && hint.title });
    const live = preview.podcast || preview.show || preview || {};
    const entry = {
      feedUrl: live.feedUrl || feedUrl,
      title: live.title || (hint && hint.title) || feedUrl,
      author: live.author || (hint && hint.author) || '',
      image: live.image || (hint && hint.image) || '',
      description: live.description || '',
      episodes: live.episodes || [],
    };
    const api = defaultsApi();
    const list = ensurePodcastDefaults();
    if (api && api.findPodcastDuplicate && api.findPodcastDuplicate(list, entry)) {
      throw new Error('这个播客已经添加过了');
    }
    list.unshift(entry);
    writeStore(PODCAST_STORE_KEY, list);
    podState.feedUrl = '';
  }

  /* ---------- Playback ---------- */

  async function loadVideos() {
    try {
      const res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers: headers() });
      if (!res.ok) throw new Error('视频列表加载失败');
      const data = await res.json();
      state.videos = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[desktop-app] loadVideos', err);
      state.videos = state.videos || [];
    }
    if (typeof root.renderTagFilters === 'function') {
      try { root.renderTagFilters(state.videos, true); } catch (_) {}
    }
    if (root.__vbOpen) renderVideoBrowser();
    return state.videos;
  }

  async function loadTranscriptForVideo(video, token) {
    if (!video) return;
    if (video.external_podcast) return;
    if (!/^\d+$/.test(String(video.id))) {
      // YouTube temp ids: try no server transcript
      state.currentSegments = [];
      renderTranscript();
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/video-resources/${video.id}`, { headers: headers() });
      if (!res.ok) throw new Error('详情加载失败');
      if (token !== selectionToken) return;
      const data = await res.json();
      const detail = data.video || data || {};
      let segs = coerceSegments(detail.transcript_segments || detail.video_sentences);
      if (!segs.length) {
        try {
          const trRes = await fetch(`${API_BASE}/video-resources/${video.id}/transcript`, { headers: headers() });
          if (trRes.ok) {
            const trData = await trRes.json().catch(() => ({}));
            segs = coerceSegments(trData.segments);
          }
        } catch (_) {}
      }
      if (token !== selectionToken) return;
      if (detail.youtube_video_id) {
        state.currentVideo.youtube_video_id = state.currentVideo.youtube_video_id || detail.youtube_video_id;
      }
      state.currentSegments = segs;
      renderTranscript();
    } catch (err) {
      console.warn('[desktop-app] transcript', err);
      if (token !== selectionToken) return;
      state.currentSegments = [];
      renderTranscript();
    }
  }

  async function playLocal(video) {
    if (!playerEl) return;
    const yt = document.getElementById('youtube-player');
    if (yt) yt.style.display = 'none';
    playerEl.style.display = 'block';
    currentPlayerType = 'local';
    let src = video.audioUrl || video.local_video_path || video.video_url || video.url || '';
    if (src && !/^https?:\/\//i.test(src) && !src.startsWith('blob:')) {
      src = API_BASE + (src.startsWith('/') ? '' : '/') + src;
    }
    if (!src) throw new Error('没有可播放的地址');
    playerEl.src = src;
    playerEl.load();
    try { await playerEl.play(); } catch (_) {}
  }

  async function playYouTube(video) {
    const ytId = video.youtube_video_id || video.youtubeId || (String(video.id || '').startsWith('yt:') ? String(video.id).slice(3) : '');
    if (!ytId) throw new Error('缺少 YouTube 视频 ID');
    if (playerEl) {
      playerEl.pause();
      playerEl.removeAttribute('src');
      playerEl.style.display = 'none';
    }
    const box = document.getElementById('youtube-player');
    if (box) box.style.display = 'block';
    currentPlayerType = 'youtube';
    if (root.YouTubePlayer) {
      if (!youtubePlayer) youtubePlayer = new root.YouTubePlayer('youtube-player');
      await youtubePlayer.init(ytId);
      try { youtubePlayer.playVideo && youtubePlayer.playVideo(); } catch (_) {}
      return;
    }
    if (box) {
      box.innerHTML = `<iframe title="YouTube" src="https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0"
        style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    }
  }

  const LAST_STUDY_MEDIA_KEY = 'linglish.last_study_media.v1';

  function writeDesktopLastMedia(v, seconds) {
    if (!v || v.id == null) return;
    const snap = {
      id: String(v.id),
      title: videoTitle(v),
      youtube_video_id: v.youtube_video_id || '',
      audioUrl: v.audioUrl || '',
      transcriptUrl: v.transcriptUrl || '',
      external_podcast: Boolean(v.external_podcast || v.audioUrl),
      external_youtube: Boolean(v.external_youtube || v.youtube_video_id),
      thumbnail_path: v.thumbnail_path || '',
      collection_name: v.collection_name || '',
      seconds: Math.max(0, Math.round(Number(seconds) || 0)),
      updatedAt: Date.now(),
    };
    try { root.localStorage.setItem(LAST_STUDY_MEDIA_KEY, JSON.stringify(snap)); } catch (_) {}
    if (/^\d+$/.test(String(v.id))) {
      try { root.localStorage.setItem('last_video_id', String(v.id)); } catch (_) {}
    }
    if (root.LinglishStudyRecent) {
      root.LinglishStudyRecent.record({
        id: snap.id,
        title: snap.title,
        thumb: snap.thumbnail_path,
        seconds: snap.seconds,
      });
    }
  }

  function readDesktopLastMedia() {
    try {
      const raw = root.localStorage.getItem(LAST_STUDY_MEDIA_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && data.id != null ? data : null;
    } catch (_) {
      return null;
    }
  }

  function videoFromDesktopSnap(snap) {
    if (!snap) return null;
    const id = String(snap.id);
    const yt = snap.youtube_video_id || (id.match(/^yt:([\w-]{6,})$/) || [])[1] || '';
    if (snap.external_podcast || snap.audioUrl) {
      return {
        id,
        title: snap.title || '播客',
        audioUrl: snap.audioUrl || '',
        transcriptUrl: snap.transcriptUrl || '',
        external_podcast: true,
        thumbnail_path: snap.thumbnail_path || '',
        collection_name: snap.collection_name || '',
        status: 'ready',
      };
    }
    if (yt) {
      return {
        id: id.startsWith('yt:') ? id : `yt:${yt}`,
        title: snap.title || `YouTube ${yt}`,
        youtube_video_id: yt,
        external_youtube: true,
        thumbnail_path: snap.thumbnail_path || `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
        status: 'ready',
      };
    }
    return null;
  }

  async function selectVideo(v) {
    if (!v) return;
    writeDesktopLastMedia(v);
    if (v.external_podcast || v.audioUrl) {
      await playPodcastEpisode(
        { title: v.collection_name || '播客', image: v.thumbnail_path },
        { title: v.title, audioUrl: v.audioUrl, image: v.thumbnail_path, transcriptUrl: v.transcriptUrl }
      );
      try {
        const url = new URL(root.location.href);
        url.searchParams.set('videoId', String(v.id));
        root.history.replaceState({}, '', url);
      } catch (_) {}
      return;
    }

    const token = ++selectionToken;
    state.currentVideo = v;
    state.currentSegments = [];
    root.LinglishStudyVideoId = /^\d+$/.test(String(v.id)) ? String(v.id) : '';
    if (!/^\d+$/.test(String(v.id))) {
      root.LinglishStudyMedia = {
        id: String(v.id),
        title: videoTitle(v),
        youtube_video_id: v.youtube_video_id || '',
        audioUrl: v.audioUrl || '',
        external_podcast: Boolean(v.external_podcast),
        external_youtube: Boolean(v.external_youtube || v.youtube_video_id),
        thumbnail_path: v.thumbnail_path || '',
        collection_name: v.collection_name || '',
      };
    } else {
      root.LinglishStudyMedia = null;
    }
    if (currentTitleEl) currentTitleEl.textContent = videoTitle(v);
    const idEl = document.getElementById('video-id');
    if (idEl) idEl.textContent = 'ID: ' + v.id;
    const introTitle = document.getElementById('intro-title');
    if (introTitle) introTitle.textContent = videoTitle(v);

    showLoadingOverlay();
    renderTranscript();

    try {
      const isYt = !!(v.youtube_video_id || v.external_youtube || v.source === 'youtube' || String(v.id || '').startsWith('yt:'));
      if (isYt) await playYouTube(v);
      else await playLocal(v);
      if (token !== selectionToken) return;
      hideOverlay();
      await loadTranscriptForVideo(v, token);
      try {
        const url = new URL(root.location.href);
        url.searchParams.set('videoId', String(v.id));
        if (v.youtube_video_id) url.searchParams.set('yt', String(v.youtube_video_id));
        else url.searchParams.delete('yt');
        root.history.replaceState({}, '', url);
      } catch (_) {}
    } catch (err) {
      console.error('[desktop-app] selectVideo', err);
      if (token !== selectionToken) return;
      setOverlay('error', '视频加载失败', err.message || '请重试或换一个视频');
      showToast(err.message || '视频加载失败', 'warn');
    }
    if (root.__vbOpen) renderVideoBrowser();
  }

  function applyVideoFilter() {
    if (root.__vbOpen) renderVideoBrowser();
  }

  function wireUi() {
    playerEl = document.getElementById('player');
    overlayEl = document.getElementById('player-overlay');
    overlayTitle = document.getElementById('player-overlay-title');
    overlayDesc = document.getElementById('player-overlay-desc');
    overlayRetry = document.getElementById('player-overlay-retry');
    overlayRefresh = document.getElementById('player-overlay-refresh');
    transcriptListEl = document.getElementById('transcript-list')
      || document.querySelector('.transcript-list')
      || document.getElementById('transcript');
    currentTitleEl = document.getElementById('current-title');

    document.getElementById('open-video-browser')?.addEventListener('click', (e) => {
      e.preventDefault();
      openVideoBrowser('videos');
    });
    document.getElementById('open-channel-browser')?.addEventListener('click', (e) => {
      e.preventDefault();
      openChannelBrowser();
    });
    document.getElementById('open-podcast-browser')?.addEventListener('click', (e) => {
      e.preventDefault();
      openPodcastBrowser();
    });

    document.getElementById('vb-close-btn')?.addEventListener('click', closeVideoBrowser);
    document.querySelectorAll('[data-vb-close]').forEach((el) => el.addEventListener('click', closeVideoBrowser));
    document.getElementById('pod-close-btn')?.addEventListener('click', closeVideoBrowser);
    document.querySelectorAll('[data-pod-close]').forEach((el) => el.addEventListener('click', closeVideoBrowser));

    document.getElementById('vb-channel-back')?.addEventListener('click', () => {
      if (vbState.libraryView === 'podcasts') {
        podState.feedUrl = '';
      } else {
        vbState.channelKey = '';
      }
      renderVideoBrowser();
    });

    document.querySelectorAll('[data-vb-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.vbView;
        if (view === 'channels' || view === 'podcasts' || view === 'videos') {
          openVideoBrowser(view);
        }
      });
    });

    document.getElementById('vb-filter-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = document.getElementById('vb-filter-pop');
      setFilterPopOpen(!!(pop && pop.hidden));
    });
    document.addEventListener('click', (e) => {
      const wrap = document.querySelector('.vb-filter-wrap');
      if (!wrap || wrap.contains(e.target)) return;
      setFilterPopOpen(false);
    });

    function activateChipRow(rowSelector, attr, value) {
      document.querySelectorAll(`${rowSelector} .vb-chip`).forEach((chip) => {
        const on = String(chip.getAttribute(attr) || '') === String(value || '');
        chip.classList.toggle('active', on);
      });
    }

    document.getElementById('vb-scope-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-scope]');
      if (!chip) return;
      const scope = chip.getAttribute('data-scope') || 'all';
      vbState.scope = scope;
      activateChipRow('#vb-scope-chips', 'data-scope', scope);
      if (typeof root.setLibraryFilter === 'function') root.setLibraryFilter({ scope });
      renderVideoBrowser();
    });
    document.getElementById('vb-diff-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-diff]');
      if (!chip) return;
      const difficulty = chip.getAttribute('data-diff') || '';
      vbState.difficulty = difficulty;
      activateChipRow('#vb-diff-chips', 'data-diff', difficulty);
      if (typeof root.setLibraryFilter === 'function') root.setLibraryFilter({ difficulty: difficulty || null });
      renderVideoBrowser();
    });
    document.getElementById('vb-scene-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-scene]');
      if (!chip) return;
      const scene = chip.getAttribute('data-scene') || '';
      vbState.scene = scene;
      activateChipRow('#vb-scene-chips', 'data-scene', scene);
      if (typeof root.setLibraryFilter === 'function') root.setLibraryFilter({ scene: scene || null });
      renderVideoBrowser();
    });
    document.getElementById('vb-status-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-status]');
      if (!chip) return;
      const status = chip.getAttribute('data-status') || '';
      vbState.status = status;
      activateChipRow('#vb-status-chips', 'data-status', status);
      renderVideoBrowser();
    });
    document.getElementById('vb-clear-all-btn')?.addEventListener('click', () => {
      vbState.difficulty = '';
      vbState.scene = '';
      vbState.status = '';
      vbState.scope = 'all';
      activateChipRow('#vb-scope-chips', 'data-scope', 'all');
      activateChipRow('#vb-diff-chips', 'data-diff', '');
      activateChipRow('#vb-scene-chips', 'data-scene', '');
      activateChipRow('#vb-status-chips', 'data-status', '');
      if (typeof root.setLibraryFilter === 'function') {
        root.setLibraryFilter({ difficulty: null, scene: null, tagId: null, scope: 'all' });
      }
      renderVideoBrowser();
    });

    const search = document.getElementById('vb-search');
    search?.addEventListener('input', () => {
      vbState.query = search.value || '';
      podState.query = vbState.query;
      renderVideoBrowser();
    });
    document.getElementById('vb-search-clear')?.addEventListener('click', () => {
      if (search) search.value = '';
      vbState.query = '';
      podState.query = '';
      renderVideoBrowser();
    });
    document.getElementById('vb-reset-btn')?.addEventListener('click', () => {
      vbState.query = '';
      vbState.difficulty = '';
      vbState.channelKey = '';
      podState.feedUrl = '';
      podState.query = '';
      if (search) search.value = '';
      if (typeof root.setLibraryFilter === 'function') {
        root.setLibraryFilter({ difficulty: null, scene: null, tagId: null, scope: 'all' });
      }
      renderVideoBrowser();
    });

    document.getElementById('vb-add-channel')?.addEventListener('click', openChannelDialog);
    document.getElementById('channel-dialog-x')?.addEventListener('click', closeChannelDialog);
    document.getElementById('channel-cancel')?.addEventListener('click', closeChannelDialog);
    document.getElementById('channel-submit')?.addEventListener('click', () => { submitChannelDialog(); });

    document.getElementById('pod-add-btn')?.addEventListener('click', () => {
      const menu = document.getElementById('pod-add-menu');
      if (menu) menu.hidden = !menu.hidden;
    });
    document.getElementById('pod-add-search')?.addEventListener('click', () => {
      const menu = document.getElementById('pod-add-menu');
      if (menu) menu.hidden = true;
      openPodcastDialog('search');
    });
    document.getElementById('pod-add-rss')?.addEventListener('click', () => {
      const menu = document.getElementById('pod-add-menu');
      if (menu) menu.hidden = true;
      openPodcastDialog('rss');
    });
    document.getElementById('podcast-dialog-x')?.addEventListener('click', closePodcastDialog);
    document.getElementById('podcast-cancel')?.addEventListener('click', closePodcastDialog);
    document.getElementById('podcast-submit')?.addEventListener('click', () => { submitPodcastDialog(); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const channelDialog = document.getElementById('channel-dialog');
      const podcastDialog = document.getElementById('podcast-dialog');
      const filterPop = document.getElementById('vb-filter-pop');
      if (channelDialog && !channelDialog.hidden) { closeChannelDialog(); return; }
      if (podcastDialog && !podcastDialog.hidden) { closePodcastDialog(); return; }
      if (filterPop && !filterPop.hidden) { setFilterPopOpen(false); return; }
      if (root.__vbOpen) closeVideoBrowser();
    });

    overlayRetry?.addEventListener('click', () => {
      if (!state.currentVideo) { openVideoBrowser('videos'); return; }
      selectVideo(state.currentVideo);
    });
    overlayRefresh?.addEventListener('click', () => root.location.reload());
    document.getElementById('back-to-list')?.addEventListener('click', (e) => {
      e.preventDefault();
      openVideoBrowser(vbState.libraryView || 'videos');
    });
  }

  async function restoreDesktopStudyVideo() {
    const params = new URLSearchParams(root.location.search);
    const videoId = String(params.get('videoId') || '').trim();
    const yt = String(params.get('yt') || '').trim();
    const last = readDesktopLastMedia();
    const recent = root.LinglishStudyRecent && root.LinglishStudyRecent.latest();
    const refs = [];
    if (videoId) refs.push({ id: videoId, youtube_video_id: yt || undefined });
    else if (yt) refs.push({ id: `yt:${yt}`, youtube_video_id: yt });
    if (last) refs.push(last);
    if (recent) refs.push(recent);
    try {
      const legacy = root.localStorage.getItem('last_video_id');
      if (legacy) refs.push({ id: legacy });
    } catch (_) {}

    for (const ref of refs) {
      if (!ref || ref.id == null) continue;
      let hit = state.videos.find((v) => String(v.id) === String(ref.id));
      if (!hit && /^\d+$/.test(String(ref.id))) {
        try {
          const res = await fetch(`${API_BASE}/video-resources/${ref.id}`, { headers: headers(false) });
          if (res.ok) {
            const data = await res.json();
            hit = data && (data.video || data);
            if (hit && hit.id != null && !state.videos.some((v) => String(v.id) === String(hit.id))) {
              state.videos = [hit, ...state.videos];
            }
          }
        } catch (_) {}
      }
      if (!hit) hit = videoFromDesktopSnap(ref);
      if (!hit && ref.youtube_video_id) {
        hit = videoFromDesktopSnap({ ...ref, id: `yt:${ref.youtube_video_id}` });
      }
      if (!hit && /^yt:/.test(String(ref.id))) hit = videoFromDesktopSnap(ref);
      if (!hit) continue;
      await selectVideo(hit);
      return true;
    }
    return false;
  }

  async function boot() {
    wireUi();
    ensureChannelDefaults();
    ensurePodcastDefaults();
    showIdleOverlay();
    await loadVideos();

    const params = new URLSearchParams(root.location.search);
    const restored = await restoreDesktopStudyVideo();
    if (!restored) showIdleOverlay();

    if (params.get('returnTo') === 'coach') {
      const library = params.get('library');
      if (library === 'podcasts') openPodcastBrowser();
      else if (library === 'channels') openChannelBrowser();
      else openVideoBrowser();
    }
  }

  root.openVideoBrowser = openVideoBrowser;
  root.closeVideoBrowser = closeVideoBrowser;
  root.openChannelBrowser = openChannelBrowser;
  root.openPodcastBrowser = openPodcastBrowser;
  root.closePodcastBrowser = closePodcastBrowser;
  root.renderVideoBrowser = renderVideoBrowser;
  root.renderPodcastBrowser = renderPodcastBrowser;
  root.selectVideo = selectVideo;
  root.loadVideos = loadVideos;
  root.applyVideoFilter = applyVideoFilter;
  root.hidePlayerOverlay = hideOverlay;
  root.showPlayerOverlay = setOverlay;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch((e) => console.error(e)); });
  } else {
    boot().catch((e) => console.error(e));
  }
})(typeof window !== 'undefined' ? window : this);
