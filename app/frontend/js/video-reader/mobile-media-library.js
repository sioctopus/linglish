/**
 * Mobile Video Lab — 我的视频 / 频道 / 播客 侧栏选取
 */
(function (root) {
  'use strict';

  const CHANNEL_STORE_KEY = 'linglish_channels_v1';
  const PODCAST_STORE_KEY = 'linglish_podcasts_v1';
  const CHANNEL_DEFAULTS_VERSION_KEY = 'linglish_channels_defaults_ver';
  const MEDIA_STORE_LIMIT = 80;

  const state = {
    view: 'videos',
    channelKey: '',
    feedUrl: '',
    busy: false,
  };

  function apiBase() {
    return root.API_BASE || '';
  }

  function authHeaders() {
    const token = root.localStorage && root.localStorage.getItem('linglish_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

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
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? root.setTimeout(() => controller.abort(), 45000)
      : null;
    let res;
    try {
      res = await fetch(`${apiBase()}/media/${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
      throw new Error('网络请求失败，请检查网络后重试');
    } finally {
      if (timer) root.clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || '请求失败');
    return data;
  }

  function firstPodcastHit(data) {
    const list = (data && (data.podcasts || data.results || data.items)) || [];
    return Array.isArray(list) ? list[0] : null;
  }

  function podcastPayload(preview) {
    if (!preview || typeof preview !== 'object') return {};
    return preview.podcast || preview.show || preview.feed || preview;
  }

  function setBusy(msg) {
    const shelf = document.getElementById('media-shelf');
    const browse = document.getElementById('library-panel-browse');
    if (browse) browse.hidden = false;
    if (!shelf) return;
    shelf.innerHTML = `<li class="media-shelf-empty">${escapeHtml(msg || '加载中…')}</li>`;
  }

  function collapseUploadForm() {
    const upload = document.getElementById('video-upload');
    const btn = document.getElementById('upload-toggle-btn');
    if (upload) {
      upload.classList.add('collapsed');
      upload.hidden = false;
    }
    if (btn) {
      btn.classList.remove('expanded');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function showVideosList(show) {
    const mine = document.getElementById('library-panel-mine');
    const browse = document.getElementById('library-panel-browse');
    const sidebar = document.getElementById('video-sidebar');
    if (mine) mine.hidden = !show;
    if (browse) browse.hidden = show;
    if (sidebar) {
      sidebar.classList.toggle('is-mine-view', show);
      sidebar.classList.toggle('is-browse-view', !show);
    }
    if (!show) collapseUploadForm();
  }

  function syncTabs() {
    document.querySelectorAll('[data-lib-src]').forEach((btn) => {
      const on = btn.getAttribute('data-lib-src') === state.view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function materializeChannelVideo(channelTitle, item) {
    const videos = (root.LinglishVideoReaderState && root.LinglishVideoReaderState.videos) || [];
    const existing = videos.find((v) => v.youtube_video_id && v.youtube_video_id === item.videoId);
    if (existing) return existing;
    return {
      id: `yt:${item.videoId}`,
      title: item.title,
      original_filename: item.title,
      youtube_video_id: item.videoId,
      thumbnail_path: item.thumbnail,
      collection_name: channelTitle,
      published: item.published,
      duration_sec: 0,
      external_youtube: true,
      status: 'ready',
      language: 'en',
    };
  }

  function renderBackRow(label, onBack) {
    const li = document.createElement('li');
    li.className = 'media-shelf-back';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-shelf-back-btn';
    btn.textContent = '‹ ' + label;
    btn.addEventListener('click', onBack);
    li.appendChild(btn);
    return li;
  }

  function renderShelfItem({ title, meta, thumb }, onClick) {
    const li = document.createElement('li');
    li.className = 'media-shelf-item';
    li.innerHTML = `
      <button type="button" class="media-shelf-card">
        <span class="media-shelf-thumb" aria-hidden="true">${thumb ? `<img alt="" src="${escapeHtml(thumb)}">` : (escapeHtml(String(title || 'V').charAt(0).toUpperCase()))}</span>
        <span class="media-shelf-copy">
          <strong>${escapeHtml(title || '未命名')}</strong>
          ${meta ? `<em>${escapeHtml(meta)}</em>` : ''}
        </span>
      </button>`;
    li.querySelector('button').addEventListener('click', onClick);
    return li;
  }

  async function hydrateChannel(channel) {
    if (!channel) return null;
    // Always refresh seeded / empty feeds so a previous failed load cannot stick.
    const cachedOk = Array.isArray(channel.videos) && channel.videos.length && !channel.seeded;
    if (cachedOk) return channel;
    const url = channel.pageUrl || (channel.handle ? `https://www.youtube.com/@${channel.handle}` : '');
    if (!url) throw new Error('这个频道没有可用地址');
    const data = await postMedia('channels/preview', { url });
    const live = data.channel || {};
    const videos = Array.isArray(live.videos) ? live.videos : [];
    if (!videos.length) throw new Error('暂时读不到这个频道的视频列表');
    const list = ensureChannelDefaults().map((item) => (
      item.channelId === channel.channelId || item.defaultId === channel.defaultId
        ? {
          ...item,
          title: live.title || item.title,
          handle: live.handle || item.handle,
          pageUrl: live.pageUrl || item.pageUrl,
          youtubeChannelId: live.channelId || item.youtubeChannelId || '',
          description: `来自 YouTube · ${videos.length} 个视频`,
          videos,
          seeded: false,
        }
        : item
    ));
    writeStore(CHANNEL_STORE_KEY, list);
    return list.find((item) => item.channelId === channel.channelId || item.defaultId === channel.defaultId)
      || { ...channel, videos, seeded: false, title: live.title || channel.title };
  }

  function podcastHasBrokenAudio(show) {
    const episodes = Array.isArray(show && show.episodes) ? show.episodes : [];
    return episodes.some((ep) => /sphinx\.acast\.com\/p\/open\//i.test(String(ep && ep.audioUrl || '')));
  }

  async function hydratePodcast(show) {
    if (!show) return null;
    const hasEps = Array.isArray(show.episodes) && show.episodes.length;
    const seeded = String(show.feedUrl || '').startsWith('seed:');
    // Old iTunes caches keep sphinx.acast.com stubs that 404 in the player.
    if (hasEps && !seeded && !podcastHasBrokenAudio(show)) {
      return show;
    }
    let feedUrl = show.feedUrl;
    if (String(feedUrl || '').startsWith('seed:podcast:')) {
      const data = await postMedia('podcasts/search', { query: show.query || show.title });
      const hit = firstPodcastHit(data);
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
      query: show.query || show.title || '',
      collectionId: show.collectionId || '',
    });
    const live = podcastPayload(preview) || {};
    const episodes = Array.isArray(live.episodes) ? live.episodes : [];
    if (!episodes.length) throw new Error('这个播客暂时没有可播放的单集');
    const nextFeed = live.feedUrl || feedUrl;
    const list = ensurePodcastDefaults().map((item) => (
      item.feedUrl === feedUrl || item.feedUrl === nextFeed || item.defaultId === show.defaultId
        ? {
          ...item,
          feedUrl: nextFeed,
          title: live.title || item.title,
          author: live.author || item.author,
          image: live.image || item.image,
          description: live.description || item.description,
          collectionId: live.collectionId || item.collectionId || '',
          query: item.query || show.query || '',
          episodes,
        }
        : item
    ));
    writeStore(PODCAST_STORE_KEY, list);
    return list.find((item) => item.feedUrl === nextFeed) || { ...show, feedUrl: nextFeed, episodes, title: live.title || show.title };
  }

  async function resolvePlayablePodcastAudio(video) {
    if (!video || !video.external_podcast) return video;
    const audio = String(video.audioUrl || '');
    if (audio && !/sphinx\.acast\.com\/p\/open\//i.test(audio)) return video;
    const shows = ensurePodcastDefaults();
    const show = shows.find((item) => {
      const eps = Array.isArray(item.episodes) ? item.episodes : [];
      return eps.some((ep) => (
        `pod:${ep.id || ep.audioUrl}` === String(video.id)
        || String(ep.title || '') === String(video.title || '')
      ));
    }) || shows.find((item) => String(item.title || '') === String(video.collection_name || ''));
    if (!show) return video;
    const live = await hydratePodcast({ ...show, episodes: podcastHasBrokenAudio(show) ? [] : show.episodes });
    const episodes = (live && live.episodes) || [];
    const hit = episodes.find((ep) => (
      `pod:${ep.id || ep.audioUrl}` === String(video.id)
      || String(ep.title || '') === String(video.title || '')
    )) || null;
    if (!hit || !hit.audioUrl) return video;
    return {
      ...video,
      audioUrl: hit.audioUrl,
      transcriptUrl: hit.transcriptUrl || video.transcriptUrl || '',
      thumbnail_path: hit.image || video.thumbnail_path || live.image || '',
      collection_name: live.title || video.collection_name,
    };
  }

  async function pickVideo(video) {
    let next = video;
    try {
      if (video && video.external_podcast) {
        next = await resolvePlayablePodcastAudio(video);
      }
    } catch (_) { /* keep original */ }
    if (typeof root.selectVideo === 'function') {
      root.selectVideo(next);
      return;
    }
    if (typeof root.selectVideoByEntry === 'function') {
      root.selectVideoByEntry(next);
    }
  }

  async function openChannelFeed(channel) {
    state.channelKey = `import:${channel.channelId}`;
    showVideosList(false);
    setBusy('正在读取频道…');
    try {
      const live = await hydrateChannel(channel);
      const shelf = document.getElementById('media-shelf');
      if (!shelf) return;
      shelf.innerHTML = '';
      shelf.appendChild(renderBackRow('全部频道', () => {
        state.channelKey = '';
        renderChannels();
      }));
      const videos = (live.videos || []).map((item) => materializeChannelVideo(live.title, item));
      if (!videos.length) {
        shelf.appendChild(Object.assign(document.createElement('li'), {
          className: 'media-shelf-empty',
          textContent: '这个频道暂时没有可学视频',
        }));
        return;
      }
      videos.forEach((video) => {
        shelf.appendChild(renderShelfItem({
          title: video.title,
          meta: live.title || '频道视频',
          thumb: video.thumbnail_path,
        }, () => pickVideo(video)));
      });
    } catch (err) {
      const msg = err && err.message ? String(err.message) : '频道读取失败';
      if (/没有可导入|没有可用|没有内容/.test(msg)) {
        setBusy('这个频道暂时没有可学视频，换一个频道试试，或先用「我的视频」。');
      } else if (/网络|超时|代理|proxy|读不到 YouTube/i.test(msg)) {
        setBusy('暂时读不到这个频道的视频列表。请检查网络或代理后重试，也可先用「我的视频」里已有内容。');
      } else {
        setBusy(msg);
      }
    }
  }

  async function openPodcastEpisodes(show) {
    state.feedUrl = show.feedUrl;
    showVideosList(false);
    setBusy('正在读取播客…');
    try {
      const live = await hydratePodcast(show);
      state.feedUrl = live.feedUrl;
      const shelf = document.getElementById('media-shelf');
      if (!shelf) return;
      shelf.innerHTML = '';
      shelf.appendChild(renderBackRow('全部播客', () => {
        state.feedUrl = '';
        renderPodcasts();
      }));
      const episodes = live.episodes || [];
      if (!episodes.length) {
        shelf.appendChild(Object.assign(document.createElement('li'), {
          className: 'media-shelf-empty',
          textContent: '这个播客暂时没有节目',
        }));
        return;
      }
      episodes.slice(0, 40).forEach((episode) => {
        shelf.appendChild(renderShelfItem({
          title: episode.title,
          meta: live.title || live.author || '播客',
          thumb: episode.image || live.image,
        }, () => {
          const id = `pod:${episode.id || episode.audioUrl}`;
          pickVideo({
            id,
            title: episode.title || live.title,
            original_filename: episode.title || live.title,
            thumbnail_path: episode.image || live.image,
            collection_name: live.title,
            duration_sec: 0,
            external_podcast: true,
            audioUrl: episode.audioUrl,
            transcriptUrl: episode.transcriptUrl || '',
            status: 'ready',
            language: 'en',
          });
        }));
      });
    } catch (err) {
      setBusy(err.message || '播客读取失败');
    }
  }

  function renderChannels() {
    showVideosList(false);
    const shelf = document.getElementById('media-shelf');
    if (!shelf) return;
    const channels = ensureChannelDefaults();
    shelf.hidden = false;
    shelf.innerHTML = '';
    if (!channels.length) {
      shelf.innerHTML = '<li class="media-shelf-empty">还没有频道</li>';
      return;
    }
    channels.forEach((channel) => {
      shelf.appendChild(renderShelfItem({
        title: channel.title,
        meta: channel.handle ? `@${channel.handle}` : (channel.description || 'YouTube 频道'),
        thumb: (channel.videos && channel.videos[0] && channel.videos[0].thumbnail) || '',
      }, () => openChannelFeed(channel)));
    });
  }

  function renderPodcasts() {
    showVideosList(false);
    const shelf = document.getElementById('media-shelf');
    if (!shelf) return;
    const shows = ensurePodcastDefaults();
    shelf.hidden = false;
    shelf.innerHTML = '';
    if (!shows.length) {
      shelf.innerHTML = '<li class="media-shelf-empty">还没有播客</li>';
      return;
    }
    shows.forEach((show) => {
      shelf.appendChild(renderShelfItem({
        title: show.title,
        meta: show.author || '播客节目',
        thumb: show.image || '',
      }, () => openPodcastEpisodes(show)));
    });
  }

  function setView(view) {
    const next = view === 'channels' || view === 'podcasts' ? view : 'videos';
    state.view = next;
    state.channelKey = '';
    state.feedUrl = '';
    syncTabs();
    if (next === 'channels') renderChannels();
    else if (next === 'podcasts') renderPodcasts();
    else showVideosList(true);
  }

  function init() {
    const params = new URLSearchParams(root.location.search || '');
    const library = params.get('library');
    const tabs = document.querySelector('.library-source-tabs');
    if (tabs && tabs.dataset.libTabsWired !== '1') {
      tabs.dataset.libTabsWired = '1';
      tabs.addEventListener('click', (event) => {
        const btn = event.target && event.target.closest
          ? event.target.closest('[data-lib-src]')
          : null;
        if (!btn || !tabs.contains(btn)) return;
        event.preventDefault();
        setView(btn.getAttribute('data-lib-src'));
      });
    }
    if (library === 'channels' || library === 'podcasts' || library === 'videos') {
      setView(library);
    } else {
      setView('videos');
    }
  }

  root.LinglishMobileMediaLibrary = {
    init,
    setView,
    getView: () => state.view,
    resolvePlayablePodcastAudio,
    hydratePodcast,
  };
})(typeof window !== 'undefined' ? window : globalThis);
