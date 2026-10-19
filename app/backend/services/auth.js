const { getSupportEmail } = require('../utils/support-email');
const crypto = require('crypto');
const dataStore = require('../data-store');
const { getEntitlement } = require('./entitlements');
const emailService = require('./email');
const loginSession = require('./login-session');

const SECRET_SALT = 'linglish-mvp-salt';
// Data-access credential. The 30/90 day login is a separate refresh session.
const ACCESS_TTL_SECONDS = Math.max(
  60,
  Math.min(24 * 60 * 60, Number(process.env.AUTH_ACCESS_TTL_SECONDS || 60 * 60) || 3600),
);
const PASSWORD_RESET_TTL_MINUTES = Math.max(
  5,
  Math.min(120, Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30) || 30),
);
const EMAIL_VERIFICATION_TTL_HOURS = Math.max(
  1,
  Math.min(168, Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 48) || 48),
);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || process.env.JWT_SECRET || null;
const ALLOW_LEGACY_UNSIGNED_TOKENS =
  process.env.AUTH_ALLOW_LEGACY_UNSIGNED_TOKENS === 'true' ||
  (!IS_PRODUCTION && process.env.AUTH_ALLOW_LEGACY_UNSIGNED_TOKENS !== 'false');
const PASSWORD_RESET_DEBUG = process.env.PASSWORD_RESET_DEBUG === 'true';
const EMAIL_VERIFICATION_DEBUG = process.env.EMAIL_VERIFICATION_DEBUG === 'true';
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
};

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function legacyHashPassword(password) {
  return crypto
    .createHash('sha256')
    .update(password + SECRET_SALT)
    .digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  }).toString('base64url');
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    return { valid: false, needsUpgrade: false };
  }

  if (storedHash.startsWith('scrypt$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 6) return { valid: false, needsUpgrade: false };
    const [, nRaw, rRaw, pRaw, salt, expected] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expected) {
      return { valid: false, needsUpgrade: false };
    }
    const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
      N: n,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    }).toString('base64url');
    return { valid: timingSafeEqualString(derived, expected), needsUpgrade: false };
  }

  const legacy = legacyHashPassword(password);
  return {
    valid: timingSafeEqualString(legacy, storedHash),
    needsUpgrade: true,
  };
}

function getTokenSecret() {
  if (TOKEN_SECRET) return TOKEN_SECRET;
  if (IS_PRODUCTION) {
    throw new Error('AUTH_TOKEN_SECRET_REQUIRED');
  }
  return 'linglish-development-token-secret';
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function signTokenData(data) {
  return crypto
    .createHmac('sha256', getTokenSecret())
    .update(data)
    .digest('base64url');
}

function buildToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
  });
  const data = `${encodedHeader}.${encodedPayload}`;
  return `${data}.${signTokenData(data)}`;
}

function decodeToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  if (!headerB64 || !payloadB64) return null;
  try {
    const header = decodeJson(headerB64);
    if (signature) {
      if (header.alg !== 'HS256') return null;
      const data = `${headerB64}.${payloadB64}`;
      const expected = signTokenData(data);
      if (!timingSafeEqualString(signature, expected)) return null;
    } else if (header.alg === 'none' && ALLOW_LEGACY_UNSIGNED_TOKENS) {
      // Temporary migration path for old MVP sessions. Disabled by default in production.
    } else {
      return null;
    }
    const payload = decodeJson(payloadB64);
    return payload;
  } catch (err) {
    return null;
  }
}

function createAccessTokenForUser(user, extra = {}) {
  if (!user || !user.id) {
    throw new Error('INVALID_USER');
  }
  return buildToken({
    ...extra,
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS,
  });
}

function sessionResponse(user, session, accessToken, refreshToken) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TTL_SECONDS,
    session_expires_at: new Date(session.slidingExp * 1000).toISOString(),
    absolute_expires_at: new Date(session.absoluteExp * 1000).toISOString(),
    device_id: session.deviceId,
    user_id: user.id,
  };
}

async function issueLoginCredentials(user, options = {}) {
  if (!user || !user.id) throw new Error('INVALID_USER');
  const provider = options.provider || (isGuestEmail(user.email) ? 'guest' : 'password');
  const session = await loginSession.openSession({
    userId: user.id,
    deviceId: options.deviceId,
    provider,
  });
  const accessToken = createAccessTokenForUser(user, { sid: session.id });
  const refreshToken = buildToken({
    typ: 'refresh',
    sub: user.id,
    email: user.email,
    sid: session.id,
    did: session.deviceId,
    abs: session.absoluteExp,
    exp: session.slidingExp,
  });
  return sessionResponse(user, session, accessToken, refreshToken);
}

async function refreshLogin(refreshToken, deviceId) {
  const payload = decodeToken(refreshToken);
  if (!payload || payload.typ !== 'refresh' || !payload.sid) {
    throw new Error('INVALID_TOKEN');
  }
  const now = Math.floor(Date.now() / 1000);
  if ((payload.exp && payload.exp < now) || (payload.abs && payload.abs < now)) {
    throw new Error('TOKEN_EXPIRED');
  }
  const session = await loginSession.touch(payload.sid, deviceId || payload.did || null, {
    absoluteExp: payload.abs,
  });
  if (!session) throw new Error('TOKEN_EXPIRED');

  if (loginSession.shouldCheckGoogle(session)) {
    const oauthService = require('./oauth');
    const grant = await oauthService.probeStoredGoogleGrant(session.userId);
    await loginSession.markGoogleChecked(session.id);
    if (grant === 'revoked') {
      await loginSession.revokeProvider(session.userId, 'google');
      throw new Error('GOOGLE_AUTHORIZATION_REVOKED');
    }
  }

  const user = await dataStore.findUserById(session.userId);
  if (!user) throw new Error('UNAUTHORIZED');
  if (String(user.status || '').toLowerCase() === 'banned') {
    const err = new Error('BANNED');
    err.status = 403;
    throw err;
  }
  const accessToken = createAccessTokenForUser(user, { sid: session.id });
  const nextRefresh = buildToken({
    typ: 'refresh',
    sub: user.id,
    email: user.email,
    sid: session.id,
    did: session.deviceId,
    abs: session.absoluteExp,
    exp: session.slidingExp,
  });
  return sessionResponse(user, session, accessToken, nextRefresh);
}

async function revokeSessionToken(token) {
  const payload = decodeToken(token);
  if (payload?.sid) await loginSession.revoke(payload.sid);
  return true;
}

function hashPasswordResetToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex');
}

function getFrontendBaseUrl() {
  const raw = process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:4000';
  return String(raw).replace(/\/+$/, '');
}

function buildPasswordResetUrl(token) {
  return `${getFrontendBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
}

function buildEmailVerificationUrl(token) {
  return `${getFrontendBaseUrl()}/verify-email.html?token=${encodeURIComponent(token)}`;
}

function isGuestEmail(email) {
  return /^guest_[a-z0-9]+@temp\.linglish\.local$/i.test(String(email || ''));
}

function isDeliverableEmail(email) {
  const value = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return false;
  if (/\.local$/i.test(value)) return false;
  if (isGuestEmail(value)) return false;
  return true;
}

function normalizeResetAccount({ account, email, phone } = {}) {
  const raw = account || email || phone || '';
  return String(raw).trim();
}

async function findResetUser(account) {
  if (!account) return null;
  if (account.includes('@')) return dataStore.findUserByEmail(account);
  if (typeof dataStore.findUserByPhone === 'function') return dataStore.findUserByPhone(account);
  return null;
}

async function register({ email, password, username, phone, account, level }) {
  // Support unified 'account' field - auto-detect email or phone
  let finalEmail = email;
  let finalPhone = phone;

  if (account && !email && !phone) {
    if (account.includes('@')) {
      finalEmail = account;
    } else {
      finalPhone = account;
      // Generate a temporary email for phone-only registration
      finalEmail = `phone_${account}@linglish.local`;
    }
  }

  if (!finalEmail || !password) {
    throw new Error('EMAIL_AND_PASSWORD_REQUIRED');
  }

  const existing = await dataStore.findUserByEmail(finalEmail);
  if (existing) {
    throw new Error('EMAIL_ALREADY_EXISTS');
  }

  // Check if phone already exists
  if (finalPhone) {
    const phoneExists = await dataStore.findUserByPhone(finalPhone);
    if (phoneExists) {
      throw new Error('PHONE_ALREADY_EXISTS');
    }
  }

  // Validate level if provided - allow beginner, intermediate, advanced
  // Level is now optional for two-step registration (user selects on welcome page)
  const validLevels = ['beginner', 'intermediate', 'advanced'];
  const userLevel = level && validLevels.includes(level) ? level : null;

  const userRecord = await dataStore.createUser({
    email: finalEmail,
    username: username || finalEmail.split('@')[0],
    password_hash: hashPassword(password),
    phone: finalPhone || null,
    level: userLevel,
  });
  return sanitizeUser(userRecord);
}

async function login({ email, password, phone, account, device_id: bodyDeviceId, deviceId: bodyDeviceAlias } = {}, options = {}) {
  // Support unified 'account' field - auto-detect email or phone
  let finalEmail = email;
  let finalPhone = phone;

  if (account && !email && !phone) {
    if (account.includes('@')) {
      finalEmail = account;
    } else {
      finalPhone = account;
    }
  }

  // Support login with either email or phone
  let user = null;
  if (finalEmail) {
    user = await dataStore.findUserByEmail(finalEmail);
  } else if (finalPhone) {
    user = await dataStore.findUserByPhone(finalPhone);
  }

  if (!user) {
    throw new Error('INVALID_CREDENTIALS');
  }
  if (String(user.status || '').toLowerCase() === 'banned') {
    const err = new Error('BANNED');
    err.status = 403;
    throw err;
  }
  const passwordCheck = verifyPassword(password || '', user.password_hash);
  if (!passwordCheck.valid) {
    throw new Error('INVALID_CREDENTIALS');
  }
  if (passwordCheck.needsUpgrade && typeof dataStore.updateUserPasswordHash === 'function') {
    try {
      await dataStore.updateUserPasswordHash(user.id, hashPassword(password || ''));
    } catch (err) {
      console.warn('[Auth] Failed to upgrade legacy password hash:', err?.message || err);
    }
  }
  return issueLoginCredentials(user, {
    deviceId: options.deviceId || bodyDeviceId || bodyDeviceAlias || null,
    provider: options.provider || (isGuestEmail(user.email) ? 'guest' : 'password'),
  });
}

async function requestPasswordReset(payload = {}, metadata = {}) {
  const account = normalizeResetAccount(payload);
  if (!account) {
    throw new Error('PASSWORD_RESET_ACCOUNT_REQUIRED');
  }

  const response = {
    ok: true,
    expires_in_minutes: PASSWORD_RESET_TTL_MINUTES,
    delivery_configured: emailService.isEmailDeliveryConfigured(),
    support_email: getSupportEmail(),
  };

  let user = null;
  try {
    user = await findResetUser(account);
  } catch (err) {
    console.warn('[Auth] Password reset lookup failed:', err?.message || err);
  }

  if (!user || isGuestEmail(user.email) || String(user.status || '').toLowerCase() === 'banned') {
    return response;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashPasswordResetToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  const resetRecord = await dataStore.createPasswordResetToken({
    userId: user.id,
    tokenHash,
    expiresAt,
    requesterIp: metadata.ip || null,
    userAgent: metadata.userAgent || null,
  });
  if (!resetRecord) {
    return response;
  }

  let emailSent = false;
  let emailError = null;
  if (response.delivery_configured && isDeliverableEmail(user.email)) {
    try {
      await emailService.sendPasswordResetEmail({
        to: user.email,
        resetUrl: buildPasswordResetUrl(token),
        expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
      });
      emailSent = true;
    } catch (err) {
      emailError = err?.message || 'EMAIL_DELIVERY_FAILED';
      console.warn('[Auth] Password reset email failed:', emailError);
    }
  }

  try {
    await dataStore.createEvent({
      user_id: user.id,
      event_time: new Date().toISOString(),
      event_name: 'password_reset_requested',
      properties: {
        ip: metadata.ip || null,
        user_agent: metadata.userAgent || null,
        delivery_configured: response.delivery_configured,
        email_sent: emailSent,
        ...(emailError ? { email_error: emailError } : {}),
      },
      source: 'web',
    });
  } catch (err) {
    console.warn('[Auth] Failed to record password reset request:', err?.message || err);
  }

  if (PASSWORD_RESET_DEBUG) {
    response.reset_url = buildPasswordResetUrl(token);
    response.debug = true;
  }

  return response;
}

async function resetPassword({ token, password } = {}, metadata = {}) {
  const resetToken = String(token || '').trim();
  const nextPassword = String(password || '');

  if (resetToken.length < 24) {
    throw new Error('INVALID_OR_EXPIRED_RESET_TOKEN');
  }
  if (nextPassword.length < 6 || nextPassword.length > 128) {
    throw new Error('INVALID_PASSWORD');
  }

  const tokenHash = hashPasswordResetToken(resetToken);
  const resetRecord = await dataStore.findPasswordResetByTokenHash(tokenHash);
  if (!resetRecord) {
    throw new Error('INVALID_OR_EXPIRED_RESET_TOKEN');
  }

  const user = await dataStore.findUserById(resetRecord.user_id);
  if (!user || String(user.status || '').toLowerCase() === 'banned') {
    throw new Error('INVALID_OR_EXPIRED_RESET_TOKEN');
  }

  await dataStore.updateUserPasswordHash(user.id, hashPassword(nextPassword));
  await dataStore.markPasswordResetUsed(resetRecord.id);
  await dataStore.invalidateUserPasswordResets(user.id, resetRecord.id);

  try {
    await dataStore.createEvent({
      user_id: user.id,
      event_time: new Date().toISOString(),
      event_name: 'password_reset_completed',
      properties: {
        ip: metadata.ip || null,
        user_agent: metadata.userAgent || null,
      },
      source: 'web',
    });
  } catch (err) {
    console.warn('[Auth] Failed to record password reset completion:', err?.message || err);
  }

  return {
    ok: true,
    user_id: user.id,
  };
}

async function requestEmailVerification(userId, metadata = {}) {
  const response = {
    ok: true,
    expires_in_hours: EMAIL_VERIFICATION_TTL_HOURS,
    delivery_configured: emailService.isEmailDeliveryConfigured(),
    support_email: getSupportEmail(),
  };

  const user = await dataStore.findUserById(userId);
  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }
  if (user.email_verified === true) {
    return { ...response, already_verified: true };
  }
  if (!isDeliverableEmail(user.email)) {
    return { ...response, skipped: true, reason: 'EMAIL_NOT_DELIVERABLE' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashPasswordResetToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000);
  const updated = await dataStore.storeEmailVerificationToken(user.id, tokenHash, expiresAt);
  if (!updated) {
    return response;
  }

  let emailSent = false;
  let emailError = null;
  if (response.delivery_configured) {
    try {
      await emailService.sendEmailVerificationEmail({
        to: user.email,
        verificationUrl: buildEmailVerificationUrl(token),
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
      });
      emailSent = true;
    } catch (err) {
      emailError = err?.message || 'EMAIL_DELIVERY_FAILED';
      console.warn('[Auth] Email verification delivery failed:', emailError);
    }
  }

  try {
    await dataStore.createEvent({
      user_id: user.id,
      event_time: new Date().toISOString(),
      event_name: 'email_verification_requested',
      properties: {
        ip: metadata.ip || null,
        user_agent: metadata.userAgent || null,
        delivery_configured: response.delivery_configured,
        email_sent: emailSent,
        ...(emailError ? { email_error: emailError } : {}),
      },
      source: 'web',
    });
  } catch (err) {
    console.warn('[Auth] Failed to record email verification request:', err?.message || err);
  }

  if (EMAIL_VERIFICATION_DEBUG) {
    response.verification_url = buildEmailVerificationUrl(token);
    response.debug = true;
  }

  return response;
}

async function verifyEmail({ token } = {}, metadata = {}) {
  const verificationToken = String(token || '').trim();
  if (verificationToken.length < 24) {
    throw new Error('INVALID_OR_EXPIRED_EMAIL_VERIFICATION_TOKEN');
  }

  const tokenHash = hashPasswordResetToken(verificationToken);
  const user = await dataStore.findUserByEmailVerificationToken(tokenHash);
  if (!user) {
    throw new Error('INVALID_OR_EXPIRED_EMAIL_VERIFICATION_TOKEN');
  }

  const updated = await dataStore.markUserEmailVerified(user.id);
  try {
    await dataStore.createEvent({
      user_id: user.id,
      event_time: new Date().toISOString(),
      event_name: 'email_verified',
      properties: {
        ip: metadata.ip || null,
        user_agent: metadata.userAgent || null,
      },
      source: 'web',
    });
  } catch (err) {
    console.warn('[Auth] Failed to record email verification completion:', err?.message || err);
  }

  return {
    ok: true,
    user_id: user.id,
    user: updated ? sanitizeUser(updated) : null,
  };
}

async function requireUser(token) {
  const payload = decodeToken(token);
  if (!payload) {
    throw new Error('UNAUTHORIZED');
  }
  if (payload.typ != null || payload.aud != null || payload.purpose != null) {
    throw new Error('INVALID_TOKEN');
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('TOKEN_EXPIRED');
  }
  if (payload.sid) {
    const active = await loginSession.assertActive(payload.sid);
    if (!active) throw new Error('TOKEN_EXPIRED');
  }
  const user = await dataStore.findUserById(payload.sub);
  if (!user) {
    throw new Error('UNAUTHORIZED');
  }
  if (String(user.status || '').toLowerCase() === 'banned') {
    const err = new Error('BANNED');
    err.status = 403;
    throw err;
  }
  return sanitizeUser(user);
}

function sanitizeUser(user) {
  const { password_hash, ...rest } = user;
  const entitlement = getEntitlement(rest);
  return {
    ...rest,
    entitlement: {
      tier: entitlement.tier,
      effective_tier: entitlement.effectiveTier,
      subscription_status: entitlement.subscriptionStatus,
      reason: entitlement.reason,
      max_videos: entitlement.maxVideos,
      max_video_size_mb: entitlement.maxVideoSizeMb,
      daily_pronunciation_assessments: entitlement.dailyPronunciationAssessments,
      daily_ai_scores: entitlement.dailyAiScores,
      daily_deep_word_generations: entitlement.dailyDeepWordGenerations,
      is_active: entitlement.isActive,
      is_premium_active: entitlement.isPremiumActive,
    },
  };
}

module.exports = {
  register,
  login,
  requireUser,
  requestPasswordReset,
  resetPassword,
  requestEmailVerification,
  verifyEmail,
  sanitizeUser,
  decodeToken,
  createAccessTokenForUser,
  issueLoginCredentials,
  refreshLogin,
  revokeSessionToken,
  ACCESS_TTL_SECONDS,
};
