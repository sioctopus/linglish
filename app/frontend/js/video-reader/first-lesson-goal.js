(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonGoal = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const STORAGE_KEY = 'linglish.firstLesson.goal.v1';
  function day(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
  function valid(record) {
    return record && /^\d+$/.test(record.videoId) && Array.isArray(record.ids)
      && record.ids.length > 0 && record.ids.length <= 3
      && record.ids.every(id => typeof id === 'string')
      && Number.isFinite(record.createdAt);
  }
  function createStore(storage, clock = Date.now) {
    let memory = {};
    let unsaved = false;
    function read() {
      if (unsaved) return memory;
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
        if (parsed && parsed.version === 1 && parsed.subjects && typeof parsed.subjects === 'object') memory = parsed.subjects;
      } catch (_) { /* In-memory goals remain usable when storage is unavailable. */ }
      return memory;
    }
    function latest(subject) {
      const records = read();
      const record = Object.prototype.hasOwnProperty.call(records, subject) ? records[subject] : null;
      return valid(record) ? { ...record, ids: record.ids.slice() } : null;
    }
    function sync(snapshot, segments, ids) {
      if (!snapshot || !snapshot.subject || !/^\d+$/.test(snapshot.videoId) || !Array.isArray(ids) || !ids.length) return null;
      const now = clock();
      const practiced = new Set(snapshot.practicedSegmentIds || []);
      let record = latest(snapshot.subject);
      if (!record || record.videoId !== String(snapshot.videoId) || record.ids.some(id => !ids.includes(id))
        || (record.completedAt && day(record.completedAt) !== day(now))) {
        const targets = ids.filter((id, index) => {
          const segment = segments[index] || {};
          const duration = Number(segment.end ?? segment.end_sec) - Number(segment.start ?? segment.start_sec);
          return !practiced.has(id) && (!Number.isFinite(duration) || duration <= 18);
        }).slice(0, 3);
        if (!targets.length) return null;
        record = { videoId: String(snapshot.videoId), ids: targets, createdAt: now, completedAt: null };
      }
      const completedCount = record.ids.filter(id => practiced.has(id)).length;
      const complete = completedCount === record.ids.length;
      const newlyCompleted = complete && !record.completedAt;
      record = {
        ...record, completedCount, total: record.ids.length, complete,
        completedAt: complete ? (record.completedAt || now) : null,
        updatedAt: now,
      };
      memory[snapshot.subject] = record;
      let saved = false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, subjects: memory }));
        saved = true; unsaved = false;
      } catch (_) { unsaved = true; }
      const nextId = record.ids.find(id => !practiced.has(id));
      return { ...record, ids: record.ids.slice(), saved, newlyCompleted, nextIndex: nextId ? ids.indexOf(nextId) : -1 };
    }
    return { sync, latest };
  }
  function resumeHref(record, mobile) {
    if (!record || !/^\d+$/.test(record.videoId)) return null;
    return `./video-reader${mobile ? '' : '-desktop'}.html?focus=first_lesson&from=today_goal_resume&videoId=${record.videoId}`;
  }
  function createCard(container, options) {
    if (!container) return { update() {}, hide() {}, setState() {}, feedback() {}, settle() {} };
    const doc = container.ownerDocument;
    container.classList.add('first-lesson-goal');
    const status = doc.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const title = doc.createElement('strong');
    const detail = doc.createElement('p');
    const meter = doc.createElement('progress');
    meter.setAttribute('aria-label', '小目标跟读进度');
    status.append(title, detail, meter);
    const actions = doc.createElement('div');
    actions.className = 'first-lesson-goal-actions';
    const listen = doc.createElement('button');
    listen.type = 'button'; listen.textContent = '先听原句';
    const record = doc.createElement('button');
    record.type = 'button'; record.textContent = '跟读这句';
    record.className = 'goal-primary';
    const again = doc.createElement('button');
    again.type = 'button'; again.textContent = '再来一句'; again.className = 'goal-primary'; again.hidden = true;
    const stop = doc.createElement('a');
    stop.textContent = '今天到这';
    stop.href = options.mobile ? './mobile-today.html#learning-details' : './today.html?from=first_lesson_complete#day-end';
    stop.hidden = true;
    const back = doc.createElement('a');
    back.textContent = '回到今日计划'; back.href = options.mobile ? './mobile-today.html' : './today.html';
    back.hidden = true;
    actions.append(listen, record, again, stop, back);
    const feedback = doc.createElement('p');
    feedback.className = 'goal-feedback';
    feedback.setAttribute('role', 'status');
    container.replaceChildren(feedback, status, actions);
    let current = null;
    let busy = 'idle';
    let settled = false;
    listen.addEventListener('click', () => { if (current && busy === 'idle') options.listen(current.nextIndex); });
    record.addEventListener('click', () => { if (current) options.record(current.nextIndex); });
    again.addEventListener('click', () => { if (typeof options.next === 'function') options.next(current); });
    function setState(value) {
      busy = value;
      listen.disabled = value !== 'idle';
      record.disabled = value === 'requesting' || value === 'evaluating';
      record.textContent = { recording: '完成录音', requesting: '正在请求麦克风…', evaluating: '正在评估…' }[value] || '跟读这句';
    }
    function dayHref() {
      const lines = Math.max(1, Number(current && current.completedCount) || 1);
      return options.mobile
        ? `./mobile-today.html?from=first_lesson_complete&lines=${lines}#learning-details`
        : `./today.html?from=first_lesson_complete&lines=${lines}#day-end`;
    }
    function showChoices(note) {
      settled = true;
      stop.href = dayHref();
      feedback.textContent = note || '这句说完了。';
      title.hidden = true;
      detail.hidden = true;
      meter.hidden = true;
      listen.hidden = true;
      record.hidden = true;
      back.hidden = true;
      again.hidden = false;
      stop.hidden = false;
    }
    function update(goal) {
      current = goal;
      settled = false;
      container.hidden = !goal;
      if (!goal) return;
      title.hidden = false;
      detail.hidden = false;
      meter.hidden = false;
      again.hidden = true;
      stop.hidden = true;
      title.textContent = goal.complete ? '这几句已经说完。' : '先听，再开口说这一句。';
      detail.textContent = goal.complete ? '' : '听完就跟读。说完这一句，再决定要不要下一句。';
      detail.hidden = goal.complete;
      meter.max = goal.total; meter.value = goal.completedCount;
      meter.hidden = goal.complete;
      feedback.textContent = '';
      listen.hidden = goal.complete; record.hidden = goal.complete; back.hidden = true;
      if (goal.complete) showChoices('这几句已经说完。');
      setState(busy);
    }
    return {
      update, setState, hide: () => update(null),
      feedback: text => { if (!settled) feedback.textContent = text || ''; },
      settle: text => { if (current) showChoices(text); },
    };
  }
  function renderResume(container, options) {
    if (!container) return;
    const goal = createStore(options.storage).latest(options.subject);
    const href = resumeHref(goal, options.mobile);
    container.hidden = !href;
    container.replaceChildren();
    if (!href) return;
    container.classList.add('first-lesson-goal');
    const title = container.ownerDocument.createElement('strong');
    const detail = container.ownerDocument.createElement('p');
    const link = container.ownerDocument.createElement('a');
    title.textContent = goal.complete ? '上次的小目标已完成，今天继续开口' : `接着上次练 · ${Number(goal.completedCount) || 0}/${goal.ids.length} 句`;
    detail.textContent = '保留了此浏览器中的练习位置，直接回到同一段视频。';
    link.className = 'goal-primary'; link.href = href; link.textContent = goal.complete ? '继续学习' : '继续未完成的跟读';
    link.addEventListener('click', () => options.emit?.('first_lesson_goal_resume', { video_resource_id: goal.videoId, completed: goal.complete === true }));
    container.append(title, detail, link);
  }
  function sentenceResult(success, missed) {
    const words = (Array.isArray(missed) ? missed : []).filter(word => typeof word === 'string' && word).slice(0, 4);
    if (words.length) return `这句漏了 ${words.join('、')}。`;
    return success ? '这句说出来了。' : '这句还没对上。再听一次。';
  }
  return { createStore, createCard, renderResume, resumeHref, sentenceResult };
});
