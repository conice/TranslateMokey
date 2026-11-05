import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULT_SETTINGS } from '../src/core.js';

const modules = ['core', 'review', 'dictionary', 'speech', 'storage', 'service', 'queue', 'annotations', 'reader', 'ui', 'main'];
const source = `(() => { 'use strict'; ${modules.map((name) => readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n')} })();`;

function environment() {
  const nodes = [];
  const menus = [];
  const alerts = [];
  const events = new Map();
  const documentEvents = new Map();
  const captureEvents = new Map();
  const downloads = [];
  const menuActions = new Map();
  const initialValues = new Map();
  const createElement = (tag) => {
    const node = {
      tag, dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, children: [], value: '', hidden: false,
      attributes: {},
      setAttribute(name, value) { node.attributes[name] = value; },
      getAttribute(name) { return node.attributes[name] ?? null; },
      showModal() { node.open = true; },
      close() { node.open = false; events.get(`${nodes.indexOf(node)}:close`)?.(); },
      focus() {},
      addEventListener(type, handler) { events.set(`${nodes.indexOf(node)}:${type}`, handler); },
      append(...children) { node.children.push(...children); for (const child of children) child.parentElement = node; },
      prepend(...children) { node.children.unshift(...children); },
      attachShadow() { node.shadow = createElement('shadow'); return node.shadow; },
      querySelector() { return null; },
      replaceChildren(...children) { node.children = children; },
      click() { if (node.tag === 'a') downloads.push(node.download); },
      remove() {},
    };
    nodes.push(node);
    return node;
  };
  const window = { addEventListener() {}, alert: (text) => alerts.push(text) };
  window.top = window;
  window.self = window;
  const document = { createElement, createElementNS: (namespace, tag) => createElement(tag), defaultView: window, documentElement: createElement('html'), title: 'Test',
    addEventListener(type, handler, options) { (options?.capture ? captureEvents : documentEvents).set(type, handler); } };
  const context = {
    window, document, URL, Blob, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval,
    GM_getValue: (key, fallback) => initialValues.get(key) ?? fallback,
    GM_setValue(key, value) { assert.equal(key, 'tm:logs'); initialValues.set(key, value); },
    GM_listValues: () => [],
    GM_addValueChangeListener() {},
    GM_registerMenuCommand: (title, action) => { menus.push(title); menuActions.set(title, action); },
    GM_xmlhttpRequest() { assert.fail('首次启动不得请求服务'); },
  };
  return { context, nodes, menus, alerts, events, documentEvents, captureEvents, downloads, menuActions };
}

test('打包作用域可以启动，初次安装不请求服务或保存设置', () => {
  const app = environment();
  runInNewContext(source, app.context);
  assert.deepEqual(app.alerts, []);
  assert.equal(app.menus.length, 3);
  assert.equal(app.context.document.documentElement.children.length, 1);
  assert.ok(app.nodes.some((node) => node.getAttribute('aria-label') === '查询'));
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
  const sendIndex = app.nodes.findIndex((node) => node.getAttribute('aria-label') === '查询');
  app.events.get(`${sendIndex}:click`)({ isTrusted: false });
});

test('界面导航标明当前页并关联内容，切换不自动聚焦输入框', async () => {
  const app = translationApp();
  const pages = app.nodes.filter((node) => node.className === 'page');
  const nav = app.nodes.find((node) => node.tag === 'nav');
  const panel = app.nodes.find((node) => node.className === 'panel');
  assert.equal(pages.length, 5);
  assert.ok(pages.every((page) => page.hidden));
  assert.equal(panel.getAttribute('aria-modal'), null);
  for (const page of pages) {
    page.querySelector = () => ({ focus() { assert.fail('导航切换不应唤起软键盘'); } });
  }
  assert.equal(nav.children.length, 3);
  for (const control of nav.children) {
    app.events.get(`${app.nodes.indexOf(control)}:click`)({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
    const visible = pages.filter((page) => !page.hidden);
    assert.equal(visible.length, 1);
    assert.ok(control.getAttribute('aria-controls').startsWith('tm-page-'));
    assert.equal(visible[0].children[0].tag, 'h2');
    assert.equal(nav.children.filter((node) => node.getAttribute('aria-current') === 'page').length, 1);
    assert.equal(control.getAttribute('aria-current'), 'page');
  }
  assert.equal(app.requests.length, 0);
});

test('说明按钮位于对应功能旁而非页面标题，内容按主题展示且不发送请求', async () => {
  const app = translationApp();
  const dialog = app.nodes.find((node) => node.className === 'help-dialog');
  const controls = app.nodes.filter((node) => node.className === 'help-trigger');
  assert.equal(controls.length, 16);
  assert.equal(dialog.id, 'tm-help');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'tm-help-title');
  for (const control of controls) {
    const row = control.parentElement;
    assert.equal(row.className, 'context-help');
    assert.equal(control.textContent, 'ⓘ');
    assert.equal(control.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(control.getAttribute('aria-controls'), dialog.id);
    assert.match(control.getAttribute('aria-label'), /^查看.+说明$/);
    app.events.get(`${app.nodes.indexOf(control)}:click`)({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dialog.open, true);
    assert.ok(dialog.children[1].children.length > 0);
    assert.ok(dialog.children[1].children.every((node) => node.tag === 'p' && node.textContent.length > 0));
    assert.equal(dialog.children[0].children[0].textContent, row.children[0].textContent);
    await app.click('知道了');
    assert.equal(dialog.open, false);
  }
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('说明弹窗关闭恢复按钮焦点，Escape 不关闭主面板', async () => {
  const app = translationApp();
  await app.click('文本');
  const dialog = app.nodes.find((node) => node.className === 'help-dialog');
  const trigger = app.nodes.find((node) => node.className === 'help-trigger');
  const panel = app.nodes.find((node) => node.className === 'panel');
  let restored = 0;
  trigger.isConnected = true;
  trigger.focus = () => { restored++; };
  app.events.get(`${app.nodes.indexOf(trigger)}:click`)({ isTrusted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!dialog.open);
  await app.click('ⓘ');
  let prevented = false;
  let stopped = false;
  app.events.get(`${app.nodes.indexOf(dialog)}:keydown`)({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(dialog.open, false);
  assert.equal(panel.hidden, false);
  assert.equal(restored, 1);
  assert.ok(prevented && stopped);
  await app.click('ⓘ');
  await app.click('关闭');
  assert.equal(dialog.open, false);
  assert.equal(panel.hidden, true);
  assert.equal(restored, 1);
});

test('选区打开聚焦非输入容器，Escape 关闭并恢复原焦点', async () => {
  const app = translationApp();
  const panel = app.nodes.find((node) => node.className === 'panel');
  const launcher = app.nodes.find((node) => node.className === 'launcher');
  let focused = 0;
  let restored = 0;
  let prevented = 0;
  let stopped = 0;
  panel.focus = (options) => { assert.equal(options.preventScroll, true); focused++; };
  app.context.document.activeElement = { isConnected: true, focus() { restored++; } };
  await app.click('译');
  assert.equal(focused, 1);
  assert.equal(panel.tabIndex, -1);
  assert.equal(launcher.getAttribute('aria-controls'), panel.id);
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
  app.events.get(`${app.nodes.indexOf(panel)}:keydown`)({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(panel.hidden, true);
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(restored, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(app.requests.length, 1);
});

test('可视视口变化为软键盘预留空间，缩放时不追随视口', () => {
  const app = environment();
  const listeners = new Map();
  const viewport = { height: 800, offsetTop: 0, scale: 1, addEventListener(name, listener) { listeners.set(name, listener); } };
  app.context.window.visualViewport = viewport;
  app.context.window.innerHeight = 800;
  runInNewContext(source, app.context);
  app.menuActions.get('打开 TranslateMokey')();
  const panel = app.nodes.find((node) => node.className === 'panel');
  assert.equal(panel.style['--viewport-height'], '800px');
  viewport.height = 420;
  viewport.offsetTop = 30;
  listeners.get('resize')();
  assert.equal(panel.style['--viewport-height'], '420px');
  assert.equal(panel.style['--viewport-bottom'], '350px');
  viewport.offsetTop = 80;
  listeners.get('scroll')();
  assert.equal(panel.style['--viewport-bottom'], '300px');
  viewport.scale = 2;
  viewport.height = 200;
  listeners.get('resize')();
  assert.equal(panel.style['--viewport-height'], '420px');
  viewport.scale = 1;
  viewport.height = 800;
  viewport.offsetTop = 0;
  listeners.get('resize')();
  assert.equal(panel.style['--viewport-bottom'], '0px');
});

test('样式保留不透明内容层、主题与无障碍降级，表单控件统一尺寸', () => {
  const app = environment();
  runInNewContext(source, app.context);
  const css = app.nodes.find((node) => node.tag === 'style').textContent;
  for (const feature of ['prefers-color-scheme:dark', 'prefers-reduced-transparency:reduce', 'prefers-contrast:more',
    'forced-colors:active', 'prefers-reduced-motion:reduce', 'safe-area-inset-bottom', '100dvh']) assert.ok(css.includes(feature));
  assert.match(css, /button,input,textarea,select \{ font:inherit/);
  assert.match(css, /input\[type=checkbox\].*width:22px/);
  assert.match(css, /\.chrome,\.launcher::before \{ background:var\(--surface\)/);
  assert.match(css, /\.launcher \{[^}]*min-width:44px; min-height:44px;[^}]*background:transparent/);
  assert.match(css, /\.launcher::before \{[^}]*inset:6px;[^}]*pointer-events:none;[^}]*background:var\(--surface\)/);
  assert.doesNotMatch(css, /min-width:52px; min-height:52px/);
  assert.match(css, /\.word \{[^}]*background:transparent/);
  assert.match(css, /min-height:44px; min-width:44px/);
  assert.match(css, /font:14px\/1.5 system-ui/);
  assert.match(css, /h2 \{ font-size:24px; line-height:1.2; font-weight:600; letter-spacing:normal/);
  assert.match(css, /h3 \{ font-size:18px; line-height:1.3; font-weight:600/);
  assert.match(css, /#tm-page-settings>details>summary \{ font-size:16px; line-height:1.5; font-weight:600/);
  assert.match(css, /@media\(max-width:600px\) \{\s*label input,label textarea,label select \{ font-size:16px/);
});

test('浅深主题的正文、提示与主按钮配色达到 4.5:1', () => {
  const app = environment();
  runInNewContext(source, app.context);
  const css = app.nodes.find((node) => node.tag === 'style').textContent;
  function luminance(hex) {
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const channels = expanded.match(/../g).map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const palettes = [...css.matchAll(/:host \{([^}]+)\}/g)].slice(0, 2);
  assert.equal(palettes.length, 2);
  for (const palette of palettes) {
    const colors = Object.fromEntries([...palette[1].matchAll(/--([\w-]+):#([0-9a-f]+);/g)].map((match) => [match[1], match[2]]));
    for (const [foreground, background] of [['ink', 'surface'], ['ink', 'card'], ['muted', 'surface'], ['muted', 'card'], ['on-accent', 'accent']]) {
      const light = luminance(colors[foreground]);
      const dark = luminance(colors[background]);
      assert.ok((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) >= 4.5, `${foreground}/${background}`);
    }
  }
});

test('翻译等待状态有明确文字，取消后恢复主操作', async () => {
  const app = environment();
  let aborted = false;
  app.context.window.location = { origin: 'https://example.com', hostname: 'example.com', pathname: '/' };
  app.context.window.confirm = () => true;
  app.context.GM_xmlhttpRequest = () => ({ abort() { aborted = true; } });
  runInNewContext(source, app.context);
  app.nodes.find((node) => node.tag === 'textarea').value = 'hello';
  const send = app.nodes.find((node) => node.getAttribute('aria-label') === '查询');
  app.events.get(`${app.nodes.indexOf(send)}:click`)({ isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(send.disabled, true);
  assert.equal(send.getAttribute('aria-label'), '取消查询');
  assert.ok(app.nodes.some((node) => node.textContent === '翻译中…'));
  app.events.get(`${app.nodes.indexOf(send)}:click`)({ isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.notEqual(send.disabled, true);
  assert.equal(send.getAttribute('aria-label'), '查询');
});

test('复习卡片先隐藏答案，评分持久化且不请求服务', async () => {
  const app = translationApp();
  const entry = { term: 'run', source: 'en', target: 'zh-cn', meaning: '跑', createdAt: '2026-01-01T00:00:00.000Z' };
  const key = `tm:word:${JSON.stringify([entry.term, entry.source, entry.target])}`;
  app.values.set(key, { version: 1, value: entry });
  await app.click('复习');
  assert.ok(app.nodes.some((node) => node.textContent === '显示答案'));
  assert.ok(!app.nodes.some((node) => node.tag === 'button' && node.textContent === '认识'));
  await app.click('显示答案');
  await app.click('认识');
  assert.equal(app.values.get(key).value.review.count, 1);
  assert.ok(app.nodes.some((node) => node.textContent === '本轮完成 1 条。当前到期 0 条；点击刷新开始下一轮。'));
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
  await app.click('认识');
  assert.equal(app.values.get(key).value.review.count, 1);
});

test('复习反面卡片、数量校验及写入失败保留当前进度', async () => {
  const app = translationApp();
  const entry = { term: 'run', source: 'en', target: 'zh-cn', meaning: '跑', createdAt: '2026-01-01T00:00:00.000Z' };
  const key = `tm:word:${JSON.stringify([entry.term, entry.source, entry.target])}`;
  app.values.set(key, { version: 1, value: entry });
  const limit = app.nodes.find((node) => node.textContent === '每轮数量（1–100）').children[0];
  limit.value = '0';
  await app.click('复习');
  assert.ok(app.nodes.some((node) => node.textContent === '每轮数量必须为 1–100 的整数'));
  limit.value = '1';
  app.nodes.find((node) => node.textContent === '反向卡片（看释义回忆原词）').children[0].checked = true;
  await app.click('开始 / 刷新复习');
  assert.ok(app.nodes.some((node) => node.tag === 'strong' && node.textContent === '跑'));
  await app.click('显示答案');
  app.failStorage();
  await app.click('模糊');
  assert.equal(app.values.get(key).value.review, undefined);
  assert.ok(!app.nodes.some((node) => node.textContent?.startsWith('本轮完成 1 条')));
  assert.equal(app.requests.length, 0);
});

test('词条编辑保存词形、多义项，并能交换默认义项', async () => {
  const app = translationApp();
  const entry = { term: 'run', source: 'en', target: 'zh-cn', meaning: '跑', example: 'run fast', createdAt: '2026-01-01T00:00:00.000Z',
    senses: [{ meaning: '运营', example: 'run a shop' }] };
  const key = `tm:word:${JSON.stringify([entry.term, entry.source, entry.target])}`;
  app.values.set(key, { version: 1, value: entry });
  await app.click('生词本');
  const summaryRow = app.nodes.find((node) => node.className === 'word-summary');
  assert.deepEqual(summaryRow.children.map((node) => [node.tag, node.textContent]),
    [['strong', 'run'], ['span', '跑'], ['span', '词条详情与管理']]);
  assert.equal(summaryRow.parentElement.tag, 'summary');
  assert.equal(summaryRow.parentElement.parentElement.open, undefined);
  await app.click('编辑');
  app.nodes.find((node) => node.textContent === '原形（手动确认；留空不关联）').children[0].value = 'run';
  app.nodes.find((node) => node.textContent === '关联词形（每行一个，最多 20 个；区分大小写）').children[0].value = 'running\nran';
  await app.click('设为默认义项');
  await app.click('保存修改');
  const saved = app.values.get(key).value;
  assert.equal(saved.meaning, '运营');
  assert.equal(saved.example, 'run a shop');
  assert.equal(saved.senses[0].meaning, '跑');
  assert.equal(saved.forms.join(','), 'running,ran');
  assert.equal(app.requests.length, 0);
});

test('重复收藏补充义项且保留默认释义和复习记录', async () => {
  const app = translationApp({ hideFeePopup: true });
  const entry = { term: 'robust', source: 'auto', target: 'zh-cn', meaning: '强健的', example: '', createdAt: '2026-01-01T00:00:00.000Z',
    forms: ['Robust'], review: { count: 1, step: 0, feedback: 'known', lastAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-01-02T00:00:00.000Z' } };
  const key = `tm:word:${JSON.stringify([entry.term, entry.source, entry.target])}`;
  app.values.set(key, { version: 1, value: entry });
  await app.select();
  await app.click('翻译选区');
  await app.click('查询');
  await app.click('收藏当前结果');
  await app.click('收藏当前结果');
  const saved = app.values.get(key).value;
  assert.equal(saved.meaning, '强健的');
  assert.equal(saved.senses.length, 1);
  assert.equal(saved.senses[0].meaning, '稳健的');
  assert.equal(saved.review.count, 1);
  assert.equal(saved.forms[0], 'Robust');
});

test('缺少必要管理器 API 时明确报错且不挂载半成品界面', () => {
  const app = environment();
  delete app.context.GM_xmlhttpRequest;
  runInNewContext(source, app.context);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /GM_\*/);
  assert.equal(app.context.document.documentElement.children.length, 0);
});

function translationApp(options = {}, allowConfirm = true, handleRequest) {
  const app = environment();
  const values = new Map([['tm:settings', { version: 1, value: { ...DEFAULT_SETTINGS, ...options } }]]);
  const requests = [];
  const confirmations = [];
  let failStorage = false;
  app.context.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
  app.context.GM_listValues = () => [...values.keys()];
  app.context.GM_setValue = (key, value) => {
    if (failStorage) throw new Error('storage unavailable');
    values.set(key, value);
  };
  app.context.GM_xmlhttpRequest = (request) => {
    requests.push(request);
    if (handleRequest) return handleRequest(request);
    const body = request.method === 'POST' ? '{"choices":[{"message":{"content":"稳健的"}}]}'
      : /\/models$/.test(request.url) ? '{"data":[{"id":"model-one"},{"id":"model-two"}]}'
        : '{"meaning":"<img onerror=alert(1)>","phonetic":"/test/"}';
    request.onload({ status: 200, responseText: body });
    return { abort() {} };
  };
  app.context.window.location = { origin: 'https://example.com', hostname: 'example.com', pathname: '/', href: 'https://example.com/' };
  app.context.window.confirm = (message) => { confirmations.push(message); return allowConfirm; };
  let selectedText = 'robust';
  let excluded = false;
  const parent = { closest: () => excluded ? parent : null };
  const text = { nodeType: 3, parentElement: parent };
  app.context.window.getSelection = () => ({
    rangeCount: 1, isCollapsed: !selectedText, toString: () => selectedText,
    getRangeAt: () => ({ startContainer: text, endContainer: text, cloneContents: () => ({ querySelector: () => null }) }),
  });
  runInNewContext(source, app.context);
  assert.deepEqual(app.alerts, []);
  const click = async (title) => {
    const labelledIndex = app.nodes.findIndex((node) => node.tag === 'button' && node.getAttribute('aria-label') === title);
    const index = labelledIndex >= 0 ? labelledIndex : app.nodes.findIndex((node) => node.tag === 'button' && node.textContent === title);
    assert.ok(index >= 0, `缺少按钮：${title}`);
    app.events.get(`${index}:click`)({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const select = async (value = 'robust', trusted = true) => {
    selectedText = value;
    app.documentEvents.get('selectionchange')();
    app.documentEvents.get('pointerup')({ isTrusted: trusted, composedPath: () => [] });
    await new Promise((resolve) => setTimeout(resolve, 350));
  };
  const change = async (input, trusted = true) => {
    app.events.get(`${app.nodes.indexOf(input)}:change`)({ isTrusted: trusted });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...app, requests, confirmations, click, change, select, values, exclude() { excluded = true; }, failStorage() { failStorage = true; } };
}

test('词典默认内置只读脱敏；取消确认或禁用网站不请求，自定义配置保存不执行 JS', async () => {
  const app = translationApp({}, false);
  const summary = app.nodes.find((node) => node.tag === 'p' && node.textContent.startsWith('内置词典'));
  assert.ok(summary);
  assert.ok(!summary.textContent.includes('cn.bing.com'));
  assert.equal(app.nodes.find((node) => node.textContent === '编辑当前词典').hidden, true);
  assert.equal(app.nodes.find((node) => node.textContent === '删除当前词典').hidden, true);
  await app.click('词典');
  app.nodes.find((node) => node.textContent === '原文（选区或手动粘贴，上限 10000 字符）').children[0].value = 'hello';
  await app.click('查询');
  assert.equal(app.requests.length, 0);
  assert.match(app.confirmations[0], /微软 Bing 词典（内置）/);
  assert.ok(!app.confirmations[0].includes('cn.bing.com'));
  await app.click('添加词典');
  app.nodes.find((node) => node.textContent === '词典名称').children[0].value = '本地测试词典';
  app.nodes.find((node) => node.textContent?.startsWith('词典 HTTPS URL')).children[0].value = 'https://dictionary.example/?q={term}';
  await app.click('保存词典');
  const dictionaryState = app.values.get('tm:dictionary').value;
  assert.equal(dictionaryState.profiles[0].name, '本地测试词典');
  assert.equal(dictionaryState.profiles[0].url, 'https://dictionary.example/?q={term}');
  assert.equal(dictionaryState.selectedId, dictionaryState.profiles[0].id);
  assert.equal(app.requests.length, 0);
  assert.ok(!app.nodes.some((node) => node.textContent?.includes('throw new Error("must not run")')));
  const disabled = translationApp({ siteRules: [{ host: 'example.com', mode: 'disabled', annotations: false }] });
  await disabled.click('词典');
  disabled.nodes.find((node) => node.textContent === '原文（选区或手动粘贴，上限 10000 字符）').children[0].value = 'hello';
  await disabled.click('查询');
  assert.equal(disabled.requests.length, 0);
  assert.equal(disabled.confirmations.length, 0);
});

test('选区默认 AI 直接展示只读结果，编辑后完成与收藏使用新释义', async () => {
  const app = translationApp({ hideFeePopup: true });
  await app.select('robust');
  assert.equal(app.requests.length, 0);
  await app.click('翻译选区');
  assert.equal(app.requests.length, 1);
  const editor = app.nodes.find((node) => node.className === 'translation-editor');
  const preview = app.nodes.find((node) => node.className === 'result-text' && node.textContent === '稳健的');
  assert.equal(editor.hidden, true);
  assert.ok(preview);
  await app.click('编辑释义');
  assert.equal(editor.hidden, false);
  const meaning = app.nodes.find((node) => node.textContent === '译文 / 收藏释义（可编辑）').children[0];
  meaning.value = '健壮的';
  await app.click('完成编辑');
  assert.equal(editor.hidden, true);
  assert.equal(preview.textContent, '健壮的');
  await app.click('收藏当前结果');
  const saved = [...app.values.entries()].find(([key]) => key.startsWith('tm:word:'))[1].value;
  assert.equal(saved.meaning, '健壮的');
  assert.equal(app.requests.length, 1);
});

test('默认词典只发送词典请求，结果可编辑收藏且不调用 AI', async () => {
  const app = translationApp({ lookupProvider: 'dictionary' });
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  await app.select('hello');
  await app.click('翻译选区');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'GET');
  assert.equal(app.nodes.find((node) => node.id === 'tm-page-translate').hidden, false);
  const editor = app.nodes.find((node) => node.className === 'translation-editor');
  assert.equal(editor.hidden, true);
  await app.click('编辑释义');
  assert.equal(editor.hidden, false);
  app.nodes.find((node) => node.textContent === '译文 / 收藏释义（可编辑）').children[0].value = '你好';
  await app.click('完成编辑');
  await app.click('收藏当前结果');
  const saved = [...app.values.entries()].find(([key]) => key.startsWith('tm:word:'))[1].value;
  assert.equal(saved.meaning, '你好');
  assert.equal(app.requests.length, 1);
});

test('词典费用确认可独立关闭并保存，关闭后直接请求', async () => {
  const app = translationApp({ lookupProvider: 'dictionary' });
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  const label = app.nodes.find((node) => node.textContent === '关闭弹窗（不再显示词典请求前的费用确认）');
  const checkbox = label.children[0];
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  await app.change(checkbox);
  const saved = app.values.get('tm:settings').value;
  assert.equal(saved.hideDictionaryFeePopup, true);
  assert.equal(saved.hideFeePopup, false);
  await app.select('hello');
  await app.click('翻译选区');
  assert.equal(app.confirmations.length, 0);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'GET');
});

test('词典超长与拒绝确认均不回退 AI，切换来源必须显式点击', async () => {
  const app = translationApp({ lookupProvider: 'dictionary', hideFeePopup: true });
  await app.select('word '.repeat(50));
  await app.click('翻译选区');
  assert.equal(app.requests.length, 0);
  await app.click('AI');
  assert.equal(app.requests.length, 0);
  await app.click('查询');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'POST');
  const declined = translationApp({ lookupProvider: 'dictionary' }, false);
  await declined.select();
  await declined.click('翻译选区');
  assert.equal(declined.requests.length, 0);
  assert.equal(declined.confirmations.length, 1);
});

test('统一查询保留各来源编辑结果，切换不联网，修改原文使双方结果失效', async () => {
  const app = translationApp({ hideFeePopup: true });
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  await app.click('译');
  await app.click('编辑释义');
  const meaning = app.nodes.find((node) => node.textContent === '译文 / 收藏释义（可编辑）').children[0];
  meaning.value = 'AI 草稿';
  await app.click('词典');
  assert.equal(app.requests.length, 1);
  await app.click('查询');
  await app.click('编辑释义');
  meaning.value = '词典草稿';
  await app.click('AI');
  assert.equal(meaning.value, 'AI 草稿');
  await app.click('词典');
  assert.equal(meaning.value, '词典草稿');
  assert.equal(app.requests.length, 2);
  assert.equal(app.confirmations.length, 1);
  const page = app.nodes.find((node) => node.id === 'tm-page-translate');
  assert.equal(page.children.filter((node) => node.className === 'query-toolbar').length, 1);
  assert.equal(app.nodes.some((node) => node.id === 'tm-page-dictionary'), false);
  const original = app.nodes.find((node) => node.textContent === '原文（选区或手动粘贴，上限 10000 字符）').children[0];
  original.value = 'new term';
  app.events.get(`${app.nodes.indexOf(original)}:input`)();
  await app.click('收藏当前结果');
  await app.click('AI');
  await app.click('收藏当前结果');
  assert.equal([...app.values.keys()].some((key) => key.startsWith('tm:word:')), false);
  assert.equal(meaning.value, '');
});

test('来源切换取消在途词典请求，迟到响应不覆盖 AI 结果', async () => {
  const pending = [];
  let aborted = false;
  const app = translationApp({ hideFeePopup: true }, true, (request) => { pending.push(request); return { abort() { aborted = true; } }; });
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  await app.click('译');
  assert.equal(pending.length, 1);
  pending[0].onload({ status: 200, responseText: '{"choices":[{"message":{"content":"AI 结果"}}]}' });
  await new Promise((resolve) => setImmediate(resolve));
  await app.click('词典');
  await app.click('查询');
  assert.equal(pending.length, 2);
  await app.click('AI');
  assert.equal(aborted, true);
  pending[1].onload({ status: 200, responseText: '{"meaning":"迟到词典"}' });
  await new Promise((resolve) => setImmediate(resolve));
  const meaning = app.nodes.find((node) => node.textContent === '译文 / 收藏释义（可编辑）').children[0];
  assert.equal(meaning.value, 'AI 结果');
  await app.click('词典');
  assert.equal(meaning.value, '');
  assert.equal(pending.length, 2);
});

test('词典查询按钮可取消，失败后同一按钮重试且不切换 AI', async () => {
  let aborted = false;
  const app = translationApp({ lookupProvider: 'dictionary' }, true, () => ({ abort() { aborted = true; } }));
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  await app.click('译');
  await app.click('取消查询');
  assert.equal(aborted, true);
  await app.click('查询');
  assert.equal(app.requests.length, 2);
  app.requests[1].onerror();
  await new Promise((resolve) => setImmediate(resolve));
  await app.click('重试查询');
  assert.equal(app.requests.length, 3);
  assert.ok(app.requests.every((request) => request.method === 'GET'));
  assert.equal(app.confirmations.length, 3);
  await app.click('取消查询');
});

test('查询图标具有名称和提示，本地发音按钮随播放结束及关闭复位', async () => {
  const app = translationApp({ hideFeePopup: true });
  const spoken = [];
  let stops = 0;
  app.context.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  app.context.window.speechSynthesis = {
    getVoices: () => [{ name: 'Local', lang: 'en-US', localService: true }],
    speak: (utterance) => spoken.push(utterance), cancel() { stops++; },
  };
  for (const control of app.nodes.filter((node) => node.className?.includes('icon-button'))) {
    assert.ok(control.getAttribute('aria-label'));
    assert.equal(control.title, control.getAttribute('aria-label'));
    assert.equal(control.children[0].tag, 'svg');
    assert.equal(control.children[0].getAttribute('aria-hidden'), 'true');
  }
  await app.click('译');
  await app.click('播放本地发音');
  assert.equal(spoken.length, 1);
  spoken[0].onend();
  await app.click('播放本地发音');
  await app.click('停止发音');
  assert.equal(stops, 1);
  await app.click('播放本地发音');
  await app.click('关闭');
  assert.equal(stops, 2);
  assert.ok(app.nodes.some((node) => node.getAttribute('aria-label') === '播放本地发音'));
});

test('查询来源、原文动作与结果动作按对象分组，空结果与内容层级分离', async () => {
  const app = translationApp({ hideFeePopup: true });
  const sources = app.nodes.find((node) => node.className === 'query-sources');
  const originalActions = app.nodes.find((node) => node.className === 'query-toolbar');
  const resultActions = app.nodes.find((node) => node.className === 'query-result-actions');
  const sourceLabel = app.nodes.find((node) => node.className === 'query-result-source');
  assert.deepEqual(sources.children.map((node) => node.textContent), ['AI', '词典']);
  assert.deepEqual(originalActions.children.map((node) => node.getAttribute('aria-label')), ['播放本地发音', '查询']);
  assert.deepEqual(resultActions.children.map((node) => node.getAttribute('aria-label')), ['编辑释义', '收藏当前结果']);
  for (const group of [sources, originalActions, resultActions]) {
    assert.equal(group.getAttribute('role'), 'group');
    assert.ok(group.getAttribute('aria-label'));
  }
  assert.equal(sourceLabel.tag, 'span');
  assert.ok(resultActions.children.every((node) => node.disabled));
  assert.equal(originalActions.children[0].disabled, true);
  const empty = app.nodes.find((node) => node.textContent === '输入文本或选择网页文字开始查询。');
  assert.equal(empty.className, 'hint');
  await app.click('译');
  assert.ok(resultActions.children.every((node) => !node.disabled));
  assert.equal(originalActions.children[0].disabled, false);
  assert.equal(resultActions.children[1].children[0].getAttribute('fill'), 'none');
  assert.equal(empty.className, 'result-text');
  await app.click('词典');
  assert.ok(resultActions.children.every((node) => node.disabled));
  assert.equal(empty.className, 'hint');
  const css = app.nodes.find((node) => node.tag === 'style').textContent;
  assert.match(css, /\.query-sources button\[aria-pressed=true\][^}]*text-decoration:underline/);
  assert.match(css, /\.query-result-header \{[^}]*flex-wrap:wrap/);
  assert.match(css, /button\.primary\.icon-button \{ padding:10px;/);
  assert.equal(app.requests.length, 1);
});

test('AI 查询结果已在生词本时收藏图标显示实心星', async () => {
  const app = translationApp({ hideFeePopup: true });
  const entry = { term: 'robust', source: 'auto', target: 'zh-cn', meaning: '强健的', createdAt: '2026-01-01T00:00:00.000Z' };
  const key = `tm:word:${JSON.stringify([entry.term, entry.source, entry.target])}`;
  app.values.set(key, { version: 1, value: entry });
  await app.select('robust');
  await app.click('翻译选区');
  const save = app.nodes.find((node) => node.getAttribute('aria-label') === '收藏当前结果');
  assert.equal(save.children[0].getAttribute('fill'), 'currentColor');
  await app.click('编辑释义');
  app.nodes.find((node) => node.textContent === '译文 / 收藏释义（可编辑）').children[0].value = '健壮的';
  await app.click('完成编辑');
  assert.equal(save.children[0].getAttribute('fill'), 'currentColor');
});

test('自定义 JSON 词典展示纯文本并可独立收藏；输入改变清除旧结果', async () => {
  const app = translationApp();
  await app.click('词典');
  app.values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://dictionary.example/?q={term}', script: '' } });
  const term = app.nodes.find((node) => node.textContent === '原文（选区或手动粘贴，上限 10000 字符）').children[0];
  term.value = 'word';
  await app.click('查询');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers, undefined);
  assert.match(app.requests[0].url, /dictionary\.example/);
  assert.ok(app.nodes.some((node) => node.tag === 'p' && node.textContent === '<img onerror=alert(1)>'));
  await app.click('收藏当前结果');
  const saved = [...app.values.entries()].find(([key]) => key.startsWith('tm:word:'))[1].value;
  assert.equal(saved.meaning, '<img onerror=alert(1)>');
  assert.equal(saved.target, 'zh-cn');
  term.value = 'new';
  app.events.get(`${app.nodes.indexOf(term)}:input`)();
  await app.click('收藏当前结果');
  assert.ok(app.nodes.some((node) => node.textContent === '请先完成当前来源查询'));
});

test('默认 API 只读脱敏；可添加多个自定义 API、拉取模型并独立保存 Key', async () => {
  const app = translationApp({ hideFeePopup: true });
  await app.click('设置');
  const builtInSummary = app.nodes.find((node) => node.tag === 'p' && node.textContent.startsWith('内置配置'));
  assert.ok(builtInSummary);
  assert.ok(!builtInSummary.textContent.includes('index-translate.bilibili.com'));
  assert.ok(!builtInSummary.textContent.includes('index-mt-9b'));
  assert.equal(app.nodes.find((node) => node.textContent === '编辑当前 API').hidden, true);
  assert.equal(app.nodes.find((node) => node.textContent === '删除当前 API').hidden, true);

  await app.click('添加 API');
  app.nodes.find((node) => node.textContent === 'API 名称').children[0].value = '第一个 API';
  app.nodes.find((node) => node.textContent === '翻译服务协议').children[0].value = 'openai';
  app.nodes.find((node) => node.textContent?.startsWith('HTTPS 服务地址')).children[0].value = 'https://first.example/v1';
  app.nodes.find((node) => node.textContent?.startsWith('API Key')).children[0].value = 'first-key';
  app.nodes.find((node) => node.textContent?.startsWith('附加参数 JSON')).children[0].value = '{}';
  await app.click('拉取模型');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, 'GET');
  assert.equal(app.requests[0].url, 'https://first.example/v1/models');
  assert.equal(app.requests[0].headers.Authorization, 'Bearer first-key');
  const firstModel = app.nodes.find((node) => node.textContent === '模型（拉取后选择）').children[0];
  assert.deepEqual(firstModel.children.map((node) => node.value), ['', 'model-one', 'model-two', '__manual__']);
  firstModel.value = 'model-one';
  assert.equal(app.nodes.find((node) => node.textContent?.startsWith('API Key')).children[0].value, 'first-key');
  await app.click('保存并启用');
  let saved = app.values.get('tm:settings').value;
  assert.equal(saved.apiProfiles.length, 1);
  assert.equal(saved.apiProfiles[0].name, '第一个 API');
  assert.equal(saved.apiProfiles[0].model, 'model-one');
  assert.equal(saved.selectedApiId, saved.apiProfiles[0].id);
  const firstId = saved.apiProfiles[0].id;
  assert.equal(app.values.get('tm:secret:api:' + firstId), 'first-key');
  const firstSummary = app.nodes.find((node) => node.tag === 'p' && node.textContent.startsWith('已选：第一个 API'));
  assert.ok(firstSummary);
  assert.ok(!firstSummary.textContent.includes('first.example'));
  assert.ok(!firstSummary.textContent.includes('model-one'));
  assert.ok(!firstSummary.textContent.includes('first-key'));

  await app.click('添加 API');
  app.nodes.find((node) => node.textContent === 'API 名称').children[0].value = '第二个 API';
  app.nodes.find((node) => node.textContent?.startsWith('HTTPS 服务地址')).children[0].value = 'https://second.example/v1';
  app.nodes.find((node) => node.textContent?.startsWith('API Key')).children[0].value = 'second-key';
  app.nodes.find((node) => node.textContent?.startsWith('附加参数 JSON')).children[0].value = '{}';
  const secondModel = app.nodes.find((node) => node.textContent === '模型（拉取后选择）').children[0];
  secondModel.value = '__manual__';
  app.events.get(`${app.nodes.indexOf(secondModel)}:change`)();
  app.nodes.find((node) => node.textContent?.startsWith('模型（手动填写兜底）')).children[0].value = 'second-model';
  await app.click('保存并启用');
  saved = app.values.get('tm:settings').value;
  assert.equal(saved.apiProfiles.length, 2);
  const secondId = saved.apiProfiles.find((profile) => profile.name === '第二个 API').id;
  assert.equal(app.values.get('tm:secret:api:' + firstId), 'first-key');
  assert.equal(app.values.get('tm:secret:api:' + secondId), 'second-key');

  const apiSelect = app.nodes.find((node) => node.textContent === '当前 API').children[0];
  apiSelect.value = firstId;
  await app.change(apiSelect);
  assert.equal(app.values.get('tm:settings').value.selectedApiId, firstId);
  await app.click('文本');
  await app.select('hello');
  await app.click('翻译选区');
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].method, 'POST');
  assert.equal(app.requests[1].url, 'https://first.example/v1/chat/completions');
  assert.equal(app.requests[1].headers.Authorization, 'Bearer first-key');

  apiSelect.value = secondId;
  await app.change(apiSelect);
  await app.click('编辑当前 API');
  assert.equal(app.nodes.find((node) => node.textContent?.startsWith('API Key')).children[0].value, '');
  assert.ok(app.nodes.some((node) => node.textContent === '此 API 已保存 Key（不回显）。'));
  await app.click('取消');
  await app.click('删除当前 API');
  saved = app.values.get('tm:settings').value;
  assert.equal(saved.apiProfiles.length, 1);
  assert.equal(saved.selectedApiId, DEFAULT_SETTINGS.selectedApiId);
  assert.equal(app.values.get('tm:secret:api:' + secondId), '');
  assert.equal(app.requests.length, 2);
});

test('AI 提示词内置只读，自定义提示词保存后用于请求', async () => {
  const app = translationApp({ hideFeePopup: true });
  const mode = app.nodes.find((node) => node.textContent === 'AI 提示词').children[0];
  const builtinLabel = app.nodes.find((node) => node.textContent === '内置提示词（只读）');
  const builtin = builtinLabel.children[0];
  const customLabel = app.nodes.find((node) => node.textContent === '自定义提示词（必须包含 {text}）');
  const custom = customLabel.children[0];
  assert.equal(mode.value, 'builtin');
  assert.equal(builtin.readOnly, true);
  assert.match(builtin.value, /single most common translation/);
  assert.equal(builtinLabel.hidden, false);
  assert.equal(customLabel.hidden, true);

  mode.value = 'custom';
  await app.change(mode);
  assert.equal(builtinLabel.hidden, true);
  assert.equal(customLabel.hidden, false);
  assert.equal(custom.value, builtin.value);
  assert.equal(app.values.get('tm:settings').value.promptMode, 'custom');

  custom.value = 'Translate {text} into {target}; return one common meaning only.';
  await app.change(custom);
  assert.equal(app.values.get('tm:settings').value.customPrompt, custom.value);
  await app.select('hello');
  await app.click('翻译选区');
  assert.equal(app.requests.length, 1);
  assert.equal(JSON.parse(app.requests[0].data).messages[0].content,
    'Translate hello into zh-cn; return one common meaning only.');
  assert.equal(app.confirmations.length, 0);
});

test('可添加多个词典，切换后查询使用选中词典', async () => {
  const app = translationApp({ lookupProvider: 'dictionary' });
  const addDictionary = async (name, url) => {
    await app.click('添加词典');
    app.nodes.find((node) => node.textContent === '词典名称').children[0].value = name;
    app.nodes.find((node) => node.textContent?.startsWith('词典 HTTPS URL')).children[0].value = url;
    await app.click('保存词典');
  };
  await addDictionary('第一词典', 'https://first-dictionary.example/?q={term}');
  await addDictionary('第二词典', 'https://second-dictionary.example/?q={term}');
  const state = app.values.get('tm:dictionary').value;
  assert.equal(state.profiles.length, 2);
  const [first, second] = state.profiles;
  const dictionarySelect = app.nodes.find((node) => node.textContent === '当前词典').children[0];

  dictionarySelect.value = first.id;
  await app.change(dictionarySelect);
  assert.equal(app.values.get('tm:dictionary').value.selectedId, first.id);
  await app.click('词典');
  const term = app.nodes.find((node) => node.textContent === '原文（选区或手动粘贴，上限 10000 字符）').children[0];
  term.value = 'hello';
  await app.click('查询');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, 'https://first-dictionary.example/?q=hello');

  dictionarySelect.value = second.id;
  await app.change(dictionarySelect);
  assert.equal(app.values.get('tm:dictionary').value.selectedId, second.id);
  await app.click('查询');
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].url, 'https://second-dictionary.example/?q=hello');
  assert.match(app.confirmations[1], /第二词典/);
  assert.ok(!app.confirmations[1].includes('second-dictionary.example'));
});

test('网页阅读确认独立于费用弹窗开关，拒绝授权不请求', async () => {
  const app = translationApp({ hideFeePopup: true }, false);
  await app.click('开启双语阅读');
  assert.equal(app.confirmations.length, 1);
  assert.match(app.confirmations[0], /动态加载/);
  assert.equal(app.requests.length, 0);
});

test('网站禁用同时阻止手动划词与网页阅读请求', async () => {
  const app = translationApp({ siteRules: [{ host: 'example.com', mode: 'disabled', annotations: false }] });
  await app.select();
  await app.click('翻译选区');
  await app.click('重试查询');
  await app.click('开启双语阅读');
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('保存自动网站规则需额外授权，拒绝不写入，接受也不立即请求', async () => {
  for (const accepted of [false, true]) {
    const app = translationApp({}, accepted);
    const selector = app.nodes.find((node) => node.tag === 'select' && node.children.some((option) => option.textContent === '自动双语阅读'));
    selector.value = 'auto';
    await app.change(selector);
    assert.equal(app.confirmations.length, 1);
    assert.match(app.confirmations[0], /example\.com/);
    assert.equal(app.values.get('tm:settings').value.siteRules.length, Number(accepted));
    assert.equal(app.requests.length, 0);
  }
});

for (const autoTranslate of [false, true]) {
  for (const hideFeePopup of [false, true]) {
    test(`旧自动翻译=${autoTranslate} 不再阻止点击查询，费用确认=${!hideFeePopup}`, async () => {
      const app = translationApp({ autoTranslate, hideFeePopup });
      await app.select();
      assert.equal(app.requests.length, 0);
      assert.equal(app.confirmations.length, 0);
      assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
      await app.click('翻译选区');
      assert.equal(app.requests.length, 1);
      assert.equal(app.confirmations.length, Number(!hideFeePopup));
      await app.select();
      assert.equal(app.requests.length, 1);
    });
  }
}

test('自动翻译确认取消不请求；脚本选区、编辑区域及空选区不自动发送', async () => {
  const cancelled = translationApp({ autoTranslate: true }, false);
  await cancelled.select();
  assert.equal(cancelled.confirmations.length, 0);
  await cancelled.click('翻译选区');
  assert.equal(cancelled.confirmations.length, 1);
  assert.equal(cancelled.requests.length, 0);
  const app = translationApp({ autoTranslate: true, hideFeePopup: true });
  await app.select('robust', false);
  await app.select('');
  app.exclude();
  await app.select();
  await app.click('译');
  assert.equal(app.requests.length, 0);
});

test('自动翻译只处理入口选区，不发送手动输入的旧内容', async () => {
  const app = translationApp({ autoTranslate: true, hideFeePopup: true });
  await app.select('');
  app.nodes.find((node) => node.tag === 'textarea').value = 'previous input';
  await app.click('译');
  assert.equal(app.requests.length, 0);
  await app.select('next selection');
  assert.equal(app.requests.length, 0);
  await app.click('翻译选区');
  assert.equal(app.requests.length, 1);
  assert.ok(app.requests[0].data.includes('next selection'));
  assert.ok(!app.requests[0].data.includes('previous input'));
});

test('默认来源与费用开关保存回显，设置按用途折叠且保存不请求', async () => {
  const app = translationApp();
  await app.click('设置');
  for (const title of ['关闭弹窗（']) {
    const label = app.nodes.find((node) => node.tag === 'label' && node.textContent.startsWith(title));
    assert.equal(label.children[0].checked, false);
    label.children[0].checked = true;
    await app.change(label.children[0]);
  }
  const provider = app.nodes.find((node) => node.textContent === '默认查询来源').children[0];
  provider.value = 'dictionary';
  await app.change(provider);
  const saved = app.values.get('tm:settings').value;
  assert.equal(saved.lookupProvider, 'dictionary');
  assert.equal(saved.hideFeePopup, true);
  await app.click('设置');
  assert.equal(provider.value, 'dictionary');
  const settingsPage = app.nodes.find((node) => node.id === 'tm-page-settings');
  assert.equal(settingsPage.children.filter((node) => node.tag === 'details').length, 6);
  assert.equal(settingsPage.children.filter((node) => node.tag === 'details' && node.open).length, 1);
  assert.equal(app.requests.length, 0);
});

test('网页阅读归属查询，设置入口仍可进入同一任务页', async () => {
  const app = translationApp();
  await app.click('设置');
  const entry = app.nodes.find((node) => node.textContent === '打开网页阅读');
  assert.ok(entry);
  await app.click('打开网页阅读');
  const reading = app.nodes.find((node) => node.id === 'tm-page-reading');
  assert.equal(reading.hidden, false);
  assert.equal(reading.children[0].textContent, '网页');
  assert.equal(app.nodes.find((node) => node.tag === 'nav').children[0].getAttribute('aria-current'), 'page');
  await app.click('文本');
  await app.click('网页');
  assert.equal(reading.hidden, false);
  assert.equal(app.requests.length, 0);
});

test('悬浮按钮功能独立自动保存、回显并在下次点击生效', async () => {
  const app = translationApp();
  await app.select('');
  await app.click('设置');
  const input = app.nodes.find((node) => node.textContent === '右下角“译”按钮功能').children[0];
  assert.equal(input.value, 'translate');
  app.nodes.find((node) => node.textContent?.startsWith('HTTPS 服务地址')).children[0].value = 'invalid';
  input.value = 'reading';
  await app.change(input, false);
  assert.equal(app.values.get('tm:settings').value.launcherAction, 'translate');
  await app.change(input);
  assert.equal(app.values.get('tm:settings').value.launcherAction, 'reading');
  await app.click('设置');
  assert.equal(input.value, 'reading');
  await app.click('关闭');
  await app.click('译');
  assert.equal(app.nodes.find((node) => node.id === 'tm-page-reading').hidden, false);
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('无选区按设置直达页面，有选区始终优先查询', async () => {
  for (const launcherAction of ['translate', 'reading', 'words', 'review', 'menu']) {
    const app = translationApp({ launcherAction, hideFeePopup: true });
    await app.select('');
    await app.click('译');
    if (launcherAction === 'menu') {
      assert.equal(app.nodes.find((node) => node.id === 'tm-launcher-menu').hidden, false);
    } else {
      assert.equal(app.nodes.find((node) => node.id === `tm-page-${launcherAction}`).hidden, false);
      await app.click('关闭');
    }
    assert.equal(app.requests.length, 0);
    assert.equal(app.confirmations.length, 0);
    await app.select('selected word');
    await app.click('翻译选区');
    assert.equal(app.nodes.find((node) => node.id === 'tm-page-translate').hidden, false);
    assert.equal(app.nodes.find((node) => node.id === 'tm-launcher-menu').hidden, true);
    assert.equal(app.requests.length, 1);
    assert.ok(app.requests[0].data.includes('selected word'));
  }
});

test('快捷菜单固定五个入口，跳转不请求并关闭菜单', async () => {
  const app = translationApp({ launcherAction: 'menu' });
  await app.select('');
  const menu = app.nodes.find((node) => node.id === 'tm-launcher-menu');
  const launcher = app.nodes.find((node) => node.className === 'launcher');
  assert.deepEqual(menu.children.map((node) => node.textContent), ['文本查询', '网页翻译', '生词本', '复习', '设置']);
  for (const [index, page] of ['translate', 'reading', 'words', 'review', 'settings'].entries()) {
    await app.click('译');
    assert.equal(menu.hidden, false);
    assert.equal(launcher.getAttribute('aria-controls'), menu.id);
    assert.equal(launcher.getAttribute('aria-expanded'), 'true');
    app.events.get(`${app.nodes.indexOf(menu.children[index])}:click`)({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(menu.hidden, true);
    assert.equal(app.nodes.find((node) => node.id === `tm-page-${page}`).hidden, false);
    assert.equal(launcher.getAttribute('aria-controls'), 'tm-panel');
    await app.click('关闭');
  }
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('快捷菜单支持再次点击、外部点击和 Escape 收起，触摸不会重复切换', async () => {
  const app = translationApp({ launcherAction: 'menu' });
  await app.select('');
  const menu = app.nodes.find((node) => node.id === 'tm-launcher-menu');
  const launcher = app.nodes.find((node) => node.className === 'launcher');
  await app.click('译');
  await app.click('译');
  assert.equal(menu.hidden, true);
  await app.click('译');
  app.documentEvents.get('pointerdown')({ composedPath: () => [] });
  assert.equal(menu.hidden, true);
  await app.click('译');
  let focused = false;
  launcher.focus = () => { focused = true; };
  const root = app.nodes.find((node) => node.tag === 'shadow');
  app.events.get(`${app.nodes.indexOf(root)}:keydown`)({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(menu.hidden, true);
  assert.equal(focused, true);
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  const touch = { isTrusted: true, pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20 };
  app.events.get(`${app.nodes.indexOf(launcher)}:pointerdown`)(touch);
  app.events.get(`${app.nodes.indexOf(launcher)}:pointerup`)(touch);
  await app.click('译');
  assert.equal(menu.hidden, false);
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
  assert.equal(app.requests.length, 0);
});

test('字号自动保存并立即应用，未保存的坏 API 草稿不阻止独立设置保存', async () => {
  const app = translationApp();
  await app.click('添加 API');
  const font = app.nodes.find((node) => node.textContent === '译文字号').children[0];
  const extra = app.nodes.find((node) => node.textContent?.startsWith('附加参数 JSON')).children[0];
  extra.value = '{';
  font.value = '0.85';
  await app.change(font, false);
  assert.equal(app.values.get('tm:settings').value.translationFontSize, 1);
  await app.change(font);
  assert.equal(app.values.get('tm:settings').value.translationFontSize, 0.85);
  assert.equal(app.values.get('tm:settings').value.apiProfiles.length, 0);
  const panel = app.nodes.find((node) => node.className === 'panel');
  assert.equal(panel.style['--translation-scale'], '0.85');
  await app.click('设置');
  assert.equal(font.value, '0.85');
  assert.equal(app.requests.length, 0);
  assert.ok(!app.nodes.some((node) => node.tag === 'button' && node.textContent === '保存设置'));
  app.failStorage();
  font.value = '1.3';
  await app.change(font);
  assert.equal(app.values.get('tm:settings').value.translationFontSize, 0.85);
  assert.equal(panel.style['--translation-scale'], '0.85');
  assert.ok(app.nodes.some((node) => node.textContent?.startsWith('未保存：')));
});

test('网页阅读与标注保持单组分节，微调预览自动保存且不发送请求', async () => {
  const app = translationApp();
  const control = (title) => app.nodes.find((node) => node.tag === 'label' && node.textContent === title).children[0];
  const annotation = app.nodes.find((node) => node.tag === 'details' && node.children[0].textContent === '网页阅读与标注');
  const reading = annotation;
  assert.ok(annotation);
  assert.ok(annotation.children.some((node) => node.tag === 'h3' && node.textContent === '标注'));
  assert.ok(annotation.children.some((node) => node.tag === 'h3' && node.textContent === '网页阅读'));
  assert.equal(app.nodes.filter((node) => node.tag === 'details'
    && ['标注', '网页阅读'].includes(node.children[0].textContent)).length, 0);
  assert.equal(control('标注频率').parentElement.parentElement, annotation);
  assert.equal(control('译文字号').parentElement.parentElement, reading);
  assert.equal(app.nodes.find((node) => node.textContent === '刷新网页标注').parentElement, annotation);
  const preview = app.nodes.find((node) => node.getAttribute('aria-label') === '标注预览');
  const readingPreview = app.nodes.find((node) => node.getAttribute('aria-label') === '网页阅读预览');
  const font = control('释义字号微调（em）');
  font.value = '0.93';
  app.events.get(`${app.nodes.indexOf(font)}:input`)({ isTrusted: false });
  assert.equal(app.values.get('tm:settings').value.annotationFontSize, 0.85);
  app.events.get(`${app.nodes.indexOf(font)}:input`)({ isTrusted: true });
  assert.equal(app.values.get('tm:settings').value.annotationFontSize, 0.93);
  assert.equal(control('释义字号').value, 'custom');
  assert.match(preview.children[1].children[0].style.cssText, /font:0.93em/);
  const spacing = control('原文与译文间距微调（em）');
  spacing.value = '0.42';
  await app.change(spacing);
  assert.match(readingPreview.children[1].style.cssText, /padding:0.42em 0/);
  assert.equal(app.values.get('tm:settings').value.translationSpacing, 0.42);
  const color = control('译文颜色微调');
  color.value = '#123456';
  await app.change(color);
  assert.equal(control('译文颜色').value, 'custom');
  assert.match(readingPreview.children[1].style.cssText, /color:#123456/);
  const style = control('标注样式');
  style.value = 'highlight';
  await app.change(style);
  assert.equal(control('释义字号').parentElement.hidden, true);
  assert.equal(font.parentElement.hidden, true);
  assert.equal(control('高亮颜色').parentElement.hidden, false);
  const highlight = control('高亮颜色微调');
  highlight.value = '#abcdef';
  await app.change(highlight);
  assert.match(preview.children[0].style.cssText, /background:#abcdef/);
  assert.equal(preview.children[1].hidden, true);
  const word = preview.children[0];
  app.events.get(`${app.nodes.indexOf(word)}:click`)();
  assert.equal(preview.children[1].hidden, false);
  const mode = control('网页阅读模式');
  mode.value = 'translation-only';
  await app.change(mode);
  assert.equal(readingPreview.children[0].hidden, true);
  await app.click('设置');
  assert.equal(font.value, '0.93');
  assert.equal(spacing.value, '0.42');
  assert.equal(color.value, '#123456');
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('分别恢复显示默认保留总开关、另一组、语言和网站授权', async () => {
  const siteRules = [{ host: 'authorized.example.com', mode: 'auto', annotations: false },
    { host: 'example.com', mode: 'manual', annotations: false }];
  const app = translationApp({ annotations: true, annotationFrequency: 'page', annotationFontSize: 0.93,
    annotationColor: '#123456', translationFontSize: 1.13, translationSpacing: 0.42, translationLineHeight: 1.7, knownLanguages: ['en'], siteRules });
  await app.click('恢复标注显示默认');
  let saved = app.values.get('tm:settings').value;
  assert.equal(saved.annotationFontSize, DEFAULT_SETTINGS.annotationFontSize);
  assert.equal(saved.annotationColor, DEFAULT_SETTINGS.annotationColor);
  assert.equal(saved.annotationFrequency, 'all');
  assert.equal(saved.annotations, true);
  assert.equal(saved.translationFontSize, 1.13);
  assert.equal(saved.translationSpacing, 0.42);
  assert.equal(saved.translationLineHeight, 1.7);
  await app.click('恢复网页阅读显示默认');
  saved = app.values.get('tm:settings').value;
  assert.equal(saved.translationFontSize, DEFAULT_SETTINGS.translationFontSize);
  assert.equal(saved.translationSpacing, DEFAULT_SETTINGS.translationSpacing);
  assert.equal(saved.translationLineHeight, DEFAULT_SETTINGS.translationLineHeight);
  const lineHeight = app.nodes.find((node) => node.tag === 'label' && node.textContent === '译文行距').children[0];
  const spacing = app.nodes.find((node) => node.tag === 'label' && node.textContent === '原文与译文间距').children[0];
  assert.equal(lineHeight.value, '1.5');
  assert.equal(spacing.value, '0.6');
  const preview = app.nodes.find((node) => node.getAttribute('aria-label') === '网页阅读预览');
  assert.match(preview.children[1].style.cssText, /font:400 1em\/1.5/);
  assert.match(preview.children[1].style.cssText, /padding:0.6em 0;color:inherit;opacity:1/);
  assert.equal(saved.annotations, true);
  assert.equal(saved.knownLanguages.join(','), 'en');
  assert.equal(JSON.stringify(saved.siteRules), JSON.stringify(siteRules));
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('微调越界或存储失败不应用，其他独立设置仍可保存', async () => {
  const app = translationApp();
  const control = (title) => app.nodes.find((node) => node.tag === 'label' && node.textContent === title).children[0];
  const font = control('释义字号微调（em）');
  font.value = '9';
  await app.change(font);
  assert.equal(app.values.get('tm:settings').value.annotationFontSize, 0.85);
  const spacing = control('原文与译文间距微调（em）');
  spacing.value = '0.42';
  await app.change(spacing);
  assert.equal(app.values.get('tm:settings').value.translationSpacing, 0.42);
  app.failStorage();
  spacing.value = '0.7';
  await app.change(spacing);
  await app.click('恢复网页阅读显示默认');
  assert.equal(app.values.get('tm:settings').value.translationSpacing, 0.42);
  const preview = app.nodes.find((node) => node.getAttribute('aria-label') === '网页阅读预览');
  assert.match(preview.children[1].style.cssText, /padding:0.42em 0/);
  assert.ok(app.nodes.some((node) => node.textContent?.startsWith('未保存：')));
});

test('已授权自动阅读网站调整字号不重复授权、不发起请求', async () => {
  const app = translationApp();
  const mode = app.nodes.find((node) => node.tag === 'select' && node.children.some((option) => option.value === 'disabled'));
  mode.value = 'auto';
  await app.change(mode);
  assert.equal(app.confirmations.length, 1);
  const font = app.nodes.find((node) => node.textContent === '译文字号').children[0];
  font.value = '0.85';
  await app.change(font);
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.requests.length, 0);
});

test('关闭面板后焦点仍在浮动按钮时，后续手机选区仍能打开翻译', async () => {
  const app = translationApp({ hideFeePopup: true });
  await app.select();
  await app.click('翻译选区');
  await app.click('关闭');
  const host = app.context.document.documentElement.children[0];
  host.shadow.activeElement = app.nodes.find((node) => node.className === 'launcher');
  await app.select('new selection');
  assert.ok(app.nodes.some((node) => node.textContent === '翻译选区'));
  await app.click('翻译选区');
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, false);
  assert.equal(app.nodes.find((node) => node.tag === 'textarea').value, 'new selection');
  assert.equal(app.requests.length, 2);
});

test('按下选区入口后系统清空选区，点击仍带入原词且不唤起输入框焦点', async () => {
  const app = translationApp();
  await app.select();
  const launcherIndex = app.nodes.findIndex((node) => node.className === 'launcher');
  app.events.get(`${launcherIndex}:pointerdown`)({ isTrusted: true });
  await app.select('');
  const original = app.nodes.find((node) => node.tag === 'textarea');
  original.focus = () => assert.fail('划词打开不应主动唤起软键盘');
  await app.click('译');
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, false);
  assert.equal(original.value, 'robust');
  assert.equal(app.requests.length, 1);
});

test('手机入口没有 click 时，pointerup 也能打开选区翻译面板', async () => {
  const app = translationApp({ autoTranslate: true, hideFeePopup: true });
  await app.select();
  const launcherIndex = app.nodes.findIndex((node) => node.className === 'launcher');
  const touch = { isTrusted: true, pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20 };
  app.events.get(`${launcherIndex}:pointerdown`)(touch);
  app.events.get(`${launcherIndex}:pointerup`)(touch);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, false);
  assert.equal(app.nodes.find((node) => node.tag === 'textarea').value, 'robust');
  assert.equal(app.requests.length, 1);
  app.events.get(`${launcherIndex}:click`)({ isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.nodes.find((node) => node.tag === 'textarea').value, 'robust');
  assert.equal(app.values.get('tm:logs').value.filter((entry) => entry.event === 'panel-open').length, 1);
  assert.equal(app.requests.length, 1);
});

test('滑动、取消及非可信指针不会打开面板', async () => {
  for (const mode of ['move', 'cancel', 'untrusted']) {
    const app = translationApp();
    const index = app.nodes.findIndex((node) => node.className === 'launcher');
    const touch = { isTrusted: mode !== 'untrusted', pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20 };
    app.events.get(`${index}:pointerdown`)(touch);
    if (mode === 'move') app.events.get(`${index}:pointermove`)({ ...touch, clientY: 50 });
    if (mode === 'cancel') app.events.get(`${index}:pointercancel`)(touch);
    app.events.get(`${index}:pointerup`)(touch);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
    assert.equal(app.requests.length, 0);
  }
});

test('事件链与导出日志不包含原文、响应、服务 URL 或密钥', async () => {
  const app = translationApp({ hideFeePopup: true, endpoint: 'https://private.example.com/v1' });
  app.values.set('tm:secret:https://private.example.com/v1/chat/completions', 'PRIVATE_API_KEY');
  await app.select('PRIVATE_SELECTION_TEXT');
  app.captureEvents.get('touchend')({ isTrusted: true, composedPath: () => [], defaultPrevented: false });
  await app.click('翻译选区');
  await app.click('查询');
  await app.click('设置');
  await app.click('导出诊断日志');
  const preview = app.nodes.find((node) => node.textContent === '诊断日志（下载失败时可全选复制）').children[0];
  const data = JSON.parse(preview.value);
  assert.equal(data.format, 'TranslateMokey-diagnostics');
  assert.equal(data.scriptVersion, '0.4.5');
  assert.equal(data.scriptVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.match(readFileSync(new URL('../src/metadata.txt', import.meta.url), 'utf8'), /@version\s+0\.4\.5\b/);
  assert.equal(data.build, 'unified-query');
  assert.equal(app.downloads[0], 'TranslateMokey-diagnostics.json');
  assert.equal(preview.parentElement.hidden, false);
  for (const event of ['ready', 'selection-read', 'input-capture', 'button-click', 'panel-open', 'translation-request', 'translation-success', 'export-layout']) {
    assert.ok(data.logs.some((entry) => entry.event === event), event);
  }
  for (const privateText of ['PRIVATE_SELECTION_TEXT', 'PRIVATE_API_KEY', 'private.example.com', '稳健的']) {
    assert.ok(!preview.value.includes(privateText), privateText);
  }
  const count = app.requests.length;
  await app.click('清空诊断日志');
  assert.equal(app.values.get('tm:logs').value.length, 0);
  assert.equal(preview.value, '');
  assert.equal(app.requests.length, count);
});

test('面板未打开也能从脚本菜单导出；存储不可用仍可导出内存日志', async () => {
  const app = translationApp();
  app.failStorage();
  app.values.set('tm:logs', { version: 1, value: [] });
  await app.select();
  app.menuActions.get('导出 TranslateMokey 诊断日志')();
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
  assert.equal(app.downloads.length, 1);
  const data = JSON.parse(app.nodes.find((node) => node.textContent === '诊断日志（下载失败时可全选复制）').children[0].value);
  assert.ok(data.logs.some((entry) => entry.event === 'selection-read'));
  assert.equal(app.requests.length, 0);
});

test('异常日志仅记录类型，不导出可能含秘密的错误正文', async () => {
  const app = translationApp();
  app.context.window.getSelection = () => { throw new TypeError('PRIVATE_ERROR_TEXT'); };
  await app.click('译');
  app.menuActions.get('导出 TranslateMokey 诊断日志')();
  const output = app.nodes.find((node) => node.textContent === '诊断日志（下载失败时可全选复制）').children[0].value;
  assert.ok(!output.includes('PRIVATE_ERROR_TEXT'));
  assert.ok(JSON.parse(output).logs.some((entry) => entry.event === 'selection-read-error'));
});

test('下载失败时诊断文本已生成，可从设置手动复制', async () => {
  const app = translationApp();
  const createElement = app.context.document.createElement;
  app.context.document.createElement = (tag) => {
    const node = createElement(tag);
    if (tag === 'a') node.click = () => { throw new Error('download unavailable'); };
    return node;
  };
  app.menuActions.get('导出 TranslateMokey 诊断日志')();
  const preview = app.nodes.find((node) => node.textContent === '诊断日志（下载失败时可全选复制）').children[0];
  assert.equal(JSON.parse(preview.value).format, 'TranslateMokey-diagnostics');
  assert.equal(preview.parentElement.hidden, false);
  assert.equal(app.alerts.length, 1);
});
