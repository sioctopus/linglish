#!/usr/bin/env node
'use strict';

/**
 * 为家居/职业/家庭词卡生成 640 方图（emoji 主视觉，离线可跑）。
 * 已有足够大的真实照片则跳过，不覆盖。
 *
 * 用法: node scripts/generate-theme-emoji-photos.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/seguiemj.ttf',
  'C:/Windows/Fonts/seguisym.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  '/System/Library/Fonts/Apple Color Emoji.clt/Apple Color Emoji.ttf',
];

for (const file of FONT_CANDIDATES) {
  if (fs.existsSync(file)) {
    try {
      GlobalFonts.registerFromPath(file, 'ThemeEmoji');
      break;
    } catch (_) {}
  }
}

const ITEMS = [
  // home
  ['sofa', '🛋️'], ['armchair', '🪑'], ['coffee-table', '🪵'], ['bed', '🛏️'],
  ['pillow', '🛌'], ['blanket', '🛏️'], ['curtain', '🪟'], ['carpet', '🧶'],
  ['tile', '🧱'], ['sink', '🚰'], ['toilet', '🚽'], ['shower', '🚿'],
  ['bathtub', '🛁'], ['mirror', '🪞'], ['razor', '🪒'], ['toothpaste', '🦷'],
  ['toothbrush', '🪥'], ['soap', '🧼'], ['shampoo', '🧴'], ['broom', '🧹'],
  ['mop', '🧽'], ['trash-can', '🗑️'], ['plant', '🪴'], ['hanger', '👔'],
  ['remote', '📺'], ['faucet', '🚰'], ['table', '🪵'], ['wardrobe', '🚪'],
  ['bookshelf', '📚'], ['cushion', '🟧'], ['toilet-paper', '🧻'], ['tissue', '🤧'],
  ['drawer', '🗄️'], ['dryer', '👕'], ['switch', '🔘'], ['socket', '🔌'],
  ['blender', '🫙'], ['coffee-maker', '☕'], ['balcony', '🏢'], ['dining-room', '🍽️'],
  ['laundry-basket', '🧺'], ['cutting-board', '🪵'], ['pan', '🍳'], ['pot', '🍲'],
  ['plate', '🍽️'], ['bowl', '🥣'], ['chopsticks', '🥢'], ['spoon', '🥄'],
  ['fork', '🍴'], ['knife', '🔪'], ['stove', '🔥'],
  // jobs
  ['teacher', '👩‍🏫'], ['professor', '👨‍🏫'], ['student', '🧑‍🎓'], ['doctor', '🧑‍⚕️'],
  ['nurse', '👩‍⚕️'], ['dentist', '🦷'], ['pharmacist', '💊'], ['chef', '👨‍🍳'],
  ['waiter', '🧑‍🍳'], ['baker', '🥖'], ['barber', '💇'], ['hairdresser', '💇‍♀️'],
  ['architect', '🏗️'], ['engineer', '👷'], ['software-engineer', '💻'],
  ['network-engineer', '🛜'], ['civil-engineer', '🧱'], ['pilot', '✈️'],
  ['driver', '🚌'], ['police-officer', '👮'], ['firefighter', '🧑‍🚒'],
  ['soldier', '🪖'], ['farmer', '👨‍🌾'], ['fisherman', '🎣'], ['postman', '✉️'],
  ['journalist', '🎤'], ['lawyer', '⚖️'], ['judge', '🧑‍⚖️'], ['accountant', '🧮'],
  ['cashier', '🧾'], ['salesperson', '🛍️'], ['cleaner', '🧹'], ['plumber', '🔧'],
  ['electrician', '💡'], ['mechanic', '🔩'], ['carpenter', '🪚'], ['painter-job', '🖌️'],
  ['photographer', '📷'], ['musician', '🎵'], ['singer', '🎤'], ['actor', '🎭'],
  ['dancer', '💃'], ['writer', '✍️'], ['scientist', '🔬'], ['astronaut', '👨‍🚀'],
  ['vet', '🐾'], ['librarian', '📚'], ['coach', '🏋️'],
  // family
  ['family', '👨‍👩‍👧‍👦'], ['father', '👨'], ['mother', '👩'], ['dad', '👨'],
  ['mom', '👩'], ['grandfather', '👴'], ['grandmother', '👵'], ['grandpa', '👴'],
  ['grandma', '👵'], ['brother', '👦'], ['sister', '👧'], ['older-brother', '🧑'],
  ['older-sister', '👩'], ['younger-brother', '👦'], ['younger-sister', '👧'],
  ['uncle', '👨'], ['aunt', '👩'], ['cousin', '🧒'], ['son', '👦'], ['daughter', '👧'],
  ['baby', '👶'], ['husband', '👨'], ['wife', '👩'], ['parents', '👨‍👩‍👧'],
  ['grandparents', '🧓'], ['nephew', '👦'], ['niece', '👧'],
  ['relative', '🧑‍🤝‍🧑'], ['twins', '👯'], ['stepfather', '👨'], ['stepmother', '👩'],
];

function paint(emoji) {
  const size = 640;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#f0fdfa');
  grad.addColorStop(1, '#ccfbf1');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(15, 118, 110, 0.08)';
  ctx.beginPath();
  ctx.arc(480, 140, 160, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '280px ThemeEmoji, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(emoji), size / 2, size / 2 + 12);
  return canvas.toBuffer('image/jpeg', 90);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let made = 0;
  let skipped = 0;
  for (const [slug, emoji] of ITEMS) {
    const dest = path.join(OUT, slug + '.jpg');
    if (fs.existsSync(dest) && fs.statSync(dest).size > 20000) {
      skipped += 1;
      continue;
    }
    fs.writeFileSync(dest, paint(emoji));
    made += 1;
    console.log('make ' + slug);
  }
  console.log('done made=' + made + ' skipped=' + skipped);
}

main();
