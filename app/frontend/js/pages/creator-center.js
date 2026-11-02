(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishCreatorCenter = api;
  if (root?.document) root.document.addEventListener('DOMContentLoaded', () => {
    if (root.document.getElementById('creator-center')) api.boot(root);
  });
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function publicHttpUrl(value) {
    if (!String(value || '').trim()) return null;
    let url;
    try { url = new URL(String(value).trim()); } catch (_) { throw new Error('请填写有效的公开 http 或 https 作品链接。'); }
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    const invalid = () => { throw new Error('作品链接须为公开的 http 或 https 地址，不能包含登录信息或本地地址。'); };
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000
      || !host || /(^|\.)(localhost|local|internal|test|invalid|example|lan|home)$/.test(host)) invalid();
    if (host.includes(':')) {
      const first = parseInt(host.split(':')[0] || '0', 16);
      const second = parseInt(host.split(':')[1] || '0', 16);
      if (first < 0x2000 || first > 0x3fff || first === 0x2002 || (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) || (first === 0x3fff && second <= 0xfff)) invalid();
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 192 && b === 0 && [0, 2].includes(c)) || (a === 192 && b === 88 && c === 99)
        || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) invalid();
    } else if (!host.includes('.') || /^[\d.]+$/.test(host)) invalid();
    return url.href;
  }

  function boundedText(value, limit, label) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new Error(`${label}不能为空，且不能超过 ${limit} 字。`);
    return value.trim();
  }

  function applicationPayload(form) {
    if (form.rights_confirmed !== true) throw new Error('请先确认内容的使用与公开传播授权。');
    return { display_name: boundedText(form.display_name, 80, '创作者名称'), bio: boundedText(form.bio, 1200, '创作介绍'), topic: boundedText(form.topic, 80, '内容主题'), sample_url: publicHttpUrl(form.sample_url), rights_confirmed: true };
  }

  function isPublishReady(video) {
    if (!video || video._detailFailed || video.status !== 'ready' || /^audio\//i.test(video.mime_type || '')) return false;
    if (!String(video.local_video_path || video.video_path || '').startsWith('/videos/') && !video.youtube_video_id) return false;
    let segments = video.transcript_segments;
    if (typeof segments === 'string') { try { segments = JSON.parse(segments); } catch (_) { return false; } }
    return Array.isArray(segments) && segments.some(seg => {
      const start = Number(seg?.start ?? seg?.start_sec ?? seg?.start_time_sec);
      const end = Number(seg?.end ?? seg?.end_sec ?? seg?.end_time_sec);
      return typeof seg?.text === 'string' && Boolean(seg.text.trim()) && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
    });
  }

  function resourceState(video, requests) {
    const matches = (requests || []).filter(item => String(item.video_id) === String(video.id));
    const pending = matches.find(item => item.status === 'pending');
    const latest = matches.filter(item => item.request_type === 'public').sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
    if (video.is_public === true) return { key: 'published', label: '已公开', locked: true, note: '已加入公共视频库。需要修改时，请创建新草稿。' };
    if (pending) return { key: 'pending', label: pending.request_type === 'featured' ? '精选审核中' : '公开审核中', locked: true, note: '审核期间暂不能编辑或重复提交。需要修改时，请创建新草稿。' };
    if (video.status === 'processing' || video.status === 'pending') return { key: 'processing', label: '处理中', note: '视频与字幕正在后台处理，可稍后刷新状态。' };
    if (video.status === 'failed') return { key: 'failed', label: '处理失败', note: video.failure_reason || '处理未完成，请检查文件后重新上传。' };
    if (video._detailFailed) return { key: 'unchecked', label: '状态待确认', note: '未能确认字幕，请刷新后重试。' };
    if (!isPublishReady(video)) return { key: 'needs-transcript', label: '待补字幕', note: '需要处理完成且有可用字幕，才能提交公开审核。' };
    if (latest?.status === 'rejected') return { key: 'rejected', label: '未通过', note: latest.review_note || '可完善私人草稿后重新提交审核。' };
    return { key: 'draft', label: '私人草稿', note: '仅你可见。确认内容和字幕后，可提交公开审核。' };
  }

  function videoFile(file) { return Boolean(file && /^video\//i.test(file.type || '') && Number(file.size) > 0); }
  function learningHref(id, width) {
    if (!/^[1-9]\d{0,18}$/.test(String(id))) throw new Error('无效的视频编号。');
    return `./video-reader${Number(width) < 1024 ? '' : '-desktop'}.html?videoId=${encodeURIComponent(String(id))}`;
  }

  function tokenIdentity(token) {
    try {
      let encoded = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      encoded += '='.repeat((4 - encoded.length % 4) % 4);
      const data = JSON.parse(typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString());
      return data.sub == null ? null : String(data.sub);
    } catch (_) { return null; }
  }

  function accountChanged() { return Object.assign(new Error('账号已变更，请重新加载后操作。'), { code: 'ACCOUNT_CHANGED' }); }
  function createRequest(auth, fetcher) {
    return async function request(path, options = {}) {
      await auth?.ready;
      await auth?.ensureSession?.();
      const token = auth?.getToken?.();
      if (!token || ['null', 'undefined'].includes(token)) throw Object.assign(new Error('请登录后继续。'), { status: 401 });
      const subject = tokenIdentity(token);
      if (options.accountId != null && subject != null && subject !== String(options.accountId)) throw accountChanged();
      const headers = { Authorization: `Bearer ${token}` };
      if (!options.multipart) headers['Content-Type'] = 'application/json';
      const response = await fetcher(path, { method: options.method || 'GET', headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal, ...(options.body !== undefined ? { body: options.multipart ? options.body : JSON.stringify(options.body) } : {}) });
      const data = await response.json().catch(() => null);
      const current = auth?.getToken?.();
      const currentSubject = tokenIdentity(current);
      if (!current || (subject != null && currentSubject !== subject) || (subject == null && current !== token)) throw accountChanged();
      if (!response.ok) throw Object.assign(new Error(data?.message || '请求失败，请重试。'), { status: response.status });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务器未返回有效结果，请重试。');
      return data;
    };
  }

  async function loadShareRequests(request, options = {}, isCurrent = () => true) {
    const incomplete = () => new Error('审核状态未完整返回，请刷新后重试。');
    const checkCurrent = () => {
      if (options.signal?.aborted || !isCurrent()) throw Object.assign(new Error('内容加载已取消。'), { name: 'AbortError' });
    };
    checkCurrent();
    // Pending requests of either type lock editing. History is bounded separately
    // so old reviews cannot hide a pending lock beyond the server's 100-row cap.
    const recent = await request('/api/video-share-requests?status=all&request_type=public&limit=100&offset=0', options);
    checkCurrent();
    if (!Array.isArray(recent.items) || recent.items.length > 100) throw incomplete();
    const requests = recent.items.filter(item => item.request_type === 'public');
    const seen = new Set();
    for (let offset = 0; offset < 10000; offset += 100) {
      checkCurrent();
      const data = await request(`/api/video-share-requests?status=pending&limit=100&offset=${offset}`, options);
      checkCurrent();
      if (!Array.isArray(data.items) || data.items.length > 100 || data.items.some(item => !item || !/^[1-9]\d*$/.test(String(item.id)) || item.status !== 'pending')) throw incomplete();
      const fresh = data.items.filter(item => !seen.has(String(item.id)));
      if (data.items.length && !fresh.length) throw incomplete();
      fresh.forEach(item => { seen.add(String(item.id)); requests.push(item); });
      if (data.items.length < 100) return requests;
    }
    throw incomplete();
  }

  function errorMessage(error) {
    if (error?.status === 401) return '登录已过期，请重新登录。未提交的内容会在本页保留。';
    const messages = { CREATOR_REGISTERED_ACCOUNT_REQUIRED: '请使用正式注册账号申请；游客账号暂不能申请创作者。', CREATOR_APPLICATION_CONFLICT: '申请状态已变化，请刷新查看最新结果。', CREATOR_RIGHTS_CONFIRMATION_REQUIRED: '请确认你拥有内容的使用与公开传播授权。', FILE_TOO_LARGE: '视频超过当前上传大小限制，请压缩文件或查看会员权益。', GUEST_UPLOAD_FORBIDDEN: '请先注册或登录正式账号，再上传视频。' };
    return messages[error?.message] || error?.message || '暂时无法连接，请重试。';
  }

  function boot(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    const request = createRequest(win.AuthManager, win.fetch.bind(win));
    const state = { user: null, application: null, videos: [], requests: [], generation: 0, file: null, busy: false, editing: null, publishing: null, loaded: false, formOwnerId: null };
    const drafts = new Map();
    const applicationForm = $('application-form');
    const uploadForm = $('upload-form');
    const loginHref = './mobile-auth.html?' + new URLSearchParams({ next: 'creator-center.html' });
    $('creator-login').href = loginHref;

    function message(text, kind = 'info', retry = false) {
      $('creator-message').textContent = text;
      $('creator-message').dataset.kind = kind;
      $('creator-message').hidden = !text;
      $('creator-retry').hidden = !retry;
    }
    function values() {
      return { display_name: $('creator-display-name').value, topic: $('creator-topic').value, bio: $('creator-bio').value, sample_url: $('creator-sample-url').value, rights_confirmed: $('creator-rights').checked };
    }
    function fillApplication(value) {
      $('creator-display-name').value = value?.display_name || '';
      $('creator-topic').value = value?.topic || '';
      $('creator-bio').value = value?.bio || '';
      $('creator-sample-url').value = value?.sample_url || '';
      $('creator-rights').checked = value?.rights_confirmed === true;
    }
    function saveDraft() {
      // Account lookup can finish while the forms are still cleared for loading.
      // Only save a fully restored form belonging to this account.
      if (!state.loaded || !state.user || state.formOwnerId !== String(state.user.id)) return;
      drafts.set(String(state.user.id), { application: values(), upload: { title: $('upload-title-input').value, description: $('upload-description').value, category: $('upload-category').value, file: state.file } });
    }
    function restoreDraft(user) {
      const draft = drafts.get(String(user.id));
      fillApplication(draft?.application || state.application);
      $('upload-title-input').value = draft?.upload.title || '';
      $('upload-description').value = draft?.upload.description || '';
      $('upload-category').value = draft?.upload.category || '';
      state.file = draft?.upload.file || null;
      $('selected-video-file').textContent = state.file ? `已选择：${state.file.name}` : 'MP4、MOV 等视频格式；不支持单独上传音频。';
      state.formOwnerId = String(user.id);
    }
    function formBusy(form, busy) {
      form.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = busy; });
      form.setAttribute('aria-busy', String(busy));
    }
    function renderApplication() {
      const app = state.application;
      const status = app?.status || 'none';
      const labels = { none: '待申请', pending: '资格审核中', approved: '创作者已通过', rejected: '申请未通过' };
      $('application-status').textContent = labels[status] || '状态待确认';
      $('application-status').dataset.status = status;
      $('application-fields').disabled = state.busy || !state.loaded || !['none', 'rejected'].includes(status);
      $('application-submit').hidden = ['pending', 'approved'].includes(status);
      $('application-submit').textContent = status === 'rejected' ? '修改并重新提交' : '提交创作者申请';
      $('application-note').textContent = status === 'pending' ? '申请已提交，审核期间无需重复申请。可先整理私人草稿，稍后刷新查看结果。'
        : status === 'approved' ? '创作者资格已通过。视频仍需逐条提交内容审核，通过后才会公开。'
          : status === 'rejected' ? `审核意见：${app.review_note || '请完善申请资料后重新提交。'}` : '告诉我们你擅长的主题。申请资料只对你和审核管理员可见。';
      $('creator-primary').href = status === 'approved' ? '#upload-section' : '#application-section';
      $('creator-primary').textContent = status === 'approved' ? '上传下一段视频 ↗' : status === 'pending' ? '查看申请状态 ↗' : '开始申请 ↗';
    }
    function textNode(tag, className, text) {
      const el = doc.createElement(tag); if (className) el.className = className; el.textContent = text; return el;
    }
    function action(label, callback, primary = false) {
      const el = textNode('button', `button ${primary ? 'primary' : 'secondary'}`, label); el.type = 'button'; el.addEventListener('click', callback); return el;
    }
    function renderResources() {
      const list = $('resource-list'); list.replaceChildren(); $('resource-count').textContent = String(state.videos.length);
      if (!state.videos.length) { list.append(textNode('div', 'resource-empty', '这里还没有内容。上传第一段视频，先为自己留一份私人草稿。')); return; }
      state.videos.forEach(video => {
        const status = resourceState(video, state.requests);
        const card = textNode('article', 'resource-card', ''); card.dataset.videoId = String(video.id);
        const cover = textNode('div', 'resource-cover', String(video.title || 'L').slice(0, 1)); cover.setAttribute('aria-hidden', 'true');
        const detail = textNode('div', 'resource-detail', ''); detail.append(textNode('h3', '', video.title || `视频 ${video.id}`));
        const meta = textNode('div', 'resource-meta', ''); const chip = textNode('span', 'status-chip', status.label); chip.dataset.status = status.key;
        meta.append(chip, textNode('span', '', [video.category || '未分类', video.difficulty_level?.toUpperCase()].filter(Boolean).join(' · '))); detail.append(meta, textNode('p', 'resource-note', status.note));
        const actions = textNode('div', 'resource-actions', '');
        if (video.status === 'ready') { const link = textNode('a', '', '预览学习'); link.href = learningHref(video.id, win.innerWidth); link.dataset.learningVideo = String(video.id); actions.append(link); }
        if (!status.locked) actions.append(action('编辑草稿', () => openEditor(video)));
        if (!status.locked && isPublishReady(video) && (state.application?.status === 'approved' || state.user?.is_admin === true)) actions.append(action(status.key === 'rejected' ? '重新提交审核' : '提交公开审核', () => openPublish(video), true));
        card.append(cover, detail, actions); list.append(card);
      });
    }
    function clearAccountView() {
      state.user = null; state.application = null; state.videos = []; state.requests = []; state.loaded = false; state.file = null; state.formOwnerId = null;
      [applicationForm, uploadForm, $('editor-form'), $('publish-form')].forEach(form => formBusy(form, false));
      applicationForm.reset(); uploadForm.reset(); $('resource-list').replaceChildren();
      ['application-section', 'upload-section', 'resources-section'].forEach(id => { $(id).hidden = true; });
      $('login-panel').hidden = true;
      $('creator-primary').href = '#application-section';
      $('creator-primary').textContent = '开始申请 ↗';
      ['resource-editor', 'publish-dialog'].forEach(id => { if ($(id).open) $(id).close(); });
      state.editing = null; state.publishing = null;
    }
    async function loadResources(generation) {
      const options = { accountId: state.user.id };
      const [videos, requests] = await Promise.all([request('/video-resources?mine=1&lite=1', options), loadShareRequests(request, options, () => generation === state.generation)]);
      if (generation !== state.generation) return;
      if (!Array.isArray(videos.items)) throw new Error('内容列表未完整返回，请重试。');
      const owned = videos.items.filter(video => String(video.uploader_id) === String(options.accountId));
      // Lite listings intentionally omit captions. Confirm full server data before
      // enabling publication, and keep an unverified video closed on failure.
      for (let start = 0; start < owned.length; start += 4) {
        await Promise.all(owned.slice(start, start + 4).map(async video => {
          if (video.status !== 'ready') return;
          try {
            const data = await request(`/video-resources/${encodeURIComponent(String(video.id))}`, options);
            if (!data.video || String(data.video.uploader_id) !== String(options.accountId)) throw new Error('无法确认内容归属。');
            Object.assign(video, data.video);
          } catch (error) {
            if (error.code === 'ACCOUNT_CHANGED' || error.status === 401) throw error;
            video._detailFailed = true;
          }
        }));
        if (generation !== state.generation) return;
      }
      if (generation !== state.generation) return;
      state.videos = owned; state.requests = requests; renderResources();
    }
    async function load() {
      if (state.busy) return;
      saveDraft(); const generation = ++state.generation; clearAccountView(); message('正在加载你的创作空间…');
      try {
        const user = await request('/users/me');
        if (generation !== state.generation) return;
        if (!user.id) throw new Error('无法确认当前账号，请重新登录。');
        state.user = user;
        const data = await request('/api/creator/application', { accountId: user.id });
        if (generation !== state.generation) return;
        if (!Object.prototype.hasOwnProperty.call(data, 'application')) throw new Error('申请状态未完整返回，请重试。');
        state.application = data.application;
        await loadResources(generation);
        if (generation !== state.generation) return;
        restoreDraft(user); state.loaded = true; renderApplication();
        ['application-section', 'upload-section', 'resources-section'].forEach(id => { $(id).hidden = false; }); message('');
      } catch (error) {
        if (generation !== state.generation) return;
        clearAccountView();
        $('login-panel').hidden = error.status !== 401 && error.status !== 403;
        message(errorMessage(error), 'error', true);
      }
    }
    async function mutation(form, run, errorId) {
      if (state.busy || !state.user || !state.loaded) return;
      state.busy = true; const generation = state.generation; formBusy(form, true);
      if (errorId) $(errorId).hidden = true;
      try { await run({ accountId: state.user.id }, generation); }
      catch (error) {
        if (generation !== state.generation) return;
        if (error.code === 'ACCOUNT_CHANGED') { state.busy = false; await load(); return; }
        if (errorId) { $(errorId).textContent = errorMessage(error); $(errorId).hidden = false; }
        else message(errorMessage(error), 'error', true);
      } finally {
        if (generation === state.generation) { state.busy = false; formBusy(form, false); renderApplication(); saveDraft(); }
      }
    }
    applicationForm.addEventListener('submit', event => {
      event.preventDefault(); if (!['rejected', undefined].includes(state.application?.status)) return;
      let body; try { body = applicationPayload(values()); } catch (error) { message(error.message, 'error'); return; }
      mutation(applicationForm, async (options, generation) => {
        const data = await request('/api/creator/application', { ...options, method: 'POST', body });
        if (generation !== state.generation) return;
        if (!data.application?.status) throw new Error('申请结果未完整返回，请刷新确认，避免重复提交。');
        state.application = data.application; fillApplication(data.application); renderApplication(); message('申请已提交。审核结果会显示在这里。');
      });
    });
    $('creator-video-file').addEventListener('change', () => {
      state.file = $('creator-video-file').files[0] || null;
      $('selected-video-file').textContent = state.file ? `已选择：${state.file.name}` : '请选择一个视频文件。';
      if (state.file && !$('upload-title-input').value) $('upload-title-input').value = state.file.name.replace(/\.[^.]+$/, '').slice(0, 200);
    });
    uploadForm.addEventListener('submit', event => {
      event.preventDefault(); if (!videoFile(state.file)) { message('请选择非空的视频文件；当前不支持单独上传音频。', 'error'); return; }
      const body = new win.FormData(); body.append('video', state.file); body.append('title', $('upload-title-input').value.trim()); body.append('description', $('upload-description').value.trim()); body.append('category', $('upload-category').value.trim()); body.append('language', 'en'); body.append('is_public', 'false');
      mutation(uploadForm, async (options, generation) => {
        $('upload-status').textContent = '正在上传，请保持此页面打开…';
        const data = await request('/video-resources/upload', { ...options, method: 'POST', body, multipart: true });
        if (generation !== state.generation) return;
        if (!data.video?.id) throw new Error('未能确认上传结果，请刷新列表后再重试。');
        uploadForm.reset(); state.file = null; $('selected-video-file').textContent = 'MP4、MOV 等视频格式；不支持单独上传音频。'; $('upload-status').textContent = '已上传，正在后台处理。';
        message('视频已保存为私人草稿。处理和字幕就绪后，可提交公开审核。');
        await loadResources(generation);
      }).finally(() => { if (state.file) $('upload-status').textContent = '上传未完成，所选文件仍保留，可重试。'; });
    });
    function openEditor(video) {
      state.editing = video; $('edit-title').value = video.title || ''; $('edit-description').value = video.description || ''; $('edit-category').value = video.category || ''; $('edit-difficulty').value = String(video.difficulty_level || '').toLowerCase(); $('editor-error').hidden = true; $('resource-editor').showModal();
    }
    $('editor-form').addEventListener('submit', event => {
      event.preventDefault(); const video = state.editing; if (!video || resourceState(video, state.requests).locked) return;
      const body = { title: $('edit-title').value.trim(), description: $('edit-description').value.trim(), category: $('edit-category').value.trim() || null, difficulty_level: $('edit-difficulty').value || null };
      mutation($('editor-form'), async (options, generation) => {
        const data = await request(`/video-resources/${encodeURIComponent(String(video.id))}`, { ...options, method: 'PATCH', body });
        if (generation !== state.generation) return;
        if (!data.video?.id) throw new Error('保存结果未完整返回，请刷新确认。');
        Object.assign(video, data.video); renderResources(); $('resource-editor').close(); message('草稿已保存。');
      }, 'editor-error');
    });
    function openPublish(video) {
      state.publishing = video; $('publish-video-title').textContent = video.title || ''; $('publish-note').value = ''; $('publish-error').hidden = true; $('publish-dialog').showModal();
    }
    $('publish-form').addEventListener('submit', event => {
      event.preventDefault(); const video = state.publishing;
      if (!video || !isPublishReady(video) || resourceState(video, state.requests).locked || (state.application?.status !== 'approved' && state.user?.is_admin !== true)) return;
      mutation($('publish-form'), async (options, generation) => {
        const data = await request('/api/video-share-requests', { ...options, method: 'POST', body: { video_id: Number(video.id), request_type: 'public', note: $('publish-note').value.trim() || null } });
        if (generation !== state.generation) return;
        if (!data.request?.id && data.already_public !== true) throw new Error('未能确认提交结果，请刷新状态后再重试。');
        if (data.request) state.requests.unshift(data.request);
        if (data.already_public) video.is_public = true;
        renderResources(); $('publish-dialog').close(); message(data.already_public ? '这段内容已经公开，可在公共视频库学习。' : '已提交公开审核。审核期间暂不能编辑这段内容。');
      }, 'publish-error');
    });
    doc.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (!state.busy) $(button.dataset.close).close(); }));
    ['resource-editor', 'publish-dialog'].forEach(id => $(id).addEventListener('cancel', event => { if (state.busy) event.preventDefault(); }));
    $('creator-retry').addEventListener('click', load);
    $('resources-refresh').addEventListener('click', load);
    win.addEventListener('resize', () => doc.querySelectorAll('[data-learning-video]').forEach(link => { link.href = learningHref(link.dataset.learningVideo, win.innerWidth); }));
    win.addEventListener('storage', event => {
      if (!event.key || ['linglish_token', 'authToken', 'linglish_refresh_token'].includes(event.key)) {
        saveDraft(); state.busy = false; ++state.generation; clearAccountView(); load();
      }
    });
    win.addEventListener('focus', () => {
      const id = tokenIdentity(win.AuthManager?.getToken?.());
      if (state.user && id && id !== String(state.user.id)) { state.busy = false; load(); }
    });
    load();
  }

  return { publicHttpUrl, applicationPayload, isPublishReady, resourceState, videoFile, learningHref, tokenIdentity, createRequest, loadShareRequests, errorMessage, boot };
});
