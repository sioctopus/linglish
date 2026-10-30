/**
 * Goals Widget
 * 目标进度小组件
 *
 * 用于在练习页面显示当前目标进度
 */

class GoalsWidget {
  constructor(options = {}) {
    this.container = options.container || null;
    this.token = options.token || localStorage.getItem('linglish_token');
    this.onGoalCompleted = options.onGoalCompleted || null;
    this.goals = [];
    this.initialized = false;
  }

  /**
   * 初始化组件
   */
  async init() {
    if (!this.container) {
      console.warn('[GoalsWidget] No container specified');
      return;
    }

    this.render();
    await this.loadGoals();
    this.initialized = true;
  }

  /**
   * 渲染基础结构
   */
  render() {
    this.container.innerHTML = `
      <div class="goals-widget">
        <div class="goals-widget-header">
          <span class="goals-widget-icon">🎯</span>
          <span class="goals-widget-title">本周目标</span>
        </div>
        <div class="goals-widget-content" id="goals-widget-content">
          <div class="goals-widget-loading">加载中....</div>
        </div>
      </div>
    `;

    // 添加样式
    if (!document.getElementById('goals-widget-styles')) {
      const style = document.createElement('style');
      style.id = 'goals-widget-styles';
      style.textContent = `
        .goals-widget {
          background: white;
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .goals-widget-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .goals-widget-icon {
          font-size: 18px;
        }

        .goals-widget-title {
          font-weight: bold;
          color: #333;
          font-size: 14px;
        }

        .goals-widget-content {
          min-height: 60px;
        }

        .goals-widget-loading {
          color: #999;
          font-size: 14px;
          text-align: center;
          padding: 20px;
        }

        .goals-widget-empty {
          color: #999;
          font-size: 12px;
          text-align: center;
          padding: 16px;
        }

        .goals-widget-empty a {
          color: #667eea;
          text-decoration: none;
        }

        .goal-mini-card {
          background: #f8f9fa;
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 8px;
        }

        .goal-mini-card:last-child {
          margin-bottom: 0;
        }

        .goal-mini-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .goal-mini-title {
          font-size: 13px;
          font-weight: bold;
          color: #333;
        }

        .goal-mini-percent {
          font-size: 12px;
          color: #667eea;
          font-weight: bold;
        }

        .goal-mini-progress {
          height: 6px;
          background: #e5e7eb;
          border-radius: 3px;
          overflow: hidden;
        }

        .goal-mini-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
          border-radius: 3px;
          transition: width 0.5s ease;
        }

        .goal-mini-progress-bar.completed {
          background: linear-gradient(90deg, #10b981 0%, #059669 100%);
        }

        .goal-mini-reward {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          font-size: 11px;
          color: #666;
        }

        .goal-completed-banner {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          padding: 12px;
          border-radius: 8px;
          text-align: center;
          margin-bottom: 8px;
          animation: goalPulse 0.5s ease;
        }

        .goal-completed-banner .banner-icon {
          font-size: 24px;
          display: block;
          margin-bottom: 4px;
        }

        .goal-completed-banner .banner-text {
          font-weight: bold;
          font-size: 14px;
        }

        .goal-completed-banner .banner-reward {
          font-size: 12px;
          opacity: 0.9;
          margin-top: 4px;
        }

        @keyframes goalPulse {
          0% { transform: scale(0.9); opacity: 0; }
          50% { transform: scale(1.05); }
          100% { transform: scale(1); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * 加载用户目标
   */
  async loadGoals() {
    const content = this.container.querySelector('#goals-widget-content');
    if (!content) return;

    try {
      const response = await fetch('/api/retention/goals?status=active&limit=3', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      if (!response.ok) throw new Error('加载失败');

      this.goals = await response.json();
      this.renderGoals();
    } catch (err) {
      console.error('[GoalsWidget] Error loading goals:', err);
      content.innerHTML = '<div class="goals-widget-empty">加载失败</div>';
    }
  }

  /**
   * 渲染目标列表
   */
  renderGoals() {
    const content = this.container.querySelector('#goals-widget-content');
    if (!content) return;

    if (!this.goals || this.goals.length === 0) {
      content.innerHTML = `
        <div class="goals-widget-empty">
          暂无目标<br>
          <a href="leaderboard.html" onclick="event.preventDefault(); window.location.href='leaderboard.html'">去设置一个</a>
        </div>
      `;
      return;
    }

    content.innerHTML = this.goals.map(goal => {
      const progressPercent = Math.min(100, goal.progress_percent || 0);
      const isCompleted = progressPercent >= 100;
      const currentDisplay = goal.goal_type === 'accuracy'
        ? goal.current_value.toFixed(1) + '%'
        : Math.round(goal.current_value);
      const targetDisplay = goal.goal_type === 'accuracy'
        ? goal.target_value + '%'
        : goal.target_value + '次';

      return `
        <div class="goal-mini-card">
          <div class="goal-mini-header">
            <span class="goal-mini-title">${this.getGoalTypeLabel(goal.goal_type)} ${targetDisplay}</span>
            <span class="goal-mini-percent">${currentDisplay} / ${targetDisplay}</span>
          </div>
          <div class="goal-mini-progress">
            <div class="goal-mini-progress-bar ${isCompleted ? 'completed' : ''}" style="width: ${progressPercent}%"></div>
          </div>
          <div class="goal-mini-reward">
            ${goal.reward_xp > 0 ? `<span>⭐${goal.reward_xp}</span>` : ''}
            ${goal.reward_coins > 0 ? `<span>🪙${goal.reward_coins}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * 更新目标进度（练习完成后调用）
   */
  async updateProgress() {
    try {
      const response = await fetch('/api/retention/goals/check', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      if (!response.ok) throw new Error('更新失败');

      const result = await response.json();

      // 如果有新完成的目标，显示庆祝
      if (result.completed_goals && result.completed_goals.length > 0) {
        this.showCompletionCelebration(result.completed_goals);
        if (this.onGoalCompleted) {
          this.onGoalCompleted(result.completed_goals);
        }
      }

      // 重新加载目标
      await this.loadGoals();
    } catch (err) {
      console.error('[GoalsWidget] Error updating progress:', err);
    }
  }

  /**
   * 显示目标完成庆祝
   */
  showCompletionCelebration(completedGoals) {
    const content = this.container.querySelector('#goals-widget-content');
    if (!content) return;

    const goal = completedGoals[0]; // 显示第一个完成的目标
    const rewards = [];
    if (goal.reward_xp > 0) rewards.push(`+${goal.reward_xp} XP`);
    if (goal.reward_coins > 0) rewards.push(`+${goal.reward_coins} 金币`);
    if (goal.reward_badge) rewards.push(`🏅 ${goal.reward_badge}`);

    const banner = document.createElement('div');
    banner.className = 'goal-completed-banner';
    banner.innerHTML = `
      <span class="banner-icon">🎉</span>
      <span class="banner-text">目标达成！</span>
      ${rewards.length > 0 ? `<div class="banner-reward">${rewards.join(' ')}</div>` : ''}
    `;

    content.insertBefore(banner, content.firstChild);

    // 3秒后移除庆祝横幅
    setTimeout(() => {
      banner.remove();
    }, 3000);
  }

  /**
   * 获取目标类型标签
   */
  getGoalTypeLabel(type) {
    const labels = {
      'accuracy': '准确度达',
      'practice_count': '练习',
      'study_minutes': '学习'
    };
    return labels[type] || type;
  }

  /**
   * 销毁组件
   */
  destroy() {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.goals = [];
    this.initialized = false;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GoalsWidget;
}
