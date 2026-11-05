import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/core.js';
import { createTranslationQueue } from '../src/queue.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('协议切换隔离缓存，三种协议返回值分别复用', async () => {
  let calls = 0;
  const queue = createTranslationQueue((options) => {
    calls += 1;
    const data = options.url.endsWith('/messages') ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude' }] }
      : options.url.endsWith(':generateContent') ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Gemini' }] } }] }
        : { choices: [{ message: { content: 'OpenAI' } }] };
    options.onload({ status: 200, responseText: JSON.stringify(data) });
    return { abort() {} };
  });
  for (const [protocol, expected] of [['openai', 'OpenAI'], ['anthropic', 'Claude'], ['gemini', 'Gemini']]) {
    const config = { ...DEFAULT_SETTINGS, endpoint: 'https://example.com/v1', model: 'test-model', protocol, extra: {} };
    assert.equal(await queue.enqueue(config, '', 'word').promise, expected);
    assert.equal(await queue.enqueue(config, '', 'word').promise, expected);
  }
  assert.equal(calls, 3);
});
function fixture() {
  const requests = [];
  let aborts = 0;
  const queue = createTranslationQueue((options) => {
    requests.push(options);
    return { abort() { aborts += 1; } };
  });
  function reply(index, text = '译文') {
    requests[index].onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: text } }] }) });
  }
  return { queue, requests, reply, aborts: () => aborts };
}

test('串行队列、划词优先、取消等待和活动任务，迟到响应不入缓存', async () => {
  const app = fixture();
  const first = app.queue.enqueue(DEFAULT_SETTINGS, '', 'first');
  const removed = app.queue.enqueue(DEFAULT_SETTINGS, '', 'removed');
  const last = app.queue.enqueue(DEFAULT_SETTINGS, '', 'last');
  const priority = app.queue.enqueue(DEFAULT_SETTINGS, '', 'priority', true);
  const firstRejected = assert.rejects(first.promise, /取消/);
  const removedRejected = assert.rejects(removed.promise, /取消/);
  await tick();
  assert.equal(app.requests.length, 1);
  removed.cancel();
  first.cancel();
  await Promise.all([firstRejected, removedRejected]);
  app.reply(0, '过期');
  await tick();
  assert.match(app.requests[1].data, /priority/);
  app.reply(1);
  await priority.promise;
  await tick();
  assert.match(app.requests[2].data, /last/);
  app.reply(2);
  await last.promise;
  assert.equal(app.aborts(), 1);
  const again = app.queue.enqueue(DEFAULT_SETTINGS, '', 'first');
  await tick();
  assert.equal(app.requests.length, 4);
  app.reply(3);
  await again.promise;
});

test('缓存复用并隔离端点、模型、语言、参数、密钥与显式清理', async () => {
  const app = fixture();
  for (const [index, patch] of [{}, { model: 'other' }, { target: 'ja' }, { source: 'en' },
    { endpoint: 'https://example.com/v1' }, { extra: { temperature: 0.5 } }].entries()) {
    const config = { ...DEFAULT_SETTINGS, ...patch };
    const task = app.queue.enqueue(config, '', 'same');
    const duplicate = app.queue.enqueue(config, '', 'same');
    await tick();
    assert.equal(app.requests.length, index + 1);
    app.reply(index);
    assert.equal(await task.promise, '译文');
    assert.equal(await duplicate.promise, '译文');
    assert.equal(await app.queue.enqueue(config, '', 'same').promise, '译文');
  }
  const changedKey = app.queue.enqueue(DEFAULT_SETTINGS, 'test-only-credential', 'same');
  await tick();
  assert.equal(app.requests.length, 7);
  app.reply(6);
  await changedKey.promise;
  app.queue.clearCache();
  const cleared = app.queue.enqueue(DEFAULT_SETTINGS, 'test-only-credential', 'same');
  await tick();
  assert.equal(app.requests.length, 8);
  app.reply(7);
  await cleared.promise;
});

test('提示词变化隔离缓存，未启用的自定义草稿不拆分内置缓存', async () => {
  const app = fixture();
  const draft = app.queue.enqueue({ ...DEFAULT_SETTINGS, customPrompt: 'unused draft' }, '', 'same');
  await tick();
  app.reply(0);
  assert.equal(await draft.promise, '译文');
  assert.equal(await app.queue.enqueue(DEFAULT_SETTINGS, '', 'same').promise, '译文');
  assert.equal(app.requests.length, 1);

  const custom = { ...DEFAULT_SETTINGS, promptMode: 'custom', customPrompt: 'Translate {text} into {target}.' };
  const changed = app.queue.enqueue(custom, '', 'same');
  await tick();
  assert.equal(app.requests.length, 2);
  app.reply(1);
  assert.equal(await changed.promise, '译文');
  assert.equal(await app.queue.enqueue(custom, '', 'same').promise, '译文');
  assert.equal(app.requests.length, 2);
});

test('错误不缓存且后续任务继续，立即取消不启动请求', async () => {
  const app = fixture();
  const cancelled = app.queue.enqueue(DEFAULT_SETTINGS, '', 'cancelled');
  const rejected = assert.rejects(cancelled.promise, /取消/);
  cancelled.cancel();
  await rejected;
  await tick();
  assert.equal(app.requests.length, 0);
  const failed = app.queue.enqueue(DEFAULT_SETTINGS, '', 'failure');
  const failure = assert.rejects(failed.promise, /限流/);
  await tick();
  app.requests[0].onload({ status: 429 });
  await failure;
  const retry = app.queue.enqueue(DEFAULT_SETTINGS, '', 'failure');
  await tick();
  app.reply(1);
  assert.equal(await retry.promise, '译文');
});

test('单段强制重译绕过已有缓存并更新缓存值', async () => {
  const app = fixture();
  const first = app.queue.enqueue(DEFAULT_SETTINGS, '', 'same');
  await tick();
  app.reply(0, '第一版');
  await first.promise;
  const retry = app.queue.enqueue(DEFAULT_SETTINGS, '', 'same', true, true);
  await tick();
  assert.equal(app.requests.length, 2);
  app.reply(1, '第二版');
  assert.equal(await retry.promise, '第二版');
  assert.equal(await app.queue.enqueue(DEFAULT_SETTINGS, '', 'same').promise, '第二版');
});

test('清理缓存后活动请求不回填旧缓存，超过 200 条淘汰最旧项', async () => {
  const app = fixture();
  const pending = app.queue.enqueue(DEFAULT_SETTINGS, '', 'pending');
  await tick();
  app.queue.clearCache();
  app.reply(0);
  await pending.promise;
  const again = app.queue.enqueue(DEFAULT_SETTINGS, '', 'pending');
  await tick();
  assert.equal(app.requests.length, 2);
  app.reply(1);
  await again.promise;
  for (let index = 0; index < 201; index += 1) {
    const task = app.queue.enqueue(DEFAULT_SETTINGS, '', `text ${index}`);
    await tick();
    app.reply(index + 2);
    await task.promise;
  }
  assert.equal(await app.queue.enqueue(DEFAULT_SETTINGS, '', 'text 200').promise, '译文');
  const evicted = app.queue.enqueue(DEFAULT_SETTINGS, '', 'text 0');
  await tick();
  assert.equal(app.requests.length, 204);
  app.reply(203);
  await evicted.promise;
});
