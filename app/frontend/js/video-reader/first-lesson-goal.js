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
  function resumeHref(record, mobile, source) {
    if (!record || !/^\d+$/.test(record.videoId)) return null;
    const from = source === 'reader_guided_practice' ? source : 'today_goal_resume';
    return `./video-reader${mobile ? '' : '-desktop'}.html?focus=first_lesson&from=${from}&videoId=${record.videoId}`;
  }
  function createCard(container, options) {
    if (!container) return { update() {}, hide() {}, setState() {}, feedback() {}, settle() {}, setSentence() {}, setRecording() {}, getSentenceIndex: () => null };
    const config = options || {};
    const doc = container.ownerDocument;
    const objectUrls = doc.defaultView && doc.defaultView.URL;
    container.classList.add('first-lesson-goal', 'goal-studio');
    function element(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    const heading = element('div', 'goal-heading');
    const eyebrow = element('span', 'goal-eyebrow', 'SPEAKING STUDIO');
    const count = element('span', 'goal-count');
    heading.append(eyebrow, count);
    const title = element('strong', 'goal-title');
    const detail = element('p', 'goal-detail', '听清节奏，再说出来。不用一次完美。');
    const meter = element('progress', 'goal-meter');
    meter.setAttribute('aria-label', '小目标跟读进度');
    const steps = element('nav', 'goal-steps');
    steps.setAttribute('aria-label', '跟读学习步骤');
    const phases = ['listen', 'speak', 'feedback'];
    const stepLabels = ['听原句', '开口说', '看反馈'];
    const stepButtons = stepLabels.map((label, index) => {
      const button = element('button', 'goal-step', `${index + 1}  ${label}`);
      button.type = 'button';
      button.setAttribute('aria-label', `第 ${index + 1} 步：${label}`);
      button.addEventListener('click', () => { if (!button.disabled) { phase = phases[index]; paint(); } });
      steps.append(button);
      return button;
    });
    const sentencePanel = element('div', 'goal-sentence');
    const sentenceLabel = element('span', 'goal-sentence-label', 'THIS SENTENCE');
    const sentenceText = element('p', 'goal-sentence-text');
    sentenceText.setAttribute('lang', 'en');
    const translationToggle = element('button', 'goal-translation-toggle', '查看中文');
    translationToggle.type = 'button';
    translationToggle.setAttribute('aria-expanded', 'false');
    const translation = element('p', 'goal-translation');
    translation.setAttribute('lang', 'zh-CN');
    translation.hidden = true;
    translationToggle.addEventListener('click', () => {
      translation.hidden = !translation.hidden;
      translationToggle.setAttribute('aria-expanded', String(!translation.hidden));
      translationToggle.textContent = translation.hidden ? '查看中文' : '收起中文';
    });
    sentencePanel.append(sentenceLabel, sentenceText, translationToggle, translation);
    const feedback = element('p', 'goal-feedback');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    const response = element('div', 'goal-response');
    const responseLabel = element('span', 'goal-sentence-label', '你说的是');
    const recognized = element('p', 'goal-recognized');
    recognized.setAttribute('lang', 'en');
    const focus = element('p', 'goal-focus');
    response.append(responseLabel, recognized, focus);
    response.hidden = true;
    const audioLabel = element('span', 'goal-recording-label', '听听自己的录音');
    const audio = element('audio', 'goal-recording');
    audio.controls = true;
    audio.preload = 'none';
    audio.hidden = true;
    audio.setAttribute('aria-label', '我的跟读录音');
    audio.addEventListener('play', () => { if (typeof config.pauseOriginal === 'function') config.pauseOriginal(); });
    const actions = element('div', 'first-lesson-goal-actions');
    const listen = element('button', '', '先听原句');
    const record = element('button', 'goal-primary', '跟读这句');
    const again = element('button', 'goal-primary', '再来一句');
    for (const button of [listen, record, again]) button.type = 'button';
    const stop = element('a', 'goal-exit', '今天到这');
    const back = element('a', 'goal-back', '回到今日计划');
    back.href = config.mobile ? './mobile-today.html' : './today.html';
    back.hidden = true;
    actions.append(listen, record, again, stop, back);
    container.replaceChildren(heading, title, detail, steps, meter, sentencePanel, feedback, response, audioLabel, audio, actions);
    let current = null;
    let sentence = null;
    let sentenceKey = '';
    let position = 1;
    let phase = 'listen';
    let busy = 'idle';
    let settled = false;
    let outcome = null;
    let recordingUrl = null;

    function pauseRecording() {
      try { audio.pause(); } catch (_) { }
    }
    function releaseRecording() {
      pauseRecording();
      audio.removeAttribute('src');
      if (recordingUrl && objectUrls && typeof objectUrls.revokeObjectURL === 'function') objectUrls.revokeObjectURL(recordingUrl);
      recordingUrl = null;
      audio.hidden = true;
      audioLabel.hidden = true;
    }
    function sentenceIndex() { return sentence ? sentence.index : Number(current && current.nextIndex); }
    function dayHref() {
      const lines = Math.max(0, Number(current && current.completedCount) || 0);
      const base = config.mobile ? './mobile-today.html' : './today.html';
      const hash = config.mobile ? '#learning-details' : '#day-end';
      return `${base}${lines ? `?from=first_lesson_complete&lines=${lines}` : ''}${hash}`;
    }
    function paint() {
      if (!current) return;
      const locked = busy !== 'idle';
      const complete = current.complete === true;
      container.setAttribute('data-phase', phase);
      container.setAttribute('data-status', settled ? (outcome && outcome.success === false ? 'retry' : 'review') : busy);
      title.textContent = complete ? '今天，已经开口说出来了。' : '把这一句，说成自己的。';
      count.textContent = complete ? `${current.total} 句已完成` : `第 ${Math.min(position, current.total)} / ${current.total} 句`;
      detail.hidden = settled || complete;
      meter.max = current.total; meter.value = current.completedCount;
      meter.hidden = settled || complete;
      stepButtons.forEach((button, index) => {
        button.setAttribute('aria-current', phases[index] === phase ? 'step' : 'false');
        button.disabled = locked || (index === 2 && !settled && !recordingUrl && !complete);
      });
      listen.disabled = locked;
      record.disabled = busy === 'requesting' || busy === 'evaluating';
      listen.hidden = complete || (settled && !outcome);
      record.hidden = complete || (settled && !outcome);
      record.textContent = { recording: '完成录音', requesting: '正在请求麦克风…', evaluating: '正在评估…' }[busy]
        || (settled ? '再读一次' : '跟读这句');
      listen.className = phase === 'listen' && !settled ? 'goal-primary' : '';
      record.className = (phase === 'listen' && !settled) || (settled && outcome && outcome.success) ? '' : 'goal-primary';
      again.hidden = !settled || (outcome && outcome.success === false) || complete;
      again.disabled = locked;
      stop.hidden = !settled && !complete;
      stop.href = dayHref();
      response.hidden = !settled || !outcome || (!outcome.recognizedText && !outcome.missedWords?.length);
      audio.hidden = !recordingUrl || locked || phase !== 'feedback';
      audioLabel.hidden = audio.hidden;
    }
    function setSentence(value) {
      if (!value || !Number.isInteger(Number(value.index)) || Number(value.index) < 0) return false;
      const next = { index: Number(value.index), text: String(value.text || ''), translation: String(value.translation || '') };
      const key = `${current && current.videoId}:${next.index}:${next.text}`;
      if (key === sentenceKey) return false;
      releaseRecording();
      sentence = next; sentenceKey = key;
      position = Math.max(1, Number(current && current.completedCount) + 1 || 1);
      settled = false; outcome = null; phase = 'listen';
      feedback.textContent = ''; recognized.textContent = ''; focus.textContent = '';
      sentenceText.textContent = next.text;
      sentencePanel.hidden = !next.text;
      translation.textContent = next.translation;
      translation.hidden = true;
      translationToggle.hidden = !next.translation;
      translationToggle.textContent = '查看中文';
      translationToggle.setAttribute('aria-expanded', 'false');
      paint();
      return true;
    }
    function setRecording(blob) {
      releaseRecording();
      if (blob && blob.size && objectUrls && typeof objectUrls.createObjectURL === 'function') recordingUrl = objectUrls.createObjectURL(blob);
      if (recordingUrl) audio.src = recordingUrl;
      paint();
    }
    function setState(value) {
      const previous = busy;
      busy = ['requesting', 'recording', 'evaluating'].includes(value) ? value : 'idle';
      if (busy !== 'idle') pauseRecording();
      if (busy !== 'idle') phase = 'speak';
      if (busy === 'requesting') { settled = false; outcome = null; response.hidden = true; feedback.textContent = '准备好后，按自己的节奏说。'; }
      if (busy === 'recording') feedback.textContent = '正在录音，说完后点击「完成录音」。';
      if (busy === 'evaluating') feedback.textContent = '正在听你的表达，马上给你反馈…';
      if (busy === 'idle' && previous === 'evaluating' && recordingUrl) phase = 'feedback';
      paint();
    }
    function update(goal) {
      const previousVideo = current && current.videoId;
      current = goal;
      container.hidden = !goal;
      if (!goal) {
        releaseRecording(); sentence = null; sentenceKey = ''; settled = false; outcome = null; busy = 'idle';
        return;
      }
      if (previousVideo !== goal.videoId) {
        releaseRecording();
        sentence = null; sentenceKey = ''; settled = false; outcome = null; busy = 'idle'; phase = 'listen';
        sentenceText.textContent = ''; translation.textContent = ''; sentencePanel.hidden = true;
        recognized.textContent = ''; focus.textContent = ''; feedback.textContent = '';
      }
      if (busy === 'idle' && !settled && typeof config.getSentence === 'function') setSentence(config.getSentence(goal.nextIndex));
      if (goal.complete && busy === 'idle' && !settled) {
        settled = true; phase = 'feedback'; outcome = { success: true }; feedback.textContent = '这几句已经说完。休息一下，明天继续。';
      }
      paint();
    }
    listen.addEventListener('click', () => {
      if (!current || busy !== 'idle' || sentenceIndex() < 0) return;
      pauseRecording();
      phase = 'speak';
      if (!settled) feedback.textContent = '先听清重音和停顿，再按自己的节奏跟读。';
      paint();
      if (typeof config.listen === 'function') config.listen(sentenceIndex());
    });
    record.addEventListener('click', () => {
      if (!current || record.disabled || sentenceIndex() < 0) return;
      pauseRecording();
      phase = 'speak';
      if (typeof config.record === 'function') config.record(sentenceIndex());
    });
    again.addEventListener('click', () => {
      if (!current || again.hidden || busy !== 'idle') return;
      settled = false; outcome = null; phase = 'listen';
      if (typeof config.next === 'function') config.next(current);
    });
    return {
      update, setSentence, setRecording, setState,
      getSentenceIndex: () => sentence ? sentence.index : null,
      hide: () => update(null),
      feedback: text => { if (!settled) feedback.textContent = text || ''; },
      settle: (text, result) => {
        if (!current) return;
        settled = true; phase = 'feedback';
        outcome = result ? {
          success: result.success === true,
          recognizedText: String(result.recognizedText || ''),
          missedWords: (Array.isArray(result.missedWords) ? result.missedWords : []).filter(word => typeof word === 'string' && word.trim()).slice(0, 4),
        } : null;
        feedback.textContent = text || '这句说完了。';
        recognized.textContent = outcome && outcome.recognizedText || '';
        focus.textContent = outcome && outcome.missedWords.length ? `下一次，先把 ${outcome.missedWords[0]} 说完整。` : '';
        paint();
      },
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
