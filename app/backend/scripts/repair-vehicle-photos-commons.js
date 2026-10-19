#!/usr/bin/env node
'use strict';

/**
 * 用已核验的 Wikimedia Commons 缩略图直链重下交通词卡。
 * 不走 Pexels 数字 ID（会串图）。火箭保留已下载的 Starship SN16。
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const { execFileSync } = require('node:child_process');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const ATTR = path.join(OUT, 'ATTRIBUTION.md');
const TMP = path.join(__dirname, '_vehicle-dl.jpg');
const UA = 'LinglishOSS/1.0 (https://linglish.org; educational vocabulary photos)';

// slug → { credit, thumb }  thumb 必须是 upload/thumb.wikimedia.org 上已存在的路径
const JOBS = [
  {
    slug: 'fire-truck',
    credit: 'Wikimedia Commons File:Fire engine.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Fire_engine.jpg/960px-Fire_engine.jpg',
  },
  {
    slug: 'hot-air-balloon',
    credit: 'Wikimedia Commons File:Hot air balloon.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/Hot_air_balloon.jpg/960px-Hot_air_balloon.jpg',
  },
  {
    slug: 'roller-skates',
    credit: 'Wikimedia Commons File:Roller skates.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/73/Roller_skates.jpg/960px-Roller_skates.jpg',
  },
  {
    slug: 'tractor',
    credit: 'Wikimedia Commons File:John Deere 6620.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/79/John_Deere_6620.jpg/960px-John_Deere_6620.jpg',
  },
  {
    slug: 'jeep',
    credit: 'Wikimedia Commons File:Jeep Wrangler.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/Jeep_Wrangler.jpg/960px-Jeep_Wrangler.jpg',
  },
  {
    slug: 'convertible',
    credit: 'Wikimedia Commons File:Mazda MX-5.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Mazda_MX-5.jpg/960px-Mazda_MX-5.jpg',
  },
  {
    slug: 'carriage',
    credit: 'Wikimedia Commons File:Horse-drawn carriage.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Horse-drawn_carriage.jpg/640px-Horse-drawn_carriage.jpg',
  },
  {
    slug: 'ferry',
    credit: 'Wikimedia Commons File:Ferry.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Ferry.jpg/1280px-Ferry.jpg',
  },
  {
    slug: 'tram',
    credit: 'Wikimedia Commons File:C Class Tram, Melbourne - Jan 2008.jpg',
    thumb:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/C_Class_Tram%2C_Melbourne_-_Jan_2008.jpg/960px-C_Class_Tram%2C_Melbourne_-_Jan_2008.jpg',
  },
  {
    slug: 'cable-car',
    credit: 'Wikimedia Commons File:San Francisco cable car.jpg',
    thumb:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/San_Francisco_cable_car.jpg/960px-San_Francisco_cable_car.jpg',
  },
  {
    slug: 'police-car',
    credit: 'Wikimedia Commons File:Swedish police car with lights on.jpg',
    thumb:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/Swedish_police_car_with_lights_on.jpg/960px-Swedish_police_car_with_lights_on.jpg',
  },
  {
    slug: 'scooter',
    credit: 'Wikimedia Commons File:Gabriel riding a kick scooter... (Lisbon)',
    thumb:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/Gabriel_riding_a_kick_scooter_in_a_cycle_lane%2C_Lisbon%2C_Portugal_%28PPL1-Corrected%29_julesvernex2.jpg/960px-Gabriel_riding_a_kick_scooter_in_a_cycle_lane%2C_Lisbon%2C_Portugal_%28PPL1-Corrected%29_julesvernex2.jpg',
  },
  {
    slug: 'canoe',
    credit: 'Wikimedia Commons File:Canoe.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Canoe.jpg/960px-Canoe.jpg',
  },
  {
    slug: 'taxi',
    credit: 'Wikimedia Commons File:Yellow taxi.jpg',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Yellow_taxi.jpg/960px-Yellow_taxi.jpg',
  },
];

function downloadWithPowerShell(url, dest) {
  const ps = [
    `$ProgressPreference='SilentlyContinue'`,
    `$ua='${UA}'`,
    `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -Headers @{ 'User-Agent' = $ua } -OutFile '${dest.replace(/'/g, "''")}' -TimeoutSec 45`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    stdio: 'pipe',
    timeout: 60000,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const credits = [];
  for (const job of JOBS) {
    process.stdout.write('dl ' + job.slug + ' ... ');
    try {
      if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
      downloadWithPowerShell(job.thumb, TMP);
      const raw = fs.readFileSync(TMP);
      if (raw.length < 5000 || raw[0] !== 0xff) throw new Error('bad jpeg ' + raw.length);
      const jpeg = await toSquareJpeg(raw);
      fs.writeFileSync(path.join(OUT, job.slug + '.jpg'), jpeg);
      credits.push('- `' + job.slug + '.jpg` ← ' + job.credit);
      console.log('OK', jpeg.length);
    } catch (err) {
      console.log('FAIL', err.message || err);
    }
    await sleep(3500);
  }
  if (credits.length) {
    let text = fs.readFileSync(ATTR, 'utf8').trimEnd();
    text += '\n\n## Vehicle Commons repair (v=7)\n\n' + credits.join('\n') + '\n';
    fs.writeFileSync(ATTR, text);
  }
  console.log('done', credits.length, '/', JOBS.length);
  if (credits.length < JOBS.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
