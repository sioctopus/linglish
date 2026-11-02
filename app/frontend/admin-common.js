/**
 * Linglish 管理后台公共组件和工具函数
 */

// ===== 认证工具 =====
const AdminAuth = {
  getToken() {
    try {
      const fromLocal = localStorage.getItem('linglish_token') || localStorage.getItem('authToken');
      const fromSession = sessionStorage.getItem('linglish_token') || sessionStorage.getItem('authToken');
      if (fromLocal) return fromLocal;
      if (fromSession) return fromSession;
      // Fallback: try cookies
      const cookie = document.cookie || '';
      const kv = Object.fromEntries(cookie.split(';').map(s=>s.trim()).filter(Boolean).map(s=>{
        const i = s.indexOf('=');
        return i>0 ? [decodeURIComponent(s.slice(0,i)), decodeURIComponent(s.slice(i+1))] : [s,''];
      }));
      return kv.linglish_token || kv.authToken || kv.token || null;
    } catch (_) { return null; }
  },

  checkAuth() {
    const token = this.getToken();
    if (!token) {
      alert('请先登录');
      window.location.href = './index.html';
      return false;
    }
    return token;
  },

  logout() {
    try {
      localStorage.removeItem('linglish_token');
      sessionStorage.removeItem('linglish_token');
    } catch (e) {}
    window.location.href = './index.html';
  }
};

// ===== API 请求工具 =====
const AdminAPI = {
  baseURL: '',

  async request(url, options = {}) {
    const token = AdminAuth.getToken();
    const response = await fetch(this.baseURL + url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const data = await response.json().catch(() => null);

    if (response.status === 401) {
      try { localStorage.removeItem('linglish_token'); sessionStorage.removeItem('linglish_token'); } catch (e) {}
      alert('登录已过期，请重新登录');
      window.location.href = './index.html';
      throw new Error('未授权');
    }

    if (response.status === 403) {
      if ((data && String(data.message).toUpperCase() === 'BANNED')) {
        alert('账户已封禁，请联系管理员');
        try { localStorage.removeItem('linglish_token'); sessionStorage.removeItem('linglish_token'); } catch (e) {}
        window.location.href = './index.html';
        throw new Error('账户已封禁');
      }
      alert('需要管理员权限');
      throw new Error('需要管理员权限');
    }

    if (!response.ok) {
      throw new Error((data && data.message) || response.statusText);
    }

    return data;
  },

  get(url, options) {
    return this.request(url, { ...options, method: 'GET' });
  },

  post(url, body, options) {
    return this.request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  put(url, body, options) {
    return this.request(url, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  patch(url, body, options) {
    return this.request(url, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  delete(url, options) {
    return this.request(url, { ...options, method: 'DELETE' });
  }
};

// ===== 导航菜单 =====
const AdminNav = {
  menuItems: [
    {
      section: '主要功能',
      items: [
        { icon: '📊', text: 'Dashboard', href: './admin-dashboard.html', id: 'dashboard' },
        { icon: '🧭', text: '增长总览', href: './admin-growth.html', id: 'growth' },
        { icon: '📈', text: '数据分析', href: './admin-analytics.html', id: 'analytics' },
        { icon: '🏫', text: '团队线索', href: './admin-team-leads.html', id: 'team-leads' },
        { icon: '👥', text: '用户管理', href: './admin-users.html', id: 'users' },
        { icon: '📚', text: '内容管理', href: './admin-content.html', id: 'content' },
        { icon: '✅', text: '视频审核', href: './admin-video-reviews.html', id: 'video-reviews' },
        { icon: '🎙️', text: '达人申请', href: './admin-creators.html', id: 'creators' },
        { icon: '💬', text: '用户反馈', href: './admin-feedback.html', id: 'feedback' },
      ]
    },
    {
      section: '数据管理',
      items: [
        { icon: '🌍', text: '翻译管理', href: './admin-translations.html', id: 'translations' },
        { icon: '📊', text: '使用统计', href: './admin-usage.html', id: 'usage' },
      ]
    },
    {
      section: '系统',
      items: [
        { icon: '💚', text: '系统监控', href: './admin-system.html', id: 'system' },
        { icon: '⚙️', text: '系统设置', href: './admin-settings.html', id: 'settings' },
      ]
    }
  ],

  getCurrentPage() {
    const path = window.location.pathname;
    const filename = path.split('/').pop().replace('.html', '');
    return filename.replace('admin-', '') || 'dashboard';
  },

  render() {
    const currentPage = this.getCurrentPage();

    let html = `
      <div class="admin-sidebar">
        <div class="admin-sidebar-header">
          <a href="./admin-dashboard.html" class="admin-sidebar-brand">
            <span>⚡</span>
            <span>Linglish Admin</span>
          </a>
        </div>
        <nav class="admin-sidebar-nav">
    `;

    this.menuItems.forEach(section => {
      html += `<div class="admin-nav-section">`;
      html += `<div class="admin-nav-section-title">${section.section}</div>`;
      section.items.forEach(item => {
        const isActive = currentPage === item.id ? 'active' : '';
        const reviewBadge = item.id === 'video-reviews'
          ? '<span id="admin-video-review-badge" class="admin-badge admin-badge-danger" style="margin-left:auto; display:none; padding:1px 7px; border-radius:10px;">0</span>'
          : '';
        html += `
          <a href="${item.href}" class="admin-nav-item ${isActive}">
            <span class="admin-nav-icon">${item.icon}</span>
            <span>${item.text}</span>
            ${reviewBadge}
          </a>
        `;
      });
      html += `</div>`;
    });

    html += `
        </nav>
      </div>
    `;

    return html;
  },

  init() {
    // 插入移动端菜单按钮
    const menuToggle = document.createElement('button');
    menuToggle.className = 'mobile-menu-toggle';
    menuToggle.innerHTML = '☰';
    menuToggle.setAttribute('aria-label', '打开菜单');
    menuToggle.onclick = () => this.toggleMobileMenu();

    // 插入遮罩层
    const overlay = document.createElement('div');
    overlay.className = 'mobile-overlay';
    overlay.onclick = () => this.closeMobileMenu();

    // 插入侧边栏
    const layoutDiv = document.createElement('div');
    layoutDiv.className = 'admin-layout';
    layoutDiv.innerHTML = this.render();

    // 将页面内容包装到 admin-main 中
    const mainDiv = document.createElement('div');
    mainDiv.className = 'admin-main';

    // 移动 body 的所有子元素到 mainDiv
    while (document.body.firstChild) {
      mainDiv.appendChild(document.body.firstChild);
    }

    layoutDiv.appendChild(mainDiv);
    document.body.appendChild(menuToggle);
    document.body.appendChild(overlay);
    document.body.appendChild(layoutDiv);
  },

  toggleMobileMenu() {
    const sidebar = document.querySelector('.admin-sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const toggle = document.querySelector('.mobile-menu-toggle');

    if (sidebar && overlay && toggle) {
      const isOpen = sidebar.classList.contains('mobile-open');
      if (isOpen) {
        this.closeMobileMenu();
      } else {
        this.openMobileMenu();
      }
    }
  },

  openMobileMenu() {
    const sidebar = document.querySelector('.admin-sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const toggle = document.querySelector('.mobile-menu-toggle');

    if (sidebar && overlay && toggle) {
      sidebar.classList.add('mobile-open');
      overlay.classList.add('visible');
      toggle.innerHTML = '✕';
      toggle.setAttribute('aria-label', '关闭菜单');
      document.body.style.overflow = 'hidden'; // 防止背景滚动
    }
  },

  closeMobileMenu() {
    const sidebar = document.querySelector('.admin-sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const toggle = document.querySelector('.mobile-menu-toggle');

    if (sidebar && overlay && toggle) {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
      toggle.innerHTML = '☰';
      toggle.setAttribute('aria-label', '打开菜单');
      document.body.style.overflow = ''; // 恢复滚动
    }
  }
};

// ===== 顶部栏 =====
const AdminTopbar = {
  render(title) {
    return `
      <div class="admin-topbar">
        <h1 class="admin-topbar-title">${title}</h1>
        <div class="admin-topbar-actions">
          <button id="notification-bell" class="admin-btn admin-btn-secondary admin-btn-sm" onclick="AdminUtils.toggleNotificationPanel()" title="通知中心" style="position: relative;">
            🔔
          </button>
          <button class="admin-btn admin-btn-secondary admin-btn-sm" onclick="window.location.href='./index.html'">
            返回前台
          </button>
          <div class="admin-user-menu" onclick="AdminAuth.logout()">
            <div class="admin-user-avatar">👤</div>
            <span>退出登录</span>
          </div>
        </div>
      </div>
    `;
  },

  init(title = '管理后台') {
    const mainDiv = document.querySelector('.admin-main');
    if (mainDiv) {
      mainDiv.insertAdjacentHTML('afterbegin', this.render(title));

      // 初始化通知系统
      setTimeout(() => {
        AdminNotifications.init();
      }, 100);
    }
  }
};

// ===== 工具函数 =====
const AdminUtils = {
  formatDate(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays} 天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} 月前`;
    return `${Math.floor(diffDays / 365)} 年前`;
  },

  formatNumber(num) {
    if (typeof num !== 'number') return num;
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `admin-alert admin-alert-${type}`;
    toast.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; max-width: 400px; animation: slideIn 0.3s ease;';
    toast.innerHTML = `
      <span>${this.escapeHtml(message)}</span>
      <button onclick="this.parentElement.remove()" style="background: none; border: none; cursor: pointer; margin-left: auto; font-size: 1.25rem;">&times;</button>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  confirm(message) {
    return window.confirm(message);
  },

  // 骨架屏生成器
  createSkeletonStatCard() {
    return `
      <div class="skeleton-stat-card">
        <div class="skeleton-stat-header">
          <div class="skeleton skeleton-stat-label"></div>
          <div class="skeleton skeleton-stat-icon"></div>
        </div>
        <div class="skeleton skeleton-stat-value"></div>
        <div class="skeleton skeleton-stat-change"></div>
      </div>
    `;
  },

  createSkeletonChart() {
    return `<div class="skeleton skeleton-chart"></div>`;
  },

  createSkeletonActivityItem() {
    return `
      <div class="skeleton-activity-item">
        <div class="skeleton skeleton-avatar"></div>
        <div class="skeleton-activity-content">
          <div class="skeleton skeleton-activity-name"></div>
          <div class="skeleton skeleton-activity-time"></div>
        </div>
      </div>
    `;
  },

  createSkeletonActivities(count = 5) {
    return Array(count).fill(0).map(() => this.createSkeletonActivityItem()).join('');
  },

  // 数据导出功能
  exportToCSV(data, filename = 'export.csv', headers = null) {
    try {
      if (!data || data.length === 0) {
        this.showToast('没有数据可导出', 'warning');
        return;
      }

      // 使用提供的headers或从第一行数据提取
      const csvHeaders = headers || Object.keys(data[0]);

      // 生成CSV内容
      const csvContent = [
        csvHeaders.join(','), // 表头
        ...data.map(row =>
          csvHeaders.map(header => {
            const value = row[header] || '';
            // 处理包含逗号、引号或换行符的值
            if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          }).join(',')
        )
      ].join('\n');

      // 添加BOM以支持中文
      const BOM = '\uFEFF';
      const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

      this.downloadBlob(blob, filename);
      this.showToast('导出成功', 'success');
    } catch (error) {
      console.error('CSV导出失败:', error);
      this.showToast('导出失败: ' + error.message, 'error');
    }
  },

  exportToJSON(data, filename = 'export.json') {
    try {
      if (!data) {
        this.showToast('没有数据可导出', 'warning');
        return;
      }

      const jsonContent = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonContent], { type: 'application/json' });

      this.downloadBlob(blob, filename);
      this.showToast('导出成功', 'success');
    } catch (error) {
      console.error('JSON导出失败:', error);
      this.showToast('导出失败: ' + error.message, 'error');
    }
  },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // 通知系统
  createNotificationPanel() {
    const panel = document.createElement('div');
    panel.id = 'admin-notifications-panel';
    panel.style.cssText = `
      position: fixed;
      top: var(--topbar-height);
      right: 1rem;
      width: 350px;
      max-height: 500px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      display: none;
      flex-direction: column;
      z-index: 1000;
    `;
    panel.innerHTML = `
      <div style="padding: 1rem; border-bottom: 1px solid var(--gray-200); display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin: 0; font-size: 1rem;">🔔 通知中心</h3>
        <button onclick="AdminNotifications.clearAll()" style="background: none; border: none; color: var(--primary-color); cursor: pointer; font-size: 0.875rem;">清空</button>
      </div>
      <div id="notifications-list" style="flex: 1; overflow-y: auto; max-height: 400px;">
        <div style="padding: 2rem; text-align: center; color: var(--gray-500);">
          <div style="font-size: 3rem; margin-bottom: 0.5rem;">📭</div>
          <div>暂无通知</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    return panel;
  },

  // 显示/隐藏通知面板
  toggleNotificationPanel() {
    const panel = document.getElementById('admin-notifications-panel');
    if (panel.style.display === 'none' || !panel.style.display) {
      panel.style.display = 'flex';
    } else {
      panel.style.display = 'none';
    }
  }
};

// ===== 通知系统 =====
const AdminNotifications = {
  notifications: [],
  maxNotifications: 50,

  init() {
    // 创建通知面板
    AdminUtils.createNotificationPanel();

    // 加载历史通知
    this.loadFromStorage();

    // 定期检查新通知（可扩展）
    setInterval(() => this.checkNewNotifications(), 30000);
  },

  add(message, type = 'info', persistent = false) {
    const notification = {
      id: Date.now(),
      message,
      type,
      timestamp: new Date().toISOString(),
      read: false,
      persistent
    };

    this.notifications.unshift(notification);

    // 限制通知数量
    if (this.notifications.length > this.maxNotifications) {
      this.notifications = this.notifications.slice(0, this.maxNotifications);
    }

    this.saveToStorage();
    this.render();

    // 显示toast
    if (!persistent) {
      AdminUtils.showToast(message, type);
    }

    // 更新通知徽章
    this.updateBadge();
  },

  markAsRead(id) {
    const notification = this.notifications.find(n => n.id === id);
    if (notification) {
      notification.read = true;
      this.saveToStorage();
      this.render();
      this.updateBadge();
    }
  },

  markAllAsRead() {
    this.notifications.forEach(n => n.read = true);
    this.saveToStorage();
    this.render();
    this.updateBadge();
  },

  remove(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.saveToStorage();
    this.render();
    this.updateBadge();
  },

  clearAll() {
    if (confirm('确定要清空所有通知吗？')) {
      this.notifications = [];
      this.saveToStorage();
      this.render();
      this.updateBadge();
    }
  },

  render() {
    const listEl = document.getElementById('notifications-list');
    if (!listEl) return;

    if (this.notifications.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--gray-500);">
          <div style="font-size: 3rem; margin-bottom: 0.5rem;">📭</div>
          <div>暂无通知</div>
        </div>
      `;
      return;
    }

    const html = this.notifications.map(n => {
      const typeIcons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
      };
      const icon = typeIcons[n.type] || 'ℹ️';
      const readClass = n.read ? '' : 'font-weight: 600;';

      return `
        <div style="padding: 0.75rem 1rem; border-bottom: 1px solid var(--gray-100); ${readClass} ${n.read ? '' : 'background: #f0f9ff;'}" onclick="AdminNotifications.markAsRead(${n.id})">
          <div style="display: flex; align-items: flex-start; gap: 0.5rem;">
            <span style="font-size: 1.25rem;">${icon}</span>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 0.875rem; margin-bottom: 0.25rem;">${AdminUtils.escapeHtml(n.message)}</div>
              <div style="font-size: 0.75rem; color: var(--gray-500);">${AdminUtils.formatDate(n.timestamp)}</div>
            </div>
            <button onclick="event.stopPropagation(); AdminNotifications.remove(${n.id})" style="background: none; border: none; color: var(--gray-400); cursor: pointer; font-size: 1rem; padding: 0;">&times;</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = html;
  },

  updateBadge() {
    const unreadCount = this.notifications.filter(n => !n.read).length;
    let badge = document.getElementById('notification-badge');

    if (unreadCount > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'notification-badge';
        badge.style.cssText = `
          position: absolute;
          top: -4px;
          right: -4px;
          background: var(--danger-color);
          color: white;
          border-radius: 10px;
          padding: 2px 6px;
          font-size: 0.75rem;
          font-weight: 600;
          min-width: 18px;
          text-align: center;
        `;
        const bellButton = document.getElementById('notification-bell');
        if (bellButton) {
          bellButton.style.position = 'relative';
          bellButton.appendChild(badge);
        }
      }
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    } else if (badge) {
      badge.remove();
    }
  },

  checkNewNotifications() {
    // 这里可以实现定期检查新通知的逻辑
    // 例如：检查新的反馈、新的用户注册等
  },

  saveToStorage() {
    try {
      localStorage.setItem('admin_notifications', JSON.stringify(this.notifications));
    } catch (e) {
      console.error('保存通知失败:', e);
    }
  },

  loadFromStorage() {
    try {
      const stored = localStorage.getItem('admin_notifications');
      if (stored) {
        this.notifications = JSON.parse(stored);
        this.render();
        this.updateBadge();
      }
    } catch (e) {
      console.error('加载通知失败:', e);
    }
  }
};

// ===== 内容审核待办 =====
const AdminModeration = {
  summary: null,

  async refresh() {
    try {
      const data = await AdminAPI.get('/admin/video-share-requests/summary');
      this.summary = data && data.summary ? data.summary : null;
      this.render();
      return this.summary;
    } catch (_) {
      this.summary = null;
      this.render();
      return null;
    }
  },

  render() {
    const pending = Number(this.summary && this.summary.pending) || 0;
    const badge = document.getElementById('admin-video-review-badge');
    if (badge) {
      badge.textContent = pending > 99 ? '99+' : String(pending);
      badge.style.display = pending > 0 ? 'inline-flex' : 'none';
    }

    const bell = document.getElementById('notification-bell');
    if (bell) {
      const detail = pending > 0 ? `视频审核待处理：${pending}` : '通知中心';
      bell.setAttribute('title', detail);
    }

    const dashboardPending = document.getElementById('stat-video-review-pending');
    if (dashboardPending) {
      dashboardPending.textContent = String(pending);
    }
    const dashboardChange = document.getElementById('stat-video-review-change');
    if (dashboardChange) {
      const publicPending = Number(this.summary && this.summary.public_pending) || 0;
      const featuredPending = Number(this.summary && this.summary.featured_pending) || 0;
      dashboardChange.textContent = pending > 0
        ? `公开 ${publicPending} · 精选 ${featuredPending}`
        : '当前无待审';
      dashboardChange.className = pending > 0 ? 'admin-stat-change negative' : 'admin-stat-change positive';
    }
  }
};

// CSS动画
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);

// ===== 初始化函数 =====
function initAdminPage(pageTitle) {
  // 检查认证
  AdminAuth.checkAuth();

  // 初始化导航
  AdminNav.init();

  // 初始化顶部栏
  AdminTopbar.init(pageTitle);

  // 刷新内容审核待办数
  setTimeout(() => {
    AdminModeration.refresh();
  }, 150);
}
