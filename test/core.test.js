import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, INDEX_PRESET, completionEndpoint, createMatcher, entryId, exportBackup, parseBackup, validateEntry, validateSettings, sitePolicy, siteSettings } from '../src/core.js';

export const sample = { term: 'robust', source: 'en', target: 'zh-cn', meaning: '稳健的', example: '', note: '', title: 'Example', url: 'https://example.com/article', createdAt: '2026-11-05T00:00:00.000Z' };

test('第二阶段设置兼容旧数据，规则仅精确匹配域名且严格校验', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  for (const field of ['annotationFrequency', 'annotationStyle', 'translationStyle', 'siteRules']) delete legacy[field];
  const config = validateSettings(legacy);
  assert.equal(config.annotationFrequency, 'all');
  assert.equal(config.annotationStyle, 'inline');
  assert.deepEqual(config.siteRules, []);
  const rule = { host: 'example.com', mode: 'disabled', annotations: false };
  const configured = validateSettings({ ...config, siteRules: [rule] });
  assert.equal(sitePolicy(configured, 'example.com').mode, 'disabled');
  assert.equal(sitePolicy(configured, 'sub.example.com').mode, 'manual');
  for (const patch of [{ annotationFrequency: 'invalid' }, { annotationStyle: '<script>' }, { translationStyle: 'red;display:none' },
    { siteRules: [rule, rule] }, { siteRules: [{ ...rule, host: '*.example.com' }] },
    { siteRules: [{ ...rule, host: 'example.com/path' }] }, { siteRules: [{ ...rule, annotations: 'false' }] }]) {
    assert.throws(() => validateSettings({ ...config, ...patch }));
  }
});

test('阅读模式、字号、行距、颜色兼容旧设置且拒绝 CSS 注入与越界', () => {
  const legacy = { ...DEFAULT_SETTINGS, translationColor: undefined, translationStyle: 'accent' };
  assert.equal(validateSettings(legacy).translationColor, 'accent');
  for (const patch of [{ translationMode: 'invalid' }, { translationFontSize: '1' }, { translationFontSize: 0 },
    { translationFontSize: Infinity }, { translationLineHeight: 9 }, { translationLineHeight: NaN },
    { translationColor: 'red;display:none' }]) assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...patch }));
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, translationMode: 'translation-only' }).translationMode, 'translation-only');
});

test('网站级源语言与目标语言覆盖精确保留旧规则，已掌握语言与词条严格校验', () => {
  const config = validateSettings({ ...DEFAULT_SETTINGS, source: 'auto', target: 'zh-cn',
    siteRules: [{ host: 'ja.example.com', mode: 'auto', annotations: true, source: 'ja', target: 'en' }] });
  assert.deepEqual(siteSettings(config, 'ja.example.com'), { ...config, source: 'ja', target: 'en' });
  assert.equal(siteSettings(config, 'other.example.com').source, 'auto');
  const legacy = validateSettings({ ...DEFAULT_SETTINGS, siteRules: [{ host: 'example.com', mode: 'auto', annotations: true }] });
  assert.equal(siteSettings(legacy, 'example.com').source, 'auto');
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, knownLanguages: ['en', 'en', 'zh-CN'] }).knownLanguages.length, 2);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, knownLanguages: ['en'] }).knownLanguages[0], 'en');
  for (const patch of [{ knownLanguages: 'en' }, { knownLanguages: ['auto'] }, { knownLanguages: Array(31).fill('en') },
    { masteredDisplay: 'dimmed' }, { siteRules: [{ host: 'example.com', mode: 'auto', annotations: true, source: '<invalid>' }] },
    { siteRules: [{ host: 'example.com', mode: 'auto', annotations: true, target: 'auto' }] }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...patch }));
  }
  assert.equal(validateEntry({ ...sample, mastered: true }).mastered, true);
  assert.throws(() => validateEntry({ ...sample, mastered: 'true' }));
});

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

test('默认查询来源兼容旧设置且拒绝未知来源', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.lookupProvider;
  assert.equal(validateSettings(legacy).lookupProvider, 'ai');
  assert.equal(validateSettings({ ...legacy, lookupProvider: 'dictionary' }).lookupProvider, 'dictionary');
  assert.throws(() => validateSettings({ ...legacy, lookupProvider: 'remote' }));
});

test('Index 预设与 URL 规范化', () => {
  assert.equal(INDEX_PRESET.model, 'index-mt-9b');
  assert.equal(completionEndpoint(INDEX_PRESET.endpoint), 'https://index-translate.bilibili.com/v1/chat/completions');
  assert.equal(completionEndpoint('https://example.com/v1/chat/completions/'), 'https://example.com/v1/chat/completions');
  assert.equal(validateSettings(DEFAULT_SETTINGS).target, 'zh-cn');
});

test('悬浮按钮功能兼容旧设置并限制为已支持的入口', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.launcherAction;
  assert.equal(validateSettings(legacy).launcherAction, 'translate');
  for (const launcherAction of ['translate', 'reading', 'words', 'review', 'menu']) {
    assert.equal(validateSettings({ ...legacy, launcherAction }).launcherAction, launcherAction);
  }
  for (const launcherAction of ['settings', 'unknown', false, 1, {}]) {
    assert.throws(() => validateSettings({ ...legacy, launcherAction }), /按钮功能/);
  }
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
  for (const data of [null, {}, { ...valid, version: 99 }, { ...valid, entries: [sample, sample] }, { ...valid, entries: [{ ...sample, term: '' }] }]) {
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
