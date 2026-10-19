const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// --- 打桩依赖（必须在 require 路由之前） ---
const authService = require('../services/auth');
const youtubeService = require('../services/youtube');
const dataStore = require('../data-store');
const originalSetImmediate = global.setImmediate;
global.setImmediate = () => null;

authService.requireUser = async () => ({ id: 42, email: 'wu@test.dev' });
youtubeService.isValidYouTubeUrl = () => true;
youtubeService.extractVideoId = () => 'abc123xyz00';
youtubeService.getVideoInfo = async () => ({
  title: 'Stub Video',
  description: 'desc',
  thumbnail: 'thumb.jpg',
  duration: 60,
});
// 阻止后台 setImmediate 转录任务发起真实网络请求
process.env.WHISPER_FALLBACK_ENABLED = 'false';
youtubeService.getTranscript = async () => { throw new Error('stub: no transcript'); };

const { importVideo } = require('../routes/youtube');

// 连接池 min>0 会保持 socket，令测试进程无法退出
test.after(async () => {
  global.setImmediate = originalSetImmediate;
  try { await dataStore.pool.end(); } catch (_) { /* already ended */ }
});

// --- 请求/响应模拟 ---
function makeReq(body) {
  const req = new EventEmitter();
  req.headers = { authorization: 'Bearer stub-token' };
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(body));
  };
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(payload) { this.body = JSON.parse(payload); this.writableEnded = true; },
  };
}

// pool.query 打桩：按 SQL 关键字分派
function stubPool({ existingRows = [], validTagRows = [], tagInsertError = null, recorder }) {
  dataStore.pool.query = async (sql, params) => {
    recorder.push({ sql, params });
    if (sql.includes('FROM video_resources')) return { rows: existingRows };
    if (sql.includes("scope = 'global'")) return { rows: validTagRows };
    if (sql.includes('INSERT INTO video_tags')) {
      if (tagInsertError) throw tagInsertError;
      return { rows: [] };
    }
    throw new Error('Unexpected SQL in stub: ' + sql);
  };
}

test('duplicate import returns alreadyExists=true with unified video.id', async () => {
  const recorder = [];
  stubPool({ existingRows: [{ id: 777 }], recorder });

  const res = makeRes();
  await importVideo(makeReq({ url: 'https://youtube.com/watch?v=abc' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.alreadyExists, true);
  assert.equal(res.body.video.id, 777);
  assert.equal(res.body.videoId, undefined, 'legacy videoId field must be gone');
});

test('new import ignores a hand-picked level and persists valid global tags', async () => {
  const recorder = [];
  stubPool({ existingRows: [], validTagRows: [{ id: 5 }, { id: 9 }], recorder });

  let createdPayload = null;
  dataStore.createVideoResource = async (payload) => {
    createdPayload = payload;
    return { id: 900, title: payload.title, description: payload.description };
  };
  dataStore.updateVideoResource = async () => ({});

  const res = makeRes();
  await importVideo(makeReq({
    url: 'https://youtube.com/watch?v=abc',
    difficulty_level: 'Beginner', // 学习者手填的等级不采用
    tags: ['5', 9, '9', 'oops', -1], // 去重 + 非法丢弃
    collection_name: 'BBC 六分钟',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.alreadyExists, false);
  assert.equal(res.body.video.id, 900);

  assert.equal(createdPayload.difficulty_level, null);
  assert.equal(createdPayload.collection_name, 'BBC 六分钟');

  // 标签校验查询仅收到规范化后的正整数
  const tagCheck = recorder.find(r => r.sql.includes("scope = 'global'"));
  assert.deepEqual([...tagCheck.params[0]].sort((a, b) => a - b), [5, 9]);

  // 两条 video_tags 插入，绑定当前用户
  const inserts = recorder.filter(r => r.sql.includes('INSERT INTO video_tags'));
  assert.equal(inserts.length, 2);
  for (const ins of inserts) {
    assert.equal(ins.params[0], 900);
    assert.equal(ins.params[2], 42);
  }
});

test('invalid difficulty is stored as null instead of raw value', async () => {
  const recorder = [];
  stubPool({ existingRows: [], recorder });

  let createdPayload = null;
  dataStore.createVideoResource = async (payload) => {
    createdPayload = payload;
    return { id: 901, title: payload.title, description: payload.description };
  };
  dataStore.updateVideoResource = async () => ({});

  const res = makeRes();
  await importVideo(makeReq({
    url: 'https://youtube.com/watch?v=abc',
    difficulty_level: 'expert',
  }), res);

  assert.equal(res.body.success, true);
  assert.equal(createdPayload.difficulty_level, null);
});

test('tag write failure rolls back the video row and returns 500 (no orphan rows)', async () => {
  const recorder = [];
  stubPool({
    existingRows: [],
    validTagRows: [{ id: 5 }],
    tagInsertError: new Error('db down'),
    recorder,
  });

  dataStore.createVideoResource = async (payload) => ({ id: 902, title: payload.title, description: '' });
  let deletedId = null;
  dataStore.deleteVideoResource = async (id) => { deletedId = id; };

  const res = makeRes();
  await importVideo(makeReq({
    url: 'https://youtube.com/watch?v=abc',
    tags: [5],
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(deletedId, 902, 'orphan video row must be deleted on tag failure');
});
