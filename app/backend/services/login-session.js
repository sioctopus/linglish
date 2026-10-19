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

async function persist(record, { create = false } = {}) {
  if (record.revoked || revoked.has(record.id)) return false;
  memory.set(record.id, record);
  try {
    const sql = create
      ? `INSERT INTO auth_device_sessions
        (id, user_id, device_id, provider, created_at, absolute_expires_at, sliding_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), to_timestamp($7), NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`
      : `UPDATE auth_device_sessions
         SET device_id = $2, sliding_expires_at = to_timestamp($3), updated_at = NOW()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`;
    const params = create
      ? [
        record.id,
        record.userId,
        record.deviceId,
        record.provider,
        record.createdAt,
        record.absoluteExp,
        record.slidingExp,
      ]
      : [record.id, record.deviceId, record.slidingExp];
    const { rows } = await dataStore.query(sql, params);
    if (!rows.length) {
      record.revoked = true;
      revoked.add(record.id);
      memory.delete(record.id);
      return false;
    }
    return !record.revoked && !revoked.has(record.id);
  } catch (err) {
    console.warn('[AuthSession] persist failed:', err?.message || err);
    return memory.has(record.id) && isLive(record, Math.floor(Date.now() / 1000)) && !revoked.has(record.id);
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
    if (!rows[0]) {
      memory.delete(id);
      return null;
    }
    const record = recordFromRow(rows[0]);
    memory.set(id, record);
    if (record.revoked) revoked.add(id);
    return record;
  } catch (err) {
    if (cached) return cached;
    console.warn('[AuthSession] lookup failed for an uncached session:', err?.message || err);
    return null;
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
  await persist(record, { create: true });
  await revokeOtherDevices(record.userId, record.deviceId);
  return record;
}

async function revokeOtherDevices(userId, deviceId) {
  for (const record of memory.values()) {
    if (String(record.userId) === String(userId) && record.deviceId !== deviceId && !record.revoked) {
      record.revoked = true;
      revoked.add(record.id);
    }
  }
  try {
    await dataStore.query(
      `UPDATE auth_device_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL`,
      [userId, deviceId]
    );
  } catch (err) {
    console.warn('[AuthSession] revoke other devices failed:', err?.message || err);
  }
}

async function touch(id, deviceId) {
  if (!id || revoked.has(id)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const record = await load(id);
  if (revoked.has(id) || !isLive(record, nowSec)) return null;
  if (deviceId && record.deviceId !== deviceId) return null;
  record.slidingExp = Math.min(nowSec + SLIDING_SECONDS, record.absoluteExp);
  record.revoked = false;
  if (!await persist(record)) return null;
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
  return !revoked.has(id) && isLive(record, Math.floor(Date.now() / 1000));
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
