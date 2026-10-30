const crypto = require('crypto');
const dataStore = require('../data-store');

const DAY_SECONDS = 24 * 60 * 60;
const SLIDING_SECONDS = 30 * DAY_SECONDS;
const ABSOLUTE_SECONDS = 90 * DAY_SECONDS;

const memory = new Map();
const revoked = new Set();

function normalizeDeviceId(value) {
  const id = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{16,80}$/.test(id)) return id;
  return crypto.randomBytes(16).toString('hex');
}

function isLive(record, nowSec) {
  if (!record || record.revoked) return false;
  if (!Number.isFinite(record.slidingExp) || record.slidingExp <= nowSec) return false;
  if (!Number.isFinite(record.absoluteExp) || record.absoluteExp <= nowSec) return false;
  return true;
}

async function persist(record) {
  memory.set(record.id, record);
  try {
    await dataStore.query(
      `INSERT INTO auth_device_sessions
        (id, user_id, device_id, provider, created_at, absolute_expires_at, sliding_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), to_timestamp($7), NOW())
       ON CONFLICT (id) DO UPDATE SET
         device_id = EXCLUDED.device_id,
         sliding_expires_at = EXCLUDED.sliding_expires_at,
         revoked_at = CASE WHEN $8::boolean THEN auth_device_sessions.revoked_at ELSE NULL END,
         updated_at = NOW()`,
      [
        record.id,
        record.userId,
        record.deviceId,
        record.provider,
        record.createdAt,
        record.absoluteExp,
        record.slidingExp,
        record.revoked === true,
      ]
    );
  } catch (err) {
    console.warn('[AuthSession] persist failed:', err?.message || err);
  }
}

function recordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    provider: row.provider || 'password',
    createdAt: Number(row.created_at),
    absoluteExp: Number(row.absolute_exp),
    slidingExp: Number(row.sliding_exp),
    revoked: Boolean(row.revoked_at),
    lastGoogleCheckAt: row.last_google_check_at == null ? null : Number(row.last_google_check_at),
  };
}

async function load(id) {
  const cached = memory.get(id) || null;
  try {
    const { rows } = await dataStore.query(
      `SELECT id, user_id, device_id, provider,
              EXTRACT(EPOCH FROM created_at) AS created_at,
              EXTRACT(EPOCH FROM absolute_expires_at) AS absolute_exp,
              EXTRACT(EPOCH FROM sliding_expires_at) AS sliding_exp,
              revoked_at,
              EXTRACT(EPOCH FROM last_google_check_at) AS last_google_check_at
       FROM auth_device_sessions
       WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return cached;
    const record = recordFromRow(rows[0]);
    memory.set(id, record);
    if (record.revoked) revoked.add(id);
    return record;
  } catch (err) {
    if (cached) return cached;
    console.warn('[AuthSession] lookup failed, keeping the signed session:', err?.message || err);
    return {
      id,
      userId: null,
      deviceId: null,
      provider: 'unknown',
      createdAt: 0,
      absoluteExp: Number.POSITIVE_INFINITY,
      slidingExp: Number.POSITIVE_INFINITY,
      revoked: false,
      lastGoogleCheckAt: Date.now() / 1000,
      degraded: true,
    };
  }
}

async function openSession({ userId, deviceId, provider } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const absoluteExp = nowSec + ABSOLUTE_SECONDS;
  const record = {
    id: crypto.randomBytes(16).toString('hex'),
    userId,
    deviceId: normalizeDeviceId(deviceId),
    provider: provider || 'password',
    createdAt: nowSec,
    absoluteExp,
    slidingExp: Math.min(nowSec + SLIDING_SECONDS, absoluteExp),
    revoked: false,
    lastGoogleCheckAt: null,
  };
  revoked.delete(record.id);
  await persist(record);
  return record;
}

async function touch(id, deviceId, limits = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const record = await load(id);
  if (record && record.degraded) {
    const absoluteExp = Number.isFinite(Number(limits.absoluteExp))
      ? Number(limits.absoluteExp)
      : record.absoluteExp;
    if (!Number.isFinite(absoluteExp) || absoluteExp <= nowSec) return null;
    record.absoluteExp = absoluteExp;
    record.slidingExp = Math.min(nowSec + SLIDING_SECONDS, absoluteExp);
    record.deviceId = deviceId || record.deviceId;
    record.revoked = false;
    memory.set(record.id, record);
    return record;
  }
  if (!isLive(record, nowSec)) return null;
  if (deviceId && record.deviceId !== deviceId) return null;
  record.slidingExp = Math.min(nowSec + SLIDING_SECONDS, record.absoluteExp);
  record.revoked = false;
  await persist(record);
  return record;
}

async function revoke(id) {
  if (!id) return;
  revoked.add(String(id));
  const cached = memory.get(id);
  if (cached) cached.revoked = true;
  try {
    await dataStore.query(
      `UPDATE auth_device_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
  } catch (err) {
    console.warn('[AuthSession] revoke failed:', err?.message || err);
  }
}

async function revokeProvider(userId, provider) {
  for (const record of memory.values()) {
    if (String(record.userId) === String(userId) && record.provider === provider) {
      record.revoked = true;
      revoked.add(record.id);
    }
  }
  try {
    await dataStore.query(
      `UPDATE auth_device_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL`,
      [userId, provider]
    );
  } catch (err) {
    console.warn('[AuthSession] revoke provider failed:', err?.message || err);
  }
}

async function assertActive(id) {
  if (!id) return true;
  if (revoked.has(id)) return false;
  const record = await load(id);
  if (!record) return false;
  return isLive(record, Math.floor(Date.now() / 1000));
}

function shouldCheckGoogle(record) {
  if (!record || record.provider !== 'google') return false;
  if (!record.lastGoogleCheckAt) return true;
  return (Date.now() / 1000 - record.lastGoogleCheckAt) >= 60 * 60;
}

async function markGoogleChecked(id) {
  const record = memory.get(id);
  if (record) record.lastGoogleCheckAt = Date.now() / 1000;
  try {
    await dataStore.query(
      `UPDATE auth_device_sessions
       SET last_google_check_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (err) {
    console.warn('[AuthSession] google check stamp failed:', err?.message || err);
  }
}

function resetForTests() {
  memory.clear();
  revoked.clear();
}

module.exports = {
  SLIDING_SECONDS,
  ABSOLUTE_SECONDS,
  openSession,
  touch,
  revoke,
  revokeProvider,
  assertActive,
  shouldCheckGoogle,
  markGoogleChecked,
  normalizeDeviceId,
  resetForTests,
  _memory: memory,
};
