'use strict';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'on_trial', 'trialing']);
const GRACE_SUBSCRIPTION_STATUSES = new Set(['cancelled', 'cancel_at_period_end', 'past_due']);
const BLOCKED_SUBSCRIPTION_STATUSES = new Set(['expired', 'paused', 'unpaid']);

const TIER_ALIASES = {
  pro: 'vip',
  premium: 'vip',
  basic: 'vip',
};

const TIER_FEATURES = {
  free: {
    tier: 'free',
    maxVideos: 3,
    maxVideoSizeMb: 30,
    dailyPronunciationAssessments: 5,
    dailyAiScores: 3,
    dailyDeepWordGenerations: 5,
    canAccessPremiumContent: false,
    canUseCoaching: false,
  },
  vip: {
    tier: 'vip',
    maxVideos: 50,
    maxVideoSizeMb: 500,
    dailyPronunciationAssessments: 200,
    dailyAiScores: 50,
    dailyDeepWordGenerations: 80,
    canAccessPremiumContent: true,
    canUseCoaching: true,
  },
  family: {
    tier: 'family',
    maxVideos: 50,
    maxVideoSizeMb: 500,
    dailyPronunciationAssessments: 200,
    dailyAiScores: 50,
    dailyDeepWordGenerations: 80,
    canAccessPremiumContent: true,
    canUseCoaching: true,
  },
  svip: {
    tier: 'svip',
    maxVideos: 300,
    maxVideoSizeMb: 300,
    dailyPronunciationAssessments: 500,
    dailyAiScores: 150,
    dailyDeepWordGenerations: 200,
    canAccessPremiumContent: true,
    canUseCoaching: true,
  },
  admin: {
    tier: 'admin',
    maxVideos: Infinity,
    maxVideoSizeMb: Infinity,
    dailyPronunciationAssessments: Infinity,
    dailyAiScores: Infinity,
    dailyDeepWordGenerations: Infinity,
    canAccessPremiumContent: true,
    canUseCoaching: true,
  },
};

function normalizeTier(value) {
  const raw = String(value || 'free').trim().toLowerCase();
  const normalized = TIER_ALIASES[raw] || raw || 'free';
  return Object.prototype.hasOwnProperty.call(TIER_FEATURES, normalized) ? normalized : 'free';
}

function normalizeSubscriptionStatus(value) {
  const raw = String(value || 'none').trim().toLowerCase();
  if (raw === 'canceled') return 'cancelled';
  return raw || 'none';
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFutureDate(value, now = new Date()) {
  const date = parseDate(value);
  return Boolean(date && date > now);
}

function getEntitlement(user, options = {}) {
  const now = options.now || new Date();
  const rawTier = normalizeTier(user?.membership_type);
  const isAdmin = Boolean(user?.is_admin) || rawTier === 'admin';
  const tier = isAdmin ? 'admin' : rawTier;
  const subscriptionStatus = normalizeSubscriptionStatus(user?.subscription_status);
  const expiresAt = parseDate(user?.membership_expires_at || user?.subscription_end_date);
  const paidTier = tier !== 'free';
  let isActive = false;
  let reason = 'free';

  if (isAdmin) {
    isActive = true;
    reason = 'admin';
  } else if (!paidTier) {
    isActive = false;
    reason = 'free';
  } else if (BLOCKED_SUBSCRIPTION_STATUSES.has(subscriptionStatus)) {
    isActive = false;
    reason = subscriptionStatus;
  } else if (ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus)) {
    isActive = !expiresAt || expiresAt > now;
    reason = isActive ? subscriptionStatus : 'expired_period';
  } else if (GRACE_SUBSCRIPTION_STATUSES.has(subscriptionStatus)) {
    isActive = Boolean(expiresAt && expiresAt > now);
    reason = isActive ? `${subscriptionStatus}_grace` : subscriptionStatus;
  } else {
    // Manual/internal grants may not have a subscription row.
    isActive = !expiresAt || expiresAt > now;
    reason = isActive ? 'manual_grant' : 'manual_grant_expired';
  }

  const effectiveTier = isActive ? tier : 'free';
  const features = TIER_FEATURES[effectiveTier] || TIER_FEATURES.free;

  return {
    tier,
    effectiveTier,
    subscriptionStatus,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    isAdmin,
    isPaidTier: paidTier,
    isActive,
    isPremiumActive: isActive && features.canAccessPremiumContent,
    reason,
    maxVideos: features.maxVideos,
    maxVideoSizeMb: features.maxVideoSizeMb,
    dailyPronunciationAssessments: features.dailyPronunciationAssessments,
    dailyAiScores: features.dailyAiScores,
    dailyDeepWordGenerations: features.dailyDeepWordGenerations,
  };
}

function hasActivePaidEntitlement(user, options = {}) {
  return getEntitlement(user, options).isPremiumActive;
}

function canUseCoaching(user, options = {}) {
  const entitlement = getEntitlement(user, options);
  const features = TIER_FEATURES[entitlement.effectiveTier] || TIER_FEATURES.free;
  return Boolean(entitlement.isActive && features.canUseCoaching);
}

function getUploadLimits(user, options = {}) {
  const entitlement = getEntitlement(user, options);
  return {
    tier: entitlement.effectiveTier,
    maxVideos: entitlement.maxVideos,
    maxVideoSizeMb: entitlement.maxVideoSizeMb,
    entitlement,
  };
}

function isGuestAccount(user) {
  const email = String(user?.email || '');
  return email.startsWith('guest_') && email.endsWith('@temp.linglish.local');
}

function getUsageLimits(user, options = {}) {
  const entitlement = getEntitlement(user, options);
  return {
    tier: entitlement.effectiveTier,
    dailyPronunciationAssessments: entitlement.dailyPronunciationAssessments,
    dailyAiScores: entitlement.dailyAiScores,
    dailyDeepWordGenerations: entitlement.dailyDeepWordGenerations,
    entitlement,
  };
}

function buildQuotaPaywall({ feature, quota = {}, entitlement = null } = {}) {
  const key = String(feature || 'usage').trim().toLowerCase();
  const tier = String(quota.tier || entitlement?.effectiveTier || 'free').toLowerCase();
  const freeTier = tier === 'free';
  const vipFeatures = TIER_FEATURES.vip;
  const featureConfig = {
    pronunciation: {
      title: freeTier ? '今日免费发音评测已用完' : '今日发音评测额度已用完',
      message: freeTier
        ? `免费版每天 ${quota.limit || TIER_FEATURES.free.dailyPronunciationAssessments} 次评测，升级个人会员可提升到每天 ${vipFeatures.dailyPronunciationAssessments} 次。`
        : '你的高频评测额度已用完，明天会自动恢复。',
      upgradeUrl: '/pricing.html?from=quota&intent=pronunciation#plans',
      featureLabel: '发音评测',
    },
    ai_score: {
      title: freeTier ? '今日免费 AI 口语打分已用完' : '今日 AI 口语打分额度已用完',
      message: freeTier
        ? `免费版每天 ${quota.limit || TIER_FEATURES.free.dailyAiScores} 次 AI 打分，升级个人会员可提升到每天 ${vipFeatures.dailyAiScores} 次。`
        : '你的 AI 打分额度已用完，明天会自动恢复。',
      upgradeUrl: '/pricing.html?from=quota&intent=ai_score#plans',
      featureLabel: 'AI 口语打分',
    },
    word_deep: {
      title: freeTier ? '今日免费深度解析已用完' : '今日深度解析额度已用完',
      message: freeTier
        ? `免费版每天 ${quota.limit || TIER_FEATURES.free.dailyDeepWordGenerations} 次深度解析，升级个人会员可提升到每天 ${vipFeatures.dailyDeepWordGenerations} 次。`
        : '你的深度解析额度已用完，明天会自动恢复。',
      upgradeUrl: '/pricing.html?from=quota&intent=word_deep#plans',
      featureLabel: '单词深度解析',
    },
  };
  const config = featureConfig[key] || {
    title: freeTier ? '今日免费额度已用完' : '今日额度已用完',
    message: freeTier ? '升级个人会员可获得更高频训练额度。' : '额度明天会自动恢复。',
    upgradeUrl: '/pricing.html?from=quota#plans',
    featureLabel: '训练额度',
  };

  return {
    feature: key,
    feature_label: config.featureLabel,
    title: config.title,
    message: config.message,
    action_label: freeTier ? '升级个人会员' : '查看会员权益',
    upgrade_url: freeTier ? config.upgradeUrl : '/membership.html?from=quota',
    reset_hint: '每日额度会在明天自动恢复。',
    tier,
    limit: Number.isFinite(Number(quota.limit)) ? Number(quota.limit) : null,
    used_today: Number.isFinite(Number(quota.used_today)) ? Number(quota.used_today) : null,
    remaining: Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : null,
  };
}

module.exports = {
  ACTIVE_SUBSCRIPTION_STATUSES,
  BLOCKED_SUBSCRIPTION_STATUSES,
  GRACE_SUBSCRIPTION_STATUSES,
  buildQuotaPaywall,
  canUseCoaching,
  getEntitlement,
  getUsageLimits,
  getUploadLimits,
  hasActivePaidEntitlement,
  isFutureDate,
  isGuestAccount,
  normalizeSubscriptionStatus,
  normalizeTier,
};
