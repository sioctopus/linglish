/**
 * Main Application Entry Point
 * Handles initialization, authentication, and core app logic
 * VERSION: 20251126010
 */

console.log('[Main.js] Loading version 20251126010 - API_BASE detection fixed');

import { state, debugLog, API_BASE } from './state.js';
import { readStoredToken, readStoredEmail, clearAuthSession, persistAuthSession } from './auth.js?v=2026103001';
import { apiFetch, recordEvent } from './api.js';
import { wireShadowing } from './shadow-practice.js';
import { wireDictogloss } from './dictogloss.js';
import { wire432Timer } from './timer-432.js';
import { loadCatalog, populateMediaSelectors, loadLibraryCounts } from './vocabulary.js';
import {
  showToast,
  toggleAppShell,
  loadRecentContent,
} from './ui-manager.js';
import { refreshStats, refreshSessions } from './stats-refresh.js';

async function clearMediaSession() {
  try {
    if (window.LinglishMediaSession) {
      await window.LinglishMediaSession.clear();
    } else {
      await fetch('/auth/media-session', { method: 'DELETE', credentials: 'include' });
    }
  } catch (_) { }
}

/**
 * Initialize the state with stored credentials
 */
function initializeState() {
  state.token = readStoredToken() || null;
  state.userEmail = readStoredEmail() || null;
}

/**
 * Wire up authentication forms (login, register, guest)
 */
function wireAuthForms() {
  const registerForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(registerForm);
    const email = formData.get('email');
    const password = formData.get('password') || '';
    const confirmPassword = formData.has('confirmPassword') ? formData.get('confirmPassword') : null;
    const termsCheckbox = registerForm.querySelector('#desktop-agree-terms') || registerForm.querySelector('#agree-terms');

    if (password.length < 6) {
      showToast('密码至少 6 位');
      return;
    }

    if (confirmPassword !== null && password !== confirmPassword) {
      showToast('两次输入的密码不一致');
      return;
    }

    if (termsCheckbox && !termsCheckbox.checked) {
      showToast('请先同意用户协议和隐私政策');
      return;
    }

    try {
      const account = formData.get('account') || formData.get('email');

      // Validation: account is required
      if (!account || !account.trim()) {
        showToast('请输入邮箱或手机号');
        return;
      }

      const accountTrimmed = account.trim();
      const registerData = {
        password: formData.get('password'),
        username: formData.get('username'),
      };

      // Auto-detect if account is email or phone
      if (accountTrimmed.includes('@')) {
        registerData.email = accountTrimmed;
      } else {
        registerData.phone = accountTrimmed;
        // For phone registration, generate a temporary email
        registerData.email = `phone_${accountTrimmed}@linglish.local`;
      }

      const registration = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify(registerData),
      });
      if (registration?.access_token) {
        if (state.token && state.token !== registration.access_token) await clearMediaSession();
        state.token = registration.access_token;
        state.userEmail = accountTrimmed;
        persistAuthSession(state.token, accountTrimmed, { remember: true, session: registration });
        await bootstrapApp();
        showToast('注册成功！今日训练已开启');
        return;
      }

      showToast('注册成功！请登录');
      registerForm.reset();

      // Switch from register form to login form
      registerForm.style.display = 'none';
      loginForm.style.display = 'block';

      // Update header
      const authHeader = document.querySelector('.auth-header h2');
      if (authHeader) {
        authHeader.textContent = '登录';
        authHeader.setAttribute('data-i18n', 'common.login');
      }

      // Update footer back to "还没有账号？立即注册"
      const authFooter = document.querySelector('.auth-footer');
      if (authFooter) {
        authFooter.innerHTML = `
          <span data-i18n="auth.no_account">还没有账号？</span>
          <a href="#" id="show-register" data-i18n="common.register">立即注册</a>
        `;

        // Re-bind the "show-register" click event
        const showRegisterLink = document.getElementById('show-register');
        if (showRegisterLink) {
          showRegisterLink.addEventListener('click', (e) => {
            e.preventDefault();
            loginForm.style.display = 'none';
            registerForm.style.display = 'block';
            const authHeader = document.querySelector('.auth-header h2');
            if (authHeader) {
              authHeader.textContent = '注册';
              authHeader.setAttribute('data-i18n', 'common.register');
            }
            authFooter.innerHTML = `
              <span data-i18n="auth.have_account">已有账号？</span>
              <a href="#" id="show-login" data-i18n="common.login">立即登录</a>
            `;
          });
        }
      }

      // Fill in the account field
      const loginAccountInput = loginForm.querySelector('input[name="account"]') || loginForm.querySelector('input[name="email"]');
      if (loginAccountInput && account) {
        loginAccountInput.value = account.trim();
      }

      // Ensure auth section is visible and scroll to it
      const authSection = document.getElementById('auth-section');
      if (authSection) {
        // Small delay to ensure DOM is updated before scrolling
        setTimeout(() => {
          authSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }

      // Focus on password field after scrolling
      const loginPasswordInput = loginForm.querySelector('input[name="password"]');
      if (loginPasswordInput) {
        setTimeout(() => {
          loginPasswordInput.focus();
        }, 300);
      }
    } catch (err) {
      showToast(`Registration failed: ${err.message}`);
    }
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const account = (formData.get('account') || formData.get('email') || '').trim();
    const rememberCheckbox = loginForm.querySelector('#desktop-remember-me') || loginForm.querySelector('#remember-me');
    const rememberPreference = rememberCheckbox ? rememberCheckbox.checked : true;

    // Validation
    if (!account) {
      showToast('请输入邮箱或手机号');
      return;
    }

    try {
      const loginData = { password: formData.get('password') };
      // Auto-detect if account is email or phone
      if (account.includes('@')) {
        loginData.email = account;
      } else {
        loginData.phone = account;
      }

      const tokens = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
      });
      if (state.token && state.token !== tokens.access_token) await clearMediaSession();
      state.token = tokens.access_token;
      state.userEmail = account;
      console.log('[Login] Authentication established:', Boolean(state.token));
      console.log('[Login] API_BASE:', API_BASE);

      persistAuthSession(state.token, account, { remember: rememberPreference, session: tokens });
      const savedToken = readStoredToken();
      if (!savedToken) {
        console.error('[Login] CRITICAL: Token was not saved to storage layers!');
        alert('Warning: Failed to save login session. Please check browser settings.');
      } else {
        console.log('[Login] Stored token into desktop/mobile storage layers successfully');
      }

      await bootstrapApp();
      showToast('Welcome back! Training loop unlocked.');
    } catch (err) {
      showToast(`Login failed: ${err.message}`);
    }
  });

  const guestBtn = document.getElementById('desktop-guest-btn') || document.getElementById('guest-btn');
  if (guestBtn) {
    guestBtn.addEventListener('click', () => {
      showToast('请先注册或登录账号');
    });
  }
}

/**
 * Wire up global UI actions (logout, etc.)
 */
function wireGlobalActions() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await clearMediaSession();
    clearAuthSession();
    state.token = null;
    state.user = null;
    state.userEmail = null;
    toggleAppShell(false);
    showToast('Logged out. See you soon!');
    // 返回登录页（无 hash），避免停留在 #auth-section
    setTimeout(() => {
      window.location.href = './index-desktop.html';
    }, 150);
  });
}

/**
 * Bootstrap the authenticated app with user data
 */
export async function bootstrapApp() {
  try {
    console.log('[Bootstrap] Starting... authenticated:', Boolean(state.token));
    console.log('[Bootstrap] API_BASE:', API_BASE);
    const user = await apiFetch('/users/me');
    state.user = user;
    console.log('[Bootstrap] User fetched successfully:', user ? user.email || user.id : 'NULL');

    // Safely extract display name with null checks
    let displayName = 'User';
    if (user) {
      if (user.username) {
        displayName = user.username;
      } else if (user.email) {
        try {
          displayName = user.email.split('@')[0];
        } catch (e) {
          console.warn('Failed to parse email for display name:', e);
          displayName = 'User';
        }
      }
    }

    // Update top bar user display name
    const userDisplayNameEl = document.getElementById('user-display-name');
    if (userDisplayNameEl) {
      userDisplayNameEl.textContent = displayName;
    }

    // Update VIP badge
    const vipBadge = document.getElementById('vip-badge');
    if (vipBadge) {
      if (user && user.membership_type && user.membership_type !== 'free') {
        vipBadge.hidden = false;
        const tier = (user.membership_type || '').trim().toLowerCase();
        const isFamily = tier === 'family';
        const isSvip = tier === 'svip';
        vipBadge.classList.remove('vip', 'family', 'svip');
        vipBadge.classList.add(isFamily ? 'family' : (isSvip ? 'svip' : 'vip'));
        const vipText = vipBadge.querySelector('.vip-text');
        if (vipText) vipText.textContent = isFamily ? 'Family' : (isSvip ? 'SVIP' : 'VIP');
        const vipIcon = vipBadge.querySelector('.vip-icon');
        if (vipIcon) vipIcon.textContent = isSvip ? '🚀' : (isFamily ? '👑' : '🔥');
      } else {
        vipBadge.hidden = true;
      }
    }

    toggleAppShell(true);
    await Promise.all([
      loadCatalog(),
      refreshStats(),
      refreshSessions(),
      loadRecentContent(),
      loadLibraryCounts()
    ]);
    // Ensure the video list inside the library card is rendered even if counts finished first
    try {
      const videosRes = await apiFetch('/video-resources?lite=1').catch(() => ({ items: [] }));
      const videos = (videosRes && videosRes.items) || [];
      const { renderVideoLibraryList } = await import('./ui-manager.js');
      renderVideoLibraryList(videos);
    } catch (_) { }
  } catch (err) {
    console.error('Failed to bootstrap app', err);
    await clearMediaSession();
    clearAuthSession();
    state.token = null;
    state.user = null;
    state.userEmail = null;
    toggleAppShell(false);
    showToast('Session expired. Please log in again.');
  }
}

// Re-export refreshStats and refreshSessions from stats-refresh module
export { refreshStats, refreshSessions };

/**
 * Initialize the application on DOMContentLoaded
 */
document.addEventListener('DOMContentLoaded', () => {
  initializeState();
  wireAuthForms();
  wireShadowing();
  wireDictogloss();
  wire432Timer();
  wireGlobalActions();

  toggleAppShell(Boolean(state.token && state.user));

  if (state.token) {
    bootstrapApp();
  }
});

// Expose functions to global scope for language switching
window.loadRecentContent = loadRecentContent;
window.loadLibraryCounts = loadLibraryCounts;
