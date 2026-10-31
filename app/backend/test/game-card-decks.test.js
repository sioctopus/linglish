const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packPath = path.resolve(__dirname, '../../frontend/js/game/word-packs/card-decks.json');

function loadDecks() {
  return JSON.parse(fs.readFileSync(packPath, 'utf8'));
}

test('card decks cover theme packs plus numbers and alphabet', () => {
  const pack = loadDecks();
  assert.deepEqual(
    pack.decks.map((deck) => deck.id),
    ['fruits', 'animals', 'vehicles', 'colors', 'clothes', 'scenes', 'numbers', 'letters', 'shapes', 'body', 'appliances', 'home', 'jobs', 'family', 'nature', 'currencies'],
  );
});

test('each theme deck has enough study cards with chinese glosses', () => {
  const minWords = {
    numbers: 100, letters: 26, shapes: 20, body: 21, appliances: 20,
    home: 40, jobs: 40, family: 30, nature: 18, currencies: 1,
  };
  function deckWords(deck) {
    if (Array.isArray(deck.words) && deck.words.length) return deck.words;
    if (Array.isArray(deck.groups)) {
      return deck.groups.flatMap((group) => (group && group.words) || []);
    }
    return [];
  }
  loadDecks().decks.forEach((deck) => {
    const words = deckWords(deck);
    const min = minWords[deck.id] || 30;
    assert.ok(words.length >= min, `${deck.id} has ${words.length}, want >= ${min}`);
    words.forEach((word) => {
      assert.ok(word.lemma, deck.id);
      assert.ok(word.zh, word.lemma);
      assert.ok(word.ipa, word.lemma);
      assert.ok(word.emoji, word.lemma);
      if (deck.id === 'numbers') {
        assert.match(String(word.emoji), /^(?:[1-9]|[1-9]\d|100)$/, word.lemma);
      } else if (deck.id === 'letters') {
        assert.match(String(word.emoji), /^[A-Z]$/, word.lemma);
      } else {
        assert.match(word.emoji, /\p{Extended_Pictographic}/u, word.lemma);
      }
    });
  });
});

test('numbers deck counts from one to one hundred', () => {
  const deck = loadDecks().decks.find((item) => item.id === 'numbers');
  assert.equal(deck.words.length, 100);
  assert.equal(deck.words[0].lemma, 'one');
  assert.equal(deck.words[20].lemma, 'twenty-one');
  assert.equal(deck.words[99].lemma, 'one hundred');
});

test('shapes deck teaches common shapes and the four directions', () => {
  const deck = loadDecks().decks.find((item) => item.id === 'shapes');
  const lemmas = deck.words.map((word) => word.lemma);
  ['circle', 'square', 'triangle', 'rectangle', 'up', 'down', 'left', 'right'].forEach((lemma) => {
    assert.ok(lemmas.includes(lemma), lemma);
  });
  deck.words.forEach((word) => {
    assert.match(word.photo, /^\/images\/game\/shapes\/.+\.svg(\?v=\d+)?$/);
    const file = path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
    assert.ok(fs.existsSync(file), word.lemma);
  });
});

test('body and appliance decks use local drawings or photographs', () => {
  const pack = loadDecks();
  const body = pack.decks.find((item) => item.id === 'body');
  const appliances = pack.decks.find((item) => item.id === 'appliances');
  ['head', 'eye', 'ear', 'nose', 'mouth', 'hand', 'foot'].forEach((lemma) => {
    assert.ok(body.words.some((word) => word.lemma === lemma), lemma);
  });
  ['television', 'fridge', 'washing machine', 'air conditioner', 'fan', 'phone', 'dryer', 'switch', 'socket'].forEach((lemma) => {
    assert.ok(appliances.words.some((word) => word.lemma === lemma), lemma);
  });
  body.words.concat(appliances.words).forEach((word) => {
    assert.match(word.photo, /^\/images\/game\/(?:(?:body|appliances)\/.+\.svg|photos\/.+\.jpg)/);
    const file = path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
    assert.ok(fs.existsSync(file), word.lemma);
    if (word.photo.includes('/photos/')) assert.ok(fs.statSync(file).size > 8000, word.lemma);
  });
  const bodyArt = fs.readFileSync(path.resolve(__dirname, '../../frontend/images/game/body/body.svg'), 'utf8');
  assert.doesNotMatch(bodyArt, /<rect width="640" height="640" fill="#ffffff"\/>/);
  assert.match(body.words.find((word) => word.lemma === 'face').photo, /\/photos\/face\.jpg/);
  assert.match(body.words.find((word) => word.lemma === 'eye').photo, /\/photos\/eye\.jpg/);
  assert.match(appliances.words.find((word) => word.lemma === 'television').photo, /\/photos\/television\.jpg/);
  assert.match(appliances.words.find((word) => word.lemma === 'phone').photo, /\/photos\/phone\.jpg/);
});

test('home jobs and family decks cover daily life vocabulary with local photos', () => {
  const pack = loadDecks();
  const home = pack.decks.find((item) => item.id === 'home');
  const jobs = pack.decks.find((item) => item.id === 'jobs');
  const family = pack.decks.find((item) => item.id === 'family');
  ['sofa', 'toilet', 'shower', 'toothbrush', 'curtain', 'stove'].forEach((lemma) => {
    assert.ok(home.words.some((word) => word.lemma === lemma), lemma);
  });
  ['teacher', 'professor', 'student', 'barber', 'architect', 'software engineer', 'network engineer'].forEach((lemma) => {
    assert.ok(jobs.words.some((word) => word.lemma === lemma), lemma);
  });
  ['father', 'mother', 'grandfather', 'grandmother', 'older brother', 'older sister', 'uncle', 'aunt', 'cousin'].forEach((lemma) => {
    assert.ok(family.words.some((word) => word.lemma === lemma), lemma);
  });
  home.words.concat(jobs.words, family.words).forEach((word) => {
    assert.match(word.photo, /^\/images\/game\/photos\/.+\.jpg/, word.lemma);
    const file = path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
    assert.ok(fs.existsSync(file), word.lemma);
    assert.ok(fs.statSync(file).size > 5000, word.lemma);
  });
});

test('currency deck groups notes by currency with real denomination photos', async () => {
  const { loadImage } = require('@napi-rs/canvas');
  const deck = loadDecks().decks.find((item) => item.id === 'currencies');
  assert.ok(Array.isArray(deck.groups));
  assert.deepEqual(deck.groups.map((group) => group.label), [
    '人民币', '美元', '英镑', '欧元', '日元', '韩元', '台币', '港币', '泰铢', '越南盾',
  ]);
  const yuan = deck.groups.find((group) => group.id === 'yuan');
  assert.deepEqual(yuan.words.map((word) => word.amount), [1, 5, 10, 20, 50, 100]);
  assert.deepEqual(deck.groups.find((group) => group.id === 'dollar').words.map((word) => word.amount), [1, 5, 10, 20, 50, 100]);
  assert.deepEqual(deck.groups.find((group) => group.id === 'euro').words.map((word) => word.amount), [5, 10, 20, 50, 100, 200]);
  assert.deepEqual(deck.groups.find((group) => group.id === 'yen').words.map((word) => word.amount), [1000, 5000, 10000]);
  assert.deepEqual(deck.groups.find((group) => group.id === 'won').words.map((word) => word.amount), [1000, 5000, 10000, 50000]);
  assert.deepEqual(deck.groups.find((group) => group.id === 'pound').words.map((word) => word.amount), [5, 10]);
  const allWords = deck.groups.flatMap((group) => group.words);
  for (const word of allWords) {
    assert.ok(word.amount != null, word.lemma);
    assert.match(word.photo, /^\/images\/game\/photos\/currency-.+\.jpg\?v=\d+$/, word.lemma);
    const file = path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
    assert.ok(fs.statSync(file).size > 15000, word.lemma);
    const image = await loadImage(file);
    assert.equal(image.width, 640, word.lemma);
    assert.equal(image.height, 640, word.lemma);
  }
  const views = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/game/game-views.js'), 'utf8');
  assert.match(views, /game-currency-places/);
  assert.match(views, /selectCurrency/);
});

test('letters deck covers A to Z', () => {
  const deck = loadDecks().decks.find((item) => item.id === 'letters');
  assert.equal(deck.words.length, 26);
  assert.equal(deck.words[0].lemma, 'A');
  assert.equal(deck.words[25].lemma, 'Z');
});

test('animal and nature decks use local photographs', () => {
  const pack = loadDecks();
  const animals = pack.decks.find((item) => item.id === 'animals');
  const nature = pack.decks.find((item) => item.id === 'nature');
  ['dog', 'horse', 'panda', 'penguin', 'kangaroo', 'shark', 'whale', 'owl', 'polar bear'].forEach((lemma) => {
    assert.ok(animals.words.some((word) => word.lemma === lemma), lemma);
  });
  ['forest', 'ocean', 'snow mountain', 'desert', 'waterfall', 'volcano'].forEach((lemma) => {
    assert.ok(nature.words.some((word) => word.lemma === lemma), lemma);
  });
  animals.words.concat(nature.words).forEach((word) => {
    assert.match(word.photo, /^\/images\/game\/photos\/.+\.jpg/, word.lemma);
    const file = path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
    assert.ok(fs.existsSync(file), word.lemma);
    assert.ok(fs.statSync(file).size > 20000, word.lemma);
  });
});

test('home pages open each reading deck inside the game', () => {
  const frontend = path.resolve(__dirname, '../../frontend');
  const decks = loadDecks().decks;
  const gameApp = fs.readFileSync(path.join(frontend, 'js/game/game-app.js'), 'utf8');
  assert.match(gameApp, /searchParams\.get\('deck'\)/);
  assert.match(gameApp, /openCardDeck\(deckId\)/);
  assert.match(gameApp, /encodeURIComponent\(gameReturnPath\(\)\)/);

  ['index-desktop.html', 'mobile-today.html'].forEach((page) => {
    const html = fs.readFileSync(path.join(frontend, page), 'utf8');
    assert.match(html, /id="game-read-cards"/);
    decks.forEach((deck) => {
      const href = `href="./game.html?deck=${deck.id}"`;
      assert.ok(html.includes(href), `${page} missing ${href}`);
      assert.ok(html.includes(`<strong>${deck.label}</strong>`), `${page} missing ${deck.label}`);
      const first = Array.isArray(deck.words) && deck.words[0]
        ? deck.words[0]
        : deck.groups && deck.groups[0] && deck.groups[0].words && deck.groups[0].words[0];
      assert.ok(first && first.photo, `${deck.id} needs a cover photo`);
      // 首页封面只核对路径，版本号可与词卡 JSON 各自 bump
      const coverBase = first.photo.replace(/^\//, './').replace(/\?.*$/, '');
      assert.ok(html.includes(coverBase), `${page} missing cover ${coverBase}`);
    });
  });
});

test('reading cards move with arrow keys and toggle speech with space', () => {
  const views = require(path.resolve(__dirname, '../../frontend/js/game/game-views.js'));
  assert.equal(views.cardKeyAction({ key: 'ArrowUp', target: { tagName: 'BUTTON' } }), 'prev');
  assert.equal(views.cardKeyAction({ key: 'ArrowDown', target: { tagName: 'BODY' } }), 'next');
  assert.equal(views.cardKeyAction({ key: ' ', code: 'Space', target: { tagName: 'BUTTON' } }), 'toggle');
  assert.equal(views.cardKeyAction({ key: 'ArrowDown', target: { tagName: 'INPUT' } }), null);
  assert.equal(views.cardKeyAction({ key: 'ArrowUp', ctrlKey: true, target: { tagName: 'BODY' } }), null);
  const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/game/game-views.js'), 'utf8');
  assert.match(source, /bindCardKeys\(onKey\)/);
  assert.match(source, /action === 'toggle'|return 'toggle'/);
});

test('repaired fruit photos are not copies of another fruit', async () => {
  const crypto = require('node:crypto');
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const fruits = loadDecks().decks.find((deck) => deck.id === 'fruits');
  const fileOf = (lemma) => {
    const word = fruits.words.find((item) => item.lemma === lemma);
    return path.resolve(__dirname, '../../frontend', word.photo.replace(/^\//, '').replace(/\?.*$/, ''));
  };
  const hash = (lemma) => crypto.createHash('md5').update(fs.readFileSync(fileOf(lemma))).digest('hex');
  assert.notEqual(hash('lemon'), hash('orange'));
  assert.notEqual(hash('kiwi'), hash('papaya'));
  assert.notEqual(hash('kiwi'), hash('dragon fruit'));
  assert.notEqual(hash('papaya'), hash('dragon fruit'));
  assert.notEqual(hash('coconut'), hash('tangerine'));
  assert.notEqual(hash('apricot'), hash('fig'));
  assert.notEqual(hash('grapefruit'), hash('watermelon'));
  assert.notEqual(hash('cantaloupe'), hash('melon'));
  assert.notEqual(hash('plum'), hash('papaya'));
  assert.notEqual(hash('durian'), hash('coconut'));

  const img = await loadImage(path.resolve(__dirname, '../../frontend/images/game/photos/one.png'));
  const canvas = createCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 128, 128);
  const data = ctx.getImageData(0, 0, 128, 128).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 100) dark += 1;
  }
  assert.ok(dark > 200, 'one.png should be a large numeral, dark pixels ' + dark);
  assert.equal(data[3], 0, 'one.png corner should be transparent');
});

test('concrete theme cards use real local photos when available', () => {
  const pack = loadDecks();
  const dog = pack.decks.find((d) => d.id === 'animals').words.find((w) => w.lemma === 'dog');
  assert.match(dog.photo, /^\/images\/game\/photos\/dog\.jpg/);
  const photoPath = path.resolve(__dirname, '../../frontend', dog.photo.replace(/^\//, '').replace(/\?.*$/, ''));
  assert.ok(fs.existsSync(photoPath), 'dog.jpg missing on disk');
  const fruits = pack.decks.find((d) => d.id === 'fruits');
  fruits.words.forEach((word) => {
    assert.ok(word.photo, word.lemma + ' needs a real photo');
    assert.doesNotMatch(word.photo, /color-/, word.lemma + ' must not use color swatch');
  });
  const colors = pack.decks.find((d) => d.id === 'colors');
  colors.words.forEach((word) => {
    assert.match(word.photo, /\/color-/, word.lemma);
  });
});
