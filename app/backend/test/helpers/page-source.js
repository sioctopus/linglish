// 读取页面"有效源码":HTML 本体 + 它外链的 js/pages/* 页面脚本内容。
// 大页面已把巨型内联脚本提取为版本化外链文件(可被浏览器长缓存),
// 测试断言的是页面最终行为/内容,所以要同时看两部分。
const fs = require('fs');
const path = require('path');

const frontendRoot = path.join(__dirname, '..', '..', '..', 'frontend');
const EXTRACTED_PAGE_SCRIPT = /<script src="\.\/(js\/pages\/[^"?]+)[^"]*"><\/script>/g;

function readPage(relativePath) {
  const html = fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
  let combined = html;
  for (const match of html.matchAll(EXTRACTED_PAGE_SCRIPT)) {
    try {
      combined += '\n' + fs.readFileSync(path.join(frontendRoot, match[1]), 'utf8');
    } catch (_) { /* 外链文件缺失时让针对 HTML 的断言自行暴露 */ }
  }
  return combined;
}

module.exports = { readPage, frontendRoot };
