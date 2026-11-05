import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher, exportBackup, parseBackup, validateEntry } from '../src/core.js';
import { dueEntries, gradeEntry } from '../src/review.js';

const entry = { term: 'run', source: 'en', target: 'zh-cn', meaning: '跑', createdAt: '2026-11-05T00:00:00.000Z' };
const now = Date.parse(entry.createdAt);
const day = 86400000;

test('旧备份可读，新备份完整保留学习字段且拒绝未知版本', () => {
  assert.deepEqual(parseBackup(JSON.stringify({ format: 'TranslateMokey', version: 1, entries: [entry] })), [validateEntry(entry)]);
  const learned = gradeEntry({ ...entry, lemma: 'run', forms: ['running', 'ran'], senses: [{ meaning: '运营', example: 'run a shop' }] }, 'known', now);
  const backup = exportBackup([learned]);
  assert.equal(JSON.parse(backup).version, 2);
  assert.deepEqual(parseBackup(backup), [learned]);
  assert.throws(() => parseBackup(backup.replace('"version": 2', '"version": 3')), /版本/);
});

test('学习字段严格校验并去除未知字段', () => {
  const learned = gradeEntry(entry, 'known', now);
  for (const patch of [{ lemma: 1 }, { forms: 'running' }, { forms: [''] }, { forms: Array(21).fill('ran') },
    { senses: [null] }, { senses: [{ meaning: '' }] }, { senses: Array(21).fill({ meaning: '释义' }) },
    { review: null }, { review: { ...learned.review, step: 7 } }, { review: { ...learned.review, count: 1.5 } },
    { review: { ...learned.review, feedback: 'bad' } }, { review: { ...learned.review, dueAt: entry.createdAt } },
    { review: { ...learned.review, lastAt: '2026-02-30T00:00:00.000Z' } }]) assert.throws(() => validateEntry({ ...entry, ...patch }));
  assert.deepEqual(validateEntry({ ...entry, forms: ['ran', ' ran '], secret: 'ignored' }).forms, ['ran']);
  assert.equal(validateEntry({ ...learned, review: { ...learned.review, secret: 'ignored' } }).review.secret, undefined);
});

test('手动词形使用默认义项，精确原词优先，歧义不匹配', () => {
  const linked = { ...entry, lemma: 'run', forms: ['running', 'ran'], senses: [{ meaning: '运营' }] };
  const match = createMatcher([linked], 'zh-cn', 'en');
  assert.deepEqual(match('running ran run runner').map((item) => item.entry.meaning), ['跑', '跑', '跑']);
  assert.equal(match('Running').length, 0);
  assert.equal(createMatcher([linked], 'en', 'en')('running').length, 0);
  const exact = { ...entry, term: 'running', meaning: '运行' };
  assert.equal(createMatcher([linked, exact], 'zh-cn', 'en')('running')[0].entry.meaning, '运行');
  const ambiguous = { ...entry, term: 'other', forms: ['running'] };
  assert.equal(createMatcher([linked, ambiguous], 'zh-cn', 'en')('running').length, 0);
});

test('到期列表按时间排序，排除已掌握和未到期词条', () => {
  const learned = gradeEntry(entry, 'known', now);
  const older = { ...entry, term: 'old', createdAt: '2026-11-04T00:00:00.000Z' };
  assert.deepEqual(dueEntries([learned, entry, older, { ...entry, mastered: true }], now).map((item) => item.term), ['old', 'run']);
  assert.equal(dueEntries([learned], now + day - 1).length, 0);
  assert.equal(dueEntries([learned], now + day).length, 1);
  assert.throws(() => dueEntries([], NaN));
});

test('三档反馈、间隔上限、UTC 跨日以及系统时间回退', () => {
  let learned = entry;
  let clock = now;
  for (const interval of [1, 3, 7, 14, 30, 90, 180, 180]) {
    learned = gradeEntry(learned, 'known', clock);
    assert.equal(Date.parse(learned.review.dueAt) - clock, interval * day);
    clock = Date.parse(learned.review.dueAt);
  }
  assert.equal(learned.review.count, 8);
  const fuzzy = gradeEntry(learned, 'fuzzy', clock);
  assert.equal(Date.parse(fuzzy.review.dueAt), clock + day);
  assert.equal(gradeEntry(fuzzy, 'known', clock + day).review.step, 0);
  const again = gradeEntry(entry, 'again', Date.parse('2026-11-05T23:55:00.000Z'));
  assert.equal(again.review.dueAt, '2026-11-06T00:05:00.000Z');
  assert.throws(() => gradeEntry(again, 'known', now), /尚未到期/);
  assert.throws(() => gradeEntry(entry, 'bad', now), /反馈/);
  assert.throws(() => gradeEntry(entry, 'known', NaN), /时间/);
  assert.throws(() => gradeEntry({ ...entry, mastered: true }, 'known', now), /已掌握/);
});
