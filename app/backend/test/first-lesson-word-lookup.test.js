const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assist = require('../../frontend/js/video-reader/sentence-assist');

function fixture({ guided = true } = {}) {
  const pending = new Map();
  const calls = [];
  const say = { addEventListener: (_type, fn) => { say.click = fn; } };
  const card = { hidden: true, innerHTML: '', querySelector: selector => selector === '[data-assist="say"]' ? say : null };
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/video-reader/main.js'), 'utf8');
  const start = source.indexOf('async function showSentenceAssist(word) {');
  const end = source.indexOf('\nasync function lookupWord(rawWord)', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    document: { getElementById: id => id === 'sentence-assist' ? card : (id === 'practice-start' ? { click: () => calls.push('legacy-record') } : null) },
    window: { LinglishSentenceAssist: assist },
    state: { lastLookupContext: { sentence: 'Your brother and family.' } },
    firstLessonSession: { isActive: () => guided },
    firstLessonGoalCard: { recordSentence: () => calls.push('guided-record') },
    localStorage: { getItem: () => null },
    API_BASE: '', AbortController, setTimeout, clearTimeout,
    fetch: url => new Promise(resolve => pending.set(url, resolve)),
  });
  vm.runInContext(`let sentenceAssistRequest = 0;\n${source.slice(start, end)}`, context);
  return {
    card, calls, say,
    lookup: word => context.showSentenceAssist(word),
    resolve(word, gloss) {
      pending.get(`/dictionary/${word}`)({ ok: true, json: async () => ({ entry: {
        meanings: [{ definitions: [{ zh: gloss }] }],
      } }) });
    },
  };
}

test('a slower earlier guided lookup cannot replace the word tapped most recently', async () => {
  const f = fixture();
  const brother = f.lookup('brother');
  const family = f.lookup('family');
  f.resolve('family', '一家人');
  await family;
  const latest = f.card.innerHTML;
  assert.match(latest, /family/);
  assert.match(latest, /一家人/);
  f.resolve('brother', '兄弟');
  await brother;
  assert.equal(f.card.innerHTML, latest);
});

test('continuing from a guided word card uses the goal recorder that prepares the displayed sentence', async () => {
  const f = fixture();
  const request = f.lookup('family');
  f.resolve('family', '一家人');
  await request;
  f.say.click();
  assert.equal(f.card.hidden, true);
  assert.deepEqual(f.calls, ['guided-record']);
});

test('a word card outside the guided lesson retains the existing practice record action', async () => {
  const f = fixture({ guided: false });
  const request = f.lookup('family');
  f.resolve('family', '一家人');
  await request;
  f.say.click();
  assert.deepEqual(f.calls, ['legacy-record']);
});

test('closing the guided word card while its request is pending keeps it closed', async () => {
  const f = fixture();
  const request = f.lookup('family');
  f.card.hidden = true;
  const loading = f.card.innerHTML;
  f.resolve('family', '一家人');
  await request;
  assert.equal(f.card.hidden, true);
  assert.equal(f.card.innerHTML, loading);
});
