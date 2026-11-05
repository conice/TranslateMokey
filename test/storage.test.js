import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/storage.js';
import { DEFAULT_SETTINGS } from '../src/core.js';

const entry = { term: 'art', source: 'en', target: 'zh-cn', meaning: '艺术', createdAt: '2026-11-05T00:00:00.000Z' };
function fixture() {
  const values = new Map();
  let listener;
  const api = {
    get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    set: (key, value) => values.set(key, structuredClone(value)),
    list: () => [...values.keys()],
    listen: (_key, callback) => { listener = callback; },
  };
  return { values, api, store: createStore(api), notify: (...args) => listener(...args) };
}

test('默认设置、独立凭据及持久化', () => {
  const { store } = fixture();
  assert.equal(store.settings().model, DEFAULT_SETTINGS.model);
  store.saveSettings({ ...DEFAULT_SETTINGS, target: 'ja' });
  store.saveKey('https://example.com/v1/chat/completions', 'sample-key');
  assert.equal(store.settings().target, 'ja');
  assert.equal(store.key('https://other.example.com'), '');
  assert.equal(store.key('https://example.com/v1/chat/completions'), 'sample-key');
  assert.throws(() => store.saveKey('test', 'bad\r\nheader'));
});

test('重复收藏、覆盖、删除与撤销', () => {
  const { store } = fixture();
  assert.equal(store.saveEntry(entry), true);
  assert.equal(store.saveEntry({ ...entry, meaning: '其他释义' }), false);
  assert.equal(store.entries()[0].meaning, '艺术');
  store.saveEntry({ ...entry, meaning: '美术' }, true);
  assert.equal(store.entries()[0].meaning, '美术');
  store.removeEntry(entry);
  assert.deepEqual(store.entries(), []);
  assert.equal(store.saveEntry(entry), true);
});

test('逐词存储避免不同标签页新增互相覆盖', () => {
  const { store, api } = fixture();
  const other = createStore(api);
  store.saveEntry({ ...entry, mastered: true });
  other.saveEntry({ ...entry, term: 'robust' });
  assert.equal(store.entries().length, 2);
  assert.equal(other.entries().length, 2);
  assert.equal(other.entries().find((word) => word.term === 'art').mastered, true);
});

test('远端变更通知与未知版本保护', () => {
  const { store, values, notify } = fixture();
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  notify('key', null, null, false);
  notify('key', null, null, true);
  assert.equal(calls, 1);
  values.set('tm:settings', { version: 99, value: {} });
  assert.throws(() => store.settings(), /版本/);
  assert.equal(values.get('tm:settings').version, 99);
});

test('存储失败明确抛出，不伪造成功', () => {
  const { api } = fixture();
  const store = createStore({ ...api, set() { throw new Error('quota'); } });
  assert.throws(() => store.saveEntry(entry), /quota/);
});

test('日志限制 300 条，刷新可读取，清空不影响词条及设置', () => {
  const { store, api } = fixture();
  store.saveEntry(entry);
  store.saveSettings(DEFAULT_SETTINGS);
  for (let index = 0; index < 305; index += 1) store.appendLog({ event: 'test', index });
  assert.equal(store.logs().length, 300);
  assert.equal(store.logs()[0].index, 5);
  assert.equal(createStore(api).logs().length, 300);
  store.clearLogs();
  assert.deepEqual(store.logs(), []);
  assert.equal(store.entries().length, 1);
  assert.equal(store.settings().model, DEFAULT_SETTINGS.model);
});

test('日志写入失败返回失败，不阻断交互', () => {
  const { api } = fixture();
  const store = createStore({ ...api, set() { throw new Error('quota'); } });
  assert.equal(store.appendLog({ event: 'test' }), false);
});
