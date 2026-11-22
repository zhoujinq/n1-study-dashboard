import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);

const forbiddenExtensions = new Set([
  '.pdf', '.mp3', '.wav', '.ogg', '.apkg', '.anki21', '.zip',
  '.onnx', '.gguf', '.bin', '.sqlite3', '.pyc', '.exe', '.dll'
]);
const forbiddenDirectories = new Set(['resources', 'private', 'models', 'sources', 'tmp', 'runs']);
for (const file of files) {
  const relative = path.relative(root, file);
  assert(!forbiddenExtensions.has(path.extname(file).toLowerCase()), `禁止发布的文件类型：${relative}`);
  assert(!relative.split(path.sep).some(part => forbiddenDirectories.has(part)), `禁止发布的目录：${relative}`);
}

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(index.includes('static-data.js'), '入口缺少静态数据');
assert(index.includes('static-api.js'), '入口缺少静态接口适配');
assert(!index.includes('await setupExam()'), '入口仍调用不存在的旧模块');
assert(index.includes('applyOnlineProgress(r)'), '入口未应用浏览器进度');
assert(!index.includes('src="${esc(item.links.find'), '入口仍可能请求本地音频');

const raw = fs.readFileSync(path.join(root, 'static-data.js'), 'utf8');
const prefix = 'window.N1_STATIC_DATA=';
assert(raw.startsWith(prefix) && raw.endsWith(';'), '静态数据封装格式错误');
const data = JSON.parse(raw.slice(prefix.length, -1));
assert.equal(data.vocab.session.questions.length, 5, '当前词汇首屏应为五词');
for (const question of data.vocab.session.questions) {
  for (const key of ['wordAudio', 'exampleAudio', 'audio']) {
    assert(!(key in question), `词汇快照仍包含音频字段：${key}`);
  }
}
assert.equal(data.paper.questions.length, 92, '真题导航数量被改变');
assert.equal(String(data.paper.questions[15].number), '16', '首屏题号不是本地当前题');
assert.equal(data.paper.questions[15].options.length, 4, '首屏真题选项不完整');
assert(data.paper.questions.every((question, index) => index === 15 || question.options.length === 0), '非首屏题目正文未被裁剪');

const api = fs.readFileSync(path.join(root, 'static-api.js'), 'utf8');
assert(api.includes("localStorage.setItem(STORAGE_KEY"), '本日进度未写入浏览器');
assert(api.includes("path === '/api/papers/catalog'"), '真题目录未接入静态数据');
assert(api.includes("path === '/api/vocab/state'"), '词汇状态未接入静态数据');

for (const file of files.filter(file => /\.(?:html|css|js|json|md|mjs)$/i.test(file))) {
  const content = fs.readFileSync(file, 'utf8');
  assert(!/C:[\\/]Users[\\/]/i.test(content), `文件包含本机绝对路径：${path.relative(root, file)}`);
}

console.log(`静态发布检查通过：${files.length} 个文件；无媒体资源；首屏数据完整。`);
