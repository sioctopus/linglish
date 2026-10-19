#!/usr/bin/env node
'use strict';

/**
 * 下载词卡/闯关用的真实照片到 app/frontend/images/game/photos/
 * 来源写进 photos/ATTRIBUTION.md。
 *
 * 用法: node scripts/fetch-game-photos.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(ROOT, 'frontend/images/game/photos');
const CARD_DECKS = path.resolve(ROOT, 'frontend/js/game/word-packs/card-decks.json');
const PACK_MAX = path.resolve(ROOT, 'frontend/js/game/word-packs/pack-max.json');
const ATTR_PATH = path.resolve(OUT_DIR, 'ATTRIBUTION.md');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

const ANIMAL_BASE =
  'https://cdn.jsdelivr.net/gh/ricoz/toddleranimals@master/images/animals/';
const FRUIT_BASE =
  'https://cdn.jsdelivr.net/gh/hgzojer/picturetrainer@master/app/src/main/res/raw/';
const CLOTHES_FILE_BASE =
  'https://cdn.jsdelivr.net/gh/lightly-ai/dataset_clothing_images@main/';

const ANIMAL_FILES = {
  dog: 'dog.jpg', cat: 'cat.jpg', bird: 'bird.jpg', fish: 'fish.jpg', rabbit: 'rabbit.jpg',
  horse: 'horse.jpg', cow: 'cow.jpg', pig: 'pig.jpg', lion: 'lion.jpg', elephant: 'elephant.jpg',
  monkey: 'monkey.jpg', bear: 'bear.jpg', tiger: 'tiger.jpg', zebra: 'zebra.jpg', fox: 'fox.jpg',
  wolf: 'wolf.jpg', deer: 'deer.jpg', sheep: 'sheep.jpg', goat: 'goat.jpg', chicken: 'chicken.jpg',
  duck: 'duck.jpg', frog: 'frog.jpg', snake: 'snake.jpg', turtle: 'turtle.jpg', mouse: 'mouse.jpg',
  dolphin: 'dolphin.jpg',
};

const FRUIT_FILES = {
  apple: 'apple.jpg', banana: 'banana.jpg', orange: 'orange.jpg',
  cherry: 'cherry.jpg', strawberry: 'strawberry.jpg',
};

const CLOTHES_DIR = {
  shirt: 'shirt', 't-shirt': 't-shirt', tshirt: 't-shirt', pants: 'pants', jeans: 'pants',
  dress: 'dress', skirt: 'skirt', coat: 'outwear', jacket: 'outwear', hat: 'hat',
  cap: 'hat', beanie: 'hat', shoes: 'shoes', boots: 'shoes', sandals: 'shoes',
  slippers: 'shoes', shorts: 'shorts',
};

// Unsplash 固定照片（Unsplash License）。只放确认过的 id。
const UNSPLASH = {
  panda: '1525382455947-f319bc05fb35',
  giraffe: '1547721064-da6cfb341d50',
  kangaroo: '1575699914911-0027c7b95fb6',
  penguin: '1598439210625-5067c578f3f6',
  'polar bear': '1589656966895-2f33e7653819',
  grape: '1537640538966-79f369143f8f',
  watermelon: '1587049352846-4a222e784d38',
  pear: '1517277518246-ae956fc5aeb3',
  peach: '1595747732137-595192f69043',
  pineapple: '1490885578174-acda8905c2c6',
  mango: '1553279768-865429fa0078',
  lemon: '1590502593744-c1857ed57922',
  kiwi: '1615485290382-441e4d049cb5',
  coconut: '1557800636-894a64c1696f',
  blueberry: '1498557850523-fd3d118b962e',
  raspberry: '1577069861033-55e04ce45a1a',
  avocado: '1523049673857-eb4f4dcb4d1f',
  lime: '1621506289937-a8e4df240d0b',
  car: '1492144534655-ae79c964c9d7',
  bus: '1544620341-11cb7edc48e2',
  train: '1474487548417-781cb71495f3',
  plane: '1436491865332-7a61a109cc05',
  boat: '1544551763-46a013bb70d5',
  taxi: '1519659528534-7fd503be5835',
  truck: '1519003722824-194d4455a60c',
  motorcycle: '1558981403-c5f9899a28bc',
  ship: '1569263979104-865ab7cd8d13',
  // 交通主题词卡改由 scripts/repair-vehicle-photos-commons.js 维护(Commons 已核验)。
  // 勿再用不稳定的 Unsplash/Pexels 数字 ID 覆盖 ambulance/fire truck/rocket 等。
  park: '1519331379826-f10be3486a1b',
  beach: '1507525428034-b723cf961d3e',
  kitchen: '1556910103-1c02745aae4d',
  bedroom: '1522771739844-6a9f6d5f14af',
  hospital: '1516549655169-df83a0774514',
  supermarket: '1542838132-92c53300491e',
  library: '1521587760476-6c12a4b040da',
  farm: '1500935313896-41b8d0c2d0c2',
  airport: '1436491865332-7a61a109cc05',
  restaurant: '1517248135467-4c7edcad34c4',
  street: '1477959858617-67f85cf4f1df',
  // school = 校园外观楼体; classroom = 空教室(勿与课桌/办公室混用)
  school: '1562774053-701939374585',
  classroom: '1580582932707-520aed937b7b',
  museum: '1554907984-15263bfd63bd',
  cinema: '1489599849927-2cdc440e33a5',
  hotel: '1566073771259-6a8506099945',
  bathroom: '1552321554-5fefe8c9ef14',
  'living room': '1586023492125-27b2c045efd7',
  garden: '1416879595882-3373a0480b5b',
  forest: '1448375240586-882707db888b',
  mountain: '1464822759023-fed622ff2c3b',
  river: '1439066615861-d1af74d74000',
  market: '1488459716781-31db52582fe9',
  bookstore: '1524995997946-a1c2e315a42f',
  cafe: '1495474472287-4d71bcdd2085',
  socks: '1586350977771-b3b0abd50c67',
  sweater: '1576566588028-4147f3842f27',
  hoodie: '1556821840-3a63f95609a7',
  umbrella: '1527489377706-5bf9163fda69',
  // chair = 带靠背椅子(勿用无靠背凳子)
  chair: '1506439773649-6e0eb8cfb237',
  book: '1544716278-ca5e3f4abd8c',
  bag: '1553062407-98eeb64c6a62',
  bottle: '1602143407151-7111542de6e8',
  phone: '1511707171634-5f897ff02aa9',
  pencil: '1513542789411-952c69fee492',
  student: '1523240795612-9a054b0db644',
  girl: '1517841905240-472988babdf9',
  bike: '1571068316344-75bc76f77890',
  // jeep / convertible：见 repair-vehicle-photos-commons.js
  zoo: '1534567110243-b87b6d3b0a0b',
  playground: '1566454825489-2f0c0d3f3f3f',
  station: '1474487548417-781cb71495f3',
  // desk = 木质课桌(勿用办公室走廊)
  desk: '1635424239131-32dc44986b56',
  door: '1535905557558-afc1acb73553',
  window: '1497366216548-37526070297c',
  paper: '1586281380349-632531db7ed4',
  suit: '1507679799987-7f3865fd05d4',
  uniform: '1523050854058-8df90110c9f1',
};


const COLOR_HEX = {
  red: '#e11d48', blue: '#2563eb', green: '#16a34a', yellow: '#eab308',
  orange: '#f97316', purple: '#9333ea', pink: '#ec4899', black: '#0f172a',
  white: '#f8fafc', brown: '#92400e', gray: '#64748b', grey: '#64748b',
  gold: '#d97706', silver: '#94a3b8', beige: '#d6d3d1', navy: '#1e3a8a',
  turquoise: '#14b8a6', violet: '#7c3aed', indigo: '#4338ca', maroon: '#9f1239',
  crimson: '#be123c', scarlet: '#dc2626', ivory: '#fffbeb', cream: '#fef3c7',
  tan: '#d6b48a', olive: '#65a30d', lime: '#84cc16', cyan: '#06b6d4',
  magenta: '#d946ef',
};

function slugify(lemma) {
  return String(lemma).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function unsplashUrl(id) {
  return 'https://images.unsplash.com/photo-' + id + '?w=640&h=640&fit=crop&q=80';
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeColorSwatch(lemma, hex) {
  const canvas = createCanvas(640, 640);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 640, 640);
  if (lemma === 'white' || lemma === 'ivory' || lemma === 'cream') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 632, 632);
  }
  return canvas.toBuffer('image/jpeg', 85);
}

function writeRainbowSwatch() {
  const canvas = createCanvas(640, 640);
  const ctx = canvas.getContext('2d');
  const colors = ['#e11d48', '#f97316', '#eab308', '#16a34a', '#2563eb', '#9333ea'];
  const w = 640 / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i * w, 0, w + 1, 640);
  });
  return canvas.toBuffer('image/jpeg', 85);
}

async function firstClothesFile(dir) {
  const api =
    'https://api.github.com/repos/lightly-ai/dataset_clothing_images/contents/' + dir;
  const response = await fetch(api, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return null;
  const list = await response.json();
  const file = (list || []).find((item) => /\.jpe?g$/i.test(item.name));
  return file ? file.download_url : null;
}

async function resolveSource(lemma) {
  const key = lemma.toLowerCase();

  if (COLOR_HEX[key]) {
    return {
      kind: 'generated',
      buffer: writeColorSwatch(key, COLOR_HEX[key]),
      credit: 'Generated color swatch (Linglish)',
    };
  }
  if (key === 'rainbow' || key === 'colorful' || key === 'color') {
    return {
      kind: 'generated',
      buffer: writeRainbowSwatch(),
      credit: 'Generated color swatch (Linglish)',
    };
  }
  if (ANIMAL_FILES[key]) {
    return {
      kind: 'url',
      url: ANIMAL_BASE + ANIMAL_FILES[key],
      credit: 'ricoz/toddleranimals (MIT)',
    };
  }
  if (FRUIT_FILES[key]) {
    return {
      kind: 'url',
      url: FRUIT_BASE + FRUIT_FILES[key],
      credit: 'hgzojer/picturetrainer (Wikimedia-sourced fruits)',
    };
  }
  if (CLOTHES_DIR[key]) {
    const url = await firstClothesFile(CLOTHES_DIR[key]);
    if (url) {
      return {
        kind: 'url',
        url,
        credit: 'lightly-ai/dataset_clothing_images (CC0)',
      };
    }
  }
  if (UNSPLASH[key]) {
    return {
      kind: 'url',
      url: unsplashUrl(UNSPLASH[key]),
      credit: 'Unsplash photo-' + UNSPLASH[key],
    };
  }
  return null;
}

function collectLemmas() {
  const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(PACK_MAX, 'utf8'));
  const set = new Set();
  decks.decks.forEach((deck) => {
    if (deck.id === 'numbers' || deck.id === 'letters') return;
    deck.words.forEach((word) => set.add(word.lemma));
  });
  pack.chapters.forEach((chapter) => {
    chapter.words.forEach((word) => set.add(word.lemma));
  });
  return [...set];
}

function applyPhotos(photoByLemma) {
  const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
  decks.decks.forEach((deck) => {
    deck.words.forEach((word) => {
      const photo = photoByLemma.get(word.lemma.toLowerCase());
      if (photo) word.photo = photo;
      else delete word.photo;
    });
  });
  fs.writeFileSync(CARD_DECKS, JSON.stringify(decks, null, 2) + '\n');

  const pack = JSON.parse(fs.readFileSync(PACK_MAX, 'utf8'));
  pack.chapters.forEach((chapter) => {
    chapter.words.forEach((word) => {
      const photo = photoByLemma.get(word.lemma.toLowerCase());
      if (photo) word.photo = photo;
      else delete word.photo;
    });
  });
  fs.writeFileSync(PACK_MAX, JSON.stringify(pack, null, 2) + '\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lemmas = collectLemmas();
  const photoByLemma = new Map();
  const credits = [];
  let ok = 0;
  let miss = 0;

  for (const lemma of lemmas) {
    const slug = slugify(lemma);
    const outFile = path.join(OUT_DIR, slug + '.jpg');
    const publicPath = '/images/game/photos/' + slug + '.jpg?v=1';

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
      photoByLemma.set(lemma.toLowerCase(), publicPath);
      credits.push('- `' + slug + '.jpg` ← ' + lemma + ' ← cached');
      ok += 1;
      continue;
    }

    const source = await resolveSource(lemma);
    if (!source) {
      miss += 1;
      continue;
    }

    let buffer = null;
    if (source.kind === 'generated') buffer = source.buffer;
    else buffer = await download(source.url);

    if (!buffer || buffer.length < 500) {
      miss += 1;
      console.log('miss', lemma);
      continue;
    }

    fs.writeFileSync(outFile, buffer);
    photoByLemma.set(lemma.toLowerCase(), publicPath);
    credits.push('- `' + slug + '.jpg` ← ' + lemma + ' ← ' + source.credit);
    ok += 1;
    if (ok % 15 === 0) console.log('progress', ok, 'ok /', miss, 'miss');
  }

  applyPhotos(photoByLemma);
  fs.writeFileSync(
    ATTR_PATH,
    ['# Game photo attribution', '', 'Real photos used by Linglish word cards and challenge packs.', '', ...credits.sort(), '',].join('\n'),
  );
  console.log('done ok=', ok, 'miss=', miss, 'of', lemmas.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
