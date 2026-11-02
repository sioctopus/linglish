(function (win) {
  'use strict';
  if (!win?.document) return;
  win.document.addEventListener('DOMContentLoaded', async () => {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    if (!$('admin-creators')) return;
    const adminAuth = AdminAuth;
    const adminApi = AdminAPI;
    const shared = win.LinglishCreatorCenter;
    const request = shared.createRequest(win.AuthManager, win.fetch.bind(win));
    const state = { items: [], generation: 0, offset: 0, limit: 50, busy: false, user: null, accountId: null };
    const notes = new Map();
    const statusNames = { pending: '待审核', approved: '已通过', rejected: '未通过' };

    function notice(text, error = false) {
      $('creator-admin-message').textContent = text;
      $('creator-admin-message').hidden = !text;
      $('creator-admin-message').dataset.kind = error ? 'error' : 'info';
    }
    function node(tag, cls, text) {
      const el = doc.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el;
    }
    function setBusy(value) {
      state.busy = value;
      doc.querySelectorAll('.creator-review-form button, #creator-admin-refresh, #creator-review-filter').forEach(el => { el.disabled = value || el.dataset.reviewBlocked === 'true'; });
      $('creator-review-list').setAttribute('aria-busy', String(value));
      $('creator-review-prev').disabled = value || state.offset === 0;
      $('creator-review-next').disabled = value || state.items.length < state.limit;
    }
    function render() {
      const list = $('creator-review-list'); list.replaceChildren();
      if (!state.items.length) list.append(node('div', 'resource-empty', '当前没有符合条件的创作者申请。'));
      state.items.forEach(item => {
        const card = node('article', 'creator-review-card'); card.dataset.applicationId = String(item.id);
        const head = node('div', 'creator-review-head'); const title = node('div');
        title.append(node('h2', '', item.display_name || '未命名申请'), node('p', 'creator-review-meta', `用户 #${item.user_id} · ${item.topic || '未填写主题'} · 版本 ${item.revision}`));
        const badge = node('span', 'status-chip', statusNames[item.status] || '未知状态'); badge.dataset.status = item.status;
        head.append(title, badge); card.append(head, node('p', 'creator-review-bio', item.bio || ''));
        if (item.sample_url) {
          try {
            const url = shared.publicHttpUrl(item.sample_url);
            if (url) { const link = node('a', 'creator-review-sample', '打开作品链接 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }
          } catch (_) { card.append(node('p', 'creator-review-rights', '作品链接无效，已禁用。')); }
        }
        card.append(node('p', 'creator-review-rights', item.rights_confirmed === true ? '已确认：仅分享原创或已获使用与公开传播授权的内容。' : '申请中缺少授权确认；请勿通过。'));
        if (item.status === 'pending') {
          const form = node('form', 'creator-review-form'); const label = node('label', '', '审核意见（选填，申请者可见）');
          const textarea = node('textarea'); textarea.maxLength = 1200; textarea.rows = 2; textarea.value = notes.get(String(item.id)) || '';
          textarea.setAttribute('aria-label', `给 ${item.display_name || '申请者'} 的审核意见`);
          textarea.addEventListener('input', () => notes.set(String(item.id), textarea.value)); label.append(textarea);
          const buttons = node('div', 'creator-review-buttons');
          for (const [decision, text] of [['rejected', '不通过'], ['approved', '通过申请']]) {
            const button = node('button', `button ${decision === 'approved' ? 'primary' : 'secondary'}`, text); button.type = 'button';
            button.disabled = state.busy || (decision === 'approved' && item.rights_confirmed !== true) || String(item.user_id) === String(state.user?.id);
            button.dataset.reviewBlocked = String((decision === 'approved' && item.rights_confirmed !== true) || String(item.user_id) === String(state.user?.id));
            button.addEventListener('click', () => review(item, decision, textarea.value)); buttons.append(button);
          }
          form.addEventListener('submit', event => event.preventDefault()); form.append(label, buttons); card.append(form);
          if (String(item.user_id) === String(state.user?.id)) card.append(node('p', 'creator-review-result', '不能审核自己的申请，请由其他管理员处理。'));
        } else if (item.review_note) card.append(node('p', 'creator-review-result', `审核意见：${item.review_note}`));
        list.append(card);
      });
      $('creator-review-page').textContent = `第 ${Math.floor(state.offset / state.limit) + 1} 页`;
    }
    async function load(preserveMessage = false) {
      if (state.busy) return;
      const generation = ++state.generation;
      state.items = []; render(); setBusy(true);
      ['pending', 'approved', 'rejected'].forEach(status => { $(`summary-${status}`).textContent = '—'; });
      if (!preserveMessage) notice('正在加载审核队列…');
      try {
        await win.AuthManager?.ready; await win.AuthManager?.ensureSession?.();
        const currentToken = adminAuth.getToken();
        if (!currentToken) throw Object.assign(new Error('请登录管理员账号。'), { status: 401 });
        const currentIdentity = shared.tokenIdentity(currentToken);
        if (state.accountId != null && currentIdentity !== state.accountId) { notes.clear(); state.user = null; }
        state.accountId = currentIdentity;
        const user = await request('/users/me');
        if (generation !== state.generation) return;
        state.user = user;
        // AdminAPI supplies the established admin-list behavior; the following
        // identity check prevents an old account response from reaching the DOM.
        const data = await adminApi.get(`/admin/creator-applications?status=${encodeURIComponent($('creator-review-filter').value)}&limit=50&offset=${state.offset}`);
        if (generation !== state.generation || shared.tokenIdentity(adminAuth.getToken()) !== currentIdentity) return;
        if (!Array.isArray(data?.items)) throw new Error('审核队列未完整返回，请重试。');
        state.items = data.items;
        ['pending', 'approved', 'rejected'].forEach(status => { $(`summary-${status}`).textContent = String(Number(data.summary?.[status]) || 0); });
        render(); if (!preserveMessage) notice('');
      } catch (error) {
        if (generation !== state.generation) return;
        state.items = []; render(); ['pending', 'approved', 'rejected'].forEach(status => { $(`summary-${status}`).textContent = '—'; });
        notice(shared.errorMessage(error), true);
      } finally { if (generation === state.generation) setBusy(false); }
    }
    async function review(item, decision, note) {
      if (state.busy || item.status !== 'pending') return;
      notes.set(String(item.id), note); setBusy(true); const generation = state.generation;
      try {
        const data = await request(`/admin/creator-applications/${encodeURIComponent(String(item.id))}/review`, { method: 'POST', accountId: state.user?.id, body: { decision, expected_revision: Number(item.revision), review_note: note.trim() || null } });
        if (generation !== state.generation) return;
        if (!data.application?.id || data.application.status !== decision) throw new Error('审核结果未完整返回，请刷新确认；审核意见仍保留。');
        notes.delete(String(item.id)); notice(decision === 'approved' ? '创作者资格已通过。视频内容仍需单独审核。' : '已记录未通过结果。申请者可修改后重新提交。');
        setBusy(false); await load(true);
      } catch (error) {
        if (generation !== state.generation) return;
        if (error.code === 'ACCOUNT_CHANGED') {
          notes.clear(); state.items = []; state.user = null; state.accountId = null;
          render(); setBusy(false); await load(); return;
        }
        if (error.status === 409) {
          notice('这份申请已被更新或审核。已刷新队列，请核对最新版本；你的审核意见仍保留。', true);
          setBusy(false); await load(true);
        } else { notice(shared.errorMessage(error), true); setBusy(false); render(); }
      }
    }
    $('creator-admin-refresh').addEventListener('click', () => load());
    $('creator-review-filter').addEventListener('change', () => { state.offset = 0; load(); });
    $('creator-review-prev').addEventListener('click', () => { if (!state.busy && state.offset > 0) { state.offset -= state.limit; load(); } });
    $('creator-review-next').addEventListener('click', () => { if (!state.busy && state.items.length === state.limit) { state.offset += state.limit; load(); } });
    win.addEventListener('storage', event => {
      if (!event.key || ['linglish_token', 'authToken', 'linglish_refresh_token'].includes(event.key)) {
        ++state.generation; state.busy = false; state.items = []; notes.clear(); state.user = null; state.accountId = null; render(); load();
      }
    });
    await win.AuthManager?.ready; await win.AuthManager?.ensureSession?.();
    if (adminAuth.getToken()) win.initAdminPage('创作者资格审核');
    await load();
  });
})(typeof window !== 'undefined' ? window : null);
