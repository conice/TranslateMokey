import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/service.js';
import { DEFAULT_SETTINGS, serviceEndpoint, validateSettings } from '../src/core.js';

test('构造非流式请求、附加参数及隐私边界', async () => {
  let sent;
  const task = translate((options) => {
    sent = options;
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '稳健的' } }] }) }));
    return { abort() {} };
  }, DEFAULT_SETTINGS, 'sample-key', 'robust');
  assert.equal(await task.promise, '稳健的');
  assert.equal(sent.anonymous, true);
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers.Authorization, 'Bearer sample-key');
  const data = JSON.parse(sent.data);
  assert.equal(data.stream, false);
  assert.deepEqual(data.chat_template_kwargs, { enable_thinking: false });
  assert.equal(data.messages.length, 1);
  assert.match(data.messages[0].content, /source language from the text/);
  assert.ok(!sent.data.includes('sample-key'));
});

test('显式源语言与空凭据', async () => {
  const task = translate((options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.match(JSON.parse(options.data).messages[0].content, /source language is en/);
    options.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"译文"}}]}' });
  }, { ...DEFAULT_SETTINGS, source: 'en' }, '', 'text');
  assert.equal(await task.promise, '译文');
});

for (const [status, message] of [[401, /鉴权/], [403, /鉴权/], [429, /限流/], [500, /HTTP 500/], [302, /HTTP 302/]]) {
  test(`HTTP ${status} 分类且不暴露响应体`, async () => {
    const task = translate((options) => options.onload({ status, responseText: 'SECRET' }), DEFAULT_SETTINGS, '', 'text');
    await assert.rejects(task.promise, message);
  });
}

test('拒绝异常响应及重定向', async () => {
  for (const response of [
    { status: 200, responseText: 'invalid' },
    { status: 200, responseText: '{"choices":[{"message":{"content":null}}]}' },
    { status: 200, responseText: '{"choices":[{"message":{"content":" "}}]}' },
    { status: 200, finalUrl: 'https://other.example.com', responseText: '{}' },
  ]) {
    const task = translate((options) => options.onload(response), DEFAULT_SETTINGS, '', 'text');
    await assert.rejects(task.promise);
  }
});

test('取消不依赖管理器回调，迟到的响应不生效', async () => {
  let callback;
  let aborted = false;
  const task = translate((options) => {
    callback = options.onload;
    return { abort() { aborted = true; } };
  }, DEFAULT_SETTINGS, '', 'text');
  task.cancel();
  callback({ status: 200, responseText: '{"choices":[{"message":{"content":"迟到"}}]}' });
  await assert.rejects(task.promise, /取消/);
  assert.equal(aborted, true);
});

test('网络错误、超时及同步启动失败均不泄露底层报错', async () => {
  for (const trigger of ['onerror', 'ontimeout', 'onabort']) {
    const task = translate((options) => options[trigger]({ error: 'SECRET' }), DEFAULT_SETTINGS, '', 'text');
    await assert.rejects(task.promise, (error) => !error.message.includes('SECRET'));
  }
  await assert.rejects(translate(() => { throw new Error('SECRET'); }, DEFAULT_SETTINGS, '', 'text').promise, /无法启动/);
});

test('空文本、超长文本及相同语言不发请求', () => {
  const request = () => assert.fail('不得发送');
  assert.throws(() => translate(request, DEFAULT_SETTINGS, '', ' '));
  assert.throws(() => translate(request, DEFAULT_SETTINGS, '', 'a'.repeat(10001)));
  assert.throws(() => translate(request, { ...DEFAULT_SETTINGS, source: 'zh-CN' }, '', 'text'), /相同/);
});

for (const protocol of ['anthropic', 'gemini']) {
  test(`${protocol} 原生端点、鉴权头、参数映射与多文本块解析`, async () => {
    const config = { ...DEFAULT_SETTINGS, protocol, endpoint: 'https://example.com/v1', model: 'test-model', extra: { max_tokens: 1000, top_p: 0.8 } };
    let sent;
    const response = protocol === 'anthropic'
      ? { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '译文一' }, { type: 'text', text: '译文二' }] }
      : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private', thought: true }, { text: '译文一' }, { text: '译文二' }] } }] };
    const task = translate((options) => { sent = options; options.onload({ status: 200, responseText: JSON.stringify(response) }); }, config, 'test-key', 'word');
    assert.equal(await task.promise, '译文一\n译文二');
    assert.equal(sent.url, serviceEndpoint(config));
    assert.ok(!sent.url.includes('test-key'));
    assert.equal(sent.headers.Authorization, undefined);
    const body = JSON.parse(sent.data);
    if (protocol === 'anthropic') {
      assert.equal(sent.headers['x-api-key'], 'test-key');
      assert.equal(sent.headers['anthropic-version'], '2023-06-01');
      assert.equal(body.max_tokens, 1000);
      assert.match(sent.url, /\/messages$/);
    } else {
      assert.equal(sent.headers['x-goog-api-key'], 'test-key');
      assert.deepEqual(body.generationConfig, { topP: 0.8, maxOutputTokens: 1000 });
      assert.match(sent.url, /\/models\/test-model:generateContent$/);
      assert.match(body.contents[0].parts[0].text, /word/);
    }
  });
  test(`${protocol} 拒绝截断、阻止和空响应，不回显响应正文`, async () => {
    const config = { ...DEFAULT_SETTINGS, protocol, endpoint: 'https://example.com/v1', model: 'test-model', extra: {} };
    for (const response of [{}, { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'SECRET' }] },
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'SECRET' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'SECRET' }] } }] }]) {
      const task = translate((options) => options.onload({ status: 200, responseText: JSON.stringify(response) }), config, '', 'word');
      await assert.rejects(task.promise, (error) => !error.message.includes('SECRET'));
    }
  });
}

test('旧设置默认 OpenAI；新协议拒绝旧私有参数和错误模型路径', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.protocol;
  assert.equal(validateSettings(legacy).protocol, 'openai');
  for (const protocol of ['anthropic', 'gemini', 'unknown']) assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, protocol }));
  assert.throws(() => serviceEndpoint({ endpoint: 'https://example.com/v1', protocol: 'gemini', model: '../bad' }));
  assert.throws(() => serviceEndpoint({ endpoint: 'https://example.com/v1/chat/completions', protocol: 'anthropic' }));
});
