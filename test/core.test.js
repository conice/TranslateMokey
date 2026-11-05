import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, INDEX_PRESET, completionEndpoint, createMatcher, entryId, exportBackup, parseBackup, validateEntry, validateSettings } from '../src/core.js';

export const sample = { term: 'robust', source: 'en', target: 'zh-cn', meaning: '稳健的', example: '', note: '', title: 'Example', url: 'https://example.com/article', createdAt: '2026-11-05T00:00:00.000Z' };

test('旧设置缺失新开关时默认关闭，拒绝非布尔值', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.autoTranslate;
  delete legacy.hideFeePopup;
  assert.equal(validateSettings(legacy).autoTranslate, false);
  assert.equal(validateSettings(legacy).hideFeePopup, false);
  for (const key of ['autoTranslate', 'hideFeePopup']) {
    for (const value of ['true', 1, null]) assert.throws(() => validateSettings({ ...legacy, [key]: value }));
    assert.equal(validateSettings({ ...legacy, [key]: true })[key], true);
  }
});

test('Index 预设与 URL 规范化', () => {
  assert.equal(INDEX_PRESET.model, 'index-mt-9b');
  assert.equal(completionEndpoint(INDEX_PRESET.endpoint), 'https://index-translate.bilibili.com/v1/chat/completions');
  assert.equal(completionEndpoint('https://example.com/v1/chat/completions/'), 'https://example.com/v1/chat/completions');
  assert.equal(validateSettings(DEFAULT_SETTINGS).target, 'zh-cn');
});

test('拒绝不安全地址与未知参数，不允许覆盖 messages 或凭据', () => {
  for (const endpoint of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'invalid']) {
    assert.throws(() => completionEndpoint(endpoint));
  }
  for (const extra of [{ messages: [] }, { headers: {} }, { stream: true }, [], null, { temperature: 3 }, { top_p: -1 }, { max_tokens: 1.5 }, { chat_template_kwargs: { key: 'secret' } }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, extra }));
  }
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, target: 'auto' }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, annotations: 'true' }));
});

test('词条校验与来源 URL 脱敏', () => {
  assert.equal(validateEntry({ ...sample, url: 'https://example.com/article?token=secret#secret' }).url, sample.url);
  for (const patch of [{ term: '' }, { meaning: 42 }, { createdAt: 'bad' }, { url: 'javascript:alert(1)' }, { source: '<html>' }]) {
    assert.throws(() => validateEntry({ ...sample, ...patch }));
  }
});

test('JSON 备份无损往返，只导出白名单词条字段', () => {
  const output = exportBackup([{ ...sample, apiKey: 'secret', headers: { Authorization: 'secret' } }]);
  assert.ok(!output.includes('secret'));
  assert.deepEqual(parseBackup(output), [sample]);
  assert.equal(entryId(parseBackup(output)[0]), entryId(sample));
});

test('导入在写入前拒绝损坏、未知版本、重复词条及过大数据', () => {
  const valid = JSON.parse(exportBackup([sample]));
  for (const data of [null, {}, { ...valid, version: 2 }, { ...valid, entries: [sample, sample] }, { ...valid, entries: [{ ...sample, term: '' }] }]) {
    assert.throws(() => parseBackup(JSON.stringify(data)));
  }
  assert.throws(() => parseBackup('not json'));
  assert.throws(() => parseBackup(' '.repeat(5 * 1024 * 1024 + 1)));
});

test('完整词精确匹配、短语优先、大小写及 Unicode 边界', () => {
  const entries = ['art', 'robust', 'robust design', 'c++'].map((term) => ({ ...sample, term }));
  const match = createMatcher(entries, 'zh-CN', 'en');
  assert.deepEqual(match('partial art robust design robust Robust c++').map((hit) => hit.entry.term), ['art', 'robust design', 'robust', 'c++']);
  assert.deepEqual(match('éart arté 𐐀art art𐐀 _art art2'), []);
  assert.equal(match('art art').length, 2);
  assert.equal(match('art').length, 1);
});

test('不串用源语言或目标语言；auto 不伪造语言标签', () => {
  const entries = [sample, { ...sample, source: 'auto', meaning: '自动源语言收藏' }];
  assert.equal(createMatcher(entries, 'zh-cn', 'en')('robust')[0].entry.meaning, sample.meaning);
  assert.equal(createMatcher(entries, 'zh-cn')('robust')[0].entry.source, 'auto');
  assert.deepEqual(createMatcher(entries, 'ja', 'en')('robust'), []);
  assert.deepEqual(createMatcher([sample], 'zh-cn', 'de')('robust'), []);
});
