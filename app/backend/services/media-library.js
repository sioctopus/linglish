const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::', '::1']);

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || PRIVATE_HOSTS.has(host) || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    // Only global unicast is eligible. This excludes IPv4-mapped and NAT64
    // addresses as well as loopback, link-local, unique-local and multicast.
    const first = Number.parseInt(host.split(':')[0] || '0', 16);
    const second = Number.parseInt(host.split(':')[1] || '0', 16);
    return first < 0x2000 || first > 0x3fff
      || (first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
      || first === 0x2002
      || (first === 0x3fff && second <= 0x0fff);
  }
  return host.includes(':') || /^[\d.]+$/.test(host);
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
  if (url.username || url.password) throw new Error('链接不能包含凭据');
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
      transcriptUrl: attr(item, 'podcast:transcript', 'url'),
      transcriptType: attr(item, 'podcast:transcript', 'type'),
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

function parseItunesResults(payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return results.map((item) => ({
    id: String(item.collectionId || item.trackId || item.feedUrl || ''),
    title: item.collectionName || item.trackName || '播客',
    author: item.artistName || '',
    image: item.artworkUrl600 || item.artworkUrl100 || '',
    feedUrl: item.feedUrl || '',
  })).filter((item) => item.feedUrl);
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

async function fetchText(rawUrl, options = {}) {
  const maxBytes = Math.min(options.maxBytes || 2000000, 4000000);
  const timeoutMs = Math.min(options.timeoutMs || 20000, 20000);
  const redirects = options.redirects == null ? 3 : options.redirects;
  const deadline = options.deadline || Date.now() + timeoutMs;
  const url = assertPublicHttpUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let records;
  if (net.isIP(hostname)) {
    records = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    let dnsTimer;
    try {
      records = await Promise.race([
        dns.promises.lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error('请求超时')), Math.max(1, deadline - Date.now()));
        }),
      ]);
    } catch (error) {
      if (error.message === '请求超时') throw error;
      throw new Error('网络请求失败');
    } finally {
      clearTimeout(dnsTimer);
    }
  }
  if (!records.length || records.some(record => !net.isIP(record.address) || isPrivateHostname(record.address))) {
    throw new Error('不能访问内网地址');
  }
  const address = records.find(record => record.family === 4) || records[0];
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('请求超时');
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalTimer;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      handler(value);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      // A proxy can resolve the destination independently and bypass the DNS
      // check. Connect directly, using only the already-validated address.
      agent: false,
      family: address.family,
      autoSelectFamily: false,
      lookup(_host, lookupOptions, callback) {
        if (lookupOptions && lookupOptions.all) {
          callback(null, [address]);
        } else {
          callback(null, address.address, address.family);
        }
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
      },
      timeout: remaining,
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.destroy();
        if (redirects <= 0) {
          finish(reject, new Error('重定向过多'));
          return;
        }
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch (_) {
          finish(reject, new Error('链接无效'));
          return;
        }
        finish(resolve, fetchText(next, { maxBytes, timeoutMs, redirects: redirects - 1, deadline }));
        return;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        finish(reject, new Error(`拉取失败 (${status})`));
        return;
      }
      const chunks = [];
      let size = 0;
      if (Number(res.headers['content-length']) > maxBytes) {
        finish(reject, new Error('内容过大'));
        req.destroy();
        return;
      }
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          finish(reject, new Error('内容过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => finish(reject, new Error('网络请求失败')));
      res.on('aborted', () => finish(reject, new Error('网络请求失败')));
    });
    req.on('error', () => finish(reject, new Error('网络请求失败')));
    const timeout = () => {
      finish(reject, new Error('请求超时'));
      req.destroy();
    };
    req.on('timeout', timeout);
    totalTimer = setTimeout(timeout, remaining);
  });
}

async function loadYouTubeChannel(input) {
  const parsed = parseChannelInput(input);
  let channelId = parsed.channelId;
  if (!channelId) {
    const html = await fetchText(parsed.pageUrl, { maxBytes: 4000000, timeoutMs: 20000 });
    channelId = extractChannelId(html);
    if (!channelId) throw new Error('没有找到这个频道，请换用 youtube.com/channel/UC... 链接');
  }
  const rss = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  const feed = parseYouTubeRss(rss);
  if (!feed.videos.length) throw new Error('这个频道暂时没有可导入的视频');
  feed.videos = feed.videos.slice(0, 24);
  return {
    channelId,
    handle: parsed.handle,
    title: feed.title || parsed.handle || channelId,
    author: feed.author,
    pageUrl: parsed.pageUrl,
    videos: feed.videos,
  };
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

async function loadPodcastFeed(feedUrl) {
  const xml = await fetchText(feedUrl);
  const feed = parsePodcastRss(xml);
  if (!feed.title || !feed.episodes.length) throw new Error('这不是有效的播客 RSS');
  return { ...feed, episodes: feed.episodes.slice(0, 40), feedUrl: String(feedUrl || '').trim() };
}

async function loadTranscriptCues(url) {
  const text = await fetchText(url, { maxBytes: 1500000 });
  return parseVtt(text);
}

module.exports = {
  isPrivateHostname,
  assertPublicHttpUrl,
  normalizeProxyServer,
  parseChannelInput,
  parseYouTubeRss,
  parsePodcastRss,
  parseVtt,
  parseItunesResults,
  extractChannelId,
  fetchText,
  loadYouTubeChannel,
  searchPodcasts,
  loadPodcastFeed,
  loadTranscriptCues,
};
