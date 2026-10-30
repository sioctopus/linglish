const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::', '::1']);

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || PRIVATE_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('链接无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http 或 https 链接');
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error('不能访问内网地址');
  }
  return url;
}

function parseChannelInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请填写频道链接');
  let text = raw;
  if (!/^https?:\/\//i.test(text)) {
    if (/^UC[\w-]{20,}$/.test(text)) text = `https://www.youtube.com/channel/${text}`;
    else if (text.startsWith('@')) text = `https://www.youtube.com/${text}`;
    else text = `https://www.youtube.com/@${text.replace(/^@/, '')}`;
  }
  const url = assertPublicHttpUrl(text);
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') {
    throw new Error('请填写 YouTube 频道链接');
  }
  const channelMatch = url.pathname.match(/\/channel\/(UC[\w-]{20,})/);
  if (channelMatch) {
    return {
      channelId: channelMatch[1],
      handle: '',
      pageUrl: `https://www.youtube.com/channel/${channelMatch[1]}`,
    };
  }
  const handleMatch = url.pathname.match(/\/@([^/?#]+)/);
  if (handleMatch) {
    const handle = decodeURIComponent(handleMatch[1]);
    return { channelId: '', handle, pageUrl: `https://www.youtube.com/@${handle}` };
  }
  const legacy = url.pathname.match(/\/(?:c|user)\/([^/?#]+)/);
  if (legacy) {
    return { channelId: '', handle: decodeURIComponent(legacy[1]), pageUrl: url.toString() };
  }
  throw new Error('无法识别频道链接，试试 youtube.com/@频道名');
}

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function stripTags(text) {
  return decodeXml(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = String(block || '').match(re);
  return match ? decodeXml(match[1]) : '';
}

function attr(block, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, 'i');
  const match = String(block || '').match(re);
  return match ? decodeXml(match[1]) : '';
}

function pickPodcastTranscript(itemXml) {
  const source = String(itemXml || '');
  const matches = [...source.matchAll(/<podcast:transcript\b([^>]*)\/?>/gi)];
  const candidates = matches.map((match) => {
    const attrs = match[1] || '';
    const url = decodeXml(((attrs.match(/\surl="([^"]*)"/i) || [])[1] || '').trim());
    const type = decodeXml(((attrs.match(/\stype="([^"]*)"/i) || [])[1] || '').trim().toLowerCase());
    return { url, type };
  }).filter((item) => item.url);
  if (!candidates.length) return { transcriptUrl: '', transcriptType: '' };
  const rank = (type, url) => {
    const value = `${type} ${url}`.toLowerCase();
    if (/vtt|text\/vtt/.test(value)) return 100;
    if (/srt|subrip/.test(value)) return 90;
    if (/json|json3/.test(value)) return 40;
    if (/html|plain|txt/.test(value)) return 10;
    return 50;
  };
  candidates.sort((a, b) => rank(b.type, b.url) - rank(a.type, a.url));
  return {
    transcriptUrl: candidates[0].url,
    transcriptType: candidates[0].type,
  };
}

function parseYouTubeRss(xml) {
  const source = String(xml || '');
  const title = stripTags(tagText(source, 'title'));
  const author = stripTags(tagText(source, 'name')) || title.replace(/\s*-\s*YouTube$/, '');
  const videos = source.split(/<entry\b/i).slice(1).map((entry) => {
    const videoId = tagText(entry, 'yt:videoId')
      || (tagText(entry, 'id').match(/yt:video:([\w-]{11})/) || [])[1]
      || '';
    if (!/^[\w-]{11}$/.test(videoId)) return null;
    return {
      videoId,
      title: stripTags(tagText(entry, 'title')),
      published: tagText(entry, 'published'),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      author: stripTags(tagText(entry, 'name')) || author,
    };
  }).filter(Boolean);
  return {
    title: author || title,
    author,
    channelId: tagText(source, 'yt:channelId'),
    videos,
  };
}

function parsePodcastRss(xml) {
  const source = String(xml || '');
  const channel = (source.match(/<channel\b[^>]*>([\s\S]*?)<item\b/i) || [])[1] || source;
  const image = attr(source, 'itunes:image', 'href') || tagText(channel, 'url');
  const episodes = source.split(/<item\b/i).slice(1).map((item, index) => {
    const audioUrl = attr(item, 'enclosure', 'url');
    if (!audioUrl) return null;
    return {
      id: stripTags(tagText(item, 'guid')) || audioUrl,
      title: stripTags(tagText(item, 'title')) || `第 ${index + 1} 集`,
      description: stripTags(tagText(item, 'description') || tagText(item, 'itunes:summary')).slice(0, 500),
      published: tagText(item, 'pubDate'),
      duration: tagText(item, 'itunes:duration'),
      audioUrl,
      image: attr(item, 'itunes:image', 'href') || image,
      ...pickPodcastTranscript(item),
    };
  }).filter(Boolean);
  return {
    title: stripTags(tagText(channel, 'title')),
    author: stripTags(tagText(channel, 'itunes:author') || tagText(channel, 'author')),
    description: stripTags(tagText(channel, 'description') || tagText(channel, 'itunes:summary')).slice(0, 280),
    image,
    episodes,
  };
}

function parseClock(stamp) {
  const parts = String(stamp || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseVtt(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const cues = [];
  source.split(/\n{2,}/).forEach((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return;
    const [startRaw, endRaw] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const cueText = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!cueText) return;
    cues.push({ start: parseClock(startRaw), end: parseClock(endRaw), text: cueText });
  });
  return cues;
}

function parseSrt(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const cues = [];
  source.split(/\n{2,}/).forEach((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return;
    const [startRaw, endRaw] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const cueText = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!cueText) return;
    const normalize = (stamp) => String(stamp || '').replace(',', '.');
    cues.push({
      start: parseClock(normalize(startRaw)),
      end: parseClock(normalize(endRaw)),
      text: cueText,
    });
  });
  return cues;
}

function parseJsonTranscript(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (_) {
    return [];
  }
  const rows = Array.isArray(data)
    ? data
    : (Array.isArray(data.segments) ? data.segments
      : (Array.isArray(data.cues) ? data.cues
        : (Array.isArray(data.results) ? data.results : [])));
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const textValue = String(row.text || row.body || row.content || '').replace(/<[^>]+>/g, '').trim();
    if (!textValue) return null;
    const start = Number(row.start ?? row.startTime ?? row.begin ?? 0);
    const end = Number(row.end ?? row.endTime ?? (start + Number(row.duration || 0)));
    if (!Number.isFinite(start)) return null;
    return {
      start,
      end: Number.isFinite(end) && end > start ? end : start + 2,
      text: textValue,
    };
  }).filter(Boolean);
}

function parseItunesResults(payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return results.map((item) => ({
    id: String(item.collectionId || item.trackId || item.feedUrl || ''),
    title: item.collectionName || item.trackName || '播客',
    author: item.artistName || '',
    image: item.artworkUrl600 || item.artworkUrl100 || '',
    feedUrl: item.feedUrl || '',
  })).filter((item) => item.feedUrl || item.id);
}

function parseItunesEpisodes(payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  const show = results.find((item) => item.kind === 'podcast' || item.wrapperType === 'track') || {};
  const episodes = results
    .filter((item) => item.kind === 'podcast-episode' || item.wrapperType === 'podcastEpisode')
    .map((item, index) => {
      const audioUrl = item.episodeUrl || item.previewUrl || '';
      if (!audioUrl) return null;
      const durationMs = Number(item.trackTimeMillis);
      return {
        id: String(item.trackId || item.episodeGuid || audioUrl),
        title: item.trackName || `第 ${index + 1} 集`,
        description: stripTags(item.description || '').slice(0, 500),
        published: item.releaseDate || '',
        duration: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : '',
        audioUrl,
        image: item.artworkUrl600 || item.artworkUrl60 || show.artworkUrl600 || '',
        transcriptUrl: '',
        transcriptType: '',
      };
    })
    .filter(Boolean);
  return {
    title: show.collectionName || show.trackName || '播客',
    author: show.artistName || '',
    description: stripTags(show.description || '').slice(0, 280),
    image: show.artworkUrl600 || show.artworkUrl100 || '',
    feedUrl: show.feedUrl || '',
    collectionId: String(show.collectionId || show.trackId || ''),
    episodes,
  };
}

function extractChannelId(html) {
  const source = String(html || '');
  const patterns = [
    /"externalId":"(UC[\w-]{20,})"/,
    /property="og:url" content="https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{20,})"/,
    /"browseId":"(UC[\w-]{20,})"/,
    /channel_id=(UC[\w-]{20,})/,
    /"channelId":"(UC[\w-]{20,})"/,
    /youtube\.com\/channel\/(UC[\w-]{20,})/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function decodeYtText(value) {
  return String(value || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChannelTitle(html) {
  const source = String(html || '');
  const patterns = [
    /"channelMetadataRenderer"\s*:\s*\{[^{}]*?"title"\s*:\s*"([^"]+)"/,
    /property="og:title" content="([^"]+)"/,
    /<meta[^>]+name="title"[^>]+content="([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const title = decodeYtText(match[1]).replace(/\s*-\s*YouTube$/i, '').trim();
      if (title) return title;
    }
  }
  return '';
}

function parseYtInitialData(html) {
  const match = String(html || '').match(/ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
}

function pushChannelVideo(out, video) {
  if (!video || !/^[\w-]{11}$/.test(video.videoId)) return;
  if (out.some((item) => item.videoId === video.videoId)) return;
  out.push({
    videoId: video.videoId,
    title: decodeYtText(video.title) || video.videoId,
    published: decodeYtText(video.published || ''),
    thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    author: decodeYtText(video.author || ''),
  });
}

function titleFromRuns(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs) && node.runs[0] && node.runs[0].text) return node.runs[0].text;
  return '';
}

function publishedFromLockup(lockup) {
  const rows = lockup
    && lockup.metadata
    && lockup.metadata.lockupMetadataViewModel
    && lockup.metadata.lockupMetadataViewModel.metadata
    && lockup.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel
    && lockup.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows;
  if (!Array.isArray(rows)) return '';
  for (const row of rows) {
    const parts = row && row.metadataParts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const label = part && (part.accessibilityLabel || (part.text && part.text.content));
      if (label && /(ago|前|hour|day|week|month|year|分钟|小时|天|周|月|年)/i.test(String(label))) {
        return String(part.text && part.text.content || label);
      }
    }
  }
  return '';
}

function collectChannelVideosFromNode(node, out) {
  if (!node || typeof node !== 'object' || out.length >= 48) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectChannelVideosFromNode(item, out));
    return;
  }

  if (node.lockupViewModel && node.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    const lockup = node.lockupViewModel;
    pushChannelVideo(out, {
      videoId: lockup.contentId,
      title: lockup.metadata
        && lockup.metadata.lockupMetadataViewModel
        && lockup.metadata.lockupMetadataViewModel.title
        && lockup.metadata.lockupMetadataViewModel.title.content,
      published: publishedFromLockup(lockup),
    });
  }

  const renderer = node.videoRenderer || node.gridVideoRenderer || node.compactVideoRenderer;
  if (renderer && renderer.videoId) {
    pushChannelVideo(out, {
      videoId: renderer.videoId,
      title: titleFromRuns(renderer.title),
      published: titleFromRuns(renderer.publishedTimeText),
      author: titleFromRuns(renderer.ownerText || renderer.shortBylineText),
    });
  }

  Object.keys(node).forEach((key) => {
    if (key === 'lockupViewModel' || key === 'videoRenderer' || key === 'gridVideoRenderer' || key === 'compactVideoRenderer') {
      return;
    }
    collectChannelVideosFromNode(node[key], out);
  });
}

function parseYouTubeChannelHtml(html, fallbackAuthor = '') {
  const source = String(html || '');
  const videos = [];
  const data = parseYtInitialData(source);
  if (data) collectChannelVideosFromNode(data, videos);

  if (!videos.length) {
    const ids = [];
    const re = /"videoId":"([\w-]{11})"/g;
    let match;
    while ((match = re.exec(source)) && ids.length < 24) {
      if (!ids.includes(match[1])) ids.push(match[1]);
    }
    ids.forEach((videoId) => pushChannelVideo(videos, { videoId, title: videoId, author: fallbackAuthor }));
  }

  const title = extractChannelTitle(source) || fallbackAuthor;
  return {
    title,
    author: title || fallbackAuthor,
    channelId: extractChannelId(source),
    videos: videos.slice(0, 24).map((item) => ({
      ...item,
      author: item.author || title || fallbackAuthor,
    })),
  };
}

function normalizeProxyServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let server = raw;
  if (raw.includes('=')) {
    const map = {};
    raw.split(';').forEach((part) => {
      const bits = part.split('=');
      const key = String(bits.shift() || '').trim().toLowerCase();
      const host = bits.join('=').trim();
      if (key && host) map[key] = host;
    });
    server = map.https || map.http || '';
  }
  if (!server) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) server = `http://${server}`;
  return server;
}

function readWindowsProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const buf = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { timeout: 3000 }
    );
    let out = buf.toString('utf8');
    if (out.includes('\u0000')) out = buf.toString('utf16le');
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (!enabled || Number.parseInt(enabled[1], 16) !== 1) return '';
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    return server ? normalizeProxyServer(server[1]) : '';
  } catch (_) {
    return '';
  }
}

let cachedProxy = null;
let cachedAgent = null;

function outboundAgent() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || '';
  const proxy = normalizeProxyServer(fromEnv) || readWindowsProxy();
  if (!proxy) return undefined;
  if (cachedProxy !== proxy) {
    cachedProxy = proxy;
    cachedAgent = new HttpsProxyAgent(proxy);
  }
  return cachedAgent;
}

function fetchBytes(rawUrl, options = {}) {
  const maxBytes = options.maxBytes || 2000000;
  const timeoutMs = options.timeoutMs || 20000;
  const redirects = options.redirects == null ? 3 : options.redirects;
  const agent = options.agent === undefined ? outboundAgent() : (options.agent || undefined);
  const asText = options.asText === true;
  const url = assertPublicHttpUrl(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          finish(reject, new Error('重定向过多'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        finish(resolve, fetchBytes(next, { maxBytes, timeoutMs, redirects: redirects - 1, agent, asText }));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(reject, new Error(`拉取失败 (${status})`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          finish(reject, new Error('内容过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        finish(resolve, asText ? buf.toString('utf8') : buf);
      });
    });
    const fail = (error) => {
      if (settled) return;
      if (agent && !options.directFallback) {
        settled = true;
        resolve(fetchBytes(rawUrl, {
          maxBytes,
          timeoutMs,
          redirects,
          agent: false,
          directFallback: true,
          asText,
        }));
        return;
      }
      finish(reject, error);
    };
    req.on('error', () => fail(new Error('网络请求失败')));
    req.on('timeout', () => {
      req.destroy();
      fail(new Error('请求超时'));
    });
  });
}

function fetchText(rawUrl, options = {}) {
  return fetchBytes(rawUrl, { ...options, asText: true });
}

function guessAudioExt(url, contentType) {
  const pathName = String(url && url.pathname || '').toLowerCase();
  if (/\.m4a($|\?)/i.test(pathName)) return '.m4a';
  if (/\.wav($|\?)/i.test(pathName)) return '.wav';
  if (/\.ogg($|\?)/i.test(pathName)) return '.ogg';
  if (/\.mp3($|\?)/i.test(pathName)) return '.mp3';
  const type = String(contentType || '').toLowerCase();
  if (type.includes('wav')) return '.wav';
  if (type.includes('m4a') || type.includes('mp4')) return '.m4a';
  if (type.includes('ogg')) return '.ogg';
  return '.mp3';
}

function cuesFromTranscriptResult(result) {
  const segments = Array.isArray(result && result.segments) ? result.segments : [];
  const cues = segments.map((seg) => ({
    start: Number(seg.start) || 0,
    end: Number(seg.end) || Number(seg.start) || 0,
    text: String(seg.text || '').trim(),
  })).filter((cue) => cue.text);
  if (!cues.length && result && result.text) {
    cues.push({
      start: 0,
      end: Number(result.duration) || 0,
      text: String(result.text).trim(),
    });
  }
  return cues;
}

function setFluentFfmpegPath(ffmpeg) {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer && installer.path) ffmpeg.setFfmpegPath(installer.path);
  } catch (_) { /* optional */ }
}

async function transcribePodcastBuffer(buf, options = {}) {
  if (!buf || !buf.length) throw new Error('音频文件是空的');
  const maxBytes = options.maxBytes || (40 * 1024 * 1024);
  if (buf.length > maxBytes) throw new Error('这一集音频太大，暂时无法生成字幕');
  const ext = String(options.ext || '.mp3').startsWith('.') ? String(options.ext) : `.${options.ext || 'mp3'}`;
  const tmp = path.join(os.tmpdir(), `linglish-pod-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  fs.writeFileSync(tmp, buf);
  let workPath = tmp;
  let compressed = '';
  try {
    if (buf.length > 24 * 1024 * 1024) {
      const ffmpeg = require('fluent-ffmpeg');
      setFluentFfmpegPath(ffmpeg);
      compressed = path.join(os.tmpdir(), `linglish-pod-c-${Date.now()}.mp3`);
      await new Promise((resolve, reject) => {
        ffmpeg(tmp)
          .audioChannels(1)
          .audioBitrate('64k')
          .format('mp3')
          .on('error', reject)
          .on('end', resolve)
          .save(compressed);
      });
      workPath = compressed;
    }
    const videoTranscription = require('./video-transcription');
    // Prefer local Whisper first when available — cloud STT often needs paid credits.
    let provider = options.provider || 'whisper';
    if (!options.provider && await videoTranscription.hasLocalWhisper()) {
      provider = 'local-whisper';
    }
    const result = await videoTranscription.transcribeVideoFile(workPath, {
      language: options.language || 'en',
      scenario: 'video-upload',
      provider,
      allowLocalFallback: true,
    });
    const cues = cuesFromTranscriptResult(result);
    if (!cues.length) throw new Error('生成字幕失败，没有识别到内容');
    return cues;
  } catch (error) {
    const message = error && error.message ? error.message : '生成字幕失败';
    if (/API.?[Kk]ey|not configured/i.test(message)) {
      throw new Error('字幕生成服务未配置，暂时无法为无文稿播客生成字幕');
    }
    if (/402|requires at least|balance for audio|insufficient.?credit/i.test(message)) {
      throw new Error('语音识别额度不足，正在改用本地识别…');
    }
    if (/401|429|quota/i.test(message)) {
      throw new Error('字幕生成服务暂时不可用，请稍后重试');
    }
    if (/内容过大|payload|25 ?mb|file size/i.test(message)) {
      throw new Error('这一集音频太大，暂时无法生成字幕');
    }
    throw new Error(message);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (compressed) {
      try { fs.unlinkSync(compressed); } catch (_) {}
    }
  }
}

async function searchYoutubeVideoIdByTitle(title) {
  const q = String(title || '').trim();
  if (!q) return '';
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      'yt-dlp',
      ['--get-id', `ytsearch1:${q}`],
      { timeout: 45000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        const id = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
        resolve(/^[a-zA-Z0-9_-]{11}$/.test(id) ? id : '');
      }
    );
  });
}

async function cuesFromYoutubeVideoId(videoId, language = 'en') {
  const id = String(videoId || '').trim();
  if (!id) return [];
  const youtube = require('./youtube');
  const segs = await youtube.getTranscript(id, language);
  return (Array.isArray(segs) ? segs : []).map((seg) => ({
    start: Number(seg.start) || 0,
    end: Number(seg.end != null ? seg.end : (Number(seg.start) || 0) + 2),
    text: String(seg.text || '').trim(),
  })).filter((cue) => cue.text);
}

async function transcribeYoutubeAudio(videoId, options = {}) {
  const id = String(videoId || '').trim();
  if (!id) throw new Error('缺少 YouTube 视频编号');
  const { execFile } = require('child_process');
  const outBase = path.join(os.tmpdir(), `linglish-yt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const outTemplate = `${outBase}.%(ext)s`;
  await new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      [
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '5',
        '-o', outTemplate,
        '--no-playlist',
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { timeout: 180000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message || '下载音频失败'));
        else resolve();
      }
    );
  });
  const candidates = [
    `${outBase}.mp3`,
    `${outBase}.m4a`,
    `${outBase}.webm`,
    `${outBase}.opus`,
  ];
  const audioPath = candidates.find((p) => fs.existsSync(p));
  if (!audioPath) throw new Error('下载音频失败');
  try {
    const buf = fs.readFileSync(audioPath);
    return transcribePodcastBuffer(buf, {
      language: options.language || 'en',
      ext: path.extname(audioPath) || '.mp3',
      provider: options.provider,
    });
  } finally {
    candidates.forEach((p) => {
      try { fs.unlinkSync(p); } catch (_) {}
    });
  }
}

/**
 * Unified subtitle resolver for podcasts / YouTube / uploaded media.
 * Order: transcript URL → YouTube captions → YouTube title search → audio STT.
 */
async function resolveMediaCues(input = {}) {
  const language = input.language || 'en';
  const errors = [];

  if (input.transcriptUrl) {
    try {
      const cues = await loadTranscriptCues(input.transcriptUrl);
      if (cues.length) return { cues, source: 'transcript-url' };
      errors.push('文稿地址没有可用字幕');
    } catch (err) {
      errors.push(err && err.message ? err.message : '文稿拉取失败');
    }
  }

  const youtubeId = String(input.youtubeVideoId || input.youtube_video_id || '').trim();
  if (youtubeId) {
    try {
      const cues = await cuesFromYoutubeVideoId(youtubeId, language);
      if (cues.length) return { cues, source: 'youtube-captions', youtubeVideoId: youtubeId };
      errors.push('YouTube 字幕为空');
    } catch (err) {
      errors.push(err && err.message ? err.message : 'YouTube 字幕拉取失败');
    }
    if (input.allowAudioStt !== false) {
      try {
        const cues = await transcribeYoutubeAudio(youtubeId, { language });
        if (cues.length) return { cues, source: 'youtube-stt', youtubeVideoId: youtubeId };
      } catch (err) {
        errors.push(err && err.message ? err.message : 'YouTube 音频识别失败');
      }
    }
  }

  if (!youtubeId && input.title && input.allowYoutubeSearch !== false) {
    try {
      const foundId = await searchYoutubeVideoIdByTitle(input.title);
      if (foundId) {
        try {
          const cues = await cuesFromYoutubeVideoId(foundId, language);
          if (cues.length) return { cues, source: 'youtube-search-captions', youtubeVideoId: foundId };
        } catch (err) {
          errors.push(err && err.message ? err.message : '标题匹配字幕失败');
        }
        if (input.allowAudioStt !== false) {
          try {
            const cues = await transcribeYoutubeAudio(foundId, { language });
            if (cues.length) return { cues, source: 'youtube-search-stt', youtubeVideoId: foundId };
          } catch (err) {
            errors.push(err && err.message ? err.message : '标题匹配音频识别失败');
          }
        }
      }
    } catch (err) {
      errors.push(err && err.message ? err.message : 'YouTube 搜索失败');
    }
  }

  if (input.audioBuffer && input.audioBuffer.length) {
    const cues = await transcribePodcastBuffer(input.audioBuffer, {
      language,
      ext: input.ext || '.mp3',
      provider: input.provider,
    });
    return { cues, source: 'audio-stt' };
  }

  if (input.audioUrl) {
    const cues = await transcribePodcastAudio(input.audioUrl, {
      language,
      provider: input.provider,
    });
    return { cues, source: 'audio-stt' };
  }

  throw new Error(errors.filter(Boolean).slice(0, 2).join('；') || '没有可用字幕');
}

async function transcribePodcastAudio(audioUrl, options = {}) {
  const raw = String(audioUrl || '').trim();
  if (!raw) throw new Error('缺少音频链接');
  const url = assertPublicHttpUrl(raw);
  const buf = await fetchBytes(url.toString(), {
    maxBytes: options.maxBytes || (40 * 1024 * 1024),
    timeoutMs: options.timeoutMs || 120000,
  });
  return transcribePodcastBuffer(buf, {
    ...options,
    ext: guessAudioExt(url, ''),
  });
}

async function loadYouTubeChannel(input) {
  try {
    const parsed = parseChannelInput(input);
    let channelId = parsed.channelId;
    const titleHint = parsed.handle || '';
    const videosPageUrl = channelId
      ? `https://www.youtube.com/channel/${channelId}/videos`
      : (parsed.handle
        ? `https://www.youtube.com/@${parsed.handle}/videos`
        : `${String(parsed.pageUrl || '').replace(/\/$/, '')}/videos`);
    let networkError = null;

    // Prefer channel /videos HTML first: YouTube RSS often 404s behind some proxies.
    try {
      const pageHtml = await fetchText(videosPageUrl, { maxBytes: 4000000, timeoutMs: 25000 });
      const scraped = parseYouTubeChannelHtml(pageHtml, titleHint);
      channelId = channelId || scraped.channelId;
      if (scraped.videos.length) {
        return {
          channelId: channelId || scraped.channelId || '',
          handle: parsed.handle,
          title: scraped.title || titleHint || channelId,
          author: scraped.author || scraped.title || titleHint,
          pageUrl: parsed.pageUrl,
          videos: scraped.videos,
        };
      }
      if (/doesn't have any content|没有内容|no videos/i.test(pageHtml)) {
        throw new Error('这个频道暂时没有可导入的视频');
      }
    } catch (error) {
      const message = error && error.message ? error.message : '';
      if (message.includes('暂时没有可导入')) throw error;
      networkError = error;
    }

    if (!channelId) {
      try {
        const homeHtml = await fetchText(parsed.pageUrl, { maxBytes: 4000000, timeoutMs: 25000 });
        channelId = extractChannelId(homeHtml);
        const scraped = parseYouTubeChannelHtml(homeHtml, titleHint);
        if (scraped.videos.length) {
          return {
            channelId: channelId || scraped.channelId || '',
            handle: parsed.handle,
            title: scraped.title || titleHint || channelId,
            author: scraped.author || scraped.title || titleHint,
            pageUrl: parsed.pageUrl,
            videos: scraped.videos,
          };
        }
      } catch (error) {
        networkError = error;
      }
    }

    if (channelId) {
      try {
        const rss = await fetchText(
          `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
          { timeoutMs: 12000 }
        );
        const feed = parseYouTubeRss(rss);
        if (feed.videos.length) {
          return {
            channelId,
            handle: parsed.handle,
            title: feed.title || titleHint || channelId,
            author: feed.author,
            pageUrl: parsed.pageUrl,
            videos: feed.videos.slice(0, 24),
          };
        }
      } catch (error) {
        networkError = error;
      }
    }

    if (!channelId && networkError) {
      const message = networkError.message || '';
      if (/拉取失败|网络请求失败|请求超时|内容过大|重定向过多/.test(message)) {
        throw new Error('当前网络读不到 YouTube 频道视频，请配置可用代理（HTTPS_PROXY）后重试');
      }
      throw networkError;
    }
    throw new Error('这个频道暂时没有可导入的视频');
  } catch (error) {
    const message = error && error.message ? error.message : '请求失败';
    if (/拉取失败|网络请求失败|请求超时|内容过大|重定向过多/.test(message)) {
      throw new Error('当前网络读不到 YouTube 频道视频，请配置可用代理（HTTPS_PROXY）后重试');
    }
    throw error;
  }
}

async function searchPodcasts(query) {
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('至少输入两个字');
  const endpoint = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=18&term=${encodeURIComponent(q)}`;
  let payload;
  try {
    payload = JSON.parse(await fetchText(endpoint));
  } catch (error) {
    if (error && /链接无效|不能访问|过大|超时|拉取失败|网络请求失败/.test(error.message)) throw error;
    throw new Error('搜索结果无法解析');
  }
  return parseItunesResults(payload);
}

async function loadPodcastFromItunes(collectionId) {
  const id = String(collectionId || '').trim();
  if (!id) throw new Error('缺少播客编号');
  const endpoint = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=podcastEpisode&limit=40`;
  let payload;
  try {
    payload = JSON.parse(await fetchText(endpoint));
  } catch (error) {
    if (error && /链接无效|不能访问|过大|超时|拉取失败|网络请求失败/.test(error.message)) throw error;
    throw new Error('播客单集列表无法解析');
  }
  const feed = parseItunesEpisodes(payload);
  if (!feed.episodes.length) throw new Error('这个播客暂时没有可播放的单集');
  return {
    ...feed,
    episodes: feed.episodes.slice(0, 40),
    feedUrl: feed.feedUrl || `itunes:${id}`,
    collectionId: feed.collectionId || id,
  };
}

function episodeMatchKey(episode) {
  const audio = String(episode && episode.audioUrl || '').split('?')[0].toLowerCase();
  const title = String(episode && episode.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return { audio, title };
}

function mergePodcastTranscripts(baseEpisodes, rssEpisodes) {
  const base = Array.isArray(baseEpisodes) ? baseEpisodes : [];
  const rss = Array.isArray(rssEpisodes) ? rssEpisodes : [];
  if (!rss.length) return base;
  const byAudio = new Map();
  const byTitle = new Map();
  rss.forEach((ep) => {
    const key = episodeMatchKey(ep);
    if (key.audio) byAudio.set(key.audio, ep);
    if (key.title) byTitle.set(key.title, ep);
  });
  return base.map((ep) => {
    if (ep && ep.transcriptUrl) return ep;
    const key = episodeMatchKey(ep);
    const hit = (key.audio && byAudio.get(key.audio)) || (key.title && byTitle.get(key.title));
    if (!hit || !hit.transcriptUrl) return ep;
    return {
      ...ep,
      transcriptUrl: hit.transcriptUrl,
      transcriptType: hit.transcriptType || '',
    };
  });
}

async function loadRssPodcastFeed(feedUrl) {
  const url = String(feedUrl || '').trim();
  if (!url || url.startsWith('seed:podcast:') || url.startsWith('itunes:')) return null;
  const xml = await fetchText(url);
  const feed = parsePodcastRss(xml);
  if (!(feed.title && feed.episodes.length)) return null;
  return feed;
}

async function loadPodcastFeed(feedUrl, options = {}) {
  const url = String(feedUrl || options.url || '').trim();
  const seeded = url.startsWith('seed:podcast:');
  let collectionId = String(options.collectionId || '').trim();
  const query = String(options.query || '').trim();
  let resolvedFeedUrl = url;

  if (url && !seeded) {
    try {
      const feed = await loadRssPodcastFeed(url);
      if (feed) {
        return {
          ...feed,
          episodes: feed.episodes.slice(0, 40),
          feedUrl: url,
          collectionId: collectionId || '',
        };
      }
    } catch (error) {
      if (!collectionId && !query) {
        const message = error && error.message ? error.message : '请求失败';
        if (/拉取失败|网络请求失败|请求超时|内容过大/.test(message)) {
          throw new Error('播客源暂时连不上，请稍后重试');
        }
        throw error;
      }
    }
  }

  if (!collectionId && query) {
    const found = await searchPodcasts(query);
    const matched = found[0];
    if (!matched) throw new Error('没有找到这个播客的节目源');
    collectionId = matched.id;
    if (matched.feedUrl) resolvedFeedUrl = matched.feedUrl;
  }

  // Seeded shelves often only have a query/collectionId. Prefer the real RSS
  // feed whenever iTunes (or the seed metadata) exposes one, so transcript
  // links are not dropped by the iTunes episode lookup path.
  if (seeded || !url) {
    if (!resolvedFeedUrl || resolvedFeedUrl.startsWith('seed:podcast:') || resolvedFeedUrl.startsWith('itunes:')) {
      if (collectionId) {
        try {
          const lookup = await loadPodcastFromItunes(collectionId);
          if (lookup.feedUrl) resolvedFeedUrl = lookup.feedUrl;
        } catch (_) { /* fall through */ }
      }
    }
    if (resolvedFeedUrl && !resolvedFeedUrl.startsWith('seed:podcast:') && !resolvedFeedUrl.startsWith('itunes:')) {
      try {
        const feed = await loadRssPodcastFeed(resolvedFeedUrl);
        if (feed) {
          return {
            ...feed,
            episodes: feed.episodes.slice(0, 40),
            feedUrl: resolvedFeedUrl,
            collectionId: collectionId || '',
          };
        }
      } catch (_) { /* fall back to iTunes episodes */ }
    }
  }

  if (!collectionId) throw new Error('没有找到这个播客的节目源');
  const fromItunes = await loadPodcastFromItunes(collectionId);
  const liveFeedUrl = fromItunes.feedUrl || resolvedFeedUrl || `itunes:${collectionId}`;
  let episodes = (fromItunes.episodes || []).slice(0, 40);
  if (liveFeedUrl && !String(liveFeedUrl).startsWith('itunes:')) {
    try {
      const rss = await loadRssPodcastFeed(liveFeedUrl);
      if (rss && rss.episodes.length) {
        // Prefer RSS media URLs: iTunes episodeUrl often points at CDN stubs
        // (e.g. sphinx.acast.com/p/open/...) that 404 for players and STT.
        return {
          ...fromItunes,
          ...rss,
          title: rss.title || fromItunes.title,
          author: rss.author || fromItunes.author,
          description: rss.description || fromItunes.description,
          image: rss.image || fromItunes.image,
          episodes: mergePodcastTranscripts(rss.episodes.slice(0, 40), episodes),
          feedUrl: liveFeedUrl,
          collectionId,
        };
      }
    } catch (_) { /* keep iTunes episodes */ }
  }
  return {
    ...fromItunes,
    episodes,
    feedUrl: liveFeedUrl,
    collectionId,
  };
}

async function loadTranscriptCues(url) {
  const text = await fetchText(url, { maxBytes: 1500000 });
  const hint = String(url || '').toLowerCase();
  const body = String(text || '').replace(/^\uFEFF/, '');
  const looksJson = /^\s*[\[{]/.test(body);
  const looksVtt = /^WEBVTT/i.test(body) || /text\/vtt|\.vtt(?:$|\?)/i.test(hint);
  const looksSrt = /application\/x-subrip|text\/srt|\.srt(?:$|\?)/i.test(hint)
    || (!looksVtt && /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(body));

  let cues = [];
  if (looksJson) cues = parseJsonTranscript(body);
  else if (looksSrt) cues = parseSrt(body);
  else cues = parseVtt(body);

  if (!cues.length && !looksSrt) cues = parseSrt(body);
  if (!cues.length && !looksVtt) cues = parseVtt(body);
  if (!cues.length) cues = parseJsonTranscript(body);
  if (!cues.length) throw new Error('字幕文稿为空或格式不支持');
  return cues;
}

function normalizeCoverTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCoverTitle(wantRaw, candidateRaw) {
  const want = normalizeCoverTitle(wantRaw);
  const candidate = normalizeCoverTitle(candidateRaw);
  if (!want || !candidate) return 0;
  if (want === candidate) return 100;
  if (candidate.includes(want) || want.includes(candidate)) return 80;
  const words = want.split(' ').filter((word) => word.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((word) => candidate.includes(word)).length;
  return Math.round((hits / words.length) * 60);
}

async function resolveCoverImage(query, title) {
  const want = String(title || query || '').trim();
  const queries = [
    String(query || '').trim(),
    want,
    want.replace(/[！!].*$/, '').trim(),
    want.split(/\s+/).slice(0, 3).join(' '),
  ].filter((q, index, arr) => q.length >= 2 && arr.indexOf(q) === index);

  let best = null;
  let bestScore = 0;
  for (const q of queries) {
    let found = [];
    try {
      found = await searchPodcasts(q);
    } catch (_) {
      continue;
    }
    found.forEach((item) => {
      const score = scoreCoverTitle(want, item.title);
      if (score > bestScore && item.image) {
        bestScore = score;
        best = item;
      }
    });
    if (bestScore >= 80) break;
  }
  if (best && best.image && bestScore >= 20) return best.image;
  if (best && best.image) return best.image;
  const label = want || queries[0] || 'YT';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(label.slice(0, 24))}&background=0d9488&color=fff&size=512&bold=true`;
}

async function resolveCoverImages(items) {
  const list = Array.isArray(items) ? items.slice(0, 80) : [];
  const images = {};
  const queue = [...list];
  const workers = Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item || !item.key) continue;
      try {
        images[item.key] = await resolveCoverImage(item.query || item.title, item.title);
      } catch (_) {
        images[item.key] = '';
      }
    }
  });
  await Promise.all(workers);
  return images;
}

module.exports = {
  isPrivateHostname,
  assertPublicHttpUrl,
  normalizeProxyServer,
  parseChannelInput,
  parseYouTubeRss,
  parseYouTubeChannelHtml,
  parsePodcastRss,
  parseVtt,
  parseSrt,
  parseJsonTranscript,
  pickPodcastTranscript,
  parseItunesResults,
  parseItunesEpisodes,
  extractChannelId,
  extractChannelTitle,
  loadYouTubeChannel,
  searchPodcasts,
  loadPodcastFromItunes,
  loadPodcastFeed,
  loadTranscriptCues,
  resolveCoverImage,
  resolveCoverImages,
  fetchBytes,
  cuesFromTranscriptResult,
  guessAudioExt,
  transcribePodcastBuffer,
  transcribePodcastAudio,
  searchYoutubeVideoIdByTitle,
  cuesFromYoutubeVideoId,
  transcribeYoutubeAudio,
  resolveMediaCues,
};
