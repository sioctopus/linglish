const { getSupportEmail } = require('../utils/support-email');
/**
 * SEO Routes - Server-Side Rendered pages for search engine indexing
 *
 * GET /learn/video/:id       - Video detail page (SSR)
 * GET /learn/word/:word      - Word detail page (SSR)
 * GET /learn/videos          - Video list page (paginated)
 * GET /learn/words           - Word list page (paginated, by frequency)
 * GET /sitemap.xml           - Sitemap index
 * GET /sitemap-videos.xml    - Video sitemap
 * GET /sitemap-words.xml     - Top-2000 words sitemap
 * GET /llms.txt              - AI-friendly site description
 * GET /.well-known/ai-plugin.json - AI agent discovery
 */

const dataStore = require('../data-store');
const {
  SEO_INDEXABLE_SQL,
  assessWordRecord,
  formatPhoneticForApi,
  normalizeDefinitions,
} = require('../services/dictionary/quality');

const { getPublicSiteUrl } = require('../utils/public-site-url');
const BASE_URL = getPublicSiteUrl();

// ─── HTML helpers ────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function difficultyBadge(level) {
  const map = {
    beginner: { label: '初级', color: '#10b981' },
    elementary: { label: '初级', color: '#10b981' },
    intermediate: { label: '中级', color: '#f59e0b' },
    advanced: { label: '高级', color: '#ef4444' },
    native: { label: '母语', color: '#8b5cf6' },
  };
  const d = map[(level || '').toLowerCase()] || { label: level || '通用', color: '#6b7280' };
  return `<span style="background:${d.color};color:#fff;padding:2px 10px;border-radius:12px;font-size:0.8rem;font-weight:600">${esc(d.label)}</span>`;
}

const PAGE_STYLE = `
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc; color: #1e293b; line-height: 1.6;
    }
    a { color: #059669; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .nav {
      background: #fff; border-bottom: 1px solid #e2e8f0; padding: 0 1.5rem;
      display: flex; align-items: center; justify-content: space-between;
      height: 56px; position: sticky; top: 0; z-index: 10;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    .nav-logo { font-size: 1.25rem; font-weight: 700; color: #059669; letter-spacing: -0.5px; }
    .nav-logo span { color: #1e293b; }
    .nav-links { display: flex; gap: 1.25rem; font-size: 0.9rem; }
    .btn-primary {
      background: #059669; color: #fff !important; padding: 6px 16px;
      border-radius: 8px; font-weight: 600; font-size: 0.875rem;
      display: inline-block; transition: background .15s;
    }
    .btn-primary:hover { background: #047857; text-decoration: none !important; }

    /* Layout */
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
    .card {
      background: #fff; border-radius: 12px; border: 1px solid #e2e8f0;
      padding: 1.5rem; margin-bottom: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,.04);
    }
    .tag {
      display: inline-block; background: #f0fdf4; color: #059669;
      border: 1px solid #bbf7d0; border-radius: 6px;
      padding: 2px 10px; font-size: 0.8rem; font-weight: 500;
    }
    .meta { color: #64748b; font-size: 0.875rem; display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
    h1 { font-size: 1.75rem; font-weight: 700; color: #0f172a; margin-bottom: .5rem; }
    h2 { font-size: 1.2rem; font-weight: 600; color: #1e293b; margin-bottom: .75rem; }

    /* Video embed */
    .video-wrap { position: relative; padding-bottom: 56.25%; background: #000; border-radius: 8px; overflow: hidden; }
    .video-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }

    /* Sentences */
    .sentence-item {
      padding: .875rem 0; border-bottom: 1px solid #f1f5f9;
      display: grid; grid-template-columns: 3rem 1fr; gap: .75rem; align-items: start;
    }
    .sentence-item:last-child { border-bottom: none; }
    .time-badge {
      background: #f0fdf4; color: #059669; border-radius: 6px; padding: 2px 6px;
      font-size: 0.75rem; font-weight: 600; white-space: nowrap; font-family: monospace;
      margin-top: 2px;
    }
    .sentence-en { font-weight: 500; color: #0f172a; margin-bottom: .2rem; }
    .sentence-zh { color: #64748b; font-size: 0.875rem; }

    /* Word page */
    .phonetic { color: #64748b; font-size: 1.1rem; font-style: italic; }
    .definition-item { padding: .5rem 0; border-bottom: 1px solid #f1f5f9; }
    .definition-item:last-child { border-bottom: none; }
    .pos { color: #059669; font-weight: 600; font-style: italic; font-size: 0.85rem; }
    .example { color: #475569; font-size: 0.9rem; padding: .4rem .75rem; background: #f8fafc; border-left: 3px solid #bbf7d0; border-radius: 0 4px 4px 0; margin-top: .3rem; }

    /* List pages */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
    .list-card {
      background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1rem;
      transition: box-shadow .15s, transform .15s;
    }
    .list-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.08); transform: translateY(-1px); }
    .list-card h3 { font-size: 1rem; font-weight: 600; color: #0f172a; margin-bottom: .3rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-card p { font-size: 0.82rem; color: #64748b; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .list-card .card-meta { display: flex; justify-content: space-between; align-items: center; margin-top: .6rem; }

    /* Pagination */
    .pagination { display: flex; gap: .5rem; justify-content: center; margin-top: 2rem; flex-wrap: wrap; }
    .pagination a, .pagination span {
      padding: 6px 14px; border-radius: 8px; font-size: 0.875rem; font-weight: 500;
      border: 1px solid #e2e8f0; background: #fff; color: #1e293b;
    }
    .pagination a:hover { background: #f0fdf4; border-color: #bbf7d0; text-decoration: none; }
    .pagination .active { background: #059669; color: #fff; border-color: #059669; }

    /* CTA */
    .cta-block {
      background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
      border: 1px solid #bbf7d0; border-radius: 12px; padding: 2rem 1.5rem;
      text-align: center; margin-top: 2.5rem;
    }
    .cta-block h3 { font-size: 1.25rem; color: #065f46; margin-bottom: .5rem; }
    .cta-block p { color: #047857; font-size: 0.9rem; margin-bottom: 1rem; }

    /* Footer */
    .footer { text-align: center; padding: 2rem 1rem; color: #94a3b8; font-size: 0.8rem; border-top: 1px solid #e2e8f0; margin-top: 3rem; }

    @media (max-width: 640px) {
      h1 { font-size: 1.4rem; }
      .nav-links .hide-mobile { display: none; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
`;

function navHtml() {
  return `
  <nav class="nav">
    <a class="nav-logo" href="/">Ling<span>lish</span></a>
    <div class="nav-links">
      <a href="/learn/videos" class="hide-mobile">视频库</a>
      <a href="/learn/words" class="hide-mobile">词汇表</a>
      <a href="/" class="btn-primary">免费学习</a>
    </div>
  </nav>`;
}

function footerHtml() {
  return `
  <footer class="footer">
    <p>© ${new Date().getFullYear()} Linglish · AI 驱动的英语学习平台</p>
    <p style="margin-top:.3rem"><a href="/">首页</a> · <a href="/learn/videos">视频库</a> · <a href="/learn/words">词汇表</a></p>
  </footer>`;
}

function htmlPage({ title, description, canonical, head = '', body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" type="text/plain" href="${BASE_URL}/llms.txt" title="Linglish AI content guide">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="Linglish">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${head}
${PAGE_STYLE}
</head>
<body>
${navHtml()}
${body}
${footerHtml()}
</body>
</html>`;
}

function sendHtml(res, html, status = 200) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=600, stale-while-revalidate=3600',
  });
  res.end(res._linglishHeadOnly ? undefined : buf);
}

function sendXml(res, xml) {
  const buf = Buffer.from(xml, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(res._linglishHeadOnly ? undefined : buf);
}

function sendText(res, text, contentType = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(res._linglishHeadOnly ? undefined : buf);
}

function sendHead(res, contentType, cacheControl) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  res.end();
}

// ─── Route: /learn/video/:id ──────────────────────────────────────────────────

async function handleVideoDetail(res, id) {
  if (!/^\d+$/.test(id)) {
    return sendHtml(res, htmlPage({
      title: '视频未找到 - Linglish',
      description: '该视频不存在。',
      canonical: `${BASE_URL}/learn/videos`,
      body: `<div class="container"><div class="card"><p>视频未找到。<a href="/learn/videos">浏览所有视频</a></p></div></div>`,
    }), 404);
  }

  const [videoResult, sentencesResult] = await Promise.all([
    dataStore.query(
      `SELECT id, title, description, difficulty_level, duration_sec, youtube_video_id, thumbnail_path, tags, category
       FROM video_resources WHERE id = $1 AND is_public = true AND status = 'ready'`,
      [parseInt(id, 10)]
    ),
    dataStore.query(
      `SELECT sentence_index, text, start_time_sec, speaker
       FROM video_sentences WHERE video_id = $1
       ORDER BY sentence_index ASC LIMIT 200`,
      [parseInt(id, 10)]
    ),
  ]);

  const video = videoResult.rows[0];
  if (!video) {
    return sendHtml(res, htmlPage({
      title: '视频未找到 - Linglish',
      description: '该视频不存在或已下线。',
      canonical: `${BASE_URL}/learn/videos`,
      body: `<div class="container"><div class="card"><p>视频未找到。<a href="/learn/videos">浏览所有视频</a></p></div></div>`,
    }), 404);
  }

  const sentences = sentencesResult.rows;
  const ytId = video.youtube_video_id;
  const pageTitle = `${video.title} - 英语学习 | Linglish`;
  const pageDesc = video.description
    ? video.description.slice(0, 160)
    : `在 Linglish 上学习视频《${video.title}》，包含中英字幕对照和词汇练习。`;
  const canonical = `${BASE_URL}/learn/video/${video.id}`;

  // Structured data
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description: pageDesc,
    url: canonical,
    ...(ytId ? { embedUrl: `https://www.youtube.com/embed/${ytId}` } : {}),
    ...(video.thumbnail_path ? { thumbnailUrl: `${BASE_URL}${video.thumbnail_path}` } : {}),
    ...(video.duration_sec ? { duration: `PT${Math.floor(video.duration_sec / 60)}M${video.duration_sec % 60}S` } : {}),
    educationalLevel: video.difficulty_level || 'intermediate',
    inLanguage: 'en',
    publisher: { '@type': 'Organization', name: 'Linglish', url: BASE_URL },
  };

  // Video embed or placeholder
  let embedHtml = '';
  if (ytId) {
    embedHtml = `
    <div class="card">
      <div class="video-wrap">
        <iframe src="https://www.youtube-nocookie.com/embed/${esc(ytId)}"
          title="${esc(video.title)}" allowfullscreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
        </iframe>
      </div>
    </div>`;
  }

  // Sentences list
  let sentencesHtml = '';
  if (sentences.length > 0) {
    const items = sentences.map(s => `
      <div class="sentence-item">
        <div><span class="time-badge">${formatDuration(Math.round(s.start_time_sec))}</span></div>
        <div>
          <div class="sentence-en">${esc(s.text)}</div>
        </div>
      </div>`).join('');
    sentencesHtml = `
    <div class="card">
      <h2>字幕文本（${sentences.length} 句）</h2>
      ${items}
    </div>`;
  }

  const tagsHtml = (video.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');

  const body = `
  <div class="container">
    <div style="margin-bottom:1rem">
      <a href="/learn/videos" style="color:#64748b;font-size:.875rem">← 返回视频库</a>
    </div>

    <div class="card">
      <h1>${esc(video.title)}</h1>
      <div class="meta" style="margin-top:.5rem">
        ${difficultyBadge(video.difficulty_level)}
        ${video.duration_sec ? `<span>⏱ ${formatDuration(video.duration_sec)}</span>` : ''}
        ${video.category ? `<span class="tag">${esc(video.category)}</span>` : ''}
        ${tagsHtml}
      </div>
      ${video.description ? `<p style="margin-top:1rem;color:#475569">${esc(video.description)}</p>` : ''}
    </div>

    ${embedHtml}

    ${sentencesHtml}

    <div class="cta-block">
      <h3>在 Linglish 上深度学习这个视频</h3>
      <p>AI 助手 · 单词高亮 · 影子跟读 · 间隔重复 · 完全免费</p>
      <a href="/" class="btn-primary">立即免费学习</a>
    </div>
  </div>`;

  const head = `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>`;

  sendHtml(res, htmlPage({ title: pageTitle, description: pageDesc, canonical, head, body }));
}

// ─── Route: /learn/word/:word ─────────────────────────────────────────────────

async function handleWordDetail(res, word) {
  const clean = decodeURIComponent(word).trim().toLowerCase().slice(0, 100);
  if (!clean || !/^[a-zA-Z\-']+$/.test(clean)) {
    return sendHtml(res, htmlPage({
      title: '单词未找到 - Linglish',
      description: '该单词不存在。',
      canonical: `${BASE_URL}/learn/words`,
      body: `<div class="container"><div class="card"><p>单词未找到。<a href="/learn/words">浏览词汇表</a></p></div></div>`,
    }), 404);
  }

  const result = await dataStore.query(
    `SELECT id, word, word_lowercase, part_of_speech, frequency_rank, difficulty_level,
            definitions, phonetic, example_sentences, synonyms,
            content_revision, phonetic_source, definitions_source, zh_source,
            part_of_speech_source, quality_status, quality_score, quality_reasons,
            quality_meta, quality_checked_revision, quality_checked_at, seo_indexable,
            dictionary_word_is_seo_eligible(words) AS seo_eligible
     FROM words WHERE word_lowercase = $1`,
    [clean]
  );

  const w = result.rows[0];
  if (!w) {
    return sendHtml(res, htmlPage({
      title: `"${clean}" - 单词未收录 | Linglish`,
      description: `${clean} 暂未收录，欢迎在 Linglish 上查询更多英语词汇。`,
      canonical: `${BASE_URL}/learn/words`,
      body: `<div class="container"><div class="card"><p>单词 "<strong>${esc(clean)}</strong>" 暂未收录。<a href="/learn/words">浏览词汇表</a></p></div></div>`,
    }), 404);
  }

  const canonical = `${BASE_URL}/learn/word/${encodeURIComponent(w.word)}`;
  const pageTitle = `${w.word} 是什么意思？英语单词详解 | Linglish`;
  const quality = assessWordRecord(w);
  const seoEligible = w.seo_eligible == null
    ? quality.seo_indexable
    : Boolean(w.seo_indexable && w.seo_eligible);

  // Parse definitions
  const meanings = normalizeDefinitions(w.definitions, { partOfSpeech: w.part_of_speech });
  const defs = meanings.flatMap((meaning) => (meaning.definitions || []).map((definition) => ({
    ...definition,
    part_of_speech: meaning.partOfSpeech,
  })));

  // Build short description from first definition
  let shortDef = '';
  if (defs.length > 0) {
    const first = defs[0];
    shortDef = first.definition || first.meaning || first.text || (typeof first === 'string' ? first : '');
  }
  const apiPhonetic = formatPhoneticForApi(w.phonetic);
  const pageDesc = `${w.word}${apiPhonetic ? ` ${apiPhonetic}` : ''} 的中文释义、例句和用法。${shortDef ? shortDef.slice(0, 100) : ''}`;

  // Parse example sentences
  let examples = [];
  try {
    examples = Array.isArray(w.example_sentences) ? w.example_sentences : (typeof w.example_sentences === 'string' ? JSON.parse(w.example_sentences) : []);
  } catch (_) {}

  // Structured data
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: w.word,
    description: shortDef || pageDesc,
    url: canonical,
    inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Linglish English Dictionary', url: `${BASE_URL}/learn/words` },
  };

  // Definitions HTML
  const defsHtml = defs.length > 0
    ? defs.slice(0, 6).map(d => {
        const def = d.definition || d.meaning || d.text || (typeof d === 'string' ? d : '');
        const pos = d.part_of_speech || d.pos || '';
        const ex = d.example || d.examples?.[0] || '';
        return `<div class="definition-item">
          ${pos ? `<span class="pos">${esc(pos)}</span> ` : ''}
          <span>${esc(def)}</span>
          ${ex ? `<div class="example">${esc(ex)}</div>` : ''}
        </div>`;
      }).join('')
    : '<p style="color:#94a3b8">暂无释义</p>';

  // Examples HTML
  const examplesHtml = examples.slice(0, 5).map(e => {
    const text = e.sentence || e.text || (typeof e === 'string' ? e : '');
    return text ? `<div class="example" style="margin-bottom:.5rem">${esc(text)}</div>` : '';
  }).join('');

  const synonymsHtml = (w.synonyms || []).slice(0, 8).map(s =>
    `<a href="/learn/word/${encodeURIComponent(s)}" class="tag" style="margin:.2rem">${esc(s)}</a>`
  ).join('');

  const body = `
  <div class="container">
    <div style="margin-bottom:1rem">
      <a href="/learn/words" style="color:#64748b;font-size:.875rem">← 返回词汇表</a>
    </div>

    <div class="card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:.75rem">
        <div>
          <h1 style="font-size:2.5rem;margin-bottom:.3rem">${esc(w.word)}</h1>
          ${apiPhonetic ? `<p class="phonetic">${esc(apiPhonetic)}</p>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end">
          ${difficultyBadge(w.difficulty_level)}
          ${w.frequency_rank ? `<span style="color:#94a3b8;font-size:.8rem">频率排名 #${w.frequency_rank}</span>` : ''}
        </div>
      </div>
      ${w.part_of_speech ? `<div style="margin-top:.5rem"><span class="tag">${esc(w.part_of_speech)}</span></div>` : ''}
    </div>

    <div class="card">
      <h2>释义</h2>
      ${defsHtml}
    </div>

    ${examplesHtml ? `<div class="card"><h2>例句</h2>${examplesHtml}</div>` : ''}

    ${synonymsHtml ? `<div class="card"><h2>近义词</h2><div style="display:flex;flex-wrap:wrap;gap:.3rem">${synonymsHtml}</div></div>` : ''}

    <div class="cta-block">
      <h3>在 Linglish 上掌握 "${esc(w.word)}"</h3>
      <p>AI 记忆曲线 · 真实语境例句 · 间隔重复复习 · 完全免费</p>
      <a href="/" class="btn-primary">立即免费学习</a>
    </div>
  </div>`;

  const head = seoEligible
    ? `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>`
    : '<meta name="robots" content="noindex, follow">';

  if (!seoEligible) {
    res.setHeader('X-Robots-Tag', 'noindex, follow');
  }

  sendHtml(res, htmlPage({ title: pageTitle, description: pageDesc, canonical, head, body }));
}

// ─── Route: /learn/videos ─────────────────────────────────────────────────────

async function handleVideoList(res, url) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 20;
  const offset = (page - 1) * limit;

  const [countResult, videosResult] = await Promise.all([
    dataStore.query(`SELECT COUNT(*) FROM video_resources WHERE is_public = true AND status = 'ready'`),
    dataStore.query(
      `SELECT id, title, description, difficulty_level, duration_sec, youtube_video_id, thumbnail_path, category
       FROM video_resources WHERE is_public = true AND status = 'ready'
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  const totalPages = Math.ceil(total / limit);
  const videos = videosResult.rows;

  const canonical = `${BASE_URL}/learn/videos${page > 1 ? `?page=${page}` : ''}`;
  const pageTitle = page === 1
    ? '英语学习视频库 | Linglish - AI驱动英语学习'
    : `英语学习视频库 第${page}页 | Linglish`;
  const pageDesc = `Linglish 收录 ${total} 个英语学习视频，中英字幕对照，AI 词汇辅助，影子跟读练习。`;

  const cards = videos.map(v => {
    const thumb = v.thumbnail_path
      ? `<img src="${esc(v.thumbnail_path)}" alt="${esc(v.title)}" loading="lazy" style="width:100%;height:140px;object-fit:cover;border-radius:6px;margin-bottom:.75rem">`
      : `<div style="height:80px;background:#f0fdf4;border-radius:6px;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem;color:#059669;font-size:2rem">▶</div>`;
    return `
    <a href="/learn/video/${v.id}" class="list-card" style="display:block;color:inherit">
      ${thumb}
      <h3>${esc(v.title)}</h3>
      <p>${esc((v.description || '').slice(0, 80))}</p>
      <div class="card-meta">
        ${difficultyBadge(v.difficulty_level)}
        ${v.duration_sec ? `<span style="color:#94a3b8;font-size:.8rem">⏱ ${formatDuration(v.duration_sec)}</span>` : ''}
      </div>
    </a>`;
  }).join('');

  // Pagination
  let paginationHtml = '<div class="pagination">';
  if (page > 1) paginationHtml += `<a href="/learn/videos?page=${page - 1}">上一页</a>`;
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i++) {
    if (i === page) paginationHtml += `<span class="active">${i}</span>`;
    else paginationHtml += `<a href="/learn/videos?page=${i}">${i}</a>`;
  }
  if (page < totalPages) paginationHtml += `<a href="/learn/videos?page=${page + 1}">下一页</a>`;
  paginationHtml += '</div>';

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: pageTitle,
    description: pageDesc,
    url: canonical,
    numberOfItems: total,
  };

  const head = `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>`;
  const body = `
  <div class="container">
    <div style="margin-bottom:1.5rem">
      <h1>英语学习视频库</h1>
      <p style="color:#64748b;margin-top:.3rem">共 ${total} 个视频 · 中英字幕 · AI 辅助学习</p>
    </div>
    <div class="grid">${cards}</div>
    ${totalPages > 1 ? paginationHtml : ''}
  </div>`;

  sendHtml(res, htmlPage({ title: pageTitle, description: pageDesc, canonical, head, body }));
}

// ─── Route: /learn/words ─────────────────────────────────────────────────────

async function handleWordList(res, url) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 40;
  const offset = (page - 1) * limit;

  const [countResult, wordsResult] = await Promise.all([
    dataStore.query(`SELECT COUNT(*) FROM words WHERE ${SEO_INDEXABLE_SQL}`),
    dataStore.query(
      `SELECT id, word, part_of_speech, frequency_rank, difficulty_level, definitions, phonetic
       FROM words WHERE ${SEO_INDEXABLE_SQL}
       ORDER BY frequency_rank ASC NULLS LAST, id ASC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  const totalPages = Math.ceil(total / limit);
  const words = wordsResult.rows;

  const canonical = `${BASE_URL}/learn/words${page > 1 ? `?page=${page}` : ''}`;
  const pageTitle = page === 1
    ? `英语词汇表 ${total.toLocaleString()} 个单词 | Linglish`
    : `英语词汇表 第${page}页 | Linglish`;
  const pageDesc = `Linglish 收录 ${total.toLocaleString()} 个英语单词，包含音标、释义、例句和难度分级。`;

  const cards = words.map(w => {
    let shortDef = '';
    try {
      const meanings = normalizeDefinitions(w.definitions, { partOfSpeech: w.part_of_speech });
      shortDef = meanings[0]?.definitions?.[0]?.definition || '';
    } catch (_) {}
    return `
    <a href="/learn/word/${encodeURIComponent(w.word)}" class="list-card" style="display:block;color:inherit">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:.3rem">
        <h3 style="white-space:normal">${esc(w.word)}</h3>
        ${w.phonetic ? `<span style="color:#94a3b8;font-size:.75rem;font-style:italic;flex-shrink:0;margin-left:.5rem">${esc(formatPhoneticForApi(w.phonetic))}</span>` : ''}
      </div>
      <p>${esc(shortDef.slice(0, 70))}</p>
      <div class="card-meta" style="margin-top:.5rem">
        ${difficultyBadge(w.difficulty_level)}
        ${w.frequency_rank ? `<span style="color:#94a3b8;font-size:.75rem">#${w.frequency_rank}</span>` : ''}
      </div>
    </a>`;
  }).join('');

  let paginationHtml = '<div class="pagination">';
  if (page > 1) paginationHtml += `<a href="/learn/words?page=${page - 1}">上一页</a>`;
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i++) {
    if (i === page) paginationHtml += `<span class="active">${i}</span>`;
    else paginationHtml += `<a href="/learn/words?page=${i}">${i}</a>`;
  }
  if (page < totalPages) paginationHtml += `<a href="/learn/words?page=${page + 1}">下一页</a>`;
  paginationHtml += '</div>';

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: pageTitle,
    description: pageDesc,
    url: canonical,
    numberOfItems: total,
  };

  const head = `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>`;
  const body = `
  <div class="container">
    <div style="margin-bottom:1.5rem">
      <h1>英语词汇表</h1>
      <p style="color:#64748b;margin-top:.3rem">共 ${total.toLocaleString()} 个单词 · 音标 · 释义 · 难度分级</p>
    </div>
    <div class="grid">${cards}</div>
    ${totalPages > 1 ? paginationHtml : ''}
  </div>`;

  sendHtml(res, htmlPage({ title: pageTitle, description: pageDesc, canonical, head, body }));
}

// ─── Route: /sitemap.xml (index) ──────────────────────────────────────────────

async function handleSitemapIndex(res) {
  const now = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${BASE_URL}/sitemap-main.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${BASE_URL}/sitemap-videos.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${BASE_URL}/sitemap-words.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
</sitemapindex>`;
  sendXml(res, xml);
}

// ─── Route: /sitemap-main.xml ─────────────────────────────────────────────────

async function handleSitemapMain(res) {
  const staticUrls = [
    { loc: `${BASE_URL}/`, priority: '1.0', changefreq: 'weekly' },
    { loc: `${BASE_URL}/download`, priority: '0.8', changefreq: 'weekly' },
    { loc: `${BASE_URL}/interview`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${BASE_URL}/workplace`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${BASE_URL}/shadowing`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${BASE_URL}/pricing.html`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${BASE_URL}/privacy.html`, priority: '0.3', changefreq: 'yearly' },
    { loc: `${BASE_URL}/terms.html`, priority: '0.3', changefreq: 'yearly' },
    { loc: `${BASE_URL}/learn/videos`, priority: '0.9', changefreq: 'daily' },
    { loc: `${BASE_URL}/learn/words`, priority: '0.9', changefreq: 'weekly' },
  ];
  const entries = staticUrls.map(u => `
  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
  sendXml(res, xml);
}

// ─── Route: /sitemap-videos.xml ───────────────────────────────────────────────

async function handleSitemapVideos(res) {
  const result = await dataStore.query(
    `SELECT id, updated_at FROM video_resources WHERE is_public = true AND status = 'ready' ORDER BY id ASC`
  );
  const entries = result.rows.map(v => {
    const lastmod = v.updated_at ? new Date(v.updated_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    return `
  <url>
    <loc>${BASE_URL}/learn/video/${v.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
  sendXml(res, xml);
}

// ─── Route: /sitemap-words.xml ────────────────────────────────────────────────

async function handleSitemapWords(res) {
  const result = await dataStore.query(
    `SELECT word, updated_at FROM words WHERE ${SEO_INDEXABLE_SQL}
     ORDER BY frequency_rank ASC NULLS LAST LIMIT 2000`
  );
  const entries = result.rows.map(w => {
    const updatedAt = w.updated_at ? new Date(w.updated_at) : null;
    const lastmod = updatedAt && !Number.isNaN(updatedAt.getTime())
      ? `\n    <lastmod>${updatedAt.toISOString().split('T')[0]}</lastmod>`
      : '';
    return `
  <url>
    <loc>${BASE_URL}/learn/word/${encodeURIComponent(w.word)}</loc>${lastmod}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
  sendXml(res, xml);
}

// ─── Route: /llms.txt ─────────────────────────────────────────────────────────

function handleLlmsTxt(res) {
  const text = `# Linglish

> 面向中文母语者的 AI 英语教练，把真实英语内容变成可执行的听说训练与复习闭环。

Canonical website: ${BASE_URL}/

## What is Linglish?

Linglish is an AI-powered English learning platform designed for Chinese speakers. It combines:
- Authentic video content with bilingual subtitles (English/Chinese)
- Sentence-by-sentence listening and shadowing practice
- AI-assisted daily plan based on level, goals, and learning history
- AI speech feedback for omissions, pronunciation, rhythm, and expression choices
- Contextual vocabulary collection and spaced review
- Weekly learning summaries and next-step recommendations

## Key Resources

- Product overview: ${BASE_URL}/ — how Linglish turns authentic content into a daily learning loop
- Video library: ${BASE_URL}/learn/videos — public English learning videos with timestamped transcripts
- Vocabulary: ${BASE_URL}/learn/words — English words with definitions, phonetics, examples, and difficulty levels
- Interview English: ${BASE_URL}/interview
- Workplace English: ${BASE_URL}/workplace
- Shadowing practice: ${BASE_URL}/shadowing

## Featured Vocabulary Guides

- meeting: ${BASE_URL}/learn/word/meeting
- the: ${BASE_URL}/learn/word/the
- and: ${BASE_URL}/learn/word/and
- have: ${BASE_URL}/learn/word/have

## Content

All video transcripts are available at ${BASE_URL}/learn/video/[id]. Each page includes:
- Full English transcript with timestamps
- Embedded YouTube player (when available)
- Vocabulary highlighted by difficulty level

Word definitions are at ${BASE_URL}/learn/word/[word]. Each page includes:
- Phonetic transcription (IPA)
- Definitions with part of speech
- Example sentences
- Related words and synonyms

## Contact

Website: ${BASE_URL}/
Support: ${getSupportEmail()}
`;
  sendText(res, text);
}

// ─── Route: /.well-known/ai-plugin.json ───────────────────────────────────────

function handleAiPlugin(res) {
  const plugin = {
    schema_version: 'v1',
    name_for_human: 'Linglish',
    name_for_model: 'linglish',
    description_for_human: 'AI-powered English learning platform for Chinese speakers. Access video transcripts and vocabulary.',
    description_for_model: 'Use Linglish to look up English words with definitions, phonetics, and examples, or browse video transcripts for language learning content. Base URL: ' + BASE_URL,
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: `${BASE_URL}/.well-known/openapi.json`,
    },
    logo_url: `${BASE_URL}/favicon.ico`,
    contact_email: getSupportEmail(),
    legal_info_url: `${BASE_URL}/`,
  };
  sendText(res, JSON.stringify(plugin, null, 2), 'application/json; charset=utf-8');
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function registerSeoRoutes(pathname, req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const isHead = req.method === 'HEAD';
  res._linglishHeadOnly = isHead;

  if (isHead) {
    if (/^\/learn\/(?:videos|words)$/.test(pathname)) {
      sendHead(res, 'text/html; charset=utf-8', 'public, max-age=600, stale-while-revalidate=3600');
      return true;
    }
    if (/^\/sitemap(?:-main|-videos|-words)?\.xml$/.test(pathname)) {
      sendHead(res, 'application/xml; charset=utf-8', 'public, max-age=3600');
      return true;
    }
    if (pathname === '/llms.txt') {
      sendHead(res, 'text/plain; charset=utf-8', 'public, max-age=86400');
      return true;
    }
    if (pathname === '/.well-known/ai-plugin.json') {
      sendHead(res, 'application/json; charset=utf-8', 'public, max-age=86400');
      return true;
    }
  }

  // /learn/video/:id
  const videoMatch = pathname.match(/^\/learn\/video\/(\d+)$/);
  if (videoMatch) {
    await handleVideoDetail(res, videoMatch[1]);
    return true;
  }

  // /learn/word/:word
  const wordMatch = pathname.match(/^\/learn\/word\/([^/]+)$/);
  if (wordMatch) {
    await handleWordDetail(res, wordMatch[1]);
    return true;
  }

  // /learn/videos
  if (pathname === '/learn/videos') {
    await handleVideoList(res, url);
    return true;
  }

  // /learn/words
  if (pathname === '/learn/words') {
    await handleWordList(res, url);
    return true;
  }

  // /sitemap.xml  → sitemap index
  if (pathname === '/sitemap.xml') {
    await handleSitemapIndex(res);
    return true;
  }

  // /sitemap-main.xml
  if (pathname === '/sitemap-main.xml') {
    await handleSitemapMain(res);
    return true;
  }

  // /sitemap-videos.xml
  if (pathname === '/sitemap-videos.xml') {
    await handleSitemapVideos(res);
    return true;
  }

  // /sitemap-words.xml
  if (pathname === '/sitemap-words.xml') {
    await handleSitemapWords(res);
    return true;
  }

  // /llms.txt
  if (pathname === '/llms.txt') {
    handleLlmsTxt(res);
    return true;
  }

  // /.well-known/ai-plugin.json
  if (pathname === '/.well-known/ai-plugin.json') {
    handleAiPlugin(res);
    return true;
  }

  return false;
}

module.exports = { registerSeoRoutes };
