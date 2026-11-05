import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULT_SETTINGS } from '../src/core.js';

const modules = ['core', 'storage', 'service', 'annotations', 'ui', 'main'];
const source = `(() => { 'use strict'; ${modules.map((name) => readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n')} })();`;

function environment() {
  const nodes = [];
  const menus = [];
  const alerts = [];
  const events = new Map();
  const documentEvents = new Map();
  const createElement = (tag) => {
    const node = {
      tag, dataset: {}, style: {}, children: [], value: '', hidden: false,
      setAttribute() {},
      focus() {},
      addEventListener(type, handler) { events.set(`${nodes.indexOf(node)}:${type}`, handler); },
      append(...children) { node.children.push(...children); },
      prepend(...children) { node.children.unshift(...children); },
      attachShadow() { node.shadow = createElement('shadow'); return node.shadow; },
      querySelector() { return null; },
      replaceChildren(...children) { node.children = children; },
    };
    nodes.push(node);
    return node;
  };
  const window = { addEventListener() {}, alert: (text) => alerts.push(text) };
  window.top = window;
  window.self = window;
  const document = { createElement, defaultView: window, documentElement: createElement('html'), title: 'Test',
    addEventListener(type, handler) { documentEvents.set(type, handler); } };
  const context = {
    window, document, URL, TextEncoder, setTimeout, clearTimeout,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue() { assert.fail('首次启动不得写入设置'); },
    GM_listValues: () => [],
    GM_addValueChangeListener() {},
    GM_registerMenuCommand: (title) => menus.push(title),
    GM_xmlhttpRequest() { assert.fail('首次启动不得请求服务'); },
  };
  return { context, nodes, menus, alerts, events, documentEvents };
}

test('打包作用域可以启动，初次安装不请求服务或保存设置', () => {
  const app = environment();
  runInNewContext(source, app.context);
  assert.deepEqual(app.alerts, []);
  assert.equal(app.menus.length, 2);
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
  app.context.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
  app.context.GM_setValue = (key, value) => values.set(key, value);
  app.context.GM_xmlhttpRequest = (request) => {
    requests.push(request);
    request.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"稳健的"}}]}' });
    return { abort() {} };
  };
  app.context.window.location = { origin: 'https://example.com', pathname: '/' };
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
  return { ...app, requests, confirmations, click, select, values, exclude() { excluded = true; } };
}

for (const autoTranslate of [false, true]) {
  for (const hideFeePopup of [false, true]) {
    test(`自动翻译=${autoTranslate}、关闭弹窗=${hideFeePopup} 独立生效`, async () => {
      const app = translationApp({ autoTranslate, hideFeePopup });
      await app.select();
      assert.equal(app.requests.length, Number(autoTranslate));
      if (!autoTranslate) {
        await app.click('翻译选区');
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
  assert.equal(cancelled.confirmations.length, 1);
  assert.equal(cancelled.requests.length, 0);
  const app = translationApp({ autoTranslate: true, hideFeePopup: true });
  await app.select('robust', false);
  await app.select('');
  app.exclude();
  await app.select();
  assert.equal(app.requests.length, 0);
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
