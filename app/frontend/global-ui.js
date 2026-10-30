/**
 * Global UI Components
 * 统一加载指示器、错误处理、骨架屏、空状态组件
 * v2.0 - 统一加载系统
 */

(function() {
  'use strict';

  // =====================
  // 1. 统一加载指示器
  // =====================

  let loadingCount = 0;
  let loadingOverlay = null;
  let currentLoadingMode = 'default'; // 'default' | 'brand' | 'minimal'

  // 加载器配置
  const loadingConfig = {
    default: {
      background: 'rgba(255, 255, 255, 0.92)',
      backdrop: 'blur(8px)',
      spinnerBorder: '#e2e8f0',
      spinnerColor: '#0f766e',
      textColor: '#64748b',
      defaultText: '加载中....'
    },
    brand: {
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      backdrop: 'none',
      spinnerBorder: 'rgba(255, 255, 255, 0.3)',
      spinnerColor: '#ffffff',
      textColor: 'rgba(255, 255, 255, 0.95)',
      defaultText: 'Linglish'
    },
    minimal: {
      background: 'transparent',
      backdrop: 'none',
      spinnerBorder: '#e2e8f0',
      spinnerColor: '#0f766e',
      textColor: '#64748b',
      defaultText: ''
    }
  };

  function createLoadingOverlay() {
    if (loadingOverlay) return loadingOverlay;

    loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'global-loading-overlay';
    loadingOverlay.innerHTML = `
      <div class="global-loading-content">
        <div class="global-loading-spinner"></div>
        <div class="global-loading-text">加载中....</div>
      </div>
    `;

    // 添加动画和过渡样式
    const style = document.createElement('style');
    style.id = 'global-loading-styles';
    style.textContent = `
      @keyframes global-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes global-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.05); opacity: 0.8; }
      }
      #global-loading-overlay {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.3s ease, background 0.3s ease;
      }
      #global-loading-overlay.visible {
        display: flex !important;
        opacity: 1 !important;
      }
      #global-loading-overlay.hiding {
        opacity: 0 !important;
        pointer-events: none;
      }
      .global-loading-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        animation: global-pulse 2s ease-in-out infinite;
      }
      .global-loading-spinner {
        width: 44px;
        height: 44px;
        border: 3px solid;
        border-radius: 50%;
        animation: global-spin 0.8s linear infinite;
      }
      .global-loading-text {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      /* 品牌模式特殊样式 */
      #global-loading-overlay.brand-mode .global-loading-spinner {
        width: 50px;
        height: 50px;
      }
      #global-loading-overlay.brand-mode .global-loading-text {
        font-size: 1.3rem;
        font-weight: 700;
        letter-spacing: 1px;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(loadingOverlay);

    return loadingOverlay;
  }

  function applyLoadingStyle(mode) {
    const config = loadingConfig[mode] || loadingConfig.default;
    const overlay = loadingOverlay;
    if (!overlay) return;

    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: ${config.background};
      ${config.backdrop !== 'none' ? `backdrop-filter: ${config.backdrop}; -webkit-backdrop-filter: ${config.backdrop};` : ''}
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    const spinner = overlay.querySelector('.global-loading-spinner');
    if (spinner) {
      spinner.style.borderColor = config.spinnerBorder;
      spinner.style.borderTopColor = config.spinnerColor;
    }

    const text = overlay.querySelector('.global-loading-text');
    if (text) {
      text.style.color = config.textColor;
    }

    // 品牌模式添加特殊类
    overlay.classList.toggle('brand-mode', mode === 'brand');
    currentLoadingMode = mode;
  }

  /**
   * 显示加载指示器
   * @param {string|Object} options - 加载文本或配置对象
   * @param {string} options.text - 显示的文本
   * @param {string} options.mode - 加载模式: 'default' | 'brand' | 'minimal'
   */
  function showLoading(options) {
    loadingCount++;
    const overlay = createLoadingOverlay();

    let text = '加载中....';
    let mode = 'default';

    if (typeof options === 'string') {
      text = options;
    } else if (options && typeof options === 'object') {
      text = options.text || loadingConfig[options.mode]?.defaultText || '加载中....';
      mode = options.mode || 'default';
    }

    applyLoadingStyle(mode);

    const textEl = overlay.querySelector('.global-loading-text');
    if (textEl) {
      textEl.textContent = text;
      textEl.style.display = text ? 'block' : 'none';
    }

    overlay.classList.remove('hiding');
    overlay.classList.add('visible');
  }

  /**
   * 隐藏加载指示器
   * @param {Object} options - 配置选项
   * @param {boolean} options.immediate - 是否立即隐藏（无动画）
   * @param {Function} options.onHidden - 隐藏完成后的回调
   */
  function hideLoading(options = {}) {
    loadingCount = Math.max(0, loadingCount - 1);

    if (loadingCount === 0 && loadingOverlay) {
      if (options.immediate) {
        loadingOverlay.classList.remove('visible', 'hiding');
        resetLoadingState();
        if (options.onHidden) options.onHidden();
      } else {
        loadingOverlay.classList.add('hiding');
        setTimeout(() => {
          loadingOverlay.classList.remove('visible', 'hiding');
          resetLoadingState();
          if (options.onHidden) options.onHidden();
        }, 300);
      }
    }
  }

  function resetLoadingState() {
    if (!loadingOverlay) return;
    const textEl = loadingOverlay.querySelector('.global-loading-text');
    if (textEl) textEl.textContent = '加载中....';
    applyLoadingStyle('default');
  }

  function forceHideLoading() {
    loadingCount = 0;
    if (loadingOverlay) {
      loadingOverlay.classList.remove('visible', 'hiding');
      resetLoadingState();
    }
  }

  /**
   * 显示页面初始加载器（品牌模式）
   * 用于替代各页面独立的 page-loader
   */
  function showPageLoader(text) {
    showLoading({ text: text || 'Linglish', mode: 'brand' });
  }

  /**
   * 隐藏页面初始加载器
   * @param {number} delay - 延迟毫秒数
   * @param {Function} callback - 完成回调
   */
  function hidePageLoader(delay = 300, callback) {
    setTimeout(() => {
      hideLoading({ onHidden: callback });
    }, delay);
  }

  // =====================
  // 2. 错误提示模态框
  // =====================

  let errorModal = null;

  function createErrorModal() {
    if (errorModal) return errorModal;

    errorModal = document.createElement('div');
    errorModal.id = 'global-error-modal';
    errorModal.innerHTML = `
      <div class="error-modal-backdrop"></div>
      <div class="error-modal-content">
        <div class="error-modal-icon">⚠️</div>
        <h3 class="error-modal-title">出错了</h3>
        <p class="error-modal-message"></p>
        <div class="error-modal-countdown" style="display: none;"></div>
        <div class="error-modal-actions">
          <button class="error-modal-btn error-modal-btn-secondary" id="error-modal-cancel">取消</button>
          <button class="error-modal-btn error-modal-btn-primary" id="error-modal-action">确定</button>
        </div>
      </div>
    `;

    errorModal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10001;
    `;

    const backdrop = errorModal.querySelector('.error-modal-backdrop');
    backdrop.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
    `;

    const content = errorModal.querySelector('.error-modal-content');
    content.style.cssText = `
      position: relative;
      background: white;
      border-radius: 16px;
      padding: 32px;
      max-width: 400px;
      width: 90%;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15);
      animation: error-modal-in 0.3s ease;
    `;

    const icon = errorModal.querySelector('.error-modal-icon');
    icon.style.cssText = `
      font-size: 48px;
      margin-bottom: 16px;
    `;

    const title = errorModal.querySelector('.error-modal-title');
    title.style.cssText = `
      font-size: 20px;
      font-weight: 600;
      color: #1e293b;
      margin: 0 0 12px 0;
    `;

    const message = errorModal.querySelector('.error-modal-message');
    message.style.cssText = `
      font-size: 15px;
      color: #64748b;
      margin: 0 0 20px 0;
      line-height: 1.5;
    `;

    const countdown = errorModal.querySelector('.error-modal-countdown');
    countdown.style.cssText = `
      font-size: 14px;
      color: #f59e0b;
      margin-bottom: 16px;
      padding: 10px 16px;
      background: #fef3c7;
      border-radius: 8px;
    `;

    const actions = errorModal.querySelector('.error-modal-actions');
    actions.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: center;
    `;

    const btnBase = `
      padding: 12px 24px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      min-width: 100px;
    `;

    const cancelBtn = errorModal.querySelector('#error-modal-cancel');
    cancelBtn.style.cssText = btnBase + `
      background: #f1f5f9;
      color: #64748b;
    `;

    const actionBtn = errorModal.querySelector('#error-modal-action');
    actionBtn.style.cssText = btnBase + `
      background: linear-gradient(135deg, #0f766e, #f97316);
      color: white;
    `;

    // 添加动画样式
    const style = document.createElement('style');
    style.textContent = `
      @keyframes error-modal-in {
        from {
          opacity: 0;
          transform: scale(0.9) translateY(10px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
      #global-error-modal.visible {
        display: flex !important;
      }
      .error-modal-btn:hover {
        transform: translateY(-1px);
      }
      .error-modal-btn-primary:hover {
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
      }
      .error-modal-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(errorModal);

    return errorModal;
  }

  let countdownTimer = null;

  function showErrorModal(options) {
    const {
      icon = '⚠️',
      title = '出错了',
      message = '发生了一个错误',
      actionText = '确定',
      cancelText = '取消',
      showCancel = true,
      retryAfter = 0,
      onAction = null,
      onCancel = null
    } = options;

    const modal = createErrorModal();

    modal.querySelector('.error-modal-icon').textContent = icon;
    modal.querySelector('.error-modal-title').textContent = title;
    modal.querySelector('.error-modal-message').textContent = message;

    const actionBtn = modal.querySelector('#error-modal-action');
    const cancelBtn = modal.querySelector('#error-modal-cancel');
    const countdownEl = modal.querySelector('.error-modal-countdown');

    actionBtn.textContent = actionText;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? 'inline-block' : 'none';

    // 清除之前的倒计时
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    // 处理重试倒计时
    if (retryAfter > 0) {
      countdownEl.style.display = 'block';
      let remaining = retryAfter;
      actionBtn.disabled = true;

      const updateCountdown = () => {
        countdownEl.textContent = `请等待 ${remaining} 秒后重试`;
        if (remaining <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          countdownEl.style.display = 'none';
          actionBtn.disabled = false;
          actionBtn.textContent = '立即重试';
        }
        remaining--;
      };

      updateCountdown();
      countdownTimer = setInterval(updateCountdown, 1000);
    } else {
      countdownEl.style.display = 'none';
      actionBtn.disabled = false;
    }

    // 事件处理
    const cleanup = () => {
      modal.classList.remove('visible');
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };

    actionBtn.onclick = () => {
      cleanup();
      if (onAction) onAction();
    };

    cancelBtn.onclick = () => {
      cleanup();
      if (onCancel) onCancel();
    };

    modal.querySelector('.error-modal-backdrop').onclick = () => {
      cleanup();
      if (onCancel) onCancel();
    };

    modal.classList.add('visible');
  }

  function hideErrorModal() {
    if (errorModal) {
      errorModal.classList.remove('visible');
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // =====================
  // 3. 空状态组件
  // =====================

  function createEmptyState(options) {
    const {
      icon = '📭',
      title = '暂无内容',
      description = '',
      actionText = '',
      actionUrl = '',
      onAction = null
    } = options;

    const container = document.createElement('div');
    container.className = 'global-empty-state';
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
      min-height: 200px;
    `;

    let html = `
      <div class="empty-state-icon" style="font-size: 56px; margin-bottom: 16px; opacity: 0.8;">${icon}</div>
      <h3 class="empty-state-title" style="font-size: 18px; font-weight: 600; color: #334155; margin: 0 0 8px 0;">${title}</h3>
    `;

    if (description) {
      html += `<p class="empty-state-desc" style="font-size: 14px; color: #94a3b8; margin: 0 0 20px 0; max-width: 280px; line-height: 1.5;">${description}</p>`;
    }

    if (actionText) {
      if (actionUrl) {
        html += `<a href="${actionUrl}" class="empty-state-action" style="
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          background: linear-gradient(135deg, #0f766e, #f97316);
          color: white;
          text-decoration: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.2s ease;
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        ">${actionText}</a>`;
      } else {
        html += `<button class="empty-state-action" style="
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          background: linear-gradient(135deg, #0f766e, #f97316);
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        ">${actionText}</button>`;
      }
    }

    container.innerHTML = html;

    if (actionText && onAction && !actionUrl) {
      container.querySelector('.empty-state-action').onclick = onAction;
    }

    return container;
  }

  // 预定义的空状态配置
  const emptyStatePresets = {
    videos: {
      icon: '🎬',
      title: '还没有视频',
      description: '上传你的第一个视频，开启沉浸式学习之旅',
      actionText: '📤 上传视频',
      actionUrl: './upload-video.html'
    },
    vocabulary: {
      icon: '📚',
      title: '词汇表是空的',
      description: '看视频时点击单词添加到词汇表，开始积累你的词库吧',
      actionText: '🎬 去看视频',
      actionUrl: './mobile-explore.html'
    },
    search: {
      icon: '🔍',
      title: '没有找到结果',
      description: '试试其他关键词或调整筛选条件',
      actionText: '清除筛选',
    },
    network: {
      icon: '📡',
      title: '网络连接失败',
      description: '请检查网络连接后重试',
      actionText: '🔄 重新加载',
    },
    error: {
      icon: '😵',
      title: '加载失败',
      description: '出了一点问题，请稍后再试',
      actionText: '🔄 重试',
    }
  };

  function renderEmptyState(container, preset, overrides = {}) {
    const config = { ...(emptyStatePresets[preset] || emptyStatePresets.error), ...overrides };
    const emptyEl = createEmptyState(config);

    if (typeof container === 'string') {
      container = document.getElementById(container) || document.querySelector(container);
    }

    if (container) {
      container.innerHTML = '';
      container.appendChild(emptyEl);
    }

    return emptyEl;
  }

  // =====================
  // 4. Toast 通知增强
  // =====================

  let toastContainer = null;
  const toastQueue = [];
  const MAX_TOASTS = 3;

  function createToastContainer() {
    if (toastContainer) return toastContainer;

    toastContainer = document.createElement('div');
    toastContainer.id = 'global-toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10002;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 360px;
      pointer-events: none;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateX(100%);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      @keyframes toast-out {
        from {
          opacity: 1;
          transform: translateX(0);
        }
        to {
          opacity: 0;
          transform: translateX(100%);
        }
      }
      .global-toast {
        animation: toast-in 0.3s ease;
      }
      .global-toast.removing {
        animation: toast-out 0.3s ease forwards;
      }
      @media (max-width: 480px) {
        #global-toast-container {
          top: auto !important;
          bottom: 80px !important;
          left: 16px !important;
          right: 16px !important;
          max-width: none !important;
        }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toastContainer);

    return toastContainer;
  }

  function showToast(message, type = 'info', duration = 4000) {
    const container = createToastContainer();

    const colors = {
      success: { bg: '#ecfdf5', border: '#10b981', icon: '✅' },
      error: { bg: '#fef2f2', border: '#ef4444', icon: '❌' },
      warning: { bg: '#fffbeb', border: '#f59e0b', icon: '⚠️' },
      info: { bg: '#eff6ff', border: '#3b82f6', icon: 'ℹ️' }
    };

    const color = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.className = 'global-toast';
    toast.style.cssText = `
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      background: ${color.bg};
      border-left: 4px solid ${color.border};
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      pointer-events: auto;
    `;

    toast.innerHTML = `
      <span style="font-size: 18px; flex-shrink: 0;">${color.icon}</span>
      <span style="font-size: 14px; color: #334155; line-height: 1.4; flex: 1;">${message}</span>
      <button style="
        background: none;
        border: none;
        font-size: 18px;
        color: #94a3b8;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        flex-shrink: 0;
      ">×</button>
    `;

    const closeBtn = toast.querySelector('button');
    const removeToast = () => {
      toast.classList.add('removing');
      setTimeout(() => {
        toast.remove();
        const idx = toastQueue.indexOf(toast);
        if (idx > -1) toastQueue.splice(idx, 1);
      }, 300);
    };

    closeBtn.onclick = removeToast;

    // 限制最大数量
    while (toastQueue.length >= MAX_TOASTS) {
      const oldest = toastQueue.shift();
      oldest.remove();
    }

    toastQueue.push(toast);
    container.appendChild(toast);

    // 错误类型不自动关闭
    if (type !== 'error' && duration > 0) {
      setTimeout(removeToast, duration);
    }

    return toast;
  }

  // =====================
  // 5. 网络请求包装器
  // =====================

  const originalFetch = window.fetch;
  let autoLoading = false;

  function enableAutoLoading(enable = true) {
    autoLoading = enable;
  }

  // 包装 fetch 以自动显示加载状态
  function wrapFetch() {
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

      // 排除一些不需要显示 loading 的请求
      const skipLoading =
        url.includes('/events') ||
        url.includes('/heartbeat') ||
        url.includes('.css') ||
        url.includes('.js') ||
        url.includes('.png') ||
        url.includes('.jpg');

      if (autoLoading && !skipLoading) {
        showLoading();
      }

      try {
        const response = await originalFetch.apply(this, args);
        return response;
      } finally {
        if (autoLoading && !skipLoading) {
          hideLoading();
        }
      }
    };
  }

  // 处理 401 错误的增强版本
  function handleAuthError(message) {
    forceHideLoading();
    showErrorModal({
      icon: '🔒',
      title: '登录已过期',
      message: message || '您的登录状态已过期，请重新登录',
      actionText: '去登录',
      showCancel: false,
      onAction: () => {
        try {
          localStorage.removeItem('linglish_token');
          sessionStorage.removeItem('linglish_token');
        } catch(_) {}
        window.location.href = './index.html';
      }
    });
  }

  // 处理 429 错误的增强版本
  function handleRateLimitError(retryAfter, onRetry) {
    forceHideLoading();
    showErrorModal({
      icon: '⏳',
      title: '请求过于频繁',
      message: '请稍后再试',
      actionText: '等待中...',
      retryAfter: retryAfter || 30,
      showCancel: true,
      cancelText: '取消',
      onAction: onRetry,
      onCancel: () => {}
    });
  }

  // 处理网络错误
  function handleNetworkError(onRetry) {
    forceHideLoading();
    showErrorModal({
      icon: '📡',
      title: '网络连接失败',
      message: '请检查您的网络连接后重试',
      actionText: '重试',
      showCancel: true,
      onAction: onRetry,
      onCancel: () => {}
    });
  }

  // =====================
  // 6. 骨架屏组件
  // =====================

  let skeletonStyles = null;

  function createSkeletonStyles() {
    if (skeletonStyles) return;

    skeletonStyles = document.createElement('style');
    skeletonStyles.id = 'global-skeleton-styles';
    skeletonStyles.textContent = `
      @keyframes skeleton-shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      .skeleton {
        background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
        background-size: 200% 100%;
        animation: skeleton-shimmer 1.5s ease-in-out infinite;
        border-radius: 6px;
      }
      .skeleton-text {
        height: 14px;
        margin-bottom: 8px;
      }
      .skeleton-text.short { width: 60%; }
      .skeleton-text.medium { width: 80%; }
      .skeleton-text.long { width: 100%; }
      .skeleton-title {
        height: 20px;
        width: 70%;
        margin-bottom: 12px;
      }
      .skeleton-avatar {
        width: 48px;
        height: 48px;
        border-radius: 50%;
      }
      .skeleton-image {
        width: 100%;
        aspect-ratio: 16/9;
        border-radius: 8px;
      }
      .skeleton-card {
        background: white;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
      .skeleton-row {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .skeleton-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }
    `;
    document.head.appendChild(skeletonStyles);
  }

  /**
   * 创建骨架屏元素
   * @param {string} type - 骨架屏类型: 'card' | 'list' | 'text' | 'custom'
   * @param {Object} options - 配置选项
   * @returns {HTMLElement} 骨架屏元素
   */
  function createSkeleton(type = 'card', options = {}) {
    createSkeletonStyles();

    const { count = 1, lines = 3 } = options;
    const container = document.createElement('div');

    if (type === 'card') {
      container.className = 'skeleton-grid';
      for (let i = 0; i < count; i++) {
        container.innerHTML += `
          <div class="skeleton-card">
            <div class="skeleton skeleton-image"></div>
            <div style="margin-top: 12px;">
              <div class="skeleton skeleton-title"></div>
              <div class="skeleton skeleton-text medium"></div>
              <div class="skeleton skeleton-text short"></div>
            </div>
          </div>
        `;
      }
    } else if (type === 'list') {
      for (let i = 0; i < count; i++) {
        container.innerHTML += `
          <div class="skeleton-card skeleton-row" style="margin-bottom: 12px;">
            <div class="skeleton skeleton-avatar"></div>
            <div style="flex: 1;">
              <div class="skeleton skeleton-text medium"></div>
              <div class="skeleton skeleton-text short"></div>
            </div>
          </div>
        `;
      }
    } else if (type === 'text') {
      container.className = 'skeleton-card';
      for (let i = 0; i < lines; i++) {
        const width = i === 0 ? 'long' : (i === lines - 1 ? 'short' : 'medium');
        container.innerHTML += `<div class="skeleton skeleton-text ${width}"></div>`;
      }
    }

    return container;
  }

  /**
   * 在容器中显示骨架屏
   * @param {HTMLElement|string} container - 容器元素或选择器
   * @param {string} type - 骨架屏类型
   * @param {Object} options - 配置选项
   */
  function showSkeleton(container, type = 'card', options = {}) {
    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (!container) return;

    const skeleton = createSkeleton(type, options);
    skeleton.className += ' global-skeleton-placeholder';
    container.innerHTML = '';
    container.appendChild(skeleton);
  }

  /**
   * 移除容器中的骨架屏
   * @param {HTMLElement|string} container - 容器元素或选择器
   */
  function hideSkeleton(container) {
    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (!container) return;

    const skeleton = container.querySelector('.global-skeleton-placeholder');
    if (skeleton) skeleton.remove();
  }

  // =====================
  // 7. 通用错误显示（替代 alert）
  // =====================

  /**
   * 显示简单的错误/成功/警告提示
   * 用于替代 alert()，提供更好的用户体验
   * @param {string} message - 消息内容
   * @param {Object} options - 配置选项
   */
  function showMessage(message, options = {}) {
    const {
      type = 'info', // 'success' | 'error' | 'warning' | 'info'
      title = '',
      duration = 0, // 0 表示需要手动关闭
      showClose = true
    } = options;

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const titles = {
      success: '成功',
      error: '错误',
      warning: '注意',
      info: '提示'
    };

    // 如果消息很短，使用 Toast
    if (message.length < 50 && duration !== 0) {
      return showToast(message, type, duration || 4000);
    }

    // 否则使用模态框
    showErrorModal({
      icon: icons[type] || icons.info,
      title: title || titles[type] || titles.info,
      message: message,
      actionText: '确定',
      showCancel: false
    });
  }

  // =====================
  // 8. 邮箱验证提醒
  // =====================

  const EMAIL_VERIFY_BANNER_ID = 'll-email-verify-banner';
  const EMAIL_VERIFY_STYLE_ID = 'll-email-verify-banner-style';
  const EMAIL_VERIFY_DISMISSED_UNTIL_KEY = 'linglish_email_verify_banner_dismissed_until';
  const EMAIL_VERIFY_DISMISS_MS = 24 * 60 * 60 * 1000;

  function readStoredValue(storage, key) {
    try {
      return storage && storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeStoredValue(storage, key, value) {
    try {
      if (storage) storage.setItem(key, value);
    } catch (_) { }
  }

  function readAuthToken() {
    const keys = ['linglish_token', 'authToken', 'token'];
    for (const key of keys) {
      const localValue = readStoredValue(localStorage, key);
      if (localValue && localValue !== 'null' && localValue !== 'undefined') return localValue;
      const sessionValue = readStoredValue(sessionStorage, key);
      if (sessionValue && sessionValue !== 'null' && sessionValue !== 'undefined') return sessionValue;
    }
    return null;
  }

  function shouldSkipEmailVerifyBanner() {
    if (window.__disableEmailVerificationBanner) return true;
    const path = String(window.location && window.location.pathname || '').toLowerCase();
    return [
      'desktop-auth.html',
      'mobile-auth.html',
      'reset-password.html',
      'verify-email.html',
      'privacy.html',
      'terms.html',
      'admin-'
    ].some((part) => path.includes(part));
  }

  function isEmailVerifyDismissed() {
    const raw = readStoredValue(localStorage, EMAIL_VERIFY_DISMISSED_UNTIL_KEY);
    const dismissedUntil = Number(raw || 0);
    return Number.isFinite(dismissedUntil) && dismissedUntil > Date.now();
  }

  function isDeliverableUserEmail(email) {
    const value = String(email || '').trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
      && !/\.local$/i.test(value)
      && !/^guest_[a-z0-9]+@temp\.linglish\.local$/i.test(value);
  }

  function trackEmailVerifyBanner(eventName, properties = {}, token = readAuthToken()) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      fetch('/track/event', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event_name: eventName,
          properties: {
            source: 'global_email_verify_banner',
            page: window.location && window.location.pathname || '',
            ...properties
          }
        })
      }).catch(() => {});
    } catch (_) { }
  }

  function createEmailVerifyBannerStyles() {
    if (document.getElementById(EMAIL_VERIFY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = EMAIL_VERIFY_STYLE_ID;
    style.textContent = `
      #${EMAIL_VERIFY_BANNER_ID} {
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) + 12px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 10002;
        width: min(720px, calc(100vw - 28px));
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 14px;
        background: #fff7ed;
        border: 1px solid #fed7aa;
        border-radius: 10px;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
        color: #334155;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-mark {
        width: 10px;
        height: 36px;
        border-radius: 999px;
        background: #f97316;
        flex: 0 0 auto;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-copy {
        min-width: 0;
        flex: 1;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-title {
        margin: 0 0 2px;
        font-size: 14px;
        line-height: 1.35;
        font-weight: 700;
        color: #1f2937;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-desc {
        margin: 0;
        font-size: 13px;
        line-height: 1.45;
        color: #64748b;
        overflow-wrap: anywhere;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
      }
      #${EMAIL_VERIFY_BANNER_ID} button,
      #${EMAIL_VERIFY_BANNER_ID} a {
        appearance: none;
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-resend {
        padding: 9px 12px;
        background: #0f766e;
        color: #ffffff;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-page {
        padding: 9px 10px;
        background: #ffffff;
        color: #0f766e;
        border: 1px solid #99f6e4;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-close {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: #64748b;
        font-size: 20px;
      }
      #${EMAIL_VERIFY_BANNER_ID} .email-verify-close:hover {
        background: rgba(15, 23, 42, 0.06);
      }
      @media (max-width: 640px) {
        #${EMAIL_VERIFY_BANNER_ID} {
          top: calc(env(safe-area-inset-top, 0px) + 8px);
          align-items: flex-start;
          gap: 10px;
          padding: 11px;
        }
        #${EMAIL_VERIFY_BANNER_ID} .email-verify-actions {
          flex-direction: column;
          align-items: stretch;
        }
        #${EMAIL_VERIFY_BANNER_ID} .email-verify-resend,
        #${EMAIL_VERIFY_BANNER_ID} .email-verify-page {
          padding: 9px 10px;
          text-align: center;
        }
      }
    `;
    document.head.appendChild(style);
  }

  async function resendEmailVerificationFromBanner(token, button) {
    if (!token || !button) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '发送中';
    trackEmailVerifyBanner('auth_email_verify_banner_resend', {}, token);

    try {
      const res = await fetch('/auth/email-verification/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || 'EMAIL_VERIFY_RESEND_FAILED');

      if (data.already_verified) {
        removeEmailVerificationBanner();
        showToast('邮箱已验证', 'success');
        return;
      }
      const msg = data.delivery_configured
        ? '验证邮件已发送，请查收'
        : `请联系 ${data.support_email || 'support'} 完成验证`;
      showToast(msg, data.delivery_configured ? 'success' : 'warning');
    } catch (err) {
      showToast('发送失败，请稍后再试', 'error');
    } finally {
      if (document.body.contains(button)) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function removeEmailVerificationBanner() {
    const banner = document.getElementById(EMAIL_VERIFY_BANNER_ID);
    if (banner) banner.remove();
  }

  function renderEmailVerificationBanner(user, token) {
    if (!user || !token || document.getElementById(EMAIL_VERIFY_BANNER_ID)) return;
    createEmailVerifyBannerStyles();

    const banner = document.createElement('div');
    banner.id = EMAIL_VERIFY_BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');

    const mark = document.createElement('div');
    mark.className = 'email-verify-mark';
    mark.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    copy.className = 'email-verify-copy';
    const title = document.createElement('p');
    title.className = 'email-verify-title';
    title.textContent = '验证邮箱，保护账号和学习数据';
    const desc = document.createElement('p');
    desc.className = 'email-verify-desc';
    desc.textContent = `当前邮箱 ${user.email} 尚未验证。`;
    copy.appendChild(title);
    copy.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'email-verify-actions';
    const resendBtn = document.createElement('button');
    resendBtn.type = 'button';
    resendBtn.className = 'email-verify-resend';
    resendBtn.textContent = '重发邮件';
    resendBtn.addEventListener('click', () => resendEmailVerificationFromBanner(token, resendBtn));

    const pageLink = document.createElement('a');
    pageLink.className = 'email-verify-page';
    pageLink.href = './verify-email.html';
    pageLink.textContent = '验证入口';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'email-verify-close';
    closeBtn.setAttribute('aria-label', '暂时关闭邮箱验证提醒');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      writeStoredValue(localStorage, EMAIL_VERIFY_DISMISSED_UNTIL_KEY, String(Date.now() + EMAIL_VERIFY_DISMISS_MS));
      trackEmailVerifyBanner('auth_email_verify_banner_dismiss', {}, token);
      removeEmailVerificationBanner();
    });

    actions.appendChild(resendBtn);
    actions.appendChild(pageLink);
    actions.appendChild(closeBtn);
    banner.appendChild(mark);
    banner.appendChild(copy);
    banner.appendChild(actions);
    document.body.appendChild(banner);
    trackEmailVerifyBanner('auth_email_verify_banner_view', {}, token);
  }

  async function checkEmailVerificationBanner() {
    if (window.__email_verification_banner_checked__) return;
    window.__email_verification_banner_checked__ = true;
    if (shouldSkipEmailVerifyBanner() || isEmailVerifyDismissed()) return;

    const token = readAuthToken();
    if (!token) return;

    try {
      const res = await fetch('/users/me', {
        headers: { 'Authorization': 'Bearer ' + token },
        cache: 'no-store'
      });
      if (!res.ok) return;
      const user = await res.json();
      if (!user || user.email_verified === true || !isDeliverableUserEmail(user.email)) return;
      // Root fix: if the server has no email delivery configured, verification email can
      // never be sent — the "resend" button would be a dead end. Suppress the banner
      // entirely in that case (verification currently gates no functionality). The moment
      // SMTP is configured server-side, email_delivery_configured flips true and the banner
      // returns automatically with a working resend flow.
      if (user.email_delivery_configured === false) return;
      renderEmailVerificationBanner(user, token);
    } catch (_) { }
  }

  function scheduleEmailVerificationBannerCheck() {
    const run = () => setTimeout(checkEmailVerificationBanner, 700);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  }

  // =====================
  // 暴露到全局
  // =====================

  window.GlobalUI = {
    // 加载状态
    showLoading,
    hideLoading,
    forceHideLoading,
    enableAutoLoading,
    showPageLoader,
    hidePageLoader,

    // 错误模态框
    showErrorModal,
    hideErrorModal,
    handleAuthError,
    handleRateLimitError,
    handleNetworkError,

    // 通用消息
    showMessage,

    // 邮箱验证提醒
    checkEmailVerificationBanner,
    hideEmailVerificationBanner: removeEmailVerificationBanner,

    // 空状态
    createEmptyState,
    renderEmptyState,
    emptyStatePresets,

    // 骨架屏
    createSkeleton,
    showSkeleton,
    hideSkeleton,

    // Toast
    showToast,

    // 初始化
    init: function(options = {}) {
      if (options.autoLoading) {
        enableAutoLoading(true);
        wrapFetch();
      }
      // 预创建组件
      createLoadingOverlay();
      createErrorModal();
      createToastContainer();
      createSkeletonStyles();
      checkEmailVerificationBanner();

      // 如果指定了品牌加载模式，显示页面加载器
      if (options.pageLoader) {
        showPageLoader(options.pageLoaderText);
      }
    }
  };

  // DOM ready 时自动创建容器
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createLoadingOverlay();
      createToastContainer();
    });
  }

  scheduleEmailVerificationBannerCheck();

})();
