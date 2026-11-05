import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULT_SETTINGS } from '../src/core.js';

const modules = ['core', 'storage', 'service', 'queue', 'annotations', 'reader', 'ui', 'main'];
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
      tag, dataset: {}, style: {}, children: [], value: '', hidden: false,
      setAttribute() {},
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
  const document = { createElement, defaultView: window, documentElement: createElement('html'), title: 'Test',
    addEventListener(type, handler, options) { (options?.capture ? captureEvents : documentEvents).set(type, handler); } };
  const context = {
    window, document, URL, Blob, TextEncoder, setTimeout, clearTimeout,
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
  assert.ok(app.nodes.some((node) => node.textContent === '翻译 / 重试'));
  assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
  const sendIndex = app.nodes.findIndex((node) => node.textContent === '翻译 / 重试');
  app.events.get(`${sendIndex}:click`)({ isTrusted: false });
});

test('缺少必要管理器 API 时明确报错且不挂载半成品界面', () => {
  const app = environment();
  delete app.context.GM_xmlhttpRequest;
  runInNewContext(source, app.context);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /GM_\*/);
  assert.equal(app.context.document.documentElement.children.length, 0);
});

function translationApp(options = {}, allowConfirm = true) {
  const app = environment();
  const values = new Map([['tm:settings', { version: 1, value: { ...DEFAULT_SETTINGS, ...options } }]]);
  const requests = [];
  const confirmations = [];
  let failStorage = false;
  app.context.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
  app.context.GM_setValue = (key, value) => {
    if (failStorage) throw new Error('storage unavailable');
    values.set(key, value);
  };
  app.context.GM_xmlhttpRequest = (request) => {
    requests.push(request);
    request.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"稳健的"}}]}' });
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
    const index = app.nodes.findIndex((node) => node.tag === 'button' && node.textContent === title);
    assert.ok(index >= 0);
    app.events.get(`${index}:click`)({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const select = async (value = 'robust', trusted = true) => {
    selectedText = value;
    app.documentEvents.get('selectionchange')();
    app.documentEvents.get('pointerup')({ isTrusted: trusted, composedPath: () => [] });
    await new Promise((resolve) => setTimeout(resolve, 350));
  };
  return { ...app, requests, confirmations, click, select, values, exclude() { excluded = true; }, failStorage() { failStorage = true; } };
}

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
  await app.click('翻译 / 重试');
  await app.click('开启双语阅读');
  assert.equal(app.requests.length, 0);
  assert.equal(app.confirmations.length, 0);
});

test('保存自动网站规则需额外授权，拒绝不写入，接受也不立即请求', async () => {
  for (const accepted of [false, true]) {
    const app = translationApp({}, accepted);
    const selector = app.nodes.find((node) => node.tag === 'select' && node.children.some((option) => option.textContent === '自动双语阅读'));
    selector.value = 'auto';
    await app.click('保存设置');
    assert.equal(app.confirmations.length, 1);
    assert.match(app.confirmations[0], /example\.com/);
    assert.equal(app.values.get('tm:settings').value.siteRules.length, Number(accepted));
    assert.equal(app.requests.length, 0);
  }
});

for (const autoTranslate of [false, true]) {
  for (const hideFeePopup of [false, true]) {
    test(`自动翻译=${autoTranslate}、关闭弹窗=${hideFeePopup} 独立生效`, async () => {
      const app = translationApp({ autoTranslate, hideFeePopup });
      await app.select();
      assert.equal(app.requests.length, 0);
      assert.equal(app.confirmations.length, 0);
      assert.equal(app.nodes.find((node) => node.className === 'panel').hidden, true);
      await app.click('翻译选区');
      assert.equal(app.requests.length, Number(autoTranslate));
      if (!autoTranslate) {
        await app.click('翻译 / 重试');
      }
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

test('设置开关保存且重新打开时回显；保存不会发请求', async () => {
  const app = translationApp();
  await app.click('设置');
  for (const title of ['自动翻译（', '关闭弹窗（']) {
    const label = app.nodes.find((node) => node.tag === 'label' && node.textContent.startsWith(title));
    assert.equal(label.children[0].checked, false);
    label.children[0].checked = true;
  }
  await app.click('保存设置');
  const saved = app.values.get('tm:settings').value;
  assert.equal(saved.autoTranslate, true);
  assert.equal(saved.hideFeePopup, true);
  await app.click('设置');
  assert.equal(app.nodes.find((node) => node.tag === 'label' && node.textContent.startsWith('自动翻译（')).children[0].checked, true);
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
  assert.equal(app.requests.length, 0);
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
  assert.equal(app.requests.length, 0);
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
  await app.click('翻译 / 重试');
  await app.click('设置');
  await app.click('导出诊断日志');
  const preview = app.nodes.find((node) => node.readOnly);
  const data = JSON.parse(preview.value);
  assert.equal(data.format, 'TranslateMokey-diagnostics');
  assert.equal(data.build, 'web-reading');
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
  const data = JSON.parse(app.nodes.find((node) => node.readOnly).value);
  assert.ok(data.logs.some((entry) => entry.event === 'selection-read'));
  assert.equal(app.requests.length, 0);
});

test('异常日志仅记录类型，不导出可能含秘密的错误正文', async () => {
  const app = translationApp();
  app.context.window.getSelection = () => { throw new TypeError('PRIVATE_ERROR_TEXT'); };
  await app.click('译');
  app.menuActions.get('导出 TranslateMokey 诊断日志')();
  const output = app.nodes.find((node) => node.readOnly).value;
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
  const preview = app.nodes.find((node) => node.readOnly);
  assert.equal(JSON.parse(preview.value).format, 'TranslateMokey-diagnostics');
  assert.equal(preview.parentElement.hidden, false);
  assert.equal(app.alerts.length, 1);
});
