import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DEFAULT_DICTIONARY, dictionaryURL, dictionaryResult, validateDictionary, lookupDictionary, runDictionaryScript, parseBing } from '../src/dictionary.js';

test('默认微软词典、编码与外部 URL 校验', () => {
  assert.equal(validateDictionary(DEFAULT_DICTIONARY).mode, 'bing');
  assert.equal(dictionaryURL(DEFAULT_DICTIONARY.url, 'a & b'), 'https://cn.bing.com/dict/search?q=a%20%26%20b');
  for (const url of ['http://example.com?q={term}', 'https://user:pass@example.com?q={term}', 'https://example.com/#q={term}',
    'https://{term}.example.com/', 'https://example.com/no-placeholder']) assert.throws(() => dictionaryURL(url, 'word'));
  assert.throws(() => dictionaryURL(DEFAULT_DICTIONARY.url, 'a'.repeat(201)));
  assert.throws(() => validateDictionary({ mode: 'javascript', url: DEFAULT_DICTIONARY.url, script: '' }));
  assert.throws(() => validateDictionary({ mode: 'invalid' }));
  assert.deepEqual(dictionaryResult({ meaning: '<img onerror=alert(1)>', apiKey: 'secret' }), { meaning: '<img onerror=alert(1)>', phonetic: '', example: '' });
  for (const data of [null, [], {}, { meaning: ' ' }, { meaning: 'ok', phonetic: 3 }]) assert.throws(() => dictionaryResult(data));
});

test('JSON 词典使用匿名 GET，不携带翻译凭据并校验响应', async () => {
  let sent;
  const config = { mode: 'json', url: 'https://example.com/?q={term}' };
  const task = lookupDictionary((options) => {
    sent = options;
    options.onload({ status: 200, responseText: '{"meaning":"跑","phonetic":"/rʌn/"}' });
  }, {}, config, 'run');
  assert.deepEqual(await task.promise, { meaning: '跑', phonetic: '/rʌn/', example: '' });
  assert.equal(sent.method, 'GET');
  assert.equal(sent.anonymous, true);
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers, undefined);
  for (const response of [{ status: 429 }, { status: 200, finalUrl: 'https://evil.example', responseText: '{}' },
    { status: 200, responseText: 'invalid' }, { status: 200, responseText: '{"meaning":""}' },
    { status: 200, responseText: 'a'.repeat(1024 * 1024 + 1) }]) {
    await assert.rejects(lookupDictionary((options) => options.onload(response), {}, config, 'run').promise);
  }
});

test('取消查询拒绝迟到响应与解析结果，错误不回显正文', async () => {
  let sent;
  let aborted = false;
  const config = { mode: 'json', url: 'https://example.com/?q={term}' };
  const task = lookupDictionary((options) => { sent = options; return { abort() { aborted = true; } }; }, {}, config, 'run');
  task.cancel();
  await sent.onload({ status: 200, responseText: '{"meaning":"late"}' });
  await assert.rejects(task.promise, /取消/);
  assert.equal(aborted, true);
  for (const trigger of ['onerror', 'ontimeout', 'onabort']) {
    const failed = lookupDictionary((options) => options[trigger]({ error: 'SECRET' }), {}, config, 'run');
    await assert.rejects(failed.promise, (error) => !error.message.includes('SECRET'));
  }
  await assert.rejects(lookupDictionary(() => { throw new Error('SECRET'); }, {}, config, 'run').promise, /无法启动/);
});

test('JS 解析仅接收查询词与响应，取消会停止解析器', async () => {
  let settle;
  let cancelled = false;
  const task = lookupDictionary((options) => { options.onload({ status: 200, responseText: 'body' }); return { abort() {} }; }, {},
    { mode: 'javascript', url: 'https://example.com?q={term}', script: 'return {meaning: responseText};' }, 'word',
    (_document, script, input) => {
      assert.equal(script, 'return {meaning: responseText};');
      assert.deepEqual(input, { term: 'word', responseText: 'body' });
      return { promise: new Promise((resolve) => { settle = resolve; }), cancel() { cancelled = true; } };
    });
  task.cancel();
  settle({ meaning: 'late' });
  await assert.rejects(task.promise, /取消/);
  assert.equal(cancelled, true);
});

function sandboxFixture() {
  let receive;
  let appended;
  const frames = [];
  const window = { crypto: { getRandomValues(array) { return array.fill(1); } }, Worker() {},
    addEventListener(_type, listener) { receive = listener; }, removeEventListener() { receive = undefined; } };
  const document = { defaultView: window, documentElement: { append(frame) { appended = frame; } },
    createElement() {
      const frame = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        contentWindow: { postMessage(data) { frame.sent = data; } }, remove() { frame.removed = true; } };
      frames.push(frame);
      return frame;
    } };
  return { document, frames, get appended() { return appended; }, dispatch(source, data) { receive?.({ source, data }); } };
}

test('隔离 frame 禁止同源、网络和页面权限，拒绝其他窗口消息并可取消', async () => {
  const app = sandboxFixture();
  const task = runDictionaryScript(app.document, 'return {meaning: responseText};', { term: 'word', responseText: 'body' });
  const frame = app.appended;
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.match(frame.srcdoc, /worker-src blob:/);
  assert.ok(!frame.srcdoc.includes('return {meaning: responseText}'));
  app.dispatch({}, { nonce: '1111', ready: true });
  assert.equal(frame.sent, undefined);
  app.dispatch(frame.contentWindow, { nonce: '1111', ready: true });
  assert.equal(frame.sent.input.responseText, 'body');
  app.dispatch(frame.contentWindow, { nonce: '1111', ok: true, result: '{"meaning":"释义","secret":"ignored"}' });
  assert.deepEqual(await task.promise, { meaning: '释义', phonetic: '', example: '' });
  assert.equal(frame.removed, true);
  const next = runDictionaryScript(app.document, 'while(true){}', { term: 'word', responseText: 'body' });
  next.cancel();
  await assert.rejects(next.promise, /取消/);
  assert.equal(app.frames[1].removed, true);
});

test('生成的 Worker 脚本可解析 JS，无 DOM/GM 参数；异常返回固定错误', async () => {
  const app = sandboxFixture();
  const task = runDictionaryScript(app.document, '', { term: 'word', responseText: '' });
  const frame = app.appended;
  let workerCode;
  const bootstrap = frame.srcdoc.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  runInNewContext(bootstrap, { Worker: class {}, setTimeout() {}, clearTimeout() {}, Blob: class { constructor(parts) { workerCode = parts.join(''); } },
    URL: { createObjectURL() { return 'blob:test'; } }, addEventListener() {}, parent: { postMessage() {} } });
  const results = [];
  const self = { postMessage(data) { results.push(data); } };
  runInNewContext(workerCode, { self });
  await self.onmessage({ data: { script: 'return {meaning: JSON.parse(responseText).definition + term};', input: { responseText: '{"definition":"释义"}', term: 'word' } } });
  assert.equal(JSON.parse(results[0].result).meaning, '释义word');
  await self.onmessage({ data: { script: 'return document.body;', input: { responseText: '', term: '' } } });
  assert.equal(results[1].ok, false);
  task.cancel();
  await assert.rejects(task.promise, /取消/);
});

test('隔离执行超时清理 frame，不降级为页面执行', async () => {
  const app = sandboxFixture();
  const task = runDictionaryScript(app.document, 'while(true){}', { term: 'word', responseText: '' });
  await assert.rejects(task.promise, /超时|CSP/);
  assert.equal(app.appended.removed, true);
});

test('Bing 解析只读取 inert template 里的释义与音标，不把 HTML 插入页面', () => {
  let loaded;
  const document = { createElement(tag) {
    assert.equal(tag, 'template');
    return { set innerHTML(value) { loaded = value; }, content: { querySelector(selector) {
      assert.equal(selector, '.qdef');
      return { querySelectorAll(query) {
        if (query === 'li') return [{ querySelector(name) { return { textContent: name === '.def' ? '你好' : 'int.' }; } }];
        return [{ textContent: '美 [hello]' }];
      } };
    } } };
  } };
  const result = parseBing(document, '<script>throw 1</script>');
  assert.equal(loaded, '<script>throw 1</script>');
  assert.equal(result.meaning, 'int. 你好');
  assert.equal(result.phonetic, '美 [hello]');
});
