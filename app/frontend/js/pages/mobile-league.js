/**
 * Mobile League Page
 * 移动端联赛页面
 *
 * 功能：
 * 1. 显示当前段位和排名
 * 2. 段位排行榜
 * 3. 晋级/降级区域可视化
 * 4. 赛季倒计时
 * 5. 奖励预览
 */

class MobileLeaguePage {
  constructor() {
    this.leagueStatus = null;
    this.leaderboard = null;
    this.tiers = [];
    this.isLoading = false;
    this.refreshInterval = null;
  }

  /**
   * 初始化页面
   */
  async init() {
    console.log('[MobileLeague] Initializing...');

    await this.loadTiers();
    await this.loadLeagueStatus();
    await this.loadLeaderboard();

    this.render();
    this.startAutoRefresh();
    this.startCountdown();

    console.log('[MobileLeague] Initialized');
  }

  /**
   * 销毁页面
   */
  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  /**
   * 加载所有段位信息
   */
  async loadTiers() {
    try {
      const response = await this.fetchWithAuth('/api/league/tiers');
      if (response) {
        this.tiers = response;
      }
    } catch (error) {
      console.error('[MobileLeague] Error loading tiers:', error);
    }
  }

  /**
   * 加载用户联赛状态
   */
  async loadLeagueStatus() {
    try {
      this.isLoading = true;
      const response = await this.fetchWithAuth('/api/league/status');
      if (response) {
        this.leagueStatus = response;
      }
    } catch (error) {
      console.error('[MobileLeague] Error loading league status:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 加载排行榜
   */
  async loadLeaderboard() {
    try {
      const response = await this.fetchWithAuth('/api/league/leaderboard?limit=50');
      if (response) {
        this.leaderboard = response;
      }
    } catch (error) {
      console.error('[MobileLeague] Error loading leaderboard:', error);
    }
  }

  /**
   * 带认证的请求
   */
  async fetchWithAuth(url) {
    const token = localStorage.getItem('linglish_token');
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  /**
   * 渲染页面
   */
  render() {
    const container = document.getElementById('league-container');
    if (!container) return;

    if (this.isLoading) {
      container.innerHTML = this.renderLoading();
      return;
    }

    if (!this.leagueStatus) {
      container.innerHTML = this.renderNotJoined();
      return;
    }

    container.innerHTML = `
      ${this.renderHeader()}
      ${this.renderProgressBar()}
      ${this.renderCountdown()}
      ${this.renderLeaderboard()}
      ${this.renderRewardsPreview()}
    `;

    this.attachEventListeners();
  }

  /**
   * 渲染加载状态
   */
  renderLoading() {
    return `
      <div class="league-loading">
        <div class="loading-spinner"></div>
        <p>加载中....</p>
      </div>
    `;
  }

  /**
   * 渲染未加入状态
   */
  renderNotJoined() {
    return `
      <div class="league-not-joined">
        <div class="not-joined-icon">🏆</div>
        <h2>加入联赛</h2>
        <p>与全球学习者一起竞争，争夺段位荣耀！</p>
        <button class="btn-join-league" onclick="mobileLeague.joinLeague()">
          立即加入
        </button>
      </div>
    `;
  }

  /**
   * 渲染顶部段位信息
   */
  renderHeader() {
    const status = this.leagueStatus;
    const tier = status.tier;

    return `
      <div class="league-header" style="background: linear-gradient(135deg, ${tier.colorCode}20, ${tier.colorCode}40)">
        <div class="tier-badge-large">
          <img src="/assets/badges/${tier.key}.svg" alt="${tier.name}" onerror="this.src='/assets/badges/default.svg'">
        </div>
        <div class="tier-info">
          <h2 class="tier-name" style="color: ${tier.colorCode}">${tier.name}</h2>
          <p class="tier-name-en">${tier.nameEn}</p>
        </div>
        <div class="rank-info">
          <div class="current-rank">
            <span class="rank-label">当前排名</span>
            <span class="rank-value">#${status.currentRank || '-'}</span>
          </div>
          <div class="weekly-xp">
            <span class="xp-label">本周XP</span>
            <span class="xp-value">${this.formatNumber(status.weeklyXp)}</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 渲染晋级/降级进度条
   */
  renderProgressBar() {
    const status = this.leagueStatus;
    if (!this.leaderboard) return '';

    const totalUsers = status.groupSize || 50;
    const promotionLine = status.promotionSlots || 10;
    const demotionLine = totalUsers - (status.demotionSlots || 10);
    const currentRank = status.currentRank || totalUsers;

    // 计算百分比
    const promotionPercent = (promotionLine / totalUsers) * 100;
    const demotionPercent = ((totalUsers - demotionLine) / totalUsers) * 100;
    const currentPercent = ((currentRank - 1) / (totalUsers - 1)) * 100;

    // 确定当前区域
    let zone = 'safe';
    let zoneText = '安全区';
    let zoneColor = '#6b7280';

    if (currentRank <= promotionLine) {
      zone = 'promotion';
      zoneText = '晋级区';
      zoneColor = '#10b981';
    } else if (currentRank > demotionLine) {
      zone = 'demotion';
      zoneText = '降级区';
      zoneColor = '#ef4444';
    }

    return `
      <div class="league-progress-section">
        <div class="progress-header">
          <span class="zone-badge" style="background: ${zoneColor}">${zoneText}</span>
          <span class="group-info">第${status.groupId}组 · ${totalUsers}人</span>
        </div>

        <div class="league-progress-bar">
          <div class="progress-zone promotion-zone" style="width: ${promotionPercent}%">
            <span class="zone-label">晋级</span>
          </div>
          <div class="progress-zone safe-zone" style="width: ${100 - promotionPercent - demotionPercent}%">
            <span class="zone-label">安全</span>
          </div>
          <div class="progress-zone demotion-zone" style="width: ${demotionPercent}%">
            <span class="zone-label">降级</span>
          </div>
          <div class="progress-marker" style="left: ${currentPercent}%">
            <div class="marker-dot"></div>
            <span class="marker-rank">#${currentRank}</span>
          </div>
        </div>

        <div class="progress-legend">
          <div class="legend-item">
            <span class="legend-dot promotion"></span>
            <span>前${promotionLine}名晋级</span>
          </div>
          <div class="legend-item">
            <span class="legend-dot demotion"></span>
            <span>后${status.demotionSlots || 10}名降级</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 渲染赛季倒计时
   */
  renderCountdown() {
    const status = this.leagueStatus;
    if (!status.seasonEndsAt) return '';

    return `
      <div class="season-countdown">
        <div class="countdown-icon">⏱️</div>
        <div class="countdown-text">
          <span class="countdown-label">赛季结束</span>
          <span class="countdown-time" id="season-countdown">计算中...</span>
        </div>
      </div>
    `;
  }

  /**
   * 渲染排行榜
   */
  renderLeaderboard() {
    if (!this.leaderboard || !this.leaderboard.leaderboard) {
      return '<div class="league-leaderboard-empty">暂无排行数据</div>';
    }

    const users = this.leaderboard.leaderboard;
    const promotionLine = this.leaderboard.promotionLine || 10;
    const demotionLine = this.leaderboard.demotionLine || 40;

    return `
      <div class="league-leaderboard">
        <div class="leaderboard-header">
          <h3>本周排行榜</h3>
          <button class="btn-refresh" onclick="mobileLeague.refresh()">
            刷新
          </button>
        </div>
        <div class="leaderboard-list">
          ${users.map((user, index) => this.renderLeaderboardItem(user, index, promotionLine, demotionLine)).join('')}
        </div>
      </div>
    `;
  }

  /**
   * 渲染排行榜项
   */
  renderLeaderboardItem(user, index, promotionLine, demotionLine) {
    const rank = user.rank;
    let zoneClass = 'safe';

    if (rank <= promotionLine) {
      zoneClass = 'promotion';
    } else if (rank > demotionLine) {
      zoneClass = 'demotion';
    }

    const isCurrentUser = user.isCurrentUser;
    const rankIcon = this.getRankIcon(rank);

    return `
      <div class="leaderboard-item ${zoneClass} ${isCurrentUser ? 'current-user' : ''}">
        <div class="item-rank">
          ${rankIcon ? `<span class="rank-icon">${rankIcon}</span>` : `<span class="rank-number">${rank}</span>`}
        </div>
        <div class="item-avatar">
          <div class="avatar-placeholder">${user.username.charAt(0).toUpperCase()}</div>
        </div>
        <div class="item-info">
          <span class="item-username">${user.username}</span>
          <span class="item-level">Lv.${user.level || 1}</span>
        </div>
        <div class="item-xp">
          <span class="xp-value">${this.formatNumber(user.weeklyXp)}</span>
          <span class="xp-label">XP</span>
        </div>
      </div>
    `;
  }

  /**
   * 获取排名图标
   */
  getRankIcon(rank) {
    switch (rank) {
      case 1: return '🥇';
      case 2: return '🥈';
      case 3: return '🥉';
      default: return null;
    }
  }

  /**
   * 渲染奖励预览
   */
  renderRewardsPreview() {
    const status = this.leagueStatus;
    const tier = status.tier;

    // 查找下一个段位
    const nextTier = status.nextTier;

    return `
      <div class="rewards-preview">
        <h3>赛季奖励</h3>
        <div class="rewards-grid">
          <div class="reward-card current">
            <div class="reward-tier-badge" style="background: ${tier.colorCode}">
              ${tier.name}
            </div>
            <div class="reward-items">
              <div class="reward-item">
                <span class="reward-icon">✨</span>
                <span class="reward-amount">+${this.getTierRewardXP(tier.key)} XP</span>
              </div>
              <div class="reward-item">
                <span class="reward-icon">🪙</span>
                <span class="reward-amount">+${this.getTierRewardCoins(tier.key)}</span>
              </div>
            </div>
            <span class="reward-label">保持段位奖励</span>
          </div>

          ${nextTier ? `
            <div class="reward-card promotion">
              <div class="reward-tier-badge" style="background: ${nextTier.colorCode || '#9B30FF'}">
                ${nextTier.tier_name || nextTier.name}
              </div>
              <div class="reward-items">
                <div class="reward-item">
                  <span class="reward-icon">✨</span>
                  <span class="reward-amount">+${this.getTierRewardXP(nextTier.tier_key || nextTier.key)} XP</span>
                </div>
                <div class="reward-item">
                  <span class="reward-icon">💎</span>
                  <span class="reward-amount">+${this.getTierRewardGems(nextTier.tier_key || nextTier.key)}</span>
                </div>
              </div>
              <span class="reward-label">晋级奖励</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * 获取段位XP奖励
   */
  getTierRewardXP(tierKey) {
    const rewards = {
      'bronze': 100,
      'silver': 200,
      'gold': 400,
      'diamond': 800,
      'master': 1500
    };
    return rewards[tierKey] || 100;
  }

  /**
   * 获取段位金币奖励
   */
  getTierRewardCoins(tierKey) {
    const rewards = {
      'bronze': 50,
      'silver': 100,
      'gold': 200,
      'diamond': 400,
      'master': 800
    };
    return rewards[tierKey] || 50;
  }

  /**
   * 获取段位宝石奖励
   */
  getTierRewardGems(tierKey) {
    const rewards = {
      'bronze': 0,
      'silver': 5,
      'gold': 10,
      'diamond': 20,
      'master': 50
    };
    return rewards[tierKey] || 0;
  }

  /**
   * 加入联赛
   */
  async joinLeague() {
    try {
      await this.loadLeagueStatus();
      this.render();
    } catch (error) {
      console.error('[MobileLeague] Error joining league:', error);
      alert('加入联赛失败，请稍后重试');
    }
  }

  /**
   * 刷新数据
   */
  async refresh() {
    await this.loadLeagueStatus();
    await this.loadLeaderboard();
    this.render();
  }

  /**
   * 启动自动刷新
   */
  startAutoRefresh() {
    // 每60秒刷新一次
    this.refreshInterval = setInterval(() => {
      this.refresh();
    }, 60000);
  }

  /**
   * 启动倒计时
   */
  startCountdown() {
    this.updateCountdown();
    this.countdownInterval = setInterval(() => {
      this.updateCountdown();
    }, 1000);
  }

  /**
   * 更新倒计时显示
   */
  updateCountdown() {
    if (!this.leagueStatus || !this.leagueStatus.seasonEndsAt) return;

    const countdownEl = document.getElementById('season-countdown');
    if (!countdownEl) return;

    const now = new Date().getTime();
    const endTime = new Date(this.leagueStatus.seasonEndsAt).getTime();
    const distance = endTime - now;

    if (distance < 0) {
      countdownEl.textContent = '赛季已结束';
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    if (days > 0) {
      countdownEl.textContent = `${days}天 ${hours}小时`;
    } else if (hours > 0) {
      countdownEl.textContent = `${hours}小时 ${minutes}分钟`;
    } else {
      countdownEl.textContent = `${minutes}分 ${seconds}秒`;
    }
  }

  /**
   * 格式化数字
   */
  formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  /**
   * 绑定事件监听器
   */
  attachEventListeners() {
    // 可以添加更多交互事件
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.mobileLeague = new MobileLeaguePage();

  // 页面加载时初始化
  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('league-container')) {
      window.mobileLeague.init();
    }
  });
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MobileLeaguePage;
}
