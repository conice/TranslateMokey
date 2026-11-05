import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/core.js';
import { createReader } from '../src/reader.js';
import { createDOM } from './dom.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 190));
function fixture(context) {
  const { document, scans } = createDOM();
  const tasks = [];
  const messages = [];
  const listeners = new Map();
  let mutation;
  let intersection;
  const window = {
    location: { href: 'https://example.com/first' }, innerHeight: 600,
    getComputedStyle: (node) => ({ visibility: node.style.visibility || 'visible', display: node.style.cssText?.includes('display:none') ? 'none' : node.style.display || 'block' }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { mutation = this.callback; }
      disconnect() { mutation = undefined; }
    },
    IntersectionObserver: class {
      constructor(callback) { intersection = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  function add(text, top = 0, excluded = false) {
    const block = document.createElement('p');
    block.top = top;
    if (excluded) block.setAttribute('contenteditable', 'true');
    block.text = document.createTextNode(text);
    block.append(block.text);
    document.body.append(block);
    return block;
  }
  document.defaultView = window;
  const queue = { enqueue(config, key, text, priority, bypassCache) {
    const task = { config, key, text, priority, bypassCache, cancelled: false };
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.cancel = () => { task.cancelled = true; task.reject(new Error('请求已取消')); };
    tasks.push(task);
    return task;
  } };
  const reader = createReader({ document, queue, key: () => '', onStatus: (message) => messages.push(message) });
  context.after(() => reader.stop());
  return { add, tasks, reader, window, messages, listeners, document, scans,
    mutate: (block) => mutation?.([{ type: 'characterData', target: block.text || block }]),
    change: (records) => mutation?.(records),
    enter: (block) => { block.top = 0; intersection([{ target: block, isIntersecting: true }]); },
  };
}

test('任务状态支持单一暂停继续按钮与显示模式同步', (context) => {
  const app = fixture(context);
  assert.deepEqual(app.reader.state(), { enabled: false, paused: false, mode: 'bilingual' });
  app.reader.start(DEFAULT_SETTINGS, { automatic: false });
  assert.equal(app.reader.state().enabled, true);
  app.reader.pause();
  assert.equal(app.reader.state().paused, true);
  app.reader.resume();
  assert.equal(app.reader.state().paused, false);
  app.reader.setMode('translation-only');
  assert.equal(app.reader.state().mode, 'translation-only');
  app.reader.stop();
  assert.equal(app.reader.state().enabled, false);
  assert.equal(app.tasks.length, 0);
});

test('默认零请求，可见正文优先、排除私有区域和过长段落、滚动翻译及纯文本恢复', async (context) => {
  const app = fixture(context);
  const first = app.add('Hello <strong>world</strong>');
  const below = app.add('Below viewport', 900);
  app.add('private draft', 0, true);
  app.add('a'.repeat(10001));
  assert.equal(app.tasks.length, 0);
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  assert.equal(app.tasks.length, 1);
  app.tasks[0].resolve('<img onerror=alert(1)>');
  await tick();
  assert.equal(first.children[0].label.textContent, '<img onerror=alert(1)>');
  app.enter(below);
  await tick();
  assert.equal(app.tasks.length, 2);
  app.tasks[1].resolve('下方');
  await tick();
  app.reader.stop();
  assert.equal(first.children.length, 0);
  assert.equal(below.children.length, 0);
  assert.equal(first.text.textContent, 'Hello <strong>world</strong>');
});

test('动态文字替换、节点删除与迟到响应不插入旧译文', async (context) => {
  const app = fixture(context);
  const block = app.add('old');
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  block.text.textContent = 'new';
  app.tasks[0].resolve('旧译文');
  await tick();
  assert.equal(block.children.filter((child) => Object.hasOwn(child.dataset, 'tmTranslation')).length, 0);
  app.mutate(block);
  await settle();
  assert.equal(app.tasks[1].text, 'new');
  app.tasks[1].resolve('新译文');
  await tick();
  const added = app.add('dynamic');
  app.mutate(added);
  await settle();
  assert.equal(app.tasks[2].text, 'dynamic');
  added.remove();
  app.tasks[2].resolve('已删除');
  await tick();
  assert.equal(added.children.filter((child) => Object.hasOwn(child.dataset, 'tmTranslation')).length, 0);
  assert.equal(block.children.filter((child) => Object.hasOwn(child.dataset, 'tmTranslation')).length, 1);
});

test('暂停立即继续不会插入旧响应，失败需显式重试', async (context) => {
  const app = fixture(context);
  const block = app.add('hello');
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  app.reader.pause();
  app.reader.resume();
  await tick();
  assert.equal(app.tasks[0].cancelled, true);
  assert.equal(app.tasks.length, 2);
  app.tasks[1].reject(new Error('请求被限流，请稍后手动重试'));
  await tick();
  await settle();
  assert.equal(app.tasks.length, 2);
  assert.match(app.messages.at(-1), /失败 1.*限流/);
  app.reader.retry();
  await tick();
  app.tasks[2].resolve('你好');
  await tick();
  assert.equal(block.children.filter((child) => Object.hasOwn(child.dataset, 'tmTranslation')).length, 1);
});

test('SPA 地址变化先拒绝迟到响应，再停止并移除监听器', async (context) => {
  const app = fixture(context);
  const block = app.add('first page');
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  app.window.location.href = 'https://example.com/second';
  app.tasks[0].resolve('旧页面');
  await tick();
  assert.equal(block.children.filter((child) => Object.hasOwn(child.dataset, 'tmTranslation')).length, 0);
  await settle();
  assert.match(app.messages.at(-1), /地址已变化/);
  assert.equal(app.listeners.size, 0);
});

test('没有观察器时仍支持手动阅读和滚动；同语言不发送请求', async (context) => {
  const app = fixture(context);
  delete app.window.IntersectionObserver;
  delete app.window.MutationObserver;
  const block = app.add('later', 900);
  assert.throws(() => app.reader.start({ ...DEFAULT_SETTINGS, source: 'en', target: 'en' }), /相同/);
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  assert.equal(app.tasks.length, 0);
  block.top = 0;
  app.listeners.get('scroll')();
  await settle();
  assert.equal(app.tasks.length, 1);
  app.reader.stop();
  await tick();
  assert.equal(app.tasks[0].cancelled, true);
});

test('仅译文可即时切回双语，保留原始链接、文本身份和事件', async (context) => {
  const app = fixture(context);
  const block = app.add('Hello ');
  const link = app.document.createElement('a');
  link.textContent = 'world';
  let clicks = 0;
  link.addEventListener('click', () => { clicks += 1; });
  block.append(link);
  const originalText = link.firstChild;
  app.reader.start({ ...DEFAULT_SETTINGS, translationMode: 'translation-only', translationFontSize: 1.3,
    translationLineHeight: 2.1, translationColor: 'accent' });
  await tick();
  assert.equal(app.tasks[0].text, 'Hello world');
  app.tasks[0].resolve('你好世界');
  await tick();
  assert.equal(block.querySelectorAll('[data-tm-original]').length, 2);
  assert.equal(link.firstChild.firstChild, originalText);
  const note = block.querySelector('[data-tm-translation]');
  assert.match(note.label.style.cssText, /1.3em\/2.1/);
  assert.match(note.label.style.cssText, /#17684a/);
  await settle();
  assert.equal(app.tasks.length, 1);
  app.reader.setMode('bilingual');
  assert.equal(link.firstChild, originalText);
  assert.equal(block.firstChild, block.text);
  assert.equal(block.querySelectorAll('[data-tm-original]').length, 0);
  app.reader.setMode('translation-only');
  app.reader.stop();
  assert.equal(block.textContent, 'Hello world');
  assert.equal(link.firstChild, originalText);
  link.click();
  assert.equal(clicks, 1);
});

test('修改外观立即更新已有译文，后续译文沿用且不重新请求', async (context) => {
  const app = fixture(context);
  const first = app.add('First');
  const second = app.add('Second', 900);
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  app.tasks[0].resolve('第一');
  await tick();
  const note = first.querySelector('[data-tm-translation]');
  app.reader.updateAppearance({ ...DEFAULT_SETTINGS, translationFontSize: 0.85, translationLineHeight: 2.1 });
  assert.equal(first.querySelector('[data-tm-translation]'), note);
  assert.match(note.label.style.cssText, /0.85em\/2.1/);
  assert.equal(app.tasks.length, 1);
  app.enter(second);
  await tick();
  app.tasks[1].resolve('第二');
  await tick();
  assert.match(second.querySelector('[data-tm-translation]').label.style.cssText, /0.85em\/2.1/);
  assert.equal(app.tasks.length, 2);
});

test('仅译文下原文变化重新翻译；恢复不复活网站已删除的节点', async (context) => {
  const app = fixture(context);
  const block = app.add('first');
  app.reader.start({ ...DEFAULT_SETTINGS, translationMode: 'translation-only' });
  await tick();
  app.tasks[0].resolve('第一');
  await tick();
  block.text.textContent = 'second';
  app.mutate(block);
  await settle();
  assert.equal(app.tasks[1].text, 'second');
  app.tasks[1].resolve('第二');
  await tick();
  block.textContent = 'replacement';
  app.reader.stop();
  assert.equal(block.textContent, 'replacement');
  assert.equal(block.text.isConnected, false);
});

test('逐段模式不自动请求，可信点击翻译，重译取消旧任务并绕过缓存', async (context) => {
  const app = fixture(context);
  const block = app.add('hello');
  app.reader.start(DEFAULT_SETTINGS, { automatic: false });
  await tick();
  assert.equal(app.tasks.length, 0);
  const buttons = block.querySelector('[data-tm-control]').shadow.children;
  buttons[0].click(false);
  buttons[1].click(false);
  await tick();
  assert.equal(app.tasks.length, 0);
  buttons[0].click();
  await tick();
  assert.equal(app.tasks[0].text, 'hello');
  buttons[1].click();
  await tick();
  assert.equal(app.tasks[0].cancelled, true);
  assert.equal(app.tasks[1].bypassCache, true);
  app.tasks[1].resolve('你好');
  await tick();
  buttons[1].click();
  await tick();
  assert.equal(app.tasks[2].bypassCache, true);
  app.tasks[2].resolve('您好');
  await tick();
  assert.equal(block.querySelector('[data-tm-translation]').label.textContent, '您好');
});

test('动态更新只扫描变更段落，脚本控件与译文变更不触发正文遍历', async (context) => {
  const app = fixture(context);
  const first = app.add('first');
  const second = app.add('second');
  app.reader.start(DEFAULT_SETTINGS, { automatic: false });
  app.scans.length = 0;
  first.text.textContent = 'changed';
  app.mutate(first);
  await settle();
  assert.deepEqual(app.scans, [first]);
  app.scans.length = 0;
  const control = second.querySelector('[data-tm-control]');
  app.change([{ type: 'childList', target: second, addedNodes: [control], removedNodes: [] }]);
  await settle();
  assert.equal(app.scans.length, 0);
  assert.equal(app.tasks.length, 0);
});

test('隐藏行内内容不发送，祖先隐藏后移除译文，恢复可见重新派发', async (context) => {
  const app = fixture(context);
  const section = app.document.createElement('section');
  const block = app.add('public');
  app.document.body.append(section);
  section.append(block);
  const hidden = app.document.createElement('span');
  hidden.style.display = 'none';
  hidden.textContent = 'private';
  block.append(hidden);
  app.reader.start(DEFAULT_SETTINGS);
  await tick();
  assert.equal(app.tasks[0].text, 'public');
  app.tasks[0].resolve('公开');
  await tick();
  section.style.display = 'none';
  app.change([{ type: 'attributes', target: section }]);
  await settle();
  assert.equal(block.querySelector('[data-tm-translation]'), null);
  section.style.display = 'block';
  app.change([{ type: 'attributes', target: section }]);
  await settle();
  assert.equal(app.tasks[1].text, 'public');
});

test('长页面初始扫描分批完成，局部变更不重扫其他 1000 段', async (context) => {
  const app = fixture(context);
  const blocks = Array.from({ length: 1001 }, (_value, index) => app.add(`paragraph ${index}`, 900));
  app.reader.start(DEFAULT_SETTINGS, { automatic: false });
  const deadline = Date.now() + 5000;
  while (!app.document.body.querySelector('[data-tm-control]') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.document.body.querySelectorAll('[data-tm-control]').length, 1001);
  app.scans.length = 0;
  blocks[500].text.textContent = 'updated';
  app.mutate(blocks[500]);
  await settle();
  assert.deepEqual(app.scans, [blocks[500]]);
  assert.equal(app.tasks.length, 0);
});

test('已掌握源语言不请求并计入跳过，auto 不做推测性跳过', async (context) => {
  const app = fixture(context);
  app.add('hello');
  app.reader.start({ ...DEFAULT_SETTINGS, source: 'en', target: 'zh-cn', knownLanguages: ['en'] });
  await tick();
  assert.equal(app.tasks.length, 0);
  assert.match(app.messages.at(-1), /跳过 1/);
  app.reader.stop();
  const auto = fixture(context);
  auto.add('hello');
  auto.reader.start({ ...DEFAULT_SETTINGS, knownLanguages: ['en'] });
  await tick();
  assert.equal(auto.tasks.length, 1);
});
