/**
 * Authentication Management
 * Handles token storage, persistence, and retrieval
 * Delegates to global AuthManager for robust fallback support
 */

import { AUTH_KEYS } from './state.js';

// In-memory fallback when browser storage is blocked (incognito, extensions, etc.)
const memorySession = {
  token: null,
  email: null,
};

/**
 * Read stored authentication token
 * @returns {string|null} The stored token or null if not found
 */
export function readStoredToken() {
  if (window.AuthManager) {
    return window.AuthManager.getToken();
  }
  // Fallback if AuthManager not loaded (shouldn't happen in updated app)
  try {
    return (
      localStorage.getItem('authToken') ||
      localStorage.getItem('linglish_token') ||
      sessionStorage.getItem('authToken') ||
      sessionStorage.getItem('linglish_token')
    ) || memorySession.token;
  } catch (err) {
    console.warn('[Auth] Storage unavailable when reading token:', err?.message || err);
    return memorySession.token;
  }
}

/**
 * Read stored user email
 * @returns {string|null} The stored email or null if not found
 */
export function readStoredEmail() {
  try {
    return (
      localStorage.getItem('userEmail') ||
      sessionStorage.getItem('userEmail')
    ) || memorySession.email;
  } catch (err) {
    console.warn('[Auth] Storage unavailable when reading email:', err?.message || err);
    return memorySession.email;
  }
}

/**
 * Clear all authentication session data
 */
export function clearAuthSession() {
  if (window.AuthManager) {
    window.AuthManager.clearToken();
  }

  try {
    [...AUTH_KEYS.token, ...AUTH_KEYS.email, ...AUTH_KEYS.misc].forEach((key) => {
      try { localStorage.removeItem(key); } catch (_) { }
      try { sessionStorage.removeItem(key); } catch (_) { }
    });
  } catch (err) {
    console.warn('[Auth] Storage unavailable when clearing session:', err?.message || err);
  }

  memorySession.token = null;
  memorySession.email = null;

  // 清除所有缓存，防止缓存token导致401错误
  try {
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name));
      });
    }
  } catch (e) {
    console.warn('[Auth] Could not clear caches:', e);
  }
}

/**
 * Persist authentication session
 * @param {string} token - Authentication token
 * @param {string} email - User email
 * @param {Object} options - Persistence options
 * @param {boolean} options.remember - Whether to persist to localStorage (default: true)
 */
export async function persistAuthSession(token, email, { remember = true, session = null } = {}) {
  if (window.AuthManager && session && typeof window.AuthManager.saveLogin === 'function') {
    await window.AuthManager.saveLogin(session, remember);
  } else if (window.AuthManager) {
    await window.AuthManager.setToken(token, remember);
  }

  try {
    // Also try to save email (non-critical)
    const store = remember ? localStorage : sessionStorage;
    try { store.setItem('userEmail', email); } catch (_) { }

    // Clear guest flags
    try { localStorage.removeItem('is_guest'); } catch (_) { }
    try { sessionStorage.removeItem('is_guest'); } catch (_) { }

  } catch (err) {
    console.warn('[Auth] Storage unavailable when saving session details:', err?.message || err);
    memorySession.token = token;
    memorySession.email = email;
  }
}
