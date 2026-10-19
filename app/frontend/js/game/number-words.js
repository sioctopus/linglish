(function (root) {
  'use strict';

  const SMALL = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
  ];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
  const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const CN_UNIT = ['', '十', '百', '千'];
  const CN_GROUP = ['', '万', '亿', '万亿'];
  const MAX = 999999999999999;

  const PLACES = [
    { id: 'ones', zh: '个', n: 1 },
    { id: 'tens', zh: '十', n: 10 },
    { id: 'hundreds', zh: '百', n: 100 },
    { id: 'thousands', zh: '千', n: 1000 },
    { id: 'wan', zh: '万', n: 10000 },
    { id: 'hundred-thousand', zh: '十万', n: 100000 },
    { id: 'million', zh: '百万', n: 1000000 },
    { id: 'ten-million', zh: '千万', n: 10000000 },
    { id: 'yi', zh: '亿', n: 100000000 },
    { id: 'billion', zh: '十亿', n: 1000000000 },
    { id: 'ten-billion', zh: '百亿', n: 10000000000 },
    { id: 'hundred-billion', zh: '千亿', n: 100000000000 },
    { id: 'trillion', zh: '万亿', n: 1000000000000 },
  ];

  function under100(n) {
    if (n < 20) return SMALL[n];
    const ten = TENS[Math.floor(n / 10)];
    const one = n % 10;
    return one ? ten + '-' + SMALL[one] : ten;
  }

  function under1000(n) {
    if (n < 100) return under100(n);
    const hundreds = SMALL[Math.floor(n / 100)] + ' hundred';
    const rest = n % 100;
    return rest ? hundreds + ' and ' + under100(rest) : hundreds;
  }

  function spell(n) {
    if (n === 0) return 'zero';
    const parts = [];
    let scale = 0;
    let rest = n;
    while (rest > 0 && scale < SCALES.length) {
      const chunk = rest % 1000;
      if (chunk) {
        const words = under1000(chunk);
        parts.unshift(SCALES[scale] ? words + ' ' + SCALES[scale] : words);
      }
      rest = Math.floor(rest / 1000);
      scale += 1;
    }
    if (rest > 0) return '';
    if (parts.length > 1) {
      const last = n % 1000;
      if (last > 0 && last < 100) parts[parts.length - 1] = 'and ' + parts[parts.length - 1];
    }
    return parts.join(' ');
  }

  function chineseGroup(n) {
    const text = String(n);
    let out = '';
    let pendingZero = false;
    for (let i = 0; i < text.length; i += 1) {
      const num = Number(text[i]);
      const pos = text.length - 1 - i;
      if (num === 0) {
        pendingZero = out.length > 0;
        continue;
      }
      if (pendingZero) {
        out += '零';
        pendingZero = false;
      }
      if (!(num === 1 && pos === 1 && out === '')) out += CN_DIGIT[num];
      out += CN_UNIT[pos];
    }
    return out;
  }

  function chinese(n) {
    if (n === 0) return '零';
    const groups = [];
    let rest = n;
    while (rest > 0) {
      groups.push(rest % 10000);
      rest = Math.floor(rest / 10000);
    }
    let out = '';
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const part = groups[i];
      if (part === 0) continue;
      const higher = groups[i + 1];
      if (out && (part < 1000 || (higher !== undefined && higher % 10 === 0))) out += '零';
      out += chineseGroup(part) + (CN_GROUP[i] || '');
    }
    return out;
  }

  function group(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function parse(raw) {
    const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
    if (!digits) return null;
    if (digits.length > 15) return null;
    const n = Number(digits);
    if (!Number.isSafeInteger(n) || n > MAX) return null;
    return n;
  }

  function read(raw) {
    const n = typeof raw === 'number' ? raw : parse(raw);
    if (n == null || n < 0 || n > MAX || !Number.isSafeInteger(n)) return null;
    return {
      n: n,
      emoji: String(n),
      zh: group(n) + ' · ' + chinese(n),
      lemma: spell(n),
      ipa: '',
    };
  }

  root.GameNumberWords = {
    places: PLACES,
    spell: spell,
    chinese: chinese,
    group: group,
    parse: parse,
    read: read,
  };
})(typeof window !== 'undefined' ? window : globalThis);
