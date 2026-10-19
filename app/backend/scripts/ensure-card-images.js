#!/usr/bin/env node
'use strict';

/**
 * 给还没有真实照片的词卡生成可见图片，并写回词包。
 *
 * 卡片图规范：画面里只放要认的东西，不铺底色。白色也算底色。
 * 数字和字母用透明底。色块卡本身就是颜色，整张填这个颜色，不再另加底板。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(ROOT, 'frontend/images/game/photos');
const CARD_DECKS = path.resolve(ROOT, 'frontend/js/game/word-packs/card-decks.json');
const PACK_MAX = path.resolve(ROOT, 'frontend/js/game/word-packs/pack-max.json');
const GLYPH_FONT = 'C:/Windows/Fonts/arialbd.ttf';

if (fs.existsSync(GLYPH_FONT)) GlobalFonts.registerFromPath(GLYPH_FONT, 'CardGlyph');

const COLOR_HEX = {
  red: '#e11d48', blue: '#2563eb', green: '#16a34a', yellow: '#eab308',
  orange: '#f97316', purple: '#9333ea', pink: '#ec4899', black: '#0f172a',
  white: '#f8fafc', brown: '#92400e', gray: '#64748b', grey: '#64748b',
  gold: '#d97706', silver: '#94a3b8', beige: '#d6d3d1', navy: '#1e3a8a',
  turquoise: '#14b8a6', violet: '#7c3aed', indigo: '#4338ca', maroon: '#9f1239',
  crimson: '#be123c', scarlet: '#dc2626', ivory: '#fffbeb', cream: '#fef3c7',
  tan: '#d6b48a', olive: '#65a30d', lime: '#84cc16', cyan: '#06b6d4',
  magenta: '#d946ef', rainbow: 'rainbow', colorful: 'rainbow', color: 'rainbow',
};

function slugify(lemma) {
  return String(lemma).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function writeSwatch(hex) {
  const canvas = createCanvas(640, 640);
  const ctx = canvas.getContext('2d');
  if (hex === 'rainbow') {
    const colors = ['#e11d48', '#f97316', '#eab308', '#16a34a', '#2563eb', '#9333ea'];
    const w = 640 / colors.length;
    colors.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(i * w, 0, w + 1, 640);
    });
  } else {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 640, 640);
  }
  return canvas.toBuffer('image/jpeg', 90);
}

function writeGlyph(text) {
  const canvas = createCanvas(640, 640);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 640, 640);
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = String(text || '?');
  const size = label.length >= 3 ? 220 : label.length === 2 ? 280 : 360;
  ctx.font = size + 'px CardGlyph, Arial, sans-serif';
  ctx.fillText(label, 320, 320);
  return canvas.toBuffer('image/png');
}

function hasRealFile(slug) {
  const file = path.join(OUT_DIR, slug + '.jpg');
  return fs.existsSync(file) && fs.statSync(file).size > 8000;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let made = 0;
function ensureGlyph(slug, label) {
  if (hasRealFile(slug)) return;
  fs.writeFileSync(path.join(OUT_DIR, slug + '.png'), writeGlyph(label));
  made += 1;
}

function ensureColor(slug, key) {
  const file = path.join(OUT_DIR, slug + '.jpg');
  if (!fs.existsSync(file) || fs.statSync(file).size < 2000) {
    const hex = COLOR_HEX[key] || '#94a3b8';
    fs.writeFileSync(file, writeSwatch(hex));
    made += 1;
  }
}

function assign(word, colorMode) {
  const key = String(word.lemma || '').toLowerCase();
  if (colorMode && COLOR_HEX[key]) {
    const slug = key === 'grey' ? 'color-gray' : 'color-' + slugify(key);
    ensureColor(slug, key);
    word.photo = '/images/game/photos/' + slug + '.jpg?v=4';
    return;
  }
  const slug = slugify(word.lemma);
  const label = /^[A-Za-z0-9 -]{1,12}$/.test(word.emoji || '') ? word.emoji : (word.emoji || word.lemma);
  ensureGlyph(slug, label);
  word.photo = '/images/game/photos/' + slug + '.png?v=6';
}

const decks = JSON.parse(fs.readFileSync(CARD_DECKS, 'utf8'));
decks.decks.forEach((deck) => {
  deck.words.forEach((word) => assign(word, deck.id === 'colors'));
});
fs.writeFileSync(CARD_DECKS, JSON.stringify(decks, null, 2) + '\n');

const pack = JSON.parse(fs.readFileSync(PACK_MAX, 'utf8'));
pack.chapters.forEach((chapter) => {
  const colorMode = /颜色|color/i.test(chapter.theme || '');
  chapter.words.forEach((word) => assign(word, colorMode));
});
fs.writeFileSync(PACK_MAX, JSON.stringify(pack, null, 2) + '\n');

let missing = 0;
decks.decks.forEach((deck) => {
  const n = deck.words.filter((w) => w.photo).length;
  console.log(deck.id, n + '/' + deck.words.length);
  missing += deck.words.length - n;
});
console.log('generated', made, 'still missing', missing);
