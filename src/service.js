import { BUILTIN_PROMPT_TEMPLATE, boundedText, serviceEndpoint, validateSettings } from './core.js';

export function modelsEndpoint({ endpoint, protocol = 'openai' }) {
  let url;
  try { url = new URL(boundedText(endpoint, '服务地址', 2048)); }
  catch { throw new Error('服务地址必须是有效的 HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持 HTTPS，地址中不得包含凭据、查询参数或片段');
  }
  if (!['openai', 'anthropic', 'gemini'].includes(protocol)) throw new Error('服务协议无效');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (protocol === 'openai') url.pathname = url.pathname.replace(/\/chat\/completions$/, '');
  else if (protocol === 'anthropic') url.pathname = url.pathname.replace(/\/messages$/, '');
  else url.pathname = url.pathname.replace(/\/models\/[^/]+:generateContent$/, '');
  if (!url.pathname.endsWith('/models')) url.pathname += '/models';
  return url.href;
}

function modelList(protocol, data) {
  const items = protocol === 'gemini' ? data?.models : data?.data;
  if (!Array.isArray(items)) throw new Error('模型列表格式无效');
  const models = [];
  const seen = new Set();
  for (const item of items.slice(0, 1000)) {
    let id = protocol === 'gemini' ? item?.name : item?.id;
    if (typeof id !== 'string') continue;
    id = id.trim().replace(/^models\//, '');
    if (!id || id.length > 200 || !/^[^\s\x00-\x1f\x7f]+$/.test(id) || seen.has(id)) continue;
    if (protocol === 'gemini' && Array.isArray(item.supportedGenerationMethods)
      && !item.supportedGenerationMethods.includes('generateContent')) continue;
    const label = protocol === 'gemini' ? item.displayName : item.display_name;
    models.push({ id, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : id });
    seen.add(id);
    if (models.length >= 500) break;
  }
  if (!models.length) throw new Error('服务未返回可用模型');
  return models;
}

export function listModels(request, config, key) {
  const protocol = config.protocol ?? 'openai';
  const url = modelsEndpoint({ endpoint: config.endpoint, protocol });
  const headers = {};
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (protocol === 'gemini') {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;
  let handle;
  let rejectPending;
  let finished = false;
  let timer;
  const promise = new Promise((resolve, reject) => {
    rejectPending = reject;
    const fail = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    timer = setTimeout(() => { fail('模型列表请求超时（30 秒）'); handle?.abort(); }, 30000);
    try {
      handle = request({ method: 'GET', url, anonymous: true, redirect: 'error', timeout: 30000, headers,
        onload(response) {
          if (finished) return;
          if (response.finalUrl && response.finalUrl !== url) return fail('模型列表请求发生重定向，已拒绝响应');
          if (response.status === 401 || response.status === 403) return fail('鉴权失败：请检查 API Key');
          if (response.status === 429) return fail('模型列表请求被限流，请稍后重试');
          if (response.status < 200 || response.status >= 300) return fail(`模型列表请求失败（HTTP ${response.status}）`);
          let result;
          try {
            if (typeof response.responseText !== 'string' || response.responseText.length > 1024 * 1024) throw new Error();
            result = modelList(protocol, JSON.parse(response.responseText));
          } catch { return fail('模型列表格式无效或为空'); }
          finished = true;
          clearTimeout(timer);
          resolve(result);
        },
        onerror() { fail('模型列表网络请求失败'); },
        ontimeout() { fail('模型列表请求超时（30 秒）'); },
        onabort() { fail('模型列表请求已取消'); },
      });
    } catch { fail('无法启动模型列表请求，请检查管理器权限'); }
  });
  return {
    promise,
    cancel() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPending(new Error('模型列表请求已取消'));
      handle?.abort();
    },
  };
}

export function translationPrompt(config, input) {
  const template = config.promptMode === 'custom' && config.customPrompt ? config.customPrompt : BUILTIN_PROMPT_TEMPLATE;
  const sourceInstruction = config.source === 'auto'
    ? 'Determine the source language from the text itself.'
    : `The source language is ${config.source}.`;
  const values = { target: config.target, source: config.source, sourceInstruction, text: input };
  return template.replace(/\{(target|source|sourceInstruction|text)\}/g, (_match, name) => values[name]);
}

export function translationPayload(config, key, input) {
  const prompt = translationPrompt(config, input);
  const headers = { 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
    return { headers, body: { max_tokens: 4096, ...config.extra, model: config.model, stream: false, messages: [{ role: 'user', content: prompt }] } };
  }
  if (config.protocol === 'gemini') {
    if (key) headers['x-goog-api-key'] = key;
    const generationConfig = {};
    for (const [name, mapped] of [['temperature', 'temperature'], ['top_p', 'topP'], ['max_tokens', 'maxOutputTokens']]) {
      if (config.extra[name] !== undefined) generationConfig[mapped] = config.extra[name];
    }
    return { headers, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig } };
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  return { headers, body: { ...config.extra, model: config.model, stream: false, messages: [{ role: 'user', content: prompt }] } };
}

export function translationResult(protocol, data) {
  if (protocol === 'anthropic') {
    if (!['end_turn', 'stop_sequence'].includes(data.stop_reason) || !Array.isArray(data.content)) throw new Error('响应未完成');
    return boundedText(data.content.filter((part) => part.type === 'text').map((part) => boundedText(part.text, '文本块', 20000)).join('\n'), '译文', 20000);
  }
  if (protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new Error('响应被阻止或未完成');
    return boundedText(candidate.content.parts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('\n'), '译文', 20000);
  }
  if (data.choices?.[0]?.finish_reason && data.choices[0].finish_reason !== 'stop') throw new Error('响应未完成');
  return boundedText(data.choices?.[0]?.message?.content, '译文', 20000);
}

export function translate(request, settings, key, text) {
  const config = validateSettings(settings);
  const input = boundedText(text, '待翻译文本', 10000);
  if (config.source === config.target) throw new Error('源语言与目标语言相同，无须翻译');
  const endpoint = serviceEndpoint(config);
  const payload = translationPayload(config, key, input);
  let handle;
  let rejectPending;
  let finished = false;
  let timer;
  const promise = new Promise((resolve, reject) => {
    rejectPending = reject;
    const fail = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    timer = setTimeout(() => {
      fail('请求超时（30 秒）');
      handle?.abort();
    }, 30000);
    try {
      handle = request({
        method: 'POST', url: endpoint, anonymous: true, redirect: 'error', timeout: 30000,
        headers: payload.headers,
        data: JSON.stringify(payload.body),
        onload(response) {
          if (finished) return;
          if (response.finalUrl && response.finalUrl !== endpoint) return fail('服务发生重定向，已拒绝使用响应；请核查管理器权限');
          if (response.status === 401 || response.status === 403) return fail('鉴权失败：请检查服务权限与 API Key');
          if (response.status === 429) return fail('请求被限流，请稍后手动重试');
          if (response.status < 200 || response.status >= 300) return fail(`服务请求失败（HTTP ${response.status}）`);
          let result;
          try {
            if (typeof response.responseText !== 'string' || response.responseText.length > 1024 * 1024) throw new Error();
            result = translationResult(config.protocol, JSON.parse(response.responseText));
          } catch { return fail('服务返回格式异常、内容被阻止或响应未完成，请核对协议与输出长度限制'); }
          finished = true;
          clearTimeout(timer);
          resolve(result);
        },
        onerror() { fail('网络请求失败：检查地址、跨域授权或重定向限制'); },
        ontimeout() { fail('请求超时（30 秒）'); },
        onabort() { fail('请求已取消'); },
      });
    } catch { fail('无法启动请求：请检查脚本管理器权限'); }
  });
  return {
    promise,
    cancel() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPending(new Error('请求已取消'));
      handle?.abort();
    },
  };
}
