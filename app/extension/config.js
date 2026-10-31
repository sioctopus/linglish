/**
 * Linglish Chrome extension — site origin.
 * Dev default matches the backend static server. For production, change ORIGIN
 * and also update host_permissions / content_scripts / externally_connectable
 * matches in manifest.json to the same host.
 */
const LINGLISH_CONFIG = Object.freeze({
  ORIGIN: 'http://localhost:4000',
  PATHS: Object.freeze({
    home: '/index-desktop.html',
    today: '/today.html',
    video: '/video-reader-desktop.html',
    practice: '/practice-session-desktop.html?mode=shadowing',
    auth: '/desktop-auth.html',
    bridge: '/extension-bridge.html',
  }),
});

if (typeof globalThis !== 'undefined') {
  globalThis.LINGLISH_CONFIG = LINGLISH_CONFIG;
}
