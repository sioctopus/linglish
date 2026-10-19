#!/usr/bin/env node
'use strict';

/**
 * 修复交通主题词卡错图 / 卡通占位图。
 * - 救护车、消防车等 Unsplash 串图 → 真车照片
 * - police-car / tram / scooter 等 emoji 风格 JPG → 真照片
 * - rocket → SpaceX 星舰 (Starship) 示例图
 *
 * 用法: node scripts/repair-vehicle-photos.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(ROOT, 'frontend/images/game/photos');
const CARD_DECKS = path.resolve(ROOT, 'frontend/js/game/word-packs/card-decks.json');
const PACK_MAX = path.resolve(ROOT, 'frontend/js/game/word-packs/pack-max.json');
const ATTR_PATH = path.resolve(OUT_DIR, 'ATTRIBUTION.md');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';
const PHOTO_VER = 'v=6';

// 每条: slug → 候选 URL(按优先级) + 来源说明。必须是该词的清晰主体。
const REPAIRS = {
  ambulance: {
    lemma: 'ambulance',
    credit: 'Wikimedia Commons File:Ambulans Volvo.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Ambulans Volvo.jpg'),
      commons('Ambulance Mercedes-Benz Sprinter.jpg'),
      pexels(163016),
    ],
  },
  'police-car': {
    lemma: 'police car',
    credit: 'Wikimedia Commons File:NYPD Ford Crown Victoria.jpg (CC BY-SA 2.0)',
    urls: [
      commons('NYPD Ford Crown Victoria.jpg'),
      commons('Los Angeles Police Department Ford Crown Victoria.jpg'),
      pexels(532001),
    ],
  },
  'fire-truck': {
    lemma: 'fire truck',
    credit: 'Wikimedia Commons File:Fire engine.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Fire engine.jpg'),
      commons('Firetruck in action.jpg'),
      pexels(280222),
    ],
  },
  scooter: {
    lemma: 'scooter',
    credit: 'Wikimedia Commons File:Kick scooter.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Kick scooter.jpg'),
      commons('KickScooter.jpg'),
      pexels(1102777),
    ],
  },
  tram: {
    lemma: 'tram',
    credit: 'Wikimedia Commons File:Tram in Vienna.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Tram in Vienna.jpg'),
      commons('Melbourne tram.jpg'),
      pexels(21014),
    ],
  },
  tractor: {
    lemma: 'tractor',
    credit: 'Wikimedia Commons File:Tractor.jpg (CC BY-SA 3.0)',
    urls: [
      commons('John Deere tractor.jpg'),
      commons('Tractor ploughing.jpg'),
      pexels(2255935),
    ],
  },
  jeep: {
    lemma: 'jeep',
    credit: 'Wikimedia Commons File:Jeep Wrangler.jpg (CC BY-SA 2.0)',
    urls: [
      commons('Jeep Wrangler Unlimited.jpg'),
      commons('Jeep Wrangler.jpg'),
      pexels(116675),
    ],
  },
  convertible: {
    lemma: 'convertible',
    credit: 'Wikimedia Commons File:Convertible car.jpg (CC BY 2.0)',
    urls: [
      commons('Mazda MX-5 convertible.jpg'),
      commons('Convertible automobile.jpg'),
      pexels(170811),
    ],
  },
  // 特别说明:火箭用马斯克 SpaceX 星舰做示例图
  rocket: {
    lemma: 'rocket',
    credit: 'Wikimedia Commons File:Starship SN15 flap and nosecone (51437260707).jpg (CC BY-SA 2.0) — SpaceX Starship',
    urls: [
      commons('Starship SN15 flap and nosecone (51437260707).jpg'),
      commons('SpaceX Starship SN15 (51170388216).jpg'),
      commons('Starship SN9 (50975892572).jpg'),
      commons('SpaceX Starship prototype.jpg'),
    ],
  },
  yacht: {
    lemma: 'yacht',
    credit: 'Wikimedia Commons File:Motor yacht.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Motor yacht.jpg'),
      commons('Luxury yacht.jpg'),
      pexels(163236),
    ],
  },
  canoe: {
    lemma: 'canoe',
    credit: 'Wikimedia Commons File:Canoe.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Canoeing on a lake.jpg'),
      commons('Canoe.jpg'),
      pexels(2398220),
    ],
  },
  ferry: {
    lemma: 'ferry',
    credit: 'Wikimedia Commons File:Ferry.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Ferry boat.jpg'),
      commons('Car ferry.jpg'),
      pexels(813011),
    ],
  },
  'hot-air-balloon': {
    lemma: 'hot air balloon',
    credit: 'Wikimedia Commons File:Hot air balloon.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Hot air balloons.jpg'),
      commons('Hot air balloon festival.jpg'),
      pexels(158163),
    ],
  },
  skateboard: {
    lemma: 'skateboard',
    credit: 'Wikimedia Commons File:Skateboard.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Skateboarder.jpg'),
      commons('Skateboard.jpg'),
      pexels(165236),
    ],
  },
  'roller-skates': {
    lemma: 'roller skates',
    credit: 'Wikimedia Commons File:Roller skates.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Roller skates.jpg'),
      commons('Inline skates.jpg'),
      pexels(3621104),
    ],
  },
  carriage: {
    lemma: 'carriage',
    credit: 'Wikimedia Commons File:Horse-drawn carriage.jpg (CC BY-SA 3.0)',
    urls: [
      commons('Horse-drawn carriage.jpg'),
      commons('Horse carriage.jpg'),
      pexels(2886284),
    ],
  },
  'cable-car': {
    lemma: 'cable car',
    credit: 'Wikimedia Commons File:Cable car.jpg (CC BY-SA 3.0)',
    urls: [
      commons('San Francisco cable car.jpg'),
      commons('Cable car.jpg'),
      pexels(2901209),
    ],
  },
  taxi: {
    lemma: 'taxi',
    credit: 'Wikimedia Commons File:New York taxi.jpg (CC BY-SA 2.0)',
    urls: [
      commons('NYC yellow taxi.jpg'),
      commons('New York City taxi.jpg'),
      pexels(1424246),
    ],
  },
};

function commons(fileName) {
  return (
    'https://commons.wikimedia.org/wiki/Special:FilePath/' +
    encodeURIComponent(fileName) +
    '?width=1280'
  );
}

function pexels(id) {
  return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=1280';
}

function unsplash(id) {
  return 'https://images.unsplash.com/photo-' + id + '?w=1280&h=1280&fit=crop&q=80';
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 8000) return null;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      // 允许 PNG，后面统一转 JPEG
      if (!(buffer[0] === 0x89 && buffer[1] === 0x50)) return null;
    }
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

function bumpPhotoQuery(photoPath) {
  if (!photoPath) return photoPath;
  return photoPath.replace(/\?v=\d+/, '?' + PHOTO_VER).replace(/(\.jpe?g)$/i, (m) => {
    return photoPath.includes('?') ? m : m + '?' + PHOTO_VER;
  });
}

function wireDecks(slugs) {
  const photoByLemma = new Map();
  for (const [slug, meta] of Object.entries(REPAIRS)) {
    if (!slugs.has(slug)) continue;
    photoByLemma.set(meta.lemma.toLowerCase(), '/images/game/photos/' + slug + '.jpg?' + PHOTO_VER);
  }

  function apply(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const words = data.decks
      ? data.decks.flatMap((d) => d.words || [])
      : data.chapters
        ? data.chapters.flatMap((c) => c.words || [])
        : [];
    let n = 0;
    words.forEach((word) => {
      const key = String(word.lemma || '').toLowerCase();
      if (photoByLemma.has(key)) {
        word.photo = photoByLemma.get(key);
        n += 1;
      } else if (word.photo && /\/images\/game\/photos\//.test(word.photo)) {
        // 同批交通词卡统一抬版本，避免浏览器缓存旧错图
        const slug = path.basename(String(word.photo).split('?')[0], path.extname(String(word.photo).split('?')[0]));
        if (REPAIRS[slug]) {
          word.photo = bumpPhotoQuery(word.photo);
          n += 1;
        }
      }
    });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return n;
  }

  return { decks: apply(CARD_DECKS), pack: apply(PACK_MAX) };
}

function appendAttribution(lines) {
  let text = fs.existsSync(ATTR_PATH) ? fs.readFileSync(ATTR_PATH, 'utf8') : '# Game photo attribution\n\n';
  const marker = '## Vehicle photo repair (' + PHOTO_VER + ')';
  if (text.includes(marker)) {
    text = text.split(marker)[0].trimEnd() + '\n\n';
  }
  text += marker + '\n\n' + lines.join('\n') + '\n';
  fs.writeFileSync(ATTR_PATH, text);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const okSlugs = new Set();
  const credits = [];

  for (const [slug, meta] of Object.entries(REPAIRS)) {
    let saved = null;
    let usedUrl = null;
    for (const url of meta.urls) {
      process.stdout.write('try ' + slug + ' ← ' + url.slice(0, 88) + '...\n');
      const raw = await download(url);
      if (!raw) continue;
      try {
        const jpeg = await toSquareJpeg(raw);
        if (!jpeg || jpeg.length < 12000) continue;
        // 过小文件多半是图标占位，拒绝
        if (jpeg.length < 20000 && slug !== 'taxi') {
          // 允许再试下一条
          const img = await loadImage(jpeg);
          if (img.width < 200) continue;
        }
        fs.writeFileSync(path.join(OUT_DIR, slug + '.jpg'), jpeg);
        saved = jpeg.length;
        usedUrl = url;
        break;
      } catch (err) {
        process.stdout.write('  decode fail: ' + (err && err.message) + '\n');
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!saved) {
      console.log('FAIL', slug);
      continue;
    }
    okSlugs.add(slug);
    credits.push('- `' + slug + '.jpg` ← ' + meta.lemma + ' ← ' + meta.credit + ' ← ' + usedUrl);
    console.log('OK', slug, saved, 'bytes');
    await new Promise((r) => setTimeout(r, 600));
  }

  const wired = wireDecks(okSlugs);
  appendAttribution(credits);
  console.log('done ok=', okSlugs.size, '/', Object.keys(REPAIRS).length, 'wired decks=', wired.decks, 'pack=', wired.pack);
  if (okSlugs.size < Object.keys(REPAIRS).length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
