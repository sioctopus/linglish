#!/usr/bin/env node
'use strict';

/**
 * 用 PowerShell 访问 Commons（本机 Node fetch 常超时），下载家居/职业词卡方图。
 * 用法:
 *   node scripts/fetch-theme-photos-ps.js home
 *   node scripts/fetch-theme-photos-ps.js jobs
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const ATTR = path.join(OUT, 'ATTRIBUTION.md');
const TMP = path.join(__dirname, '_theme-dl.bin');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

const HOME = [
  { slug: 'sofa', query: 'sofa living room furniture' },
  { slug: 'armchair', query: 'armchair furniture' },
  { slug: 'coffee-table', query: 'coffee table living room' },
  { slug: 'bed', query: 'bed bedroom furniture' },
  { slug: 'pillow', query: 'pillow bed white' },
  { slug: 'blanket', query: 'blanket bed folded' },
  { slug: 'curtain', query: 'curtain window interior' },
  { slug: 'carpet', query: 'carpet rug floor' },
  { slug: 'tile', query: 'ceramic floor tile bathroom' },
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
  { slug: 'trash-can', query: 'indoor trash can waste bin' },
  { slug: 'plant', query: 'potted plant indoor' },
  { slug: 'hanger', query: 'clothes hanger wood' },
  { slug: 'remote', query: 'television remote control' },
  { slug: 'faucet', query: 'faucet tap bathroom' },
  { slug: 'table', query: 'wooden dining table' },
  { slug: 'wardrobe', query: 'wardrobe closet furniture' },
  { slug: 'bookshelf', query: 'bookshelf books' },
  { slug: 'cushion', query: 'cushion sofa' },
  { slug: 'toilet-paper', query: 'toilet paper roll' },
  { slug: 'tissue', query: 'tissue box' },
  { slug: 'drawer', query: 'furniture drawer open' },
  { slug: 'dryer', query: 'clothes dryer tumble dryer' },
  { slug: 'switch', query: 'light switch wall' },
  { slug: 'socket', query: 'electrical outlet socket wall' },
  { slug: 'blender', query: 'kitchen blender' },
  { slug: 'coffee-maker', query: 'coffee maker machine' },
  { slug: 'balcony', query: 'apartment balcony' },
  { slug: 'dining-room', query: 'dining room table chairs' },
  { slug: 'laundry-basket', query: 'laundry basket clothes' },
  { slug: 'cutting-board', query: 'cutting board kitchen wood' },
  { slug: 'pan', query: 'frying pan kitchen' },
  { slug: 'pot', query: 'cooking pot kitchen' },
  { slug: 'plate', query: 'white plate dish' },
  { slug: 'bowl', query: 'ceramic bowl kitchen' },
  { slug: 'chopsticks', query: 'chopsticks pair' },
  { slug: 'spoon', query: 'spoon cutlery' },
  { slug: 'fork', query: 'fork cutlery' },
  { slug: 'knife', query: 'kitchen knife' },
  { slug: 'stove', query: 'kitchen stove cooker' },
];

const JOBS = [
  { slug: 'teacher', query: 'teacher classroom school' },
  { slug: 'professor', query: 'professor university lecture' },
  { slug: 'student', query: 'student studying school' },
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
  { slug: 'engineer', query: 'engineer hard hat construction' },
  { slug: 'software-engineer', query: 'programmer coding computer' },
  { slug: 'network-engineer', query: 'network engineer server room' },
  { slug: 'civil-engineer', query: 'civil engineer construction site' },
  { slug: 'pilot', query: 'airline pilot cockpit' },
  { slug: 'driver', query: 'bus driver' },
  { slug: 'police-officer', query: 'police officer uniform' },
  { slug: 'firefighter', query: 'firefighter fire department' },
  { slug: 'soldier', query: 'soldier military uniform' },
  { slug: 'farmer', query: 'farmer field agriculture' },
  { slug: 'fisherman', query: 'fisherman fishing boat' },
  { slug: 'postman', query: 'mailman postman delivery' },
  { slug: 'journalist', query: 'journalist reporter microphone' },
  { slug: 'lawyer', query: 'lawyer courtroom suit' },
  { slug: 'judge', query: 'judge courtroom gavel' },
  { slug: 'accountant', query: 'accountant office calculator' },
  { slug: 'cashier', query: 'cashier supermarket checkout' },
  { slug: 'salesperson', query: 'salesperson shop retail' },
  { slug: 'cleaner', query: 'cleaner mopping floor' },
  { slug: 'plumber', query: 'plumber pipes wrench' },
  { slug: 'electrician', query: 'electrician wiring' },
  { slug: 'mechanic', query: 'mechanic car repair' },
  { slug: 'carpenter', query: 'carpenter woodworking' },
  { slug: 'painter-job', query: 'house painter brush wall' },
  { slug: 'photographer', query: 'photographer camera' },
  { slug: 'musician', query: 'musician playing instrument' },
  { slug: 'singer', query: 'singer microphone stage' },
  { slug: 'actor', query: 'actor theater stage' },
  { slug: 'dancer', query: 'dancer ballet performance' },
  { slug: 'writer', query: 'writer typing laptop' },
  { slug: 'scientist', query: 'scientist laboratory research' },
  { slug: 'astronaut', query: 'astronaut spacesuit' },
  { slug: 'vet', query: 'veterinarian animal clinic' },
  { slug: 'librarian', query: 'librarian library books' },
  { slug: 'coach', query: 'sports coach whistle' },
];

const FAMILY = [
  { slug: 'family', query: 'family portrait parents children' },
  { slug: 'father', query: 'father dad with child' },
  { slug: 'mother', query: 'mother mom with child' },
  { slug: 'dad', query: 'dad father smiling' },
  { slug: 'mom', query: 'mom mother smiling' },
  { slug: 'grandfather', query: 'grandfather elderly man' },
  { slug: 'grandmother', query: 'grandmother elderly woman' },
  { slug: 'grandpa', query: 'grandpa grandfather' },
  { slug: 'grandma', query: 'grandma grandmother' },
  { slug: 'brother', query: 'brother boys siblings' },
  { slug: 'sister', query: 'sister girls siblings' },
  { slug: 'older-brother', query: 'older brother teenager' },
  { slug: 'older-sister', query: 'older sister teenager' },
  { slug: 'younger-brother', query: 'young boy brother' },
  { slug: 'younger-sister', query: 'young girl sister' },
  { slug: 'uncle', query: 'uncle man family' },
  { slug: 'aunt', query: 'aunt woman family' },
  { slug: 'cousin', query: 'cousins children playing' },
  { slug: 'son', query: 'son boy child' },
  { slug: 'daughter', query: 'daughter girl child' },
  { slug: 'baby', query: 'baby infant smiling' },
  { slug: 'husband', query: 'husband wedding man' },
  { slug: 'wife', query: 'wife wedding woman' },
  { slug: 'parents', query: 'parents with children family' },
  { slug: 'grandparents', query: 'grandparents with grandchildren' },
  { slug: 'nephew', query: 'nephew boy family' },
  { slug: 'niece', query: 'niece girl family' },
  { slug: 'relative', query: 'family relatives gathering' },
  { slug: 'twins', query: 'twin children siblings' },
  { slug: 'stepfather', query: 'stepfather father son' },
  { slug: 'stepmother', query: 'stepmother mother daughter' },
];

const SKIP = /nude|naked|geograph|map |diagram|svg|logo|icon|flag|chart|screenshot|comic|cartoon|fluent emoji|psf\)|bromine|robert broom|administrator/i;

function psJson(command) {
  const wrapped = [
    `$ProgressPreference='SilentlyContinue'`,
    `$ErrorActionPreference='Stop'`,
    command,
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', wrapped], {
    encoding: 'utf8',
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim();
}

function commonsHits(query) {
  const api = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: '10',
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    iiurlwidth: '960',
  }).toString();
  const cmd = [
    `$ua='${UA}'`,
    `$r=Invoke-RestMethod -Uri '${api.replace(/'/g, "''")}' -Headers @{ 'User-Agent'=$ua } -TimeoutSec 60`,
    `if (-not $r.query.pages) { '[]'; return }`,
    `$rows=@()`,
    `foreach ($p in $r.query.pages.PSObject.Properties.Value) {`,
    `  $ii=$p.imageinfo[0]; if (-not $ii) { continue }`,
    `  if ($ii.mime -notlike 'image/*' -or $ii.mime -like '*svg*') { continue }`,
    `  $src= if ($ii.thumburl) { $ii.thumburl } else { $ii.url }`,
    `  if (-not $src) { continue }`,
    `  $rows += [pscustomobject]@{ title=$p.title; url=$src }`,
    `}`,
    `$rows | ConvertTo-Json -Compress`,
  ].join('; ');
  const raw = psJson(cmd);
  if (!raw || raw === '[]') return [];
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((item) => item && item.url && !SKIP.test(item.title || ''));
}

function downloadWithPowerShell(url, dest) {
  const ps = [
    `$ProgressPreference='SilentlyContinue'`,
    `$ua='${UA}'`,
    `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -Headers @{ 'User-Agent' = $ua } -OutFile '${dest.replace(/'/g, "''")}' -TimeoutSec 60`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    stdio: 'pipe',
    timeout: 90000,
  });
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
  const force = process.argv.includes('--force') || process.argv.includes('--replace-emoji');
  // emoji 生成图通常 < 35KB；真照片一般更大。默认跳过真图，强制时覆盖小图。
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 35000) {
    console.log('skip ' + job.slug);
    return true;
  }
  if (force && fs.existsSync(dest) && fs.statSync(dest).size > 80000) {
    console.log('keep ' + job.slug);
    return true;
  }
  let hits = [];
  try {
    hits = commonsHits(job.query);
  } catch (err) {
    console.warn('api  ' + job.slug + ' ' + (err && err.message));
    return false;
  }
  for (const hit of hits.slice(0, 6)) {
    try {
      if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
      downloadWithPowerShell(hit.url, TMP);
      const raw = fs.readFileSync(TMP);
      if (raw.length < 8000) continue;
      const jpeg = await toSquareJpeg(raw);
      if (jpeg.length < 12000) continue;
      fs.writeFileSync(dest, jpeg);
      appendCredit('- `' + job.slug + '.jpg`: Wikimedia Commons ' + hit.title);
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
  const kind = String(process.argv[2] || '').toLowerCase();
  const list = kind === 'jobs' ? JOBS : kind === 'home' ? HOME : kind === 'family' ? FAMILY : kind === 'all' ? HOME.concat(JOBS, FAMILY) : null;
  if (!list) {
    console.error('Usage: node scripts/fetch-theme-photos-ps.js home|jobs|family|all [--force]');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0;
  for (const job of list) {
    if (await fetchOne(job)) ok += 1;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('done ' + ok + '/' + list.length);
  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
