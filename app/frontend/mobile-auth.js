/**
 * linglish Mobile Authentication Manager
 * 移动端认证管理
 */

class AuthManager {
  constructor() {
    this.authToken = null;
    this.userEmail = null;
    this.isGuest = false;
  }

  /**
   * 清理游客标记（当已持有正式 token 时调用）
   */
  clearGuestFlags() {
    this.safeRemove(localStorage, 'is_guest');
    this.safeRemove(localStorage, 'guest_id');
    this.safeRemove(localStorage, 'isGuest');
    this.safeRemove(sessionStorage, 'is_guest');
    this.safeRemove(sessionStorage, 'isGuest');
  }

  /**
   * Safely read from storage without throwing in restricted contexts
   */
  safeGet(storage, key) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return null;
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  /**
   * Safely write to storage
   */
  safeSet(storage, key, value) {
    try {
      if (!storage || typeof storage.setItem !== 'function') return;
      storage.setItem(key, value);
    } catch (_) { }
  }

  /**
   * Safely remove a key from storage
   */
  safeRemove(storage, key) {
    try {
      if (!storage || typeof storage.removeItem !== 'function') return;
      storage.removeItem(key);
    } catch (_) { }
  }

  /**
   * 检查用户是否已登录
   */
  isAuthenticated() {
    this.authToken = null;
    if (window.AuthManager && typeof window.AuthManager.getToken === 'function') {
      const managed = window.AuthManager.getToken();
      if (managed) this.authToken = managed;
    }
    if (!this.authToken) {
      this.authToken =
        this.safeGet(localStorage, 'authToken') ||
        this.safeGet(sessionStorage, 'authToken') ||
        this.safeGet(localStorage, 'linglish_token') ||
        this.safeGet(sessionStorage, 'linglish_token');
    }

    this.userEmail = this.safeGet(localStorage, 'userEmail') || this.safeGet(sessionStorage, 'userEmail');

    // Check both camelCase and underscore versions for compatibility
    const guestFlags = {
      sessionIsGuest: this.safeGet(sessionStorage, 'isGuest'),
      sessionIsGuestUnderscore: this.safeGet(sessionStorage, 'is_guest'),
      localIsGuest: this.safeGet(localStorage, 'is_guest')
    };

    this.isGuest =
      this.safeGet(sessionStorage, 'isGuest') === 'true' ||
      this.safeGet(sessionStorage, 'is_guest') === 'true' ||
      this.safeGet(localStorage, 'is_guest') === 'true';

    // Debug log
    if (this.authToken) {
      console.log('[AuthManager] Authentication check:', {
        tokenFound: true,
        isGuest: this.isGuest,
        guestFlagPresent: Object.values(guestFlags).some(value => value === 'true')
      });
    } else {
      console.log('[AuthManager] Authentication check - No token found');
    }

    // 如果有正式用户email（非游客email），但仍残留游客标记，进行自愈清理
    // 游客email格式：guest_xxxxx@temp.linglish.local
    const hasRealUserEmail = this.userEmail && !this.userEmail.includes('@temp.linglish.local');
    if (this.authToken && this.isGuest && hasRealUserEmail) {
      console.log('[AuthManager] Clearing guest flags for regular user (has real email)');
      this.clearGuestFlags();
      this.isGuest = false;
    }

    return !!this.authToken;
  }

  /**
   * 获取 token，自动从存储刷新
   */
  getToken() {
    if (this.authToken) return this.authToken;
    // Refresh from storage; isAuthenticated already hydrates all fields
    return this.isAuthenticated() ? this.authToken : null;
  }

  /**
   * 获取用户信息
   */
  getUserInfo() {
    return {
      email: this.userEmail,
      isGuest: this.isGuest,
      token: this.authToken
    };
  }

  /**
   * 要求认证，未登录则跳转
   * 游客可以访问浏览页面，但不能上传
   */
  requireAuth() {
    try {
      if (new URLSearchParams(window.location.search).get('shell_preview') === '1') return true;
    } catch (_) { }
    if (!this.isAuthenticated()) {
      // 保存当前页面，登录后返回
      this.safeSet(sessionStorage, 'returnUrl', window.location.href);
      window.location.href = 'mobile-auth.html';
      return false;
    }
    return true;
  }

  /**
   * 要求用户认证（游客也允许）
   * 注意：视频上传功能的游客限制在 video-upload.html 页面中单独处理
   */
  requireFullAuth() {
    if (!this.isAuthenticated()) {
      this.safeSet(sessionStorage, 'returnUrl', window.location.href);
      window.location.href = 'mobile-auth.html';
      return false;
    }

    // 游客也允许访问（除了上传视频，在video-upload.html中单独检查）
    return true;
  }

  /**
   * 登出
   */
  async logout() {
    try {
      if (window.LinglishMediaSession) {
        await window.LinglishMediaSession.clear();
      } else {
        await fetch('/auth/media-session', { method: 'DELETE', credentials: 'include' });
      }
    } catch (_) { }
    this.safeRemove(localStorage, 'authToken');
    this.safeRemove(localStorage, 'linglish_token');
    this.safeRemove(localStorage, 'userEmail');
    this.safeRemove(localStorage, 'is_guest');
    this.safeRemove(localStorage, 'guest_id');
    this.safeRemove(sessionStorage, 'authToken');
    this.safeRemove(sessionStorage, 'userEmail');
    this.safeRemove(sessionStorage, 'isGuest');
    this.safeRemove(sessionStorage, 'is_guest');
    this.safeRemove(sessionStorage, 'returnUrl');

    window.location.href = 'mobile-auth.html';
  }

  /**
   * 显示用户信息到页面
   */
  displayUserInfo(elementId = 'user-email-display') {
    const element = document.getElementById(elementId);
    if (element && this.userEmail) {
      if (this.isGuest) {
        element.textContent = '游客模式';
      } else {
        element.textContent = this.userEmail;
      }
    }
  }

  /**
   * 添加登出按钮事件
   */
  attachLogoutButton(buttonId = 'logout-btn') {
    const button = document.getElementById(buttonId);
    if (button) {
      button.addEventListener('click', () => {
        if (confirm('确定要退出登录吗？')) {
          this.logout();
        }
      });
    }
  }
}

// 创建全局实例
const authManager = new AuthManager();

// 页面加载时自动检查认证
window.addEventListener('DOMContentLoaded', async () => {
  // 如果当前页面不是登录页面，则检查认证
  if (!window.location.href.includes('mobile-auth.html')) {
    // Local shell preview: skip gate so layout can be checked without a session
    try {
      if (new URLSearchParams(window.location.search).get('shell_preview') === '1') return;
    } catch (_) { }
    if (window.AuthManager && window.AuthManager.ready && typeof window.AuthManager.ready.then === 'function') {
      try { await window.AuthManager.ready; } catch (_) { }
    }
    authManager.requireAuth();
  }
});
