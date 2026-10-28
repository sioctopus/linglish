const test = require('node:test');
const assert = require('node:assert/strict');
const goals = require('../../frontend/js/video-reader/first-lesson-goal');

function fixture() {
  const calls = [];
  const revoked = [];
  const sentences = [
    { index: 0, text: 'Could you slow down a little?', translation: '你可以说慢一点吗？' },
    { index: 1, text: 'Let me try that again.', translation: '让我再试一次。' },
  ];
  function element(tag) {
    const node = {
      tag, children: [], attrs: {}, style: {}, hidden: false, disabled: false,
      className: '', ownText: '', listeners: {}, pauses: 0,
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return this.attrs[name] ?? null; },
      removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.ownText = ''; },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      click() { if (!this.disabled) this.listeners.click?.forEach(fn => fn({ preventDefault() {} })); },
      pause() { this.pauses += 1; this.paused = true; },
      load() {},
    };
    Object.defineProperty(node, 'textContent', {
      get() { return node.ownText + node.children.map(child => child.textContent || '').join(''); },
      set(value) { node.ownText = String(value); node.children = []; },
    });
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('Untrusted content must use textContent'); } });
    node.classList = {
      add(...names) { node.className = [...new Set([...node.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove(name) { node.className = node.className.split(' ').filter(value => value !== name).join(' '); },
      toggle(name, enabled) { if (enabled) this.add(name); else this.remove(name); },
    };
    node.ownerDocument = doc;
    return node;
  }
  let urlCount = 0;
  const doc = {
    createElement: element,
    defaultView: { URL: { createObjectURL: () => `blob:recording-${++urlCount}`, revokeObjectURL: value => revoked.push(value) } },
  };
  const container = element('section');
  const card = goals.createCard(container, {
    mobile: true,
    getSentence: index => sentences[index],
    listen: index => calls.push(['listen', index]),
    record: index => calls.push(['record', index]),
    next: () => calls.push(['next']),
    pauseOriginal: () => calls.push(['pause-original']),
  });
  function all() {
    const nodes = [];
    (function walk(node) { nodes.push(node); node.children.forEach(walk); })(container);
    return nodes;
  }
  const button = text => all().find(node => node.tag === 'button' && node.textContent === text);
  const byLabel = label => all().find(node => node.attrs['aria-label'] === label);
  const initial = { videoId: '10', total: 3, completedCount: 0, complete: false, nextIndex: 0 };
  card.update(initial);
  return { card, container, calls, revoked, sentences, all, button, byLabel, initial };
}

test('the current English sentence leads the lesson and translation is revealed deliberately', () => {
  const f = fixture();
  assert.ok(f.container.textContent.includes('Could you slow down a little?'));
  assert.equal(f.card.getSentenceIndex(), 0);
  const translation = f.all().find(node => node.attrs.lang === 'zh-CN');
  assert.equal(translation.hidden, true);
  const toggle = f.button('查看中文');
  toggle.click();
  assert.equal(translation.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  f.card.setSentence(f.sentences[1]);
  assert.equal(translation.hidden, true);
  assert.ok(f.container.textContent.includes('Let me try that again.'));
  assert.equal(f.card.getSentenceIndex(), 1);
});

test('listening and choosing a step never start the microphone without a record action', () => {
  const f = fixture();
  f.button('先听原句').click();
  assert.deepEqual(f.calls, [['listen', 0]]);
  f.byLabel('第 2 步：开口说').click();
  assert.deepEqual(f.calls, [['listen', 0]]);
  assert.equal(f.byLabel('第 2 步：开口说').attrs['aria-current'], 'step');
  f.button('跟读这句').click();
  assert.deepEqual(f.calls, [['listen', 0], ['record', 0]]);
});

test('recording states lock competing actions while leaving an explicit stop action', () => {
  const f = fixture();
  f.card.setState('requesting');
  assert.equal(f.button('正在请求麦克风…').disabled, true);
  assert.equal(f.button('先听原句').disabled, true);
  f.card.setState('recording');
  const stop = f.button('完成录音');
  assert.equal(stop.disabled, false);
  stop.click();
  assert.deepEqual(f.calls, [['record', 0]]);
  f.card.setState('evaluating');
  assert.equal(f.button('正在评估…').disabled, true);
  assert.equal(f.byLabel('第 1 步：听原句').disabled, true);
});

test('a progress update during assessment keeps feedback and retry attached to the assessed sentence', () => {
  const f = fixture();
  f.card.setState('evaluating');
  f.card.update({ ...f.initial, nextIndex: 1, completedCount: 1 });
  f.card.settle('这句已经说出来了。', { success: true, recognizedText: 'Could you slow down a little?' });
  f.card.setState('idle');
  assert.ok(f.container.textContent.includes(f.sentences[0].text));
  assert.equal(f.container.textContent.includes(f.sentences[1].text), false);
  f.button('再读一次').click();
  assert.deepEqual(f.calls, [['record', 0]]);
});

test('failed attempts offer a retry without claiming a completed sentence or unlocking next', () => {
  const f = fixture();
  f.card.settle('先把 slow 说完整。', { success: false, missedWords: ['slow'], recognizedText: 'Could you down a little?' });
  f.card.feedback('A later helper message must not overwrite the assessment.');
  assert.ok(f.container.textContent.includes('先把 slow 说完整。'));
  assert.equal(f.button('再来一句').hidden, true);
  assert.equal(f.button('再读一次').hidden, false);
  const exit = f.all().find(node => node.tag === 'a' && node.textContent === '今天到这');
  assert.equal(exit.href, './mobile-today.html#learning-details');
});

test('real recordings can be replayed and are stopped and released when the sentence changes', () => {
  const f = fixture();
  f.card.setRecording(new Blob(['voice'], { type: 'audio/webm' }));
  f.card.settle('再听听自己。', { success: false });
  const audio = f.all().find(node => node.tag === 'audio');
  assert.equal(audio.src, 'blob:recording-1');
  assert.equal(audio.hidden, false);
  audio.listeners.play[0]();
  assert.deepEqual(f.calls, [['pause-original']]);
  f.card.setSentence(f.sentences[1]);
  assert.equal(audio.hidden, true);
  assert.equal(audio.pauses > 0, true);
  assert.deepEqual(f.revoked, ['blob:recording-1']);
  f.card.setRecording(new Blob(['next']));
  f.card.hide();
  assert.deepEqual(f.revoked, ['blob:recording-1', 'blob:recording-2']);
});

test('sentence, translation, and recognition content remain plain text', () => {
  const f = fixture();
  const payload = '<img src=x onerror=alert(1)>';
  f.card.setSentence({ index: 1, text: payload, translation: payload });
  f.card.settle('请再试一次。', { success: false, recognizedText: payload });
  assert.ok(f.container.textContent.includes(payload));
  assert.equal(f.all().some(node => node.tag === 'img'), false);
});

test('switching to an already completed video cannot retain another video recording or sentence', () => {
  const f = fixture();
  f.card.setRecording(new Blob(['old voice']));
  f.card.update({ ...f.initial, videoId: '11', complete: true, completedCount: 3, nextIndex: -1 });
  assert.deepEqual(f.revoked, ['blob:recording-1']);
  assert.equal(f.container.textContent.includes(f.sentences[0].text), false);
});

test('reader entry preserves the selected video and identifies the guided learning entry', () => {
  const href = goals.resumeHref({ videoId: '42' }, true, 'reader_guided_practice');
  const url = new URL(href, 'https://example.com/');
  assert.equal(url.pathname, '/video-reader.html');
  assert.equal(url.searchParams.get('videoId'), '42');
  assert.equal(url.searchParams.get('focus'), 'first_lesson');
  assert.equal(url.searchParams.get('from'), 'reader_guided_practice');
});

test('listening or retrying pauses the previous recording before another audible source starts', () => {
  const f = fixture();
  f.card.setRecording(new Blob(['voice']));
  f.card.settle('可以再试一次。', { success: false });
  const audio = f.all().find(node => node.tag === 'audio');
  audio.paused = false;
  f.button('先听原句').click();
  assert.equal(audio.paused, true);
  audio.paused = false;
  f.card.setState('requesting');
  assert.equal(audio.paused, true);
  assert.equal(audio.src, 'blob:recording-1');
});
