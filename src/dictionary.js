import { boundedText } from './core.js';

export const DEFAULT_DICTIONARY = Object.freeze({ mode: 'bing', url: 'https://cn.bing.com/dict/search?q={term}', script: '' });

export function dictionaryURL(template, term) {
  const value = boundedText(template, '词典 URL 模板', 2048);
  if (!value.includes('{term}')) throw new Error('词典 URL 必须包含 {term}');
  let url;
  try { url = new URL(value.replaceAll('{term}', encodeURIComponent(boundedText(term, '查询词', 200)))); }
  catch { throw new Error('词典 URL 无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[{}]/.test(url.href)) throw new Error('词典仅支持无凭据、无片段的 HTTPS URL');
  const original = new URL(value.replaceAll('{term}', 'tmplaceholder'));
  if (url.origin !== original.origin || original.hostname.includes('tmplaceholder')) throw new Error('查询词不能用于域名');
  return url.href;
}

export function validateDictionary(value) {
  if (!value || !['bing', 'json', 'javascript'].includes(value.mode)) throw new Error('词典模式无效');
  const url = value.mode === 'bing' ? DEFAULT_DICTIONARY.url : boundedText(value.url, '词典 URL', 2048);
  dictionaryURL(url, 'example');
  return { mode: value.mode, url, script: boundedText(value.script ?? '', '词典 JS', 20000, value.mode !== 'javascript') };
}

export function dictionaryResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('词典结果必须是对象');
  return { meaning: boundedText(value.meaning, '词典释义', 2000),
    phonetic: boundedText(value.phonetic ?? '', '音标', 500, true),
    example: boundedText(value.example ?? '', '词典例句', 2000, true) };
}

export function parseBing(document, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const definition = template.content.querySelector('.qdef');
  if (!definition) throw new Error('微软词典未返回释义，可能无结果、需验证或页面结构已变化');
  const meanings = [...definition.querySelectorAll('li')].map((item) => {
    const meaning = item.querySelector('.def')?.textContent.trim();
    return meaning ? `${item.querySelector('.pos')?.textContent.trim() ?? ''} ${meaning}`.trim() : '';
  }).filter(Boolean);
  return dictionaryResult({ meaning: meanings.join('\n'),
    phonetic: [...definition.querySelectorAll('.hd_prUS,.hd_pr')].map((item) => item.textContent.trim()).join(' · ') });
}

export function runDictionaryScript(document, script, input) {
  const window = document.defaultView;
  if (!window.crypto?.getRandomValues || !window.Worker) throw new Error('当前浏览器不支持隔离词典 JS');
  const nonce = [...window.crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16)).join('');
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const workerSource = `const send = self.postMessage.bind(self); self.onmessage = async (event) => {
    try { const result = await new Function('responseText', 'term', '"use strict";\\n' + event.data.script)(event.data.input.responseText, event.data.input.term);
      send({ ok: true, result: JSON.stringify(result) }); } catch { send({ ok: false }); }
  };`;
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; worker-src blob:; connect-src 'none';"><script nonce="${nonce}">
    const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], {type:'text/javascript'})));
    const deadline = setTimeout(() => { worker.terminate(); parent.postMessage({nonce:'${nonce}', ok:false}, '*'); }, 1800);
    worker.onmessage = (event) => { clearTimeout(deadline); worker.terminate(); parent.postMessage({nonce:'${nonce}', ...event.data}, '*'); };
    worker.onerror = () => { clearTimeout(deadline); worker.terminate(); parent.postMessage({nonce:'${nonce}', ok:false}, '*'); };
    addEventListener('message', (event) => { if (event.source === parent && event.data.nonce === '${nonce}') worker.postMessage(event.data); }, {once:true});
    parent.postMessage({nonce:'${nonce}', ready:true}, '*');
  </script>`;
  let finish;
  let timer;
  let started = false;
  const promise = new Promise((resolve, reject) => {
    finish = (error, result) => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      frame.remove();
      if (error) reject(new Error(error)); else resolve(result);
    };
    function receive(event) {
      if (event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
      if (event.data.ready && !started) {
        started = true;
        frame.contentWindow.postMessage({ nonce, script, input }, '*');
        return;
      }
      if (event.data.ready) return;
      try {
        if (!event.data.ok || typeof event.data.result !== 'string' || event.data.result.length > 10000) throw new Error();
        finish(null, dictionaryResult(JSON.parse(event.data.result)));
      } catch { finish('词典 JS 执行失败或返回格式无效'); }
    }
    window.addEventListener('message', receive);
    timer = setTimeout(() => finish('词典 JS 超时或被浏览器 CSP 阻止（2 秒）'), 2000);
    try { document.documentElement.append(frame); }
    catch { finish('无法启动词典 JS 隔离环境'); }
  });
  return { promise, cancel() { finish('词典查询已取消'); } };
}

export function lookupDictionary(request, document, value, text, runScript = runDictionaryScript) {
  const config = validateDictionary(value);
  const term = boundedText(text, '查询词', 200);
  const url = dictionaryURL(config.url, term);
  let handle;
  let parser;
  let finish;
  let done = false;
  let timer;
  const promise = new Promise((resolve, reject) => {
    finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(new Error(error)); else resolve(result);
    };
    timer = setTimeout(() => { finish('词典请求超时（30 秒）'); handle?.abort?.(); parser?.cancel(); }, 30000);
    try {
      handle = request({ method: 'GET', url, anonymous: true, redirect: 'error', timeout: 30000,
        async onload(response) {
          if (done) return;
          if (response.finalUrl && response.finalUrl !== url) return finish('词典发生重定向，已拒绝响应');
          if (response.status !== 200) return finish(`词典请求失败（HTTP ${response.status}）`);
          if (typeof response.responseText !== 'string' || response.responseText.length > 1024 * 1024) return finish('词典响应过大或格式无效');
          try {
            let result;
            if (config.mode === 'bing') result = parseBing(document, response.responseText);
            else if (config.mode === 'json') result = dictionaryResult(JSON.parse(response.responseText));
            else {
              parser = runScript(document, config.script, { term, responseText: response.responseText });
              result = dictionaryResult(await parser.promise);
            }
            finish(null, result);
          } catch { finish('词典无有效释义，解析失败或 JS 被阻止；请检查词典配置'); }
        },
        onerror() { finish('词典网络请求失败'); }, ontimeout() { finish('词典请求超时'); }, onabort() { finish('词典查询已取消'); },
      });
    } catch { finish('无法启动词典请求，请检查管理器权限'); }
  });
  return { promise, cancel() { if (done) return; finish('词典查询已取消'); handle?.abort?.(); parser?.cancel(); } };
}
