const fs = require('fs');
const https = require('https');
const path = require('path');
const { builtInDict, properNameDict } = require('../services/translation/built-in-dictionary');
const { getCuratedEntry } = require('../services/dictionary/curated-entries');

const ROOT = path.join(__dirname, '..', '..');
const DAILY = path.join(ROOT, 'frontend', 'daily-speaking.html');
const CORE = path.join(ROOT, 'frontend', 'data', 'core-850.js');
const OUT = path.join(ROOT, 'frontend', 'data', 'gloss-lexicon.json');

const FALLBACK_POS = {
  i: 'pronoun', me: 'pronoun', you: 'pronoun', he: 'pronoun', she: 'pronoun', we: 'pronoun',
  they: 'pronoun', it: 'pronoun', my: 'pronoun', your: 'pronoun', his: 'pronoun', her: 'pronoun',
  our: 'pronoun', their: 'pronoun', him: 'pronoun', them: 'pronoun', us: 'pronoun',
  this: 'determiner', that: 'determiner', these: 'determiner', those: 'determiner',
  a: 'determiner', an: 'determiner', the: 'determiner', some: 'determiner', any: 'determiner',
  every: 'determiner', no: 'determiner', and: 'conjunction', or: 'conjunction', but: 'conjunction',
  if: 'conjunction', in: 'preposition', on: 'preposition', at: 'preposition', to: 'particle',
  for: 'preposition', of: 'preposition', with: 'preposition', from: 'preposition',
  is: 'verb', am: 'verb', are: 'verb', was: 'verb', were: 'verb', be: 'verb',
  have: 'verb', has: 'verb', do: 'verb', does: 'verb', did: 'verb',
  can: 'modal', could: 'modal', will: 'modal', would: 'modal', should: 'modal',
  may: 'modal', might: 'modal', must: 'modal', not: 'adverb', please: 'adverb',
  hi: 'interjection', hey: 'interjection', hello: 'interjection', bye: 'interjection',
  yes: 'interjection', yeah: 'interjection', yep: 'interjection'
};

function shortZh(text) {
  const raw = String(text || '').trim();
  if (!/[\u4e00-\u9fa5]/.test(raw)) return '';
  const piece = raw.split(/[，,。；;、/（(]/)[0].trim();
  return piece.length > 8 ? piece.slice(0, 8) : piece;
}

function collectWords(text) {
  const found = new Set();
  const re = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;
  let match;
  while ((match = re.exec(text))) found.add(match[0].toLowerCase());
  return found;
}

function englishFromDaily(html) {
  const words = new Set();
  const re = /\[\s*'[^']*'\s*,\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*,/g;
  let match;
  while ((match = re.exec(html))) {
    collectWords(match[1] || match[2] || '').forEach((word) => words.add(word));
  }
  return words;
}

function readCore() {
  const raw = fs.readFileSync(CORE, 'utf8').replace(/^window\.CORE_850\s*=\s*/, '').replace(/;\s*$/, '');
  const scenes = JSON.parse(raw);
  const zh = new Map();
  const words = new Set();
  scenes.forEach((scene) => {
    (scene.words || []).forEach(([en, meaning]) => {
      const key = String(en || '').toLowerCase();
      if (!/^[a-z][a-z'-]{0,30}$/.test(key)) return;
      words.add(key);
      if (!zh.has(key)) zh.set(key, shortZh(meaning));
    });
    (scene.turns || []).forEach((turn) => {
      collectWords(turn[1] || '').forEach((word) => words.add(word));
    });
  });
  return { words, zh };
}

function normalizeIpa(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\u4e00-\u9fa5]/.test(raw)) return '';
  const body = raw.replace(/^\/+|\/+$/g, '').replace(/\s+/g, '');
  if (!body || body.length > 40) return '';
  if (!/[A-Za-zæɑɒɔəɛɪʊʌθðʃʒŋɡˈˌː]/.test(body)) return '';
  return `/${body}/`;
}

function fetchEntry(word, attempt = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { family: 4 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 429 && attempt < 1) {
          setTimeout(() => finish(fetchEntry(word, attempt + 1)), 600);
          return;
        }
        if (res.statusCode !== 200) return finish(null);
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const entry = Array.isArray(payload) ? payload[0] : null;
          if (!entry) return finish(null);
          const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
          const us = phonetics.find((item) => item && item.text && /us/i.test(item.audio || ''));
          const ipa = normalizeIpa((us && us.text) || entry.phonetic || (phonetics.find((item) => item && item.text) || {}).text);
          const poses = [...new Set((entry.meanings || []).map((item) => String(item.partOfSpeech || '').toLowerCase()).filter(Boolean))];
          finish({ ipa, poses });
        } catch (_) {
          finish(null);
        }
      });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      finish(null);
    });
    req.on('error', () => finish(null));
  });
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

async function main() {
  const daily = englishFromDaily(fs.readFileSync(DAILY, 'utf8'));
  const core = readCore();
  const words = [...new Set([...daily, ...core.words])].filter((word) => /^[a-z][a-z'-]{0,30}$/.test(word)).sort();
  const fetchWords = words.filter((word) => daily.has(word));
  console.log('words', words.length, 'fetch', fetchWords.length);
  const lexicon = {};
  words.forEach((word) => {
    const curated = getCuratedEntry(word);
    const curatedMeaning = curated?.meanings?.[0]?.definitions?.[0]?.zh || '';
    const zh = core.zh.get(word) || shortZh(curatedMeaning) || shortZh(builtInDict[word]) || shortZh(properNameDict[word]) || '';
    const pos = FALLBACK_POS[word] || (curated && curated.partOfSpeech) || (properNameDict[word] && !builtInDict[word] ? 'noun' : '');
    const ipa = normalizeIpa(curated?.phonetic) || '';
    if (!ipa && !pos && !zh) return;
    lexicon[word] = { ipa, pos, poses: pos ? [pos] : [], zh };
  });
  const write = () => fs.writeFileSync(OUT, JSON.stringify(lexicon));
  write();
  let done = 0;
  let withIpa = Object.values(lexicon).filter((item) => item.ipa).length;
  await mapPool(fetchWords, 6, async (word) => {
    const remote = await fetchEntry(word);
    done += 1;
    if (remote && lexicon[word]) {
      if (remote.ipa) {
        lexicon[word].ipa = remote.ipa;
        withIpa += 1;
      }
      if (remote.poses && remote.poses.length) lexicon[word].poses = remote.poses;
      if (!lexicon[word].pos && remote.poses && remote.poses[0]) lexicon[word].pos = remote.poses[0];
    } else if (remote && (remote.ipa || (remote.poses && remote.poses[0]))) {
      lexicon[word] = {
        ipa: remote.ipa || '',
        pos: FALLBACK_POS[word] || remote.poses[0] || '',
        poses: remote.poses || [],
        zh: ''
      };
      if (remote.ipa) withIpa += 1;
    }
    if (done % 40 === 0) {
      write();
      console.log('fetch', done, '/', fetchWords.length, 'ipa', withIpa);
    }
    return null;
  });
  write();
  console.log('wrote', Object.keys(lexicon).length, 'withIpa', withIpa);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
