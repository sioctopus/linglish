(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishSentenceAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'from', 'with',
    'that', 'this', 'these', 'those', 'was', 'were', 'is', 'are', 'be', 'been', 'being',
    'it', 'its', 'as', 'at', 'by', 'we', 'you', 'i', 'he', 'she', 'they', 'them', 'his',
    'her', 'our', 'your', 'my', 'not', 'so', 'if', 'than', 'then', 'there', 'here',
    'would', 'could', 'should', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'just', 'into', 'about', 'over', 'after', 'before', 'when', 'what', 'which', 'who',
  ]);
  const FILLERS = ['actually', 'originally', 'really', 'literally', 'basically', 'simply'];
  const ADVERB_NOTE = {
    actually: '副词，表示“其实”，起强调作用',
    originally: '副词，意思是“最初”',
    really: '副词，用来加强语气',
    literally: '副词，表示“字面上、确实”',
    basically: '副词，用来概括',
    simply: '副词，表示“仅仅、简单地”',
  };

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function wordsOf(text) {
    return clean(text).match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
  }

  function capitalize(text) {
    const value = clean(text).replace(/[.?!]+$/, '');
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function stripFillers(text) {
    const pattern = new RegExp(`\\b(?:${FILLERS.join('|')})\\b`, 'gi');
    return clean(text.replace(pattern, ''));
  }

  function plain(text) {
    return stripFillers(text)
      .replace(/\breferred to\b/gi, 'meant')
      .replace(/\bseparated from\b/gi, 'separate from')
      .replace(/\s+([,.;!?])/g, '$1');
  }

  function splitAnd(text) {
    const parts = clean(text).split(/\s+and\s+/i);
    if (parts.length < 2) return [clean(text)];
    const head = parts[0];
    const tail = parts.slice(1).join(' and ');
    if (wordsOf(head).length < 4 || wordsOf(tail).length < 3) return [clean(text)];
    if (/^(it|he|she|they|we|i|you|this|that|the|a|an|mr|mrs|ms)\b/i.test(tail)) return [head, tail];
    if (/^(meant|means|comes|come|went|goes|is|was|were|has|have|had)\b/i.test(tail)) return [head, `It ${tail}`];
    return [clean(text)];
  }

  function splitThat(text) {
    const match = clean(text).match(/^(.*?)\s+that\s+(.+)$/i);
    if (!match || wordsOf(text).length < 10) return [clean(text)];
    const head = match[1];
    const rest = match[2];
    if (wordsOf(head).length < 3) return [clean(text)];
    return [head, `This ${rest}`];
  }

  function simplify(text) {
    const source = plain(text);
    if (!source) return '';
    const sentences = splitAnd(source).flatMap((part) => splitThat(part));
    const unique = [];
    sentences.forEach((part) => {
      const sentence = capitalize(part);
      if (sentence && !unique.includes(sentence)) unique.push(sentence.endsWith('.') ? sentence : `${sentence}.`);
    });
    return unique.join(' ') || source;
  }

  function trunk(text) {
    const source = plain(text);
    const beforeClause = source.split(/\s+(?:which|who)\s+|\s+that\s+(?:was|were|is|are|has|had|have|would|could)\s+/i)[0] || source;
    const beforeAnd = beforeClause.split(/\s+and\s+/i)[0] || beforeClause;
    return capitalize(beforeAnd);
  }

  function keywords(text) {
    const seen = new Set();
    const picked = [];
    wordsOf(text).forEach((word) => {
      const key = word.toLowerCase().replace(/’/g, "'");
      if (STOP.has(key) || FILLERS.includes(key) || key.length < 4 || seen.has(key)) return;
      seen.add(key);
      picked.push(key);
    });
    return picked.slice(0, 5);
  }

  function parts(text) {
    const source = clean(text);
    const items = [];
    FILLERS.forEach((word) => {
      if (new RegExp(`\\b${word}\\b`, 'i').test(source)) {
        items.push({ en: word, zh: ADVERB_NOTE[word] });
      }
    });
    const verb = source.match(/\b((?:originally|really|actually)\s+)?(referred to|comes from|come from|meant|means|looks like|used to)\b/i);
    if (verb) {
      items.push({
        en: clean(verb[0]),
        zh: '动词短语，承担这句话的主要动作',
      });
    }
    const clause = source.match(/\b((?:a|an|the)\s+.+?\s+that\s+.+)$/i);
    if (clause) {
      items.push({
        en: clean(clause[1]).replace(/[.?!]+$/, ''),
        zh: '定语从句，用来修饰前面的名词',
      });
    }
    if (!items.length) {
      const chunks = source.split(/,\s+|\s+and\s+/i).map(clean).filter((part) => wordsOf(part).length >= 3);
      chunks.slice(0, 3).forEach((part, index) => {
        items.push({
          en: part.replace(/[.?!]+$/, ''),
          zh: index === 0 ? '这句话先说的部分' : '后面补充的部分',
        });
      });
    }
    return items.slice(0, 4);
  }

  function points(text) {
    const source = clean(text);
    const notes = [];
    if (/\bthat\s+(?:was|were|is|are|has|had|have|would|could)\b/i.test(source)) {
      notes.push('that 引导的从句用来补充说明前面的名词。');
    }
    if (/\b(actually|originally|really)\b/i.test(source)) notes.push('actually、originally 这类词不改变主干，只补充语气或时间。');
    if (/\b(and|but)\b/i.test(source)) notes.push('and 或 but 把两个意思连在同一段里，可以分开读。');
    if (!notes.length) notes.push('先读出谁做了什么，再看后面补充的信息。');
    return notes.slice(0, 3);
  }

  function analyze(text) {
    const original = clean(text);
    return {
      original,
      simplified: original ? simplify(original) : '',
      trunk: original ? trunk(original) : '',
      keywords: original ? keywords(original) : [],
      parts: original ? parts(original) : [],
      points: original ? points(original) : [],
    };
  }

  return { analyze, keywords, simplify, trunk };
});
