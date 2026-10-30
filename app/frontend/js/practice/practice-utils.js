/**
 * Practice Session Utility Functions
 * 通用工具函数模块
 */

// ===== YouTube 工具函数 =====

/**
 * 从 URL 提取 YouTube 视频 ID
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&?\/\s]+)/i,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * 检查是否为 YouTube URL
 */
function isYouTubeUrl(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be'));
}

// ===== HTML/格式化工具 =====

/**
 * HTML 转义
 */
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return map[char] || char;
  });
}

/**
 * 格式化时间 (秒 -> m:ss)
 */
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ===== 收藏管理 =====

const FAVORITES_KEY = 'linglish_practice_favorites';

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  } catch (_) { return []; }
}

function setFavorites(ids) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch (_) { }
}

function toggleFavorite(videoId) {
  const favs = getFavorites();
  const id = String(videoId);
  const idx = favs.indexOf(id);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.push(id);
  }
  setFavorites(favs);
  return favs.includes(id);
}

function isFavorite(videoId) {
  return getFavorites().includes(String(videoId));
}

// ===== 导出 =====

window.PracticeUtils = {
  // YouTube
  extractYouTubeVideoId,
  isYouTubeUrl,
  // HTML/Format
  escapeHtml,
  formatTime,
  // Favorites
  FAVORITES_KEY,
  getFavorites,
  setFavorites,
  toggleFavorite,
  isFavorite,
};
