#!/usr/bin/env node
'use strict';

/**
 * 为家居/电器补图：Commons 搜索 → 640 方图 → photos/<slug>.jpg
 * 用法: node scripts/fetch-home-photos.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const ATTR = path.join(OUT, 'ATTRIBUTION.md');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

// lemma → Commons 搜索词（挑日常家居实物图）
const JOBS = [
  { slug: 'sofa', query: 'sofa living room furniture' },
  { slug: 'armchair', query: 'armchair furniture' },
  { slug: 'coffee-table', query: 'coffee table living room' },
  { slug: 'bed', query: 'bed bedroom furniture' },
  { slug: 'pillow', query: 'pillow bed white' },
  { slug: 'blanket', query: 'blanket bed folded' },
  { slug: 'curtain', query: 'curtain window interior' },
  { slug: 'carpet', query: 'carpet rug floor' },
  { slug: 'tile', query: 'floor tile ceramic bathroom' },
  { slug: 'sink', query: 'bathroom sink washbasin' },
  { slug: 'toilet', query: 'toilet bathroom white' },
  { slug: 'shower', query: 'shower bathroom cabin' },
  { slug: 'bathtub', query: 'bathtub bathroom' },
  { slug: 'mirror', query: 'bathroom mirror wall' },
  { slug: 'razor', query: 'electric razor shaver' },
  { slug: 'toothpaste', query: 'toothpaste tube' },
  { slug: 'toothbrush', query: 'toothbrush dental' },
  { slug: 'soap', query: 'bar of soap' },
  { slug: 'shampoo', query: 'shampoo bottle' },
  { slug: 'broom', query: 'broom cleaning tool' },
  { slug: 'mop', query: 'mop cleaning floor' },
  { slug: 'trash-can', query: 'trash can waste bin indoor' },
  { slug: 'plant', query: 'potted plant indoor' },
  { slug: 'hanger', query: 'clothes hanger wood' },
  { slug: 'remote', query: 'television remote control' },
  { slug: 'faucet', query: 'faucet tap bathroom' },
  { slug: 'table', query: 'wooden dining table' },
  { slug: 'wardrobe', query: 'wardrobe closet furniture' },
  { slug: 'bookshelf', query: 'bookshelf books' },
  { slug: 'cushion', query: 'cushion sofa pillow' },
  { slug: 'toilet-paper', query: 'toilet paper roll' },
  { slug: 'tissue', query: 'tissue box' },
  { slug: 'drawer', query: 'drawer furniture open' },
  { slug: 'dryer', query: 'clothes dryer tumble dryer' },
  { slug: 'switch', query: 'light switch wall' },
  { slug: 'socket', query: 'electrical outlet socket wall' },
  { slug: 'blender', query: 'kitchen blender' },
  { slug: 'coffee-maker', query: 'coffee maker machine' },
  { slug: 'balcony', query: 'balcony apartment outdoor' },
  { slug: 'dining-room', query: 'dining room table chairs' },
  { slug: 'laundry-basket', query: 'laundry basket clothes' },
  { slug: 'cutting-board', query: 'cutting board kitchen wood' },
  { slug: 'pan', query: 'frying pan kitchen' },
  { slug: 'pot', query: 'cooking pot kitchen' },
  { slug: 'plate', query: 'plate dish white' },
  { slug: 'bowl', query: 'bowl ceramic kitchen' },
  { slug: 'chopsticks', query: 'chopsticks pair' },
  { slug: 'spoon', query: 'spoon cutlery' },
  { slug: 'fork', query: 'fork cutlery' },
  { slug: 'knife', query: 'kitchen knife' },
  { slug: 'stove', query: 'kitchen stove gas' },
];

const SKIP_TITLE = /nude|naked|geograph|portrait|people|person|woman|man |child|baby|dog|cat |animal|map |diagram|svg|logo|icon|flag|chart|graph|screenshot|comic|cartoon|drawing|illustration|psf\)|robert broom|bromine|wikipedia administrator|fluent emoji/i;

async function commonsSearch(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    iiurlwidth: '960',
  }).toString();
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!response.ok) return [];
  const body = await response.json();
  const pages = body && body.query && body.query.pages ? Object.values(body.query.pages) : [];
  return pages
    .map((page) => {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info) return null;
      const mime = String(info.mime || '');
      if (!mime.startsWith('image/') || mime.includes('svg')) return null;
      if (SKIP_TITLE.test(page.title || '')) return null;
      const src = info.thumburl || info.url;
      if (!src) return null;
      return { title: page.title, url: src, credit: 'Wikimedia Commons ' + page.title };
    })
    .filter(Boolean);
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
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

function appendCredit(line) {
  let text = '';
  try { text = fs.readFileSync(ATTR, 'utf8'); } catch (_) { text = '# Game photo attribution\n\n'; }
  if (text.includes(line)) return;
  fs.writeFileSync(ATTR, text.trimEnd() + '\n' + line + '\n');
}

async function fetchOne(job) {
  const dest = path.join(OUT, job.slug + '.jpg');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 20000) {
    console.log('skip ' + job.slug);
    return true;
  }
  const hits = await commonsSearch(job.query);
  for (const hit of hits) {
    const raw = await download(hit.url);
    if (!raw || raw.length < 8000) continue;
    try {
      const jpeg = await toSquareJpeg(raw);
      if (jpeg.length < 12000) continue;
      fs.writeFileSync(dest, jpeg);
      appendCredit('- `' + job.slug + '.jpg`: ' + hit.credit);
      console.log('ok   ' + job.slug + ' ← ' + hit.title);
      return true;
    } catch (err) {
      console.warn('bad  ' + job.slug + ' ' + (err && err.message));
    }
  }
  console.warn('miss ' + job.slug);
  return false;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0;
  for (const job of JOBS) {
    if (await fetchOne(job)) ok += 1;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log('done ' + ok + '/' + JOBS.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
