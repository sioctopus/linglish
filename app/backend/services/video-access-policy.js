const { hasActivePaidEntitlement } = require('./entitlements');

function isSameUserId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

function canAccessVideoResource(resource, user) {
  if (!resource) return false;
  if (Boolean(user?.is_admin) || isSameUserId(resource.uploader_id, user?.id)) return true;
  // Files on disk and incomplete rows do not establish public visibility.
  if (resource.is_public !== true) return false;
  return resource.is_vip_only !== true || hasActivePaidEntitlement(user);
}

module.exports = { canAccessVideoResource, isSameUserId };
