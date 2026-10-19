/**
 * Workbench template catalog + HTML renderers.
 * Keep templates data-driven so a future template market can plug in.
 */
(function (global) {
  'use strict';

  const TEMPLATES = [
    { id: 'intensive-note', role: 'teacher', name: '精读笔记', desc: '逐句精读 + 单词标注' },
    { id: 'homework', role: 'teacher', name: '作业单', desc: '跟读任务 + 默写清单' },
    { id: 'lesson-handout', role: 'teacher', name: '课堂讲义', desc: '标题 + 重点表达' },
    { id: 'word-cards', role: 'teacher', name: '单词卡组', desc: '词汇卡片网格' },
    { id: 'xhs-long', role: 'blogger', name: '小红书长图', desc: '适合竖版长图发布' },
    { id: 'quote-card', role: 'blogger', name: '金句卡片', desc: '一句金句主视觉' },
    { id: 'video-script', role: 'blogger', name: '视频脚本页', desc: '口播脚本分镜' },
    { id: 'traffic-cover', role: 'blogger', name: '引流封面', desc: '带练习入口引导' },
  ];

  /** Fixed color + font themes — more stable than ad-hoc color picks. */
  const FONT_UI = 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif';
  const FONT_CN = '"PingFang SC", "Microsoft YaHei", sans-serif';
  const FONT_SERIF = 'Georgia, "Songti SC", "SimSun", serif';

  const STYLE_THEMES = [
    { id: 'teal-day', name: '青绿日间', desc: '白底默认', fontFamily: FONT_UI, textColor: '#0f172a', accentColor: '#0f766e', background: '#ffffff', highlightColor: '#ccfbf1' },
    { id: 'mint-soft', name: '薄荷浅底', desc: '课堂讲义', fontFamily: FONT_UI, textColor: '#134e4a', accentColor: '#0d9488', background: '#f0fdfa', highlightColor: '#99f6e4' },
    { id: 'ink-paper', name: '墨纸讲义', desc: '打印友好', fontFamily: FONT_CN, textColor: '#1e293b', accentColor: '#0369a1', background: '#f8fafc', highlightColor: '#e0f2fe' },
    { id: 'slate-card', name: '石板卡片', desc: '中性灰底', fontFamily: FONT_UI, textColor: '#0f172a', accentColor: '#0f766e', background: '#f1f5f9', highlightColor: '#cbd5e1' },
    { id: 'chalkboard', name: '黑板课堂', desc: '深色投影', fontFamily: FONT_CN, textColor: '#f8fafc', accentColor: '#2dd4bf', background: '#0f172a', highlightColor: '#115e59' },
    { id: 'night-teal', name: '夜读青绿', desc: '深色护眼', fontFamily: FONT_UI, textColor: '#ecfdf5', accentColor: '#5eead4', background: '#042f2e', highlightColor: '#134e4a' },
    { id: 'ocean-breeze', name: '海风蓝', desc: '清爽日间', fontFamily: FONT_UI, textColor: '#0c4a6e', accentColor: '#0284c7', background: '#f0f9ff', highlightColor: '#bae6fd' },
    { id: 'sky-note', name: '晴空笔记', desc: '浅蓝卡片', fontFamily: FONT_UI, textColor: '#1e3a5f', accentColor: '#2563eb', background: '#ffffff', highlightColor: '#dbeafe' },
    { id: 'deep-sea', name: '深海蓝', desc: '夜间阅读', fontFamily: FONT_UI, textColor: '#e0f2fe', accentColor: '#38bdf8', background: '#0c4a6e', highlightColor: '#075985' },
    { id: 'indigo-desk', name: '靛蓝书桌', desc: '专注深色', fontFamily: FONT_UI, textColor: '#eef2ff', accentColor: '#818cf8', background: '#1e1b4b', highlightColor: '#312e81' },
    { id: 'forest-leaf', name: '林间绿', desc: '自然浅底', fontFamily: FONT_UI, textColor: '#14532d', accentColor: '#15803d', background: '#f0fdf4', highlightColor: '#bbf7d0' },
    { id: 'moss-board', name: '苔藓板', desc: '深绿投影', fontFamily: FONT_CN, textColor: '#ecfdf5', accentColor: '#4ade80', background: '#14532d', highlightColor: '#166534' },
    { id: 'olive-study', name: '橄榄书房', desc: '柔和打印', fontFamily: FONT_SERIF, textColor: '#3f6212', accentColor: '#65a30d', background: '#f7fee7', highlightColor: '#d9f99d' },
    { id: 'sand-paper', name: '沙纸暖底', desc: '护眼米白', fontFamily: FONT_SERIF, textColor: '#44403c', accentColor: '#b45309', background: '#faf7f2', highlightColor: '#fde68a' },
    { id: 'kraft-note', name: '牛皮纸感', desc: '手作讲义', fontFamily: FONT_SERIF, textColor: '#431407', accentColor: '#c2410c', background: '#fff7ed', highlightColor: '#fed7aa' },
    { id: 'amber-lamp', name: '琥珀台灯', desc: '暖色夜读', fontFamily: FONT_UI, textColor: '#fffbeb', accentColor: '#fbbf24', background: '#451a03', highlightColor: '#78350f' },
    { id: 'sunset-card', name: '晚霞卡片', desc: '温暖分享', fontFamily: FONT_UI, textColor: '#7c2d12', accentColor: '#ea580c', background: '#fff7ed', highlightColor: '#fdba74' },
    { id: 'rose-memo', name: '玫瑰便签', desc: '轻柔强调', fontFamily: FONT_UI, textColor: '#881337', accentColor: '#e11d48', background: '#fff1f2', highlightColor: '#fecdd3' },
    { id: 'coral-board', name: '珊瑚板', desc: '活力课堂', fontFamily: FONT_UI, textColor: '#9f1239', accentColor: '#f43f5e', background: '#ffffff', highlightColor: '#ffe4e6' },
    { id: 'berry-night', name: '浆果夜色', desc: '深色对比', fontFamily: FONT_UI, textColor: '#fff1f2', accentColor: '#fb7185', background: '#4c0519', highlightColor: '#9f1239' },
    { id: 'grape-note', name: '葡萄笔记', desc: '紫调浅底', fontFamily: FONT_UI, textColor: '#4c1d95', accentColor: '#7c3aed', background: '#f5f3ff', highlightColor: '#ddd6fe' },
    { id: 'lavender-soft', name: '薰衣草', desc: '柔和日间', fontFamily: FONT_UI, textColor: '#312e81', accentColor: '#6366f1', background: '#eef2ff', highlightColor: '#c7d2fe' },
    { id: 'plum-desk', name: '梅紫书桌', desc: '深色沉浸', fontFamily: FONT_CN, textColor: '#faf5ff', accentColor: '#c084fc', background: '#3b0764', highlightColor: '#6b21a8' },
    { id: 'coffee-study', name: '咖啡书房', desc: '暖棕阅读', fontFamily: FONT_SERIF, textColor: '#292524', accentColor: '#a16207', background: '#fafaf9', highlightColor: '#e7e5e4' },
    { id: 'cocoa-board', name: '可可黑板', desc: '深棕投影', fontFamily: FONT_CN, textColor: '#fafaf9', accentColor: '#d6d3d1', background: '#1c1917', highlightColor: '#44403c' },
    { id: 'graphite', name: '石墨灰', desc: '高对比打印', fontFamily: FONT_CN, textColor: '#111827', accentColor: '#374151', background: '#ffffff', highlightColor: '#e5e7eb' },
    { id: 'zinc-card', name: '锌灰卡片', desc: '中性商务', fontFamily: FONT_UI, textColor: '#18181b', accentColor: '#52525b', background: '#fafafa', highlightColor: '#e4e4e7' },
    { id: 'mono-night', name: '单色夜读', desc: '低刺激深色', fontFamily: FONT_UI, textColor: '#f4f4f5', accentColor: '#a1a1aa', background: '#18181b', highlightColor: '#3f3f46' },
    { id: 'high-contrast', name: '高对比', desc: '无读友好', fontFamily: FONT_CN, textColor: '#000000', accentColor: '#0f766e', background: '#ffffff', highlightColor: '#fef08a' },
    { id: 'lemon-desk', name: '柠檬书桌', desc: '明亮提神', fontFamily: FONT_UI, textColor: '#422006', accentColor: '#ca8a04', background: '#fefce8', highlightColor: '#fde047' },

    // Grokbot / robot console
    { id: 'grok-night', name: 'Grok 夜控', desc: '机器人深色', fontFamily: FONT_UI, textColor: '#f5f5f4', accentColor: '#ff6b2c', background: '#0a0a0a', highlightColor: '#292524' },
    { id: 'grok-circuit', name: 'Grok 电路', desc: '青光面板', fontFamily: FONT_UI, textColor: '#e2e8f0', accentColor: '#22d3ee', background: '#111827', highlightColor: '#1e3a5f' },
    { id: 'grok-ember', name: 'Grok 余烬', desc: '琥珀警报', fontFamily: FONT_UI, textColor: '#fff7ed', accentColor: '#fb923c', background: '#171717', highlightColor: '#431407' },
    { id: 'grok-steel', name: 'Grok 钢壳', desc: '银灰机甲', fontFamily: FONT_UI, textColor: '#f8fafc', accentColor: '#94a3b8', background: '#0f172a', highlightColor: '#334155' },
    { id: 'grok-matrix', name: 'Grok 矩阵', desc: '绿码终端', fontFamily: FONT_UI, textColor: '#d1fae5', accentColor: '#34d399', background: '#022c22', highlightColor: '#064e3b' },
    { id: 'grok-daybot', name: 'Grok 日间', desc: '浅底机器人', fontFamily: FONT_UI, textColor: '#1c1917', accentColor: '#ea580c', background: '#fafaf9', highlightColor: '#ffedd5' },

    // American poster
    { id: 'usa-poster', name: '美式海报', desc: '红白蓝经典', fontFamily: FONT_CN, textColor: '#002868', accentColor: '#bf0a30', background: '#ffffff', highlightColor: '#e8eef7' },
    { id: 'usa-navy', name: '海军海报', desc: '深蓝金标', fontFamily: FONT_SERIF, textColor: '#f8fafc', accentColor: '#fbbf24', background: '#0b1d36', highlightColor: '#1e3a5f' },
    { id: 'broadway-bill', name: '百老汇招贴', desc: '黑金大字', fontFamily: FONT_SERIF, textColor: '#fef3c7', accentColor: '#d4af37', background: '#111111', highlightColor: '#3f3f46' },
    { id: 'travel-poster', name: '旅行海报', desc: '复古青珊瑚', fontFamily: FONT_UI, textColor: '#134e4a', accentColor: '#e11d48', background: '#fff8f1', highlightColor: '#99f6e4' },
    { id: 'wartime-bill', name: '战时招贴', desc: '怒放红蓝', fontFamily: FONT_CN, textColor: '#111827', accentColor: '#c41e3a', background: '#f5f0e6', highlightColor: '#bfdbfe' },
    { id: 'hollywood-gold', name: '好莱坞金', desc: '酒红金箔', fontFamily: FONT_SERIF, textColor: '#fef3c7', accentColor: '#eab308', background: '#4c0519', highlightColor: '#7f1d1d' },
    { id: 'pop-comic', name: '美漫海报', desc: '黄黑高对比', fontFamily: FONT_UI, textColor: '#111827', accentColor: '#2563eb', background: '#fde047', highlightColor: '#fef9c3' },
    { id: 'route66', name: '公路海报', desc: '日落公路', fontFamily: FONT_UI, textColor: '#1c1917', accentColor: '#ea580c', background: '#fffbeb', highlightColor: '#67e8f9' },
  ];

  function getStyleTheme(id) {
    return STYLE_THEMES.find((item) => item.id === id) || STYLE_THEMES[0];
  }

  const POS_ZH = {
    noun: '名词',
    verb: '动词',
    adjective: '形容词',
    adj: '形容词',
    adverb: '副词',
    adv: '副词',
    pronoun: '代词',
    determiner: '限定词',
    article: '限定词',
    preposition: '介词',
    conjunction: '连词',
    interjection: '感叹词',
    particle: '助词',
    modal: '情态',
    number: '数词',
    numeral: '数词',
  };

  const POS_CLASS = {
    名词: 'pos-noun',
    动词: 'pos-verb',
    形容词: 'pos-adj',
    副词: 'pos-adv',
    代词: 'pos-pron',
    限定词: 'pos-det',
    介词: 'pos-prep',
    连词: 'pos-conj',
    感叹词: 'pos-intj',
    助词: 'pos-part',
    情态: 'pos-modal',
    数词: 'pos-num',
  };

  const FALLBACK_POS = {
    i: 'pronoun', me: 'pronoun', you: 'pronoun', he: 'pronoun', she: 'pronoun', we: 'pronoun',
    they: 'pronoun', it: 'pronoun', my: 'pronoun', your: 'pronoun', his: 'pronoun', her: 'pronoun',
    its: 'pronoun', our: 'pronoun', their: 'pronoun', mine: 'pronoun', yours: 'pronoun',
    him: 'pronoun', them: 'pronoun', us: 'pronoun', this: 'determiner', that: 'determiner',
    these: 'determiner', those: 'determiner', a: 'determiner', an: 'determiner', the: 'determiner',
    some: 'determiner', any: 'determiner', every: 'determiner', each: 'determiner', no: 'determiner',
    all: 'determiner', both: 'determiner', few: 'determiner', many: 'determiner', much: 'determiner',
    and: 'conjunction', or: 'conjunction', but: 'conjunction', so: 'conjunction', because: 'conjunction',
    if: 'conjunction', when: 'conjunction', while: 'conjunction', although: 'conjunction',
    in: 'preposition', on: 'preposition', at: 'preposition', to: 'particle', for: 'preposition',
    of: 'preposition', with: 'preposition', from: 'preposition', by: 'preposition', about: 'preposition',
    into: 'preposition', onto: 'preposition', over: 'preposition', under: 'preposition',
    after: 'preposition', before: 'preposition', during: 'preposition', without: 'preposition',
    is: 'verb', am: 'verb', are: 'verb', was: 'verb', were: 'verb', be: 'verb', been: 'verb',
    being: 'verb', have: 'verb', has: 'verb', had: 'verb', do: 'verb', does: 'verb', did: 'verb',
    can: 'modal', could: 'modal', will: 'modal', would: 'modal', shall: 'modal', should: 'modal',
    may: 'modal', might: 'modal', must: 'modal', like: 'verb', love: 'verb', want: 'verb',
    need: 'verb', go: 'verb', come: 'verb', get: 'verb', make: 'verb', take: 'verb', see: 'verb',
    know: 'verb', think: 'verb', say: 'verb', tell: 'verb', eat: 'verb', drink: 'verb',
    fresh: 'adjective', good: 'adjective', bad: 'adjective', big: 'adjective', small: 'adjective',
    new: 'adjective', old: 'adjective', happy: 'adjective', nice: 'adjective',
    very: 'adverb', really: 'adverb', always: 'adverb', never: 'adverb', often: 'adverb',
    usually: 'adverb', today: 'adverb', tomorrow: 'adverb', yesterday: 'adverb', now: 'adverb',
    here: 'adverb', there: 'adverb', not: 'adverb', please: 'adverb',
  };

  const CHUNK_START = new Set([
    'every', 'each', 'last', 'next', 'tomorrow', 'yesterday', 'today', 'tonight',
    'after', 'before', 'during', 'in', 'on', 'at', 'with', 'without', 'by', 'from',
  ]);

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function normalizePosKey(raw) {
    const key = String(raw || '').toLowerCase().trim();
    if (!key) return '';
    if (POS_ZH[key]) return key;
    if (key.startsWith('n')) return 'noun';
    if (key.startsWith('v')) return 'verb';
    if (key.startsWith('adj')) return 'adjective';
    if (key.startsWith('adv')) return 'adverb';
    if (key.startsWith('pron')) return 'pronoun';
    if (key.startsWith('det') || key.startsWith('art')) return 'determiner';
    if (key.startsWith('prep')) return 'preposition';
    if (key.startsWith('conj')) return 'conjunction';
    if (key.startsWith('inter')) return 'interjection';
    if (key.startsWith('part')) return 'particle';
    if (key.startsWith('mod')) return 'modal';
    if (key.startsWith('num')) return 'number';
    return key;
  }

  function resolvePos(key, info) {
    const fromInfo = normalizePosKey(info?.partOfSpeech);
    if (fromInfo && POS_ZH[fromInfo]) return fromInfo;
    const fallback = FALLBACK_POS[String(key || '').toLowerCase()];
    return fallback || '';
  }

  function posLabel(posKey) {
    return POS_ZH[posKey] || '';
  }

  function assignChunkIds(wordTokens, words) {
    const ids = [];
    let chunkId = 0;
    let sawVerb = false;
    wordTokens.forEach((token, index) => {
      const pos = resolvePos(token.key, words[token.key] || {});
      if (index === 0) {
        ids.push(0);
        if (pos === 'verb' || pos === 'modal') {
          sawVerb = true;
          chunkId = 1;
        }
        return;
      }
      if (!sawVerb && (pos === 'verb' || pos === 'modal')) {
        chunkId += 1;
        ids.push(chunkId);
        sawVerb = true;
        chunkId += 1;
        return;
      }
      if (sawVerb && CHUNK_START.has(token.key) && ids[index - 1] !== undefined) {
        chunkId += 1;
      }
      ids.push(Math.max(chunkId, sawVerb ? chunkId : 0));
    });
    return ids;
  }

  function renderCompactWord(token, words, styles) {
    if (token.type !== 'word') return escapeHtml(token.text);
    const info = words[token.key] || {};
    const cefr = styles.showCefr && info.cefr
      ? `<span class="wb-cefr">${escapeHtml(info.cefr)}</span>`
      : '';
    const phonetic = styles.showPhonetic && info.phonetic
      ? `<span class="wb-phonetic">${escapeHtml(info.phonetic)}</span>`
      : '';
    const gloss = styles.showGloss && (info.zh || info.definition)
      ? `<span class="wb-gloss">${escapeHtml(info.zh || info.definition)}</span>`
      : '';
    return `<span class="wb-word" data-word="${escapeHtml(token.key)}" tabindex="0">${escapeHtml(token.text)}${cefr}${phonetic}${gloss}</span>`;
  }

  function renderLayeredWord(token, words, styles, chunkId) {
    if (token.type !== 'word') {
      return `<span class="wb-word-sep">${escapeHtml(token.text)}</span>`;
    }
    const info = words[token.key] || {};
    const posKey = resolvePos(token.key, info);
    const label = posLabel(posKey);
    const posClass = POS_CLASS[label] || 'pos-other';
    const phonetic = styles.showPhonetic && info.phonetic
      ? `<span class="wb-ipa">${escapeHtml(info.phonetic)}</span>`
      : (styles.showPhonetic ? `<span class="wb-ipa wb-ipa-empty">·</span>` : '');
    const cefr = styles.showCefr && info.cefr
      ? `<span class="wb-cefr-chip">${escapeHtml(info.cefr)}</span>`
      : '';
    const pos = styles.showPos !== false && label
      ? `<span class="wb-pos ${posClass}">${escapeHtml(label)}</span>`
      : '';
    const gloss = styles.showGloss && (info.zh || info.definition)
      ? `<span class="wb-gloss-line">${escapeHtml(info.zh || info.definition)}</span>`
      : '';
    return `<span class="wb-word-col" data-chunk="${chunkId % 6}">
      ${phonetic}
      <span class="wb-word wb-word-pill" data-word="${escapeHtml(token.key)}" tabindex="0">${escapeHtml(token.text)}</span>
      ${pos}
      <span class="wb-pos-bar ${posClass}" aria-hidden="true"></span>
      ${gloss}
      ${cefr}
    </span>`;
  }

  function renderSentence(sentence, words, styles, index, layered) {
    const tokens = sentence.tokens || [];
    const indexHtml = `<span class="wb-sentence-index"><em>${String(index + 1).padStart(2, '0')}</em></span>`;
    if (!layered) {
      const body = tokens.map((token) => renderCompactWord(token, words, styles)).join('');
      return `<div class="wb-sentence wb-sentence-plain" data-sentence-id="${escapeHtml(sentence.id || '')}">
        ${indexHtml}
        <div class="wb-sentence-copy">${body}</div>
      </div>`;
    }

    const wordTokens = tokens.filter((token) => token.type === 'word');
    const chunkIds = assignChunkIds(wordTokens, words);
    let wordIndex = 0;
    const body = tokens.map((token) => {
      if (token.type !== 'word') return renderLayeredWord(token, words, styles, 0);
      const chunkId = chunkIds[wordIndex] || 0;
      wordIndex += 1;
      return renderLayeredWord(token, words, styles, chunkId);
    }).join('');

    return `<div class="wb-sentence wb-sentence-layered" data-sentence-id="${escapeHtml(sentence.id || '')}">
      ${indexHtml}
      <div class="wb-word-row">${body}</div>
    </div>`;
  }

  function renderVocabCards(annotated, styles = {}) {
    const words = annotated.words || {};
    const list = (annotated.vocabList || []).slice(0, 12);
    if (!list.length) return '<p class="wb-empty">标注后会生成单词卡。</p>';
    return `<div class="wb-vocab-deck">${list.map((item, index) => {
      const info = words[String(item.word || '').toLowerCase()] || item;
      const posKey = resolvePos(item.word || info.word, info);
      const pos = posLabel(posKey);
      const posClass = POS_CLASS[pos] || 'pos-other';
      const phonetic = styles.showPhonetic !== false && (info.phonetic || item.phonetic)
        ? `<span class="wb-vocab-ipa">${escapeHtml(info.phonetic || item.phonetic)}</span>`
        : '';
      const cefr = styles.showCefr !== false && (info.cefr || item.cefr)
        ? `<span class="wb-vocab-cefr">${escapeHtml(info.cefr || item.cefr)}</span>`
        : '';
      const posChip = styles.showPos !== false && pos
        ? `<span class="wb-vocab-pos ${posClass}">${escapeHtml(pos)}</span>`
        : '';
      const zh = styles.showGloss !== false && (info.zh || item.zh)
        ? `<p class="wb-vocab-zh">${escapeHtml(info.zh || item.zh)}</p>`
        : '';
      const def = styles.showGloss !== false && (info.definition || item.definition)
        ? `<p class="wb-vocab-def">${escapeHtml(info.definition || item.definition)}</p>`
        : '';
      const gloss = zh || def || '';
      return `<article class="wb-vocab-card" data-word="${escapeHtml(item.word || '')}" style="--wb-vocab-i:${index}">
        <span class="wb-vocab-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="wb-vocab-main">
          <div class="wb-vocab-title-row">
            <h3 class="wb-vocab-word wb-word" data-word="${escapeHtml(String(item.word || '').toLowerCase())}" tabindex="0">${escapeHtml(item.word || '')}</h3>
            <div class="wb-vocab-meta">${cefr}${posChip}</div>
          </div>
          ${phonetic}
          ${gloss}
        </div>
      </article>`;
    }).join('')}</div>`;
  }

  function renderChips(items, emptyText) {
    if (!items || !items.length) return `<p class="wb-sub">${escapeHtml(emptyText)}</p>`;
    return `<div class="wb-chip-row">${items.map((text) => `<span class="wb-chip">${escapeHtml(text)}</span>`).join('')}</div>`;
  }

  const DEFAULT_KICKERS = Object.freeze({
    'intensive-note': 'INTENSIVE READING',
    homework: 'HOMEWORK SHEET',
    'lesson-handout': 'LESSON HANDOUT',
    'word-cards': 'WORD CARDS',
    'xhs-long': 'XIAOHONGSHU',
    'quote-card': 'QUOTE CARD',
    'video-script': 'VIDEO SCRIPT',
    'traffic-cover': 'PRACTICE WITH LINGLISH',
  });

  function defaultKicker(templateId) {
    return DEFAULT_KICKERS[templateId] || 'LINGLISH';
  }

  function resolveKicker(templateId, styles) {
    const custom = String(styles?.kicker || '').trim();
    return custom || defaultKicker(templateId);
  }

  function estimateDraftCefr(word) {
    const w = String(word || '').toLowerCase();
    if (!w || w.length <= 3 || FALLBACK_POS[w]) return 'A1';
    if (w.length <= 5) return 'A2';
    if (w.length <= 7) return 'B1';
    if (w.length <= 9) return 'B2';
    return 'C1';
  }

  function extractTokens(sentence) {
    const tokens = [];
    const re = /([A-Za-z][A-Za-z']*)|([^A-Za-z]+)/g;
    let match;
    while ((match = re.exec(String(sentence || ''))) !== null) {
      if (match[1]) tokens.push({ type: 'word', text: match[1], key: match[1].toLowerCase() });
      else if (match[2]) tokens.push({ type: 'other', text: match[2] });
    }
    return tokens;
  }

  function splitSentences(text) {
    const raw = String(text || '').replace(/\r/g, '\n').trim();
    if (!raw) return [];
    const parts = raw
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return parts.length ? parts : [raw];
  }

  /** Lightweight live draft so left text syncs to the right before AI annotate. */
  function draftFromText(text, title) {
    const sourceText = String(text || '').trim();
    const sentences = splitSentences(sourceText).slice(0, 40).map((sentence, index) => ({
      id: `draft-${index + 1}`,
      text: sentence,
      tokens: extractTokens(sentence),
    }));
    const wordKeys = new Set();
    for (const sentence of sentences) {
      for (const token of sentence.tokens) {
        if (token.type === 'word') wordKeys.add(token.key);
      }
    }
    return {
      kind: 'workbench-draft',
      title: String(title || '').trim() || (sentences[0]?.text || '未命名内容').slice(0, 48),
      sourceText,
      level: 'A2',
      sentences,
      words: {},
      keyExpressions: sentences.slice(0, 3).map((item) => item.text),
      vocabList: [...wordKeys].slice(0, 12).map((word) => ({
        word,
        zh: '',
        phonetic: '',
        cefr: estimateDraftCefr(word),
        partOfSpeech: FALLBACK_POS[word] || '',
      })),
      dictationList: [...wordKeys].slice(0, 12),
      shadowingTasks: sentences.slice(0, 12).map((sentence, index) => ({
        id: `task-${index + 1}`,
        text: sentence.text,
      })),
    };
  }

  function header(annotated, kicker, styles = {}) {
    const meta = styles.showMeta === false
      ? ''
      : `<div class="wb-meta-row">
          <span class="wb-meta-pill">CEFR ${escapeHtml(annotated.level || 'A2')}</span>
          <span class="wb-meta-pill">${(annotated.sentences || []).length} 句</span>
          <span class="wb-meta-pill">${(annotated.vocabList || []).length} 词</span>
        </div>`;
    return `<header class="wb-card-head wb-card-head-hero">
      <div class="wb-kicker wb-kicker-badge" data-editable="kicker" contenteditable="true" spellcheck="false">${escapeHtml(kicker)}</div>
      <h1 class="wb-title" data-editable="title" contenteditable="true" spellcheck="false">${escapeHtml(annotated.title || '未命名内容')}</h1>
      ${meta}
    </header>`;
  }

  function section(title, bodyHtml, options = {}) {
    const step = options.step
      ? `<span class="wb-block-step">${escapeHtml(options.step)}</span>`
      : '';
    const hint = options.hint
      ? `<p class="wb-block-hint">${escapeHtml(options.hint)}</p>`
      : '';
    return `<section class="wb-block${options.tone ? ` wb-block-${options.tone}` : ''}">
      <div class="wb-block-head">
        ${step}
        <h2 class="wb-block-title">${escapeHtml(title)}</h2>
      </div>
      ${hint}
      <div class="wb-block-body">${bodyHtml}</div>
    </section>`;
  }

  function renderTaskCards(tasks) {
    if (!tasks.length) return '<p class="wb-empty">先标注文本生成任务。</p>';
    return tasks.slice(0, 8).map((task, i) => `
      <div class="wb-task-card">
        <div class="wb-task-mark">${String(i + 1).padStart(2, '0')}</div>
        <div class="wb-task-body">
          <span class="wb-task-label">跟读 Task ${i + 1}</span>
          <p class="wb-task-text">${escapeHtml(task.text)}</p>
        </div>
      </div>`).join('');
  }

  function renderDictationList(words) {
    if (!words.length) return '<p class="wb-empty">暂无默写词</p>';
    return `<div class="wb-dictation-list">${words.slice(0, 12).map((word, i) => `
      <div class="wb-dictation-item">
        <span class="wb-dictation-no">${i + 1}</span>
        <span class="wb-dictation-word">${escapeHtml(word)}</span>
        <span class="wb-dictation-line" aria-hidden="true"></span>
      </div>`).join('')}</div>`;
  }

  function renderExpressionBoard(items, emptyText) {
    if (!items || !items.length) return `<p class="wb-empty">${escapeHtml(emptyText)}</p>`;
    return `<div class="wb-expr-board">${items.map((text, i) => `
      <div class="wb-expr-card">
        <span class="wb-expr-no">${String(i + 1).padStart(2, '0')}</span>
        <p class="wb-expr-text">${escapeHtml(text)}</p>
      </div>`).join('')}</div>`;
  }

  function wrapSheet(templateId, html) {
    return `<div class="wb-sheet wb-sheet-${escapeHtml(templateId)}">${html}</div>`;
  }

  function renderTemplate(templateId, annotated, styles, extras = {}) {
    const words = annotated.words || {};
    const sentences = annotated.sentences || [];
    const expressions = annotated.keyExpressions || [];
    const dictation = annotated.dictationList || [];
    const tasks = annotated.shadowingTasks || [];
    const layered = templateId === 'intensive-note' || templateId === 'xhs-long';
    const kicker = resolveKicker(templateId, styles);
    const head = header(annotated, kicker, styles);

    switch (templateId) {
      case 'homework':
        return wrapSheet(templateId, `${head}
          ${section('跟读任务', renderTaskCards(tasks), { step: '01', hint: '大声跟读，可点练习链接录音', tone: 'task' })}
          ${section('默写清单', renderDictationList(dictation), { step: '02', hint: '遮住英文，在虚线上默写', tone: 'write' })}
          <div class="wb-callout">完成后打开练习链接录音，错句会进入复习。</div>`);

      case 'lesson-handout':
        return wrapSheet(templateId, `${head}
          ${section('重点表达', renderExpressionBoard(expressions, '标注后自动提取'), { step: 'KEY', hint: '课堂板书优先讲这些', tone: 'key' })}
          ${section('课文句子', sentences.map((s, i) => renderSentence(s, words, { ...styles, showPhonetic: false, showGloss: false, showPos: false }, i, false)).join('') || '<p class="wb-empty">粘贴英文并标注后显示句子。</p>', { step: 'TEXT', tone: 'plain' })}`);

      case 'word-cards':
        return wrapSheet(templateId, `${head}
          ${section('单词卡组', renderVocabCards(annotated, styles), { step: 'VOCAB', tone: 'plain' })}`);

      case 'quote-card': {
        const quote = expressions[0] || sentences[0]?.text || annotated.sourceText || 'Your key sentence here';
        return wrapSheet(templateId, `<div class="wb-cover">
          <div class="wb-kicker wb-kicker-badge" data-editable="kicker" contenteditable="true" spellcheck="false">${escapeHtml(kicker)}</div>
          <div class="wb-quote" data-editable="quote">${escapeHtml(quote)}</div>
          <p class="wb-sub">${escapeHtml(annotated.title || 'Linglish')}</p>
        </div>`);
      }

      case 'video-script':
        return wrapSheet(templateId, `${head}
          ${section('分镜口播', sentences.map((s, i) => `
            <div class="wb-task-card">
              <div class="wb-task-mark">${String(i + 1).padStart(2, '0')}</div>
              <div class="wb-task-body">
                <span class="wb-task-label">镜头 ${i + 1}</span>
                <p class="wb-task-text"><strong>口播：</strong>${escapeHtml(s.text)}</p>
                <p class="wb-vocab-def">画面：补充画面说明…</p>
              </div>
            </div>`).join('') || '<p class="wb-empty">粘贴英文后生成分镜口播。</p>', { step: 'SHOT', tone: 'task' })}`);

      case 'traffic-cover':
        return wrapSheet(templateId, `<div class="wb-cover">
          <div class="wb-kicker wb-kicker-badge" data-editable="kicker" contenteditable="true" spellcheck="false">${escapeHtml(kicker)}</div>
          <h1 class="wb-title" data-editable="title" contenteditable="true" spellcheck="false">${escapeHtml(annotated.title || '跟我一起练这几句')}</h1>
          <p class="wb-sub">${escapeHtml(expressions[0] || sentences[0]?.text || '扫码进入逐句跟读')}</p>
          <div class="wb-qr-box">${extras.practiceUrl ? '扫码练习' : '生成练习链接后显示二维码'}</div>
          <p class="wb-sub" style="margin-top:8px;font-size:12px">${escapeHtml(extras.practiceUrl || '')}</p>
        </div>`);

      case 'xhs-long':
        return wrapSheet(templateId, `${head}
          ${section('精读句子', sentences.map((s, i) => renderSentence(s, words, styles, i, true)).join('') || '<p class="wb-empty">在左侧粘贴英文，点击「AI 标注」。</p>', { step: '01', tone: 'read' })}
          ${section('今日重点', renderExpressionBoard(expressions.slice(0, 5), '暂无重点表达'), { step: '02', tone: 'key' })}
          <div class="wb-callout">想跟读纠音？打开 Linglish 练习链接 →</div>`);

      case 'intensive-note':
      default:
        return wrapSheet(templateId || 'intensive-note', `${head}
          ${section('精读句子', sentences.map((s, i) => renderSentence(s, words, styles, i, layered)).join('') || '<p class="wb-empty">在左侧粘贴英文，点击「AI 标注」。</p>', { step: 'READ', hint: '点单词可看释义与发音', tone: 'read' })}
          ${section('重点表达', renderExpressionBoard(expressions, '标注后自动提取'), { step: 'KEY', tone: 'key' })}`);
    }
  }

  global.WorkbenchTemplates = {
    TEMPLATES,
    STYLE_THEMES,
    DEFAULT_KICKERS,
    defaultKicker,
    draftFromText,
    getStyleTheme,
    escapeHtml,
    renderTemplate,
    forRole(role) {
      return TEMPLATES.filter((item) => item.role === role);
    },
  };
})(window);
