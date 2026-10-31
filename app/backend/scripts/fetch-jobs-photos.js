#!/usr/bin/env node
'use strict';

/**
 * 为职业词卡补图：Commons 搜索 → 640 方图 → photos/<slug>.jpg
 * 用法: node scripts/fetch-jobs-photos.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const ATTR = path.join(OUT, 'ATTRIBUTION.md');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

const JOBS = [
  { slug: 'teacher', query: 'teacher classroom school' },
  { slug: 'professor', query: 'professor university lecture' },
  { slug: 'student', query: 'student studying books school' },
  { slug: 'doctor', query: 'doctor hospital white coat' },
  { slug: 'nurse', query: 'nurse hospital uniform' },
  { slug: 'dentist', query: 'dentist dental clinic' },
  { slug: 'pharmacist', query: 'pharmacist pharmacy' },
  { slug: 'chef', query: 'chef kitchen cooking' },
  { slug: 'waiter', query: 'waiter restaurant serving' },
  { slug: 'baker', query: 'baker bakery bread' },
  { slug: 'barber', query: 'barber haircut salon' },
  { slug: 'hairdresser', query: 'hairdresser salon styling' },
  { slug: 'architect', query: 'architect blueprint drawing' },
  { slug: 'engineer', query: 'engineer construction hard hat' },
  { slug: 'software-engineer', query: 'software engineer coding computer' },
  { slug: 'network-engineer', query: 'network engineer server room' },
  { slug: 'civil-engineer', query: 'civil engineer construction site' },
  { slug: 'pilot', query: 'airline pilot cockpit' },
  { slug: 'driver', query: 'bus driver steering wheel' },
  { slug: 'police-officer', query: 'police officer uniform' },
  { slug: 'firefighter', query: 'firefighter fire department' },
  { slug: 'soldier', query: 'soldier military uniform' },
  { slug: 'farmer', query: 'farmer field agriculture' },
  { slug: 'fisherman', query: 'fisherman fishing boat' },
  { slug: 'postman', query: 'mailman postman delivery' },
  { slug: 'journalist', query: 'journalist reporter microphone' },
  { slug: 'lawyer', query: 'lawyer courtroom suit' },
  { slug: 'judge', query: 'judge courtroom gavel' },
  { slug: 'accountant', query: 'accountant calculator office' },
  { slug: 'cashier', query: 'cashier supermarket checkout' },
  { slug: 'salesperson', query: 'salesperson shop retail' },
  { slug: 'cleaner', query: 'cleaner mopping floor' },
  { slug: 'plumber', query: 'plumber pipes wrench' },
  { slug: 'electrician', query: 'electrician wiring work' },
  { slug: 'mechanic', query: 'mechanic car repair' },
  { slug: 'carpenter', query: 'carpenter woodworking' },
  { slug: 'painter', query: 'painter painting wall brush' },
  { slug: 'photographer', query: 'photographer camera' },
  { slug: 'musician', query: 'musician playing instrument' },
  { slug: 'singer', query: 'singer microphone stage' },
  { slug: 'actor', query: 'actor stage theater' },
  { slug: 'dancer', query: 'dancer ballet performance' },
  { slug: 'writer', query: 'writer typing laptop' },
  { slug: 'scientist', query: 'scientist laboratory research' },
  { slug: 'astronaut', query: 'astronaut spacesuit' },
  { slug: 'vet', query: 'veterinarian animal clinic' },
  { slug: 'librarian', query: 'librarian library books' },
  { slug: 'coach', query: 'sports coach whistle' },
];

const SKIP_TITLE = /nude|naked|geograph|map |diagram|svg|logo|icon|flag|chart|graph|screenshot|comic|cartoon|drawing|illustration|fluent emoji|portrait of|selfie/i;

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
