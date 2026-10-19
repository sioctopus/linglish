#!/usr/bin/env node
'use strict';

/** 把已下载/本地生成的照片写进 card-decks 与 pack-max；颜色色卡本地生成。 */
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(ROOT, 'frontend/images/game/photos');
const CARD_DECKS = path.resolve(ROOT, 'frontend/js/game/word-packs/card-decks.json');
const PACK_MAX = path.resolve(ROOT, 'frontend/js/game/word-packs/pack-max.json');

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

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [name, hex] of Object.entries(COLOR_HEX)) {
  const slug = name === 'grey' ? 'color-gray' : 'color-' + slugify(name);
  const file = path.join(OUT_DIR, slug + '.jpg');
  fs.writeFileSync(file, writeColorSwatch(name, hex));
}
for (const name of ['rainbow', 'colorful', 'color']) {
  fs.writeFileSync(path.join(OUT_DIR, 'color-' + name + '.jpg'), writeRainbowSwatch());
}

function apply(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let hit = 0;
  let total = 0;
  const assign = (word, colorMode) => {
    total += 1;
    const key = word.lemma.toLowerCase();
    const slug = colorMode
      ? (key === 'grey' ? 'color-gray' : 'color-' + slugify(key))
      : slugify(word.lemma);
    const file = path.join(OUT_DIR, slug + '.jpg');
    if (fs.existsSync(file) && fs.statSync(file).size > 2000) {
      word.photo = '/images/game/photos/' + slug + '.jpg?v=3';
      hit += 1;
    } else {
      delete word.photo;
    }
  };
  if (data.decks) {
    data.decks.forEach((deck) => {
      (deck.words || []).forEach((word) => assign(word, deck.id === 'colors'));
    });
  }
  if (data.chapters) {
    data.chapters.forEach((chapter) => {
      const colorMode = /颜色|color/i.test(chapter.theme || '');
      (chapter.words || []).forEach((word) => assign(word, colorMode));
    });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return { hit, total };
}

const decks = apply(CARD_DECKS);
const pack = apply(PACK_MAX);
const onDisk = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.jpg')).length;
console.log('photos on disk', onDisk);
console.log('card-decks', decks.hit + '/' + decks.total);
console.log('pack-max', pack.hit + '/' + pack.total);
