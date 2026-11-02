function publicationError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isVideoReadyForPublication(video) {
  if (!video || video.status !== 'ready' || /^audio\//i.test(video.mime_type || '')) return false;
  const mediaPath = video.local_video_path || video.video_path || '';
  if (!String(mediaPath).startsWith('/videos/') && !video.youtube_video_id) return false;
  let segments = video.transcript_segments;
  if (typeof segments === 'string') {
    try { segments = JSON.parse(segments); } catch (_) { return false; }
  }
  return Array.isArray(segments) && segments.some(segment => {
    const start = Number(segment?.start ?? segment?.start_sec ?? segment?.start_time_sec);
    const end = Number(segment?.end ?? segment?.end_sec ?? segment?.end_time_sec);
    return typeof segment?.text === 'string' && segment.text.trim()
      && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
  });
}

const CREATOR_APPROVAL_MESSAGE = '请先申请创作者并通过审核，再提交公开或精选内容。 Creator approval is required to publish.';
const VIDEO_REVIEW_LOCK_MESSAGE = '公开或审核中的内容暂不能修改，请联系管理员处理后重新提交审核。 Public or pending content is locked for review.';
const VIDEO_PROCESSING_LOCK_MESSAGE = '视频正在处理，请等待完成后再修改或重试。 Video is processing; wait before editing or retrying.';

module.exports = { publicationError, isVideoReadyForPublication, CREATOR_APPROVAL_MESSAGE, VIDEO_REVIEW_LOCK_MESSAGE, VIDEO_PROCESSING_LOCK_MESSAGE };
