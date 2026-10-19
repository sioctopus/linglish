function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function looksLikeExam(text) {
  const value = String(text || '');
  if (/class="[^"]*\bquestion\b[^"]*"/.test(value) && /参考答案|answer-key/.test(value)) return true;
  const questions = value.match(/(?:^|\n)\s*\d{1,3}[.、]\s+\S/g) || [];
  const options = value.match(/(?:^|\n)\s*[A-E][.、．]\s+\S/g) || [];
  const marked = /试卷|第一部分|参考答案|听力/.test(value);
  return marked && questions.length >= 3 && options.length >= 6;
}

function answerSpeech(line) {
  return String(line || '')
    .replace(/(\d+)\s*[-–~到至]\s*(\d+)\s*([A-Ea-e]{2,})/g, (_, from, to, letters) => (
      `第${from}到第${to}题的答案是 ${letters.toUpperCase().split('').join('，')}`
    ))
    .replace(/(^|\s)(\d{1,3})[.、]\s*/g, (_, space, number) => `${space}第${number}题，`);
}

function textFromHtml(fragment) {
  return decodeEntities(String(fragment || '')
    .replace(/<span[^>]*fill-blank[^>]*>([\s\S]*?)<\/span>/gi, '（$1）')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function classNames(attrs) {
  const match = String(attrs || '').match(/class\s*=\s*"([^"]*)"/i);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function findMatchingClose(html, from, tag) {
  const re = new RegExp(`<(/?)${tag}(\\s[^>]*)?>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let match = re.exec(html);
  while (match) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
    match = re.exec(html);
  }
  return html.length;
}

function walkChildren(html) {
  const nodes = [];
  let index = 0;
  const source = String(html || '');
  while (index < source.length) {
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      const text = source.slice(index, next === -1 ? source.length : next);
      if (text.trim()) nodes.push({ tag: '#text', attrs: '', html: '', text: decodeEntities(text), children: [] });
      index = next === -1 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    const open = source.slice(index).match(/^<([a-zA-Z0-9]+)([^>]*)>/);
    if (!open) {
      index += 1;
      continue;
    }
    const tag = open[1].toLowerCase();
    const attrs = open[2] || '';
    const startInner = index + open[0].length;
    if (tag === 'br' || tag === 'hr' || /\/\s*$/.test(attrs)) {
      nodes.push({ tag, attrs, html: '', text: '', children: [] });
      index = startInner;
      continue;
    }
    const closeAt = findMatchingClose(source, startInner, tag);
    const inner = source.slice(startInner, closeAt);
    nodes.push({ tag, attrs, html: inner, text: '', children: walkChildren(inner) });
    index = Math.min(source.length, closeAt + `</${tag}>`.length);
  }
  return nodes;
}

function passageParagraphs(node) {
  const paragraphs = [];
  let label = '';
  for (const child of node.children || []) {
    if (child.tag === 'strong') {
      const text = textFromHtml(child.html);
      if (text && text.length <= 3) label = text;
      else if (text) paragraphs.push(text);
      continue;
    }
    if (child.tag === 'p' || child.tag === 'li') {
      const text = textFromHtml(child.html);
      if (!text) continue;
      paragraphs.push(label ? `${label} ${text}` : text);
      label = '';
      continue;
    }
    if (child.tag === 'ul' || child.tag === 'ol') {
      for (const item of child.children || []) {
        if (item.tag !== 'li') continue;
        const text = textFromHtml(item.html);
        if (text) paragraphs.push(text);
      }
    }
  }
  if (!paragraphs.length) {
    const text = textFromHtml(node.html);
    if (text) paragraphs.push(text);
  }
  return paragraphs.map((text) => ({ text, speak: text }));
}

function parseQuestion(node) {
  let number = '';
  let stem = '';
  const options = [];
  for (const child of node.children || []) {
    const classes = classNames(child.attrs);
    if (classes.includes('options')) {
      for (const option of child.children || []) {
        if (option.tag !== 'div') continue;
        const text = textFromHtml(option.html);
        if (text) options.push(text);
      }
      continue;
    }
    if (child.tag === 'div' || child.tag === 'p') {
      const num = child.html.match(/class="[^"]*\bq-num\b[^"]*"[^>]*>([\s\S]*?)<\//i);
      if (num) number = textFromHtml(num[1]).replace(/\.$/, '');
      const stemHtml = child.html.replace(/<span[^>]*class="[^"]*\bq-num\b[^"]*"[^>]*>[\s\S]*?<\/span>/i, '');
      const text = textFromHtml(stemHtml);
      if (text) stem = text;
    }
  }
  const speak = [number ? `${number}.` : '', stem, ...options].filter(Boolean).join(' ');
  return { type: 'question', number, stem, options, speak };
}

function collectAnswerParagraphs(node, out) {
  if (!node || node.tag === 'summary') return;
  if (node.tag === 'p') {
    const text = textFromHtml(node.html);
    if (text && !/点击展开|收起答案/.test(text)) out.push(text);
    return;
  }
  for (const child of node.children || []) collectAnswerParagraphs(child, out);
}

function listItems(node) {
  const items = [];
  function walk(current) {
    if (current.tag === 'li') {
      const text = textFromHtml(current.html);
      if (text) items.push(text);
      return;
    }
    for (const child of current.children || []) walk(child);
  }
  walk(node);
  return items;
}

function pushAnswer(blocks, text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return;
  blocks.push({
    type: 'answer',
    lines: lines.map((line) => ({ text: line, speak: answerSpeech(line) })),
  });
}

function parseExamHtml(html, fallbackTitle) {
  const source = String(html || '');
  if (!looksLikeExam(source)) return null;
  const start = source.search(/<div[^>]*class="[^"]*\bpaper\b[^"]*"/i);
  let rootHtml = source;
  if (start >= 0) {
    const openEnd = source.indexOf('>', start);
    const closeAt = findMatchingClose(source, openEnd + 1, 'div');
    rootHtml = source.slice(openEnd + 1, closeAt);
  } else {
    const body = source.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    rootHtml = body ? body[1] : source;
  }
  const blocks = [];
  const notes = [];
  let title = String(fallbackTitle || '').trim();
  let subtitle = '';
  for (const node of walkChildren(rootHtml)) {
    if (node.tag === '#text' || node.tag === 'br') continue;
    const classes = classNames(node.attrs);
    if (node.tag === 'h1') {
      title = textFromHtml(node.html) || title;
      continue;
    }
    if (classes.includes('subtitle')) {
      subtitle = textFromHtml(node.html);
      continue;
    }
    if (classes.includes('notes')) {
      notes.push(...listItems(node));
      continue;
    }
    if (classes.includes('answer-key')) {
      blocks.push({ type: 'heading', level: 2, text: '参考答案' });
      const paragraphs = [];
      collectAnswerParagraphs(node, paragraphs);
      paragraphs.forEach((text) => pushAnswer(blocks, text));
      continue;
    }
    if (node.tag === 'h2' || node.tag === 'h3') {
      blocks.push({ type: 'heading', level: node.tag === 'h2' ? 2 : 3, text: textFromHtml(node.html) });
      continue;
    }
    if (classes.includes('section-info')) {
      const text = textFromHtml(node.html);
      if (text) blocks.push({ type: 'info', text });
      continue;
    }
    if (classes.includes('passage')) {
      blocks.push({ type: 'passage', paragraphs: passageParagraphs(node) });
      continue;
    }
    if (classes.includes('question')) {
      blocks.push(parseQuestion(node));
      continue;
    }
    if (classes.includes('options')) {
      const items = (node.children || [])
        .filter((child) => child.tag === 'div')
        .map((child) => textFromHtml(child.html))
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'choices', items, speak: items.join(' ') });
      continue;
    }
    if (node.tag === 'ol' || node.tag === 'ul') {
      const items = listItems(node);
      if (items.length) blocks.push({ type: 'list', items });
      continue;
    }
    if (node.tag === 'p') {
      const text = textFromHtml(node.html);
      if (!text || /试卷结束/.test(text)) continue;
      blocks.push({ type: /听第|回答第/.test(text) ? 'prompt' : 'note', text });
    }
  }
  return finishPaper({ title: title || '试卷', subtitle, notes, blocks });
}

function parseExamText(text, fallbackTitle) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line));
  const blocks = [];
  let answerMode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^参考答案/.test(line)) {
      answerMode = true;
      blocks.push({ type: 'heading', level: 2, text: '参考答案' });
      index += 1;
      continue;
    }
    if (answerMode) {
      pushAnswer(blocks, line);
      index += 1;
      continue;
    }
    if (/^第[一二三四五六七八九十0-9]+部分/.test(line) || /^第[一二三四五六七八九十0-9]+节/.test(line)) {
      blocks.push({ type: 'heading', level: /部分/.test(line) ? 2 : 3, text: line });
      index += 1;
      continue;
    }
    const question = line.match(/^(\d{1,3})[.、]\s*(.*)$/);
    if (question) {
      const options = [];
      index += 1;
      while (index < lines.length && /^[A-E][.、．]\s+\S/.test(lines[index])) {
        options.push(lines[index]);
        index += 1;
      }
      const stem = question[2];
      blocks.push({
        type: 'question',
        number: question[1],
        stem,
        options,
        speak: [`${question[1]}.`, stem, ...options].filter(Boolean).join(' '),
      });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length
      && !/^\d{1,3}[.、]\s/.test(lines[index])
      && !/^第[一二三四五六七八九十0-9]+[部节]/.test(lines[index])
      && !/^参考答案/.test(lines[index])
      && !/^[A-E][.、．]\s+\S/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const joined = paragraph.join('\n');
    if (/[A-Za-z]{8,}/.test(joined) && joined.length > 80) {
      blocks.push({
        type: 'passage',
        paragraphs: paragraph.map((item) => ({ text: item, speak: item })),
      });
    } else if (/听第|回答第/.test(joined)) {
      blocks.push({ type: 'prompt', text: joined });
    } else {
      blocks.push({ type: 'info', text: joined });
    }
  }
  return finishPaper({ title: String(fallbackTitle || '').trim() || '试卷', subtitle: '', notes: [], blocks });
}

function finishPaper(paper) {
  const questions = paper.blocks.filter((block) => block.type === 'question').length;
  const answers = paper.blocks.filter((block) => block.type === 'answer').length;
  if (questions < 3) return null;
  const chunks = [];
  for (const block of paper.blocks) {
    if (block.type === 'passage') chunks.push(...block.paragraphs.map((item) => item.speak));
    if (block.type === 'question') chunks.push(block.speak);
    if (block.type === 'choices') chunks.push(block.speak);
    if (block.type === 'answer') chunks.push(...block.lines.map((item) => item.speak));
  }
  const words = chunks.join(' ').match(/[A-Za-z0-9']+/g) || [];
  return {
    kind: 'exam-paper',
    title: paper.title || '试卷',
    subtitle: paper.subtitle || '',
    notes: paper.notes || [],
    blocks: paper.blocks,
    wordCount: words.length,
    speakCount: chunks.filter((item) => /[A-Za-z\u4e00-\u9fff]/.test(item || '')).length,
    hasAnswers: answers > 0,
  };
}

function buildExamPaper(text, title) {
  const value = String(text || '');
  if (!looksLikeExam(value)) return null;
  if (/<[a-z][\s\S]*>/i.test(value) && /question|paper|answer-key/.test(value)) {
    return parseExamHtml(value, title);
  }
  return parseExamText(value, title);
}

module.exports = {
  looksLikeExam,
  answerSpeech,
  buildExamPaper,
};
