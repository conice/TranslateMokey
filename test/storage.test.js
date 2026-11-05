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
  const { store, values } = fixture();
  assert.equal(store.settings().model, DEFAULT_SETTINGS.model);
  store.saveSettings({ ...DEFAULT_SETTINGS, target: 'ja' });
  store.saveKey('api:one', 'sample-key');
  store.saveKey('api:two', 'second-key');
  assert.equal(store.settings().target, 'ja');
  assert.equal(store.key('api:one'), 'sample-key');
  assert.equal(store.key('api:two'), 'second-key');
  assert.equal(store.key('api:missing'), '');
  values.set('tm:secret:https://legacy.example/v1/chat/completions', 'legacy-key');
  assert.equal(store.key('legacy:api', 'https://legacy.example/v1/chat/completions'), 'legacy-key');
  store.saveKey('legacy:api', '');
  assert.equal(store.key('legacy:api', 'https://legacy.example/v1/chat/completions'), '');
  assert.equal(store.key('builtin:index', DEFAULT_SETTINGS.endpoint), '');
  assert.throws(() => store.saveKey('builtin:index', 'not-allowed'), /内置/);
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

test('复习持久化保留词形和义项，拒绝陈旧卡片及删除后的评分', () => {
  const { store, api } = fixture();
  store.saveEntry({ ...entry, forms: ['arts'], senses: [{ meaning: '技巧' }] });
  const original = store.entries()[0];
  const now = Date.parse(entry.createdAt);
  const updated = store.reviewEntry(original, 'known', now);
  assert.equal(createStore(api).entries()[0].review.count, 1);
  assert.deepEqual(updated.forms, ['arts']);
  assert.deepEqual(updated.senses, [{ meaning: '技巧', example: '' }]);
  assert.throws(() => store.reviewEntry(original, 'known', now), /已变化/);
  store.removeEntry(updated);
  assert.throws(() => store.reviewEntry(updated, 'known', now), /已删除/);
  assert.deepEqual(store.entries(), []);
});

test('复习写入失败不伪造持久化成功', () => {
  const { store, api } = fixture();
  store.saveEntry(entry);
  const failing = createStore({ ...api, set() { throw new Error('quota'); } });
  assert.throws(() => failing.reviewEntry(store.entries()[0], 'known', Date.parse(entry.createdAt)), /quota/);
  assert.equal(store.entries()[0].review, undefined);
});

test('词典配置独立保存、可选择多个，旧存储可迁移且不污染翻译设置', () => {
  const { store, api } = fixture();
  assert.equal(store.dictionary().mode, 'bing');
  assert.equal(store.dictionary().builtIn, true);
  const first = store.saveDictionaryProfile({ id: 'dict:one', name: '词典一', mode: 'javascript',
    url: 'https://dictionary.example/?q={term}', script: 'return {meaning: responseText};' });
  assert.equal(first.id, 'dict:one');
  store.saveDictionaryProfile({ id: 'dict:two', name: '词典二', mode: 'json', url: 'https://two.example/?q={term}', script: '' });
  assert.equal(createStore(api).dictionary().name, '词典二');
  store.selectDictionary('dict:one');
  assert.equal(createStore(api).dictionary().script, 'return {meaning: responseText};');
  store.selectDictionary('builtin:bing');
  assert.equal(store.dictionary().builtIn, true);
  store.deleteDictionaryProfile('dict:one');
  assert.equal(store.dictionaryProfiles().length, 1);
  assert.equal(store.settings().protocol, 'openai');
  assert.throws(() => store.saveDictionaryProfile({ id: 'dict:bad', name: '坏词典', mode: 'json', url: 'http://example.com?q={term}', script: '' }));
});

test('旧版单一词典配置迁移为独立条目并保持选中', () => {
  const { store, values } = fixture();
  values.set('tm:dictionary', { version: 1, value: { mode: 'json', url: 'https://legacy.example/?q={term}', script: '' } });
  assert.equal(store.dictionary().id, 'legacy:dictionary');
  assert.equal(store.dictionary().name, '自定义词典');
  assert.equal(store.dictionary().url, 'https://legacy.example/?q={term}');
  values.set('tm:dictionary', { version: 1, value: { mode: 'bing', url: 'https://cn.bing.com/dict/search?q={term}', script: '' } });
  assert.equal(store.dictionary().builtIn, true);
});
