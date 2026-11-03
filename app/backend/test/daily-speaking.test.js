const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const source = fs.readFileSync(path.join(frontend, 'daily-speaking.html'), 'utf8');
const functions = name => source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    \\}`, 'm'))?.[0] || '';

function keyboardHarness(text = "It's really cold today, isn't it?") {
  const input = { value: '', readOnly: false, disabled: false, focus() {}, blur() {}, setSelectionRange() {} };
  const nodes = new Map([['hear-input', input], ['review', { hidden: true }]]);
  const timers = new Map();
  let timerId = 0;
  const sandbox = {
    splitState: null, splitListen: true, hearFromMic: false, hearTypedAt: 0, hearSeen: '', hearComposing: false,
    splitTyper: null, hearFinalBuffer: '', lineIndex: 0, methodId: 'listen', captionOn: false,
    packId: 'daily', sceneIndex: 2, packSwitchRun: 0,
    recording: false, micStarting: false, busy: false, revealed: new Set(), SPEECH_ALIASES: {},
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    Date, Math, Promise,
    document: { getElementById: id => nodes.get(id), activeElement: input },
    lineKey: index => `daily:2:${index}`,
    scene: () => ({ turns: [['Amy', text, ''], ['Ben', 'Yes. I did not bring a coat.', '']] }),
    current() { return sandbox.scene().turns[sandbox.lineIndex]; },
    sentenceWords: text => text.trim().split(/\s+/),
    spokenLabel: word => String(word || '').replace(/^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’]+$/g, ''),
    paintHearLine() {}, paintGloss() {}, render() {}, stopPlaybackOnly() {}, startHearWatch() {},
    stopSplitListen() { sandbox.splitListen = null; },
    isDictation: () => false, isMicSessionLive: () => false,
    englishShown: () => true,
    setStatus(text) { sandbox.status = text; },
    pruneSpeechToTargets: text => text,
    syncSpeakingUrl() {}, saveSpeakingProgressNow() {}, showPractice() {},
  };
  const names = ['normalizeSpoken', 'spokenDistance', 'speechAliasHit', 'wordMatches',
    'expandSpeechTokens', 'blankSlots', 'splitActive', 'filledCount', 'slotClass',
    'syncHearLine', 'applyHearText', 'confirmHearLine', 'finishTypedLine', 'queueType',
    'pumpType', 'stopTyper', 'mergeHearTranscript', 'focusHearInput', 'openKeyboardHear',
    'syncKeyboardDraft', 'confirmTypedWord', 'finishKeyboardLine', 'captureBlocksSelection', 'beginSpeakingSelection'];
  vm.createContext(sandbox);
  vm.runInContext(names.map(functions).join('\n'), sandbox);
  sandbox.splitState = sandbox.blankSlots(sandbox.sentenceWords(text));
  const handler = source.match(/hearInput\.addEventListener\('keydown', \(event\) => \{([^]*?)\n      \}\);/)?.[1];
  assert.ok(handler, 'exercise the input key handler registered by the page');
  vm.runInContext(`function pressHearKey(event) {${handler}\n}`, sandbox);
  return {
    sandbox, input,
    type(text) { input.value = text; sandbox.applyHearText(true); },
    press(key, extra = {}) {
      const event = { key, preventDefault() { this.defaultPrevented = true; }, ...extra };
      sandbox.pressHearKey(event);
      return event;
    },
    flush() {
      for (let count = 0; timers.size && count < 200; count += 1) {
        const [id, fn] = timers.entries().next().value;
        if (sandbox.splitTyper !== id) timers.delete(id);
        fn();
      }
    },
  };
}

test('Space confirms exactly one typed word and leaves the next slot ready', () => {
  const h = keyboardHarness();
  h.type('its');
  assert.equal(h.sandbox.filledCount(), 0, 'drafts stay unconfirmed');
  assert.equal(h.press(' ').defaultPrevented, true);
  assert.equal(h.sandbox.filledCount(), 1);
  assert.equal(h.input.value, '');
  assert.equal(h.sandbox.slotClass(0), 'done');
  assert.equal(h.sandbox.slotClass(1), 'current');
});

test('Enter rejects a misspelling in place instead of using speech fuzzy matching', () => {
  const h = keyboardHarness();
  h.type('it');
  h.press('Enter');
  h.flush();
  assert.equal(h.sandbox.filledCount(), 0);
  assert.equal(h.input.value, 'it');
  assert.equal(h.sandbox.slotClass(0), 'incorrect');
  assert.match(h.sandbox.status, /不对|未对上|再试/);
  h.type('It’s');
  h.press('Enter');
  assert.equal(h.sandbox.filledCount(), 1);
  assert.equal(h.input.value, '');
});

test('typing a prefix never confirms a longer word', () => {
  const h = keyboardHarness('really cold');
  h.type('rea');
  h.press('Enter');
  h.flush();
  assert.equal(h.sandbox.filledCount(), 0);
  assert.equal(h.sandbox.slotClass(0), 'incorrect');
});

test('a completed sentence reports accuracy then opens keyboard practice on the next sentence', () => {
  const h = keyboardHarness();
  for (const word of ['its', 'really', 'cold', 'today', 'isnt', 'it']) {
    h.type(word);
    h.press('Enter');
  }
  assert.match(h.sandbox.status, /完成/);
  assert.match(h.sandbox.status, /100%/);
  assert.equal(h.sandbox.lineIndex, 0, 'keep the completion visible before advancing');
  h.flush();
  assert.equal(h.sandbox.lineIndex, 1);
  assert.equal(h.sandbox.splitListen, true);
  assert.equal(h.input.value, '');
  assert.equal(h.sandbox.filledCount(), 0);
});

test('a wrong word remains editable while the previously confirmed words stay correct', () => {
  const h = keyboardHarness();
  h.type('its'); h.press('Enter');
  h.type('realy'); h.press(' ');
  assert.equal(h.sandbox.filledCount(), 1);
  assert.equal(h.sandbox.slotClass(0), 'done');
  assert.equal(h.sandbox.slotClass(1), 'incorrect');
  assert.equal(h.input.value, 'realy');
  h.type('really'); h.press(' ');
  assert.equal(h.sandbox.filledCount(), 2);
});

test('composition and modified shortcuts never confirm a word', () => {
  const h = keyboardHarness();
  h.type('its');
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
    assert.notEqual(h.press('Enter', extra).defaultPrevented, true);
  }
  assert.equal(h.sandbox.filledCount(), 0);
});

test('Space during a live microphone session remains available to the speaking shortcut', () => {
  const h = keyboardHarness();
  h.sandbox.hearFromMic = true;
  h.sandbox.isMicSessionLive = () => true;
  h.input.value = 'its';
  assert.notEqual(h.press(' ').defaultPrevented, true);
  assert.equal(h.sandbox.filledCount(), 0);
});

test('a pending completion cannot change a newly selected sentence', () => {
  const h = keyboardHarness();
  h.type("its really cold today isnt it"); h.press('Enter');
  h.sandbox.lineIndex = 1;
  h.sandbox.splitState = h.sandbox.blankSlots(['Yes.']);
  h.flush();
  assert.equal(h.sandbox.lineIndex, 1);
  assert.equal(h.sandbox.splitState.targets[0], 'Yes.');
});

test('Enter during live speech keeps the microphone recognition mode', () => {
  const h = keyboardHarness();
  h.sandbox.hearFromMic = true;
  h.input.value = 'its';
  h.press('Enter');
  assert.equal(h.sandbox.hearFromMic, true);
});

test('a final sentence stays completed without wrapping to the first one', () => {
  const h = keyboardHarness();
  h.sandbox.lineIndex = 1;
  h.sandbox.splitState = h.sandbox.blankSlots(['Yes.']);
  h.type('yes'); h.press('Enter');
  assert.match(h.sandbox.status, /100%/);
  h.flush();
  assert.equal(h.sandbox.lineIndex, 1);
  assert.equal(h.sandbox.filledCount(), 1);
});

function packHarness(search = '') {
  const select = Object.assign(new EventTarget(), { value: 'daily' });
  const window = {};
  let renders = 0;
  const sandbox = {
    window, Promise, URLSearchParams, Number, Math, Event,
    packId: 'daily', sceneIndex: 2, lineIndex: 3, recording: false, packSwitchRun: 0,
    micStarting: false, methodId: 'listen', busy: false, isMicSessionLive: () => false,
    splitListen: null, hearFromMic: false,
    location: { search },
    document: {
      getElementById: id => id === 'pack-select' ? select : { hidden: true, scrollTop: 0 },
      createElement: () => ({}),
      body: { appendChild(script) { sandbox.lastScript = script; queueMicrotask(() => script.onerror()); } },
    },
    releasePlayback() {}, stopSpeech() {}, isDictation: () => false,
    activeScenes: () => [{ title: 'Current lesson', turns: [['Amy', 'Hello.', '你好。']] }],
    syncSpeakingUrl() {}, saveSpeakingProgressNow() {},
    findSpeakingProgress: () => null, loadSpeakingProgressList: () => [],
    render() { renders += 1; },
    setStatus(text) { sandbox.status = text; },
  };
  vm.createContext(sandbox);
  const names = ['validScenePack', 'loadCorePack', 'loadScriptPack', 'packLabel', 'syncPackSelect',
    'captureBlocksSelection', 'beginSpeakingSelection', 'canCommitSpeakingSelection', 'switchPack', 'bootSpeaking'];
  vm.runInContext(names.map(functions).join('\n'), sandbox);
  return { sandbox, select, get renders() { return renders; } };
}

for (const pack of ['daylife', 'travel', 'kids', 'core', 'medical']) {
  test(`a failed ${pack} load preserves the selected course and sentence`, async () => {
    const h = packHarness();
    assert.equal(await h.sandbox.switchPack(pack), false);
    assert.equal(h.sandbox.packId, 'daily');
    assert.equal(h.sandbox.sceneIndex, 2);
    assert.equal(h.sandbox.lineIndex, 3);
    assert.equal(h.select.value, 'daily');
    assert.match(h.sandbox.status, /没有加载成功/);
  });
}

test('an unavailable bookmarked course still renders the current lesson at startup', async () => {
  const h = packHarness('?pack=medical');
  await h.sandbox.bootSpeaking();
  assert.equal(h.sandbox.packId, 'daily');
  assert.ok(h.renders > 0, 'the page must not remain blank after a missing script');
  assert.equal(h.select.value, 'daily');
  assert.match(h.sandbox.status, /没有加载成功/);
});

test('a nonempty script with malformed scenes cannot be treated as a loaded course', async () => {
  const h = packHarness();
  h.sandbox.window.MEDICAL_VOCAB = [{}];
  assert.equal(await h.sandbox.loadScriptPack('MEDICAL_VOCAB', './data/medical-vocab.js'), false);
});

test('a correctly loaded course must expose the real scene and turn data', async () => {
  const h = packHarness();
  const lesson = [{ title: 'At the desk', tag: 'Travel', place: 'Checking in', turns: [['Amy', 'Can I check in?', '可以办理入住吗？']] }];
  h.sandbox.document.body.appendChild = script => {
    h.sandbox.window.TRAVEL_SPEAK = lesson;
    queueMicrotask(() => script.onload());
  };
  assert.equal(await h.sandbox.loadScriptPack('TRAVEL_SPEAK', './data/travel-speak.js'), true);
  assert.equal(h.sandbox.window.TRAVEL_SPEAK[0].turns[0][1], 'Can I check in?');
});

for (const [pack, file, globalName, label, sceneCount] of [
  ['daylife', 'day-life.js', 'DAY_LIFE', '一日口语', 4],
  ['travel', 'travel-speak.js', 'TRAVEL_SPEAK', '旅游口语', 4],
  ['kids', 'kids-speak.js', 'KIDS_SPEAK', '儿童口语', 4],
  ['core', 'core-850.js', 'CORE_850', '基础表达', 144],
  ['medical', 'medical-vocab.js', 'MEDICAL_VOCAB', '医学词汇', 4],
]) {
  test(`${pack} loads its original bilingual starter lessons and supports keyboard practice`, async () => {
    const h = packHarness();
    vm.runInContext(functions('activeScenes'), h.sandbox);
    h.sandbox.document.body.appendChild = script => {
      const url = new URL(script.src, 'https://linglish.example/daily-speaking.html');
      try {
        const packSource = fs.readFileSync(path.join(frontend, url.pathname), 'utf8');
        vm.runInContext(packSource, h.sandbox);
        queueMicrotask(() => script.onload());
      } catch (_) {
        queueMicrotask(() => script.onerror());
      }
    };
    assert.equal(await h.sandbox.switchPack(pack), true, `${pack} must load through its real page URL`);
    assert.equal(h.sandbox.packId, pack);
    assert.equal(h.select.value, pack);
    const scenes = h.sandbox.window[globalName];
    assert.equal(scenes.length, sceneCount);
    assert.equal(scenes.flatMap(scene => scene.turns).length, sceneCount * 6);
    const ids = new Set();
    const english = new Set();
    for (const scene of scenes) {
      assert.ok(scene.id && !ids.has(scene.id), 'scenes have distinct stable identifiers');
      ids.add(scene.id);
      assert.ok(scene.title && scene.tag && scene.place);
      assert.equal(scene.turns.length, 6);
      for (const turn of scene.turns) {
        assert.match(turn[1], /[a-z]/i);
        assert.match(turn[2], /[\u4e00-\u9fff]/);
        assert.ok(turn[1].split(/\s+/).length <= 14, 'starter speech stays short');
        english.add(turn[1]);
      }
    }
    assert.ok(english.size >= sceneCount * 6 - 10, 'the course contains distinct useful lines');
    assert.match(h.sandbox.status, new RegExp(`${sceneCount * 6} 句`));
    assert.equal(h.sandbox.packLabel(pack), label);
    assert.doesNotMatch(h.sandbox.status, /850|1746/);
    const lesson = scenes[0];
    const practice = keyboardHarness(lesson.turns[0][1]);
    practice.sandbox.scene = () => lesson;
    practice.type(lesson.turns[0][1]);
    practice.press('Enter');
    assert.match(practice.sandbox.status, /100%/);
    practice.flush();
    assert.equal(practice.sandbox.lineIndex, 1);
    assert.deepEqual([...practice.sandbox.splitState.targets], lesson.turns[1][1].split(/\s+/));
  });
}

function pendingPackHarness() {
  const h = packHarness();
  const scripts = new Map();
  h.sandbox.packSelect = h.select;
  h.sandbox.document.body.appendChild = script => {
    scripts.set(new URL(script.src, 'https://linglish.example/').pathname, script);
  };
  const changeHandler = source.match(/packSelect\.addEventListener\('change', async \(\) => \{([^]*?)\n      \}\);/)?.[1];
  assert.ok(changeHandler, 'exercise the real pack menu handler');
  vm.runInContext(`async function changePack() {${changeHandler}\n}`, h.sandbox);
  return {
    ...h,
    choose(pack) { h.select.value = pack; return h.sandbox.changePack(); },
    finish(file, fail = false) {
      const script = scripts.get('/data/' + file);
      assert.ok(script, `${file} request is pending`);
      if (fail) { script.onerror(); return; }
      vm.runInContext(fs.readFileSync(path.join(frontend, 'data', file), 'utf8'), h.sandbox);
      script.onload();
    },
  };
}

test('returning to the current pack cancels an older load without resetting the current sentence', async () => {
  const h = pendingPackHarness();
  const old = h.choose('travel');
  await h.choose('daily');
  const note = h.sandbox.status;
  h.finish('travel-speak.js');
  await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(h.sandbox.lineIndex, 3);
  assert.equal(h.select.value, 'daily');
  assert.equal(h.sandbox.status, note);
  assert.doesNotMatch(note, /正在打开旅游/);
});

test('a late successful travel load cannot replace a newer completed kids selection', async () => {
  const h = pendingPackHarness();
  const old = h.choose('travel');
  const latest = h.choose('kids');
  h.finish('kids-speak.js');
  await latest;
  const note = h.sandbox.status;
  h.finish('travel-speak.js');
  await old;
  assert.equal(h.sandbox.packId, 'kids');
  assert.equal(h.select.value, 'kids');
  assert.equal(h.sandbox.status, note);
});

test('an older load cannot select its pack while the newer course is still pending', async () => {
  const h = pendingPackHarness();
  const old = h.choose('travel');
  const latest = h.choose('kids');
  h.finish('travel-speak.js');
  await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(h.sandbox.lineIndex, 3);
  assert.equal(h.select.value, 'kids');
  h.finish('kids-speak.js');
  await latest;
  assert.equal(h.sandbox.packId, 'kids');
});

test('an older network error cannot overwrite the newer pending menu or loading message', async () => {
  const h = pendingPackHarness();
  const old = h.choose('travel');
  const latest = h.choose('kids');
  const note = h.sandbox.status;
  h.finish('travel-speak.js', true);
  await old;
  assert.equal(h.select.value, 'kids');
  assert.equal(h.sandbox.status, note);
  assert.equal(h.sandbox.packId, 'daily');
  h.finish('kids-speak.js');
  await latest;
  assert.equal(h.sandbox.packId, 'kids');
});

function contextSelectionHarness() {
  const h = pendingPackHarness();
  const articles = [];
  Object.assign(h.sandbox, {
    history: { replaceState() {} },
    syncMethodButtons() {}, syncSceneSelect() {}, methodBeforeField: 'listen',
    readAuthToken: () => '', closeMaterialsModal() {},
    currentMaterialId: '', materialTitle: '', materialScenes: null,
    scenesFromArticle: article => article.scenes,
    current: () => ['Amy', 'Hello there.', '你好。'],
    fetch() { return new Promise(resolve => articles.push(resolve)); },
  });
  vm.runInContext(['applyMethodChoice', 'methodStatusText', 'openMaterial'].map(functions).join('\n'), h.sandbox);
  return {
    ...h,
    material() { return h.sandbox.openMaterial('lesson'); },
    finishArticle() {
      assert.ok(articles.length, 'an article request is pending');
      articles.shift()({ ok: true, json: async () => ({ title: 'Imported lesson', scenes: [{ title: 'One', turns: [['Amy', 'Hello there.', '你好。']] }] }) });
    },
  };
}

test('a field choice invalidates a pending pack load and keeps its speaking method', async () => {
  const h = contextSelectionHarness();
  const old = h.choose('travel');
  h.sandbox.applyMethodChoice('field');
  h.finish('travel-speak.js');
  await old;
  assert.equal(h.sandbox.packId, 'field');
  assert.equal(h.sandbox.methodId, 'speak');
  assert.equal(h.sandbox.sceneIndex, 0);
});

test('an imported lesson cannot be replaced by an older pack load', async () => {
  const h = contextSelectionHarness();
  const old = h.choose('travel');
  const material = h.material();
  h.finishArticle(); await material;
  h.finish('travel-speak.js'); await old;
  assert.equal(h.sandbox.packId, 'material');
  assert.equal(h.sandbox.currentMaterialId, 'lesson');
  assert.equal(h.sandbox.materialTitle, 'Imported lesson');
});

test('a newer pack selection invalidates an imported lesson still loading', async () => {
  const h = contextSelectionHarness();
  const old = h.material();
  const kids = h.choose('kids');
  h.finish('kids-speak.js'); await kids;
  const note = h.sandbox.status;
  h.finishArticle(); await old;
  assert.equal(h.sandbox.packId, 'kids');
  assert.equal(h.sandbox.status, note);
});

test('a field selection invalidates an imported lesson still loading', async () => {
  const h = contextSelectionHarness();
  const old = h.material();
  h.sandbox.applyMethodChoice('field');
  h.finishArticle(); await old;
  assert.equal(h.sandbox.packId, 'field');
  assert.equal(h.sandbox.methodId, 'speak');
});

test('a method no-op still cancels an older imported lesson request', async () => {
  const h = contextSelectionHarness();
  const old = h.material();
  h.sandbox.applyMethodChoice('listen');
  h.finishArticle(); await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(h.sandbox.lineIndex, 3);
});

test('a stale session preparation cannot fetch or close the newer material menu', async () => {
  const h = contextSelectionHarness();
  let ready;
  const calls = [];
  h.sandbox.window.AuthManager = { ensureSession: () => new Promise(resolve => { ready = resolve; }) };
  h.sandbox.fetch = async () => { calls.push('fetch'); throw new Error('must not fetch'); };
  h.sandbox.closeMaterialsModal = () => calls.push('close');
  const old = h.material();
  await h.choose('daily');
  ready(); await old;
  assert.deepEqual(calls, []);
  assert.equal(h.sandbox.packId, 'daily');
});

test('a new recording prevents a previously requested forced pack from committing', async () => {
  const h = contextSelectionHarness();
  const old = h.sandbox.switchPack('travel', { force: true });
  h.sandbox.recording = true;
  h.finish('travel-speak.js'); await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(h.sandbox.lineIndex, 3);
  assert.equal(h.sandbox.recording, true);
});

test('an imported lesson does not commit after a recording starts', async () => {
  const h = contextSelectionHarness();
  const old = h.material();
  h.sandbox.recording = true;
  h.finishArticle(); await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.recording, true);
});

test('microphone permission startup invalidates a pending pack before recording is active', async () => {
  const h = contextSelectionHarness();
  let finishPermission;
  Object.assign(h.sandbox, {
    hearRecordBusy: false, captionOn: false, splitState: null,
    sentenceWords: text => text.split(/\s+/), shouldUseRecordAsr: () => false,
    splitActive: () => false, stopTyper() {}, blankSlots: parts => ({ targets: parts }),
    paintGloss() {}, paintHearLine() {},
    ensureMicPermission: () => new Promise(resolve => { finishPermission = resolve; }),
  });
  vm.runInContext(functions('startMicSession'), h.sandbox);
  const old = h.choose('travel');
  const microphone = h.sandbox.startMicSession();
  h.finish('travel-speak.js'); await old;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(await h.sandbox.switchPack('kids', { force: true }), false);
  finishPermission(false); await microphone;
  assert.equal(h.sandbox.packId, 'daily');
  assert.equal(h.sandbox.micStarting, false);
});

test('scene selection keeps the current sentence while microphone permission is pending', () => {
  const h = contextSelectionHarness();
  Object.assign(h.sandbox, {
    micStarting: true, scheduleSpeakingProgress() {}, showPractice() {},
    scene: () => ({ title: 'Current lesson' }), sceneName: item => item.title,
  });
  vm.runInContext(functions('selectScene'), h.sandbox);
  h.sandbox.selectScene(0, 0);
  assert.equal(h.sandbox.sceneIndex, 2);
  assert.equal(h.sandbox.lineIndex, 3);
});

for (const [direction, index] of [['nextLine', 0], ['prevLine', 1]]) {
  test(`${direction} keeps the sentence while microphone permission is pending`, async () => {
    const h = contextSelectionHarness();
    Object.assign(h.sandbox, {
      micStarting: true, lineIndex: index, methodId: 'speak', showPractice() {},
      scene: () => ({ turns: [['Amy', 'Hello.', '你好。'], ['Ben', 'Hi there.', '嗨。']] }),
      englishShown: () => true,
    });
    vm.runInContext(functions(direction), h.sandbox);
    await h.sandbox[direction]();
    assert.equal(h.sandbox.lineIndex, index);
  });
}

test('a reserved speech session blocks a forced course change before recognition begins', async () => {
  const h = contextSelectionHarness();
  h.sandbox.splitListen = true;
  h.sandbox.hearFromMic = true;
  h.sandbox.window.KIDS_SPEAK = [{ title: 'One', turns: [['Amy', 'Hello.', '你好。']] }];
  assert.equal(await h.sandbox.switchPack('kids', { force: true }), false);
  assert.equal(h.sandbox.packId, 'daily');
});

test('keyboard completion does not advance under a pending microphone startup', () => {
  const h = keyboardHarness();
  h.type('its really cold today isnt it'); h.press('Enter');
  h.sandbox.micStarting = true;
  h.flush();
  assert.equal(h.sandbox.lineIndex, 0);
});

test('reselecting the current field mode cancels a lazy load and restores its source menu', async () => {
  const h = contextSelectionHarness();
  h.sandbox.applyMethodChoice('field');
  const old = h.choose('travel');
  h.sandbox.applyMethodChoice('field');
  h.finish('travel-speak.js'); await old;
  assert.equal(h.sandbox.packId, 'field');
  assert.equal(h.select.value, 'daily');
});
