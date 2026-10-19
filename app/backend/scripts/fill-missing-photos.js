#!/usr/bin/env node
'use strict';

/**
 * 1) 颜色色卡改存 color-*.jpg，避免覆盖 orange/lime 等水果真图
 * 2) 按 Unsplash 固定 ID 补齐缺失词图
 * 3) 写回 card-decks / pack-max
 */

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(ROOT, 'frontend/images/game/photos');
const CARD_DECKS = path.resolve(ROOT, 'frontend/js/game/word-packs/card-decks.json');
const PACK_MAX = path.resolve(ROOT, 'frontend/js/game/word-packs/pack-max.json');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

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

// lemma → Unsplash photo id（不含 photo- 前缀）
const UNSPLASH = {
  // fruits
  pear: '1655079342319-33193026ad61',
  peach: '1602813812581-0713dae489da',
  cherry: '1559181567-c3190ca9959b',
  raspberry: '1577069861033-55e04ce45a1a',
  melon: '1605674073932-262014682e46',
  plum: '1601004890684-d8cbf836bc2a',
  apricot: '1599599810769-bcde5a160d32',
  fig: '1601493700631-c0b3b0a0b0b1',
  avocado: '1523049673857-eb18f1d7b578',
  pomegranate: '1542838132-92c53300491e',
  grapefruit: '1587049352846-4a222e784d38',
  tangerine: '1557800636-894a64c1696f',
  cantaloupe: '1605674073932-262014682e46',
  'dragon fruit': '1615485290382-441e4d049cb5',
  orange: '1557800636-894a64c1696f',
  lime: '1621506289937-a8e4df240d0b',
  apple: '1579613832125-5d34a13ffe2a',
  // animals
  fish: '1524704654697-0d0875f4b1c8',
  horse: '1553284965-83fd3e82fa5c',
  cow: '1546445317-29a47409b87e',
  bear: '1530595467532-8b3f0b0a0b0b',
  panda: '1564349683136-77e08bbdab5f',
  zebra: '1501706362039-c6e758630b31',
  deer: '1484406566174-c9691bec6d69',
  sheep: '1484557989985-89d6da2b95f2',
  duck: '1560982143-4b21a8917d5b',
  frog: '1496196614465-930d67d693a9',
  snake: '1531386157998-3f0a3b0a0b0c',
  turtle: '1437620987456-3f0a3b0a0b0d',
  dolphin: '1570481662006-a3a1374699e3',
  // vehicles
  bus: '1544620341-11cb7edc48e2',
  taxi: '1519659528534-7fd503be5835',
  'police car': '1549317661-bd32cba36adb',
  scooter: '1558618047-3c8c76ca7d13',
  yacht: '1567894340315-735a97b4c7f4',
  ferry: '1544551763-77ef2d0c6336',
  'hot air balloon': '1507608616759-54e000e48275',
  // clothes
  hat: '1521369909029-2afa61d1cb4b',
  socks: '1586350977771-b3b0abd50c67',
  't-shirt': '1521572163474-6864f9cf17ab',
  sandals: '1543163521-1bf539c55dd2',
  slippers: '1543163521-1bf539c55dd2',
  cap: '1521369909029-2afa61d1cb4b',
  beanie: '1576871337632-b9aef4c17ab9',
  tie: '1507679799987-7f3865fd05d4',
  suit: '1507679799987-7f3865fd05d4',
  swimsuit: '1507525428034-b723cf961d3e',
  umbrella: '1527489377706-5bf9163fda69',
  // scenes
  park: '1519331379826-f10be3486a1b',
  cinema: '1489599849927-2cdc440e33a5',
};

function slugify(lemma) {
  return String(lemma).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function writeColorSwatch(name, hex) {
  const canvas = createCanvas(640, 640);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 640, 640);
  if (name === 'white' || name === 'ivory' || name === 'cream') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 632, 632);
  }
  return canvas.toBuffer('image/jpeg', 85);
}

function writeRainbow() {
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

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      redirect: 'follow',
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.length < 2000) return null;
    return buffer;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function collectNeeded() {
  const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(PACK_MAX, 'utf8'));
  const set = new Set();
  decks.decks.forEach((deck) => {
    if (deck.id === 'numbers' || deck.id === 'letters' || deck.id === 'colors') return;
    deck.words.forEach((word) => set.add(word.lemma));
  });
  pack.chapters.forEach((chapter) => {
    chapter.words.forEach((word) => {
      if (!COLOR_HEX[word.lemma.toLowerCase()]) set.add(word.lemma);
    });
  });
  return [...set];
}

function photoUrl(slug) {
  return '/images/game/photos/' + slug + '.jpg?v=2';
}

function assignConcretePhoto(word) {
  const slug = slugify(word.lemma);
  const file = path.join(OUT_DIR, slug + '.jpg');
  if (fs.existsSync(file) && fs.statSync(file).size > 8000) {
    word.photo = photoUrl(slug);
  } else {
    delete word.photo;
  }
}

function assignColorPhoto(word) {
  const key = word.lemma.toLowerCase();
  const slug = key === 'grey' ? 'color-gray' : 'color-' + slugify(key);
  const file = path.join(OUT_DIR, slug + '.jpg');
  if (fs.existsSync(file)) word.photo = photoUrl(slug);
  else delete word.photo;
}

function applyPhotos() {
  const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
  decks.decks.forEach((deck) => {
    deck.words.forEach((word) => {
      // 只有颜色卡用 color-*；水果 orange/lime 必须用实物图
      if (deck.id === 'colors') assignColorPhoto(word);
      else assignConcretePhoto(word);
    });
  });
  fs.writeFileSync(CARD_DECKS, JSON.stringify(decks, null, 2) + '\n');

  const pack = JSON.parse(fs.readFileSync(PACK_MAX, 'utf8'));
  pack.chapters.forEach((chapter) => {
    const colorChapter = /颜色|color/i.test(chapter.theme || '');
    chapter.words.forEach((word) => {
      if (colorChapter) assignColorPhoto(word);
      else assignConcretePhoto(word);
    });
  });
  fs.writeFileSync(PACK_MAX, JSON.stringify(pack, null, 2) + '\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 颜色单独命名，绝不覆盖水果
  for (const [name, hex] of Object.entries(COLOR_HEX)) {
    const slug = name === 'grey' ? 'color-gray' : 'color-' + name;
    fs.writeFileSync(path.join(OUT_DIR, slug + '.jpg'), writeColorSwatch(name, hex));
  }
  for (const name of ['rainbow', 'colorful', 'color']) {
    fs.writeFileSync(path.join(OUT_DIR, 'color-' + name + '.jpg'), writeRainbow());
  }

  // 删掉被色卡污染的水果文件（过小）
  for (const name of ['orange', 'lime']) {
    const file = path.join(OUT_DIR, name + '.jpg');
    if (fs.existsSync(file) && fs.statSync(file).size < 8000) fs.unlinkSync(file);
  }

  let ok = 0;
  let miss = 0;
  const needed = collectNeeded();
  for (const lemma of needed) {
    const slug = slugify(lemma);
    const file = path.join(OUT_DIR, slug + '.jpg');
    if (fs.existsSync(file) && fs.statSync(file).size > 8000) {
      ok += 1;
      continue;
    }
    const id = UNSPLASH[lemma.toLowerCase()];
    if (!id) {
      miss += 1;
      continue;
    }
    const url = 'https://images.unsplash.com/photo-' + id + '?auto=format&fit=crop&w=640&h=640&q=80';
    const buffer = await download(url);
    if (!buffer) {
      console.log('miss', lemma);
      miss += 1;
      continue;
    }
    fs.writeFileSync(file, buffer);
    console.log('ok', lemma, buffer.length);
    ok += 1;
    await new Promise((r) => setTimeout(r, 250));
  }

  applyPhotos();

  const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
  for (const deck of decks.decks) {
    if (deck.id === 'numbers' || deck.id === 'letters') continue;
    const n = deck.words.filter((w) => w.photo).length;
    console.log(deck.id, n + '/' + deck.words.length);
  }
  console.log('download ok=', ok, 'miss=', miss);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
