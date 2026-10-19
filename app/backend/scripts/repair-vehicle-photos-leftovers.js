#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const ATTR = path.join(OUT, 'ATTRIBUTION.md');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

const JOBS = [
  {
    slug: 'ambulance',
    credit: 'Pexels 5969995 ambulance',
    url: 'https://images.pexels.com/photos/5969995/pexels-photo-5969995.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    slug: 'tram',
    credit: 'Pexels 3573382 tram',
    url: 'https://images.pexels.com/photos/3573382/pexels-photo-3573382.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    slug: 'yacht',
    credit: 'Pexels 843633 yacht',
    url: 'https://images.pexels.com/photos/843633/pexels-photo-843633.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    slug: 'hot-air-balloon',
    credit: 'Pexels 1574843 hot air balloon',
    url: 'https://images.pexels.com/photos/1574843/pexels-photo-1574843.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    slug: 'rocket',
    credit: 'Wikimedia Commons File:Starship full stack.jpg (CC BY-SA) — SpaceX Starship, via wsrv.nl',
    url:
      'https://wsrv.nl/?url=' +
      encodeURIComponent('commons.wikimedia.org/wiki/Special:FilePath/Starship_full_stack.jpg?width=1600') +
      '&w=1280&h=1280&fit=cover&output=jpg',
  },
];

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 8000 || buffer[0] !== 0xff) return null;
    return buffer;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function toSquareJpeg(buffer) {
  const img = await loadImage(buffer);
  const size = 640;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, size, size);
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toBuffer('image/jpeg', 88);
}

async function main() {
  const credits = [];
  for (const job of JOBS) {
    const raw = await download(job.url);
    if (!raw) {
      console.log('FAIL', job.slug);
      continue;
    }
    const jpeg = await toSquareJpeg(raw);
    fs.writeFileSync(path.join(OUT, job.slug + '.jpg'), jpeg);
    credits.push('- `' + job.slug + '.jpg` ← ' + job.credit);
    console.log('OK', job.slug, jpeg.length);
  }
  if (credits.length) {
    let text = fs.readFileSync(ATTR, 'utf8').trimEnd();
    text += '\n\n## Vehicle photo repair leftovers (v=6)\n\n' + credits.join('\n') + '\n';
    fs.writeFileSync(ATTR, text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
