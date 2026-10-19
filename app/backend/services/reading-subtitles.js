const zlib = require('zlib');

function buildReadingSubtitles(text) {
  const normalized = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const cues = [];
  const blocks = normalized.split(/\n+/);
  for (const block of blocks) {
    const sentences = block.match(/[^.!?]+[.!?]+(?:["']+)?|[^.!?]+$/g) || [block];
    for (const sentence of sentences) {
      const line = sentence.replace(/\s+/g, ' ').trim();
      if (!isEnglishCue(line)) continue;
      cues.push(line);
    }
  }
  return cues;
}

function isEnglishCue(line) {
  const words = String(line || '').match(/[A-Za-z][A-Za-z']*/g) || [];
  if (words.join('').length < 6) return false;
  const lowered = words.map(word => word.toLowerCase());
  const filler = new Set(['of', 'page', 'pages']);
  if (lowered.every(word => filler.has(word))) return false;
  return true;
}

function subtitleContent(cues) {
  return cues.join('\n');
}

function readZipEntries(buffer, { include = () => true } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const maxEntryBytes = 8 * 1024 * 1024;
  const maxExpandedBytes = 32 * 1024 * 1024;
  if (buf.length > 20 * 1024 * 1024) throw new Error('压缩文档过大');
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('不是有效的压缩文档');
  }

  const count = buf.readUInt16LE(eocd + 10);
  if (count > 2048) throw new Error('压缩文档条目数量过多');
  let offset = buf.readUInt32LE(eocd + 16);
  const directoryStart = offset;
  const directoryEnd = offset + buf.readUInt32LE(eocd + 12);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0
      || buf.readUInt16LE(eocd + 8) !== count || directoryEnd > eocd
      || eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) {
    throw new Error('不是有效的压缩文档');
  }
  const files = new Map();
  const names = new Set();
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directoryEnd || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('不是有效的压缩文档');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const expandedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLen + extraLen + commentLen > directoryEnd) {
      throw new Error('不是有效的压缩文档');
    }
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;
    if (names.has(name) || (flags & 1) || localOffset + 30 > directoryStart
        || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('不是有效的压缩文档');
    }
    names.add(name);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8').replace(/\\/g, '/');
    if (dataStart + compSize > directoryStart || localName !== name
        || buf.readUInt16LE(localOffset + 8) !== method || (buf.readUInt16LE(localOffset + 6) & 1)) {
      throw new Error('不是有效的压缩文档');
    }
    // Skip embedded images and other binary assets without decompressing them.
    if (!include(name)) continue;
    if (expandedSize > maxEntryBytes || expandedBytes + expandedSize > maxExpandedBytes) {
      throw new Error('文档展开内容过大');
    }
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const remaining = Math.min(maxEntryBytes, maxExpandedBytes - expandedBytes);
    let data;
    if (method === 0) {
      if (compressed.length > remaining) throw new Error('文档展开内容过大');
      data = compressed;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: remaining });
      } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE' || remaining === 0) throw new Error('文档展开内容过大');
        throw new Error('不是有效的压缩文档');
      }
    } else {
      throw new Error('不支持这份压缩文档的格式');
    }
    if (data.length !== expandedSize) throw new Error('不是有效的压缩文档');
    expandedBytes += data.length;
    files.set(name, data);
  }
  if (offset !== directoryEnd) throw new Error('不是有效的压缩文档');
  return files;
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function extractDocxText(buffer) {
  const files = readZipEntries(buffer, { include: name => name === 'word/document.xml' });
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('这份 Word 里没有可读取的正文');
  return decodeXmlText(xml.toString('utf8'))
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
}

function extractEpubText(buffer) {
  const files = readZipEntries(buffer, { include: name => /\.(xhtml|html|htm)$/i.test(name) });
  const parts = [];
  for (const [name, data] of files) {
    if (!/\.(xhtml|html|htm)$/i.test(name)) continue;
    const html = data.toString('utf8');
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    const text = decodeXmlText(body ? body[1] : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    if (text.trim()) parts.push(text);
  }
  if (!parts.length) throw new Error('这本电子书里没有可读取的正文');
  return parts.join('\n');
}

function storeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = {
  buildReadingSubtitles,
  subtitleContent,
  isEnglishCue,
  readZipEntries,
  extractDocxText,
  extractEpubText,
  storeZip,
};
