import { boundedText, completionEndpoint, validateSettings } from './core.js';
import { translate } from './service.js';

export function createTranslationQueue(request) {
  const waiting = [];
  const cache = new Map();
  let cacheSize = 0;
  let active;
  let credential;
  let cacheGeneration = 0;
  function clearCache() { cache.clear(); cacheSize = 0; cacheGeneration += 1; }
  function pump() {
    if (active || !waiting.length) return;
    const job = waiting.shift();
    active = job;
    Promise.resolve().then(() => {
      if (job.cancelled) return;
      if (!job.bypassCache && credential === job.key && cache.has(job.id)) return cache.get(job.id);
      job.task = translate(request, job.config, job.key, job.text);
      return job.task.promise;
    }).then((result) => {
      if (job.cancelled) return;
      if (credential === job.key && job.generation === cacheGeneration) {
        if (cache.has(job.id)) cacheSize -= job.id.length + cache.get(job.id).length;
        cache.set(job.id, result);
        cacheSize += job.id.length + result.length;
        while (cache.size > 200 || cacheSize > 1000000) {
          const oldest = cache.keys().next().value;
          cacheSize -= oldest.length + cache.get(oldest).length;
          cache.delete(oldest);
        }
      }
      job.resolve(result);
    }, (error) => { if (!job.cancelled) job.reject(error); }).finally(() => {
      if (active === job) active = undefined;
      pump();
    });
  }
  function enqueue(settings, key, input, priority = false, bypassCache = false) {
    const config = validateSettings(settings);
    const text = boundedText(input, '待翻译文本', 10000);
    if (config.source === config.target) throw new Error('源语言与目标语言相同，无须翻译');
    if (credential !== key) { clearCache(); credential = key; }
    const extra = Object.keys(config.extra).sort().map((name) => [name, config.extra[name]]);
    const id = JSON.stringify([1, completionEndpoint(config.endpoint), config.model, config.source, config.target, extra, text]);
    if (!bypassCache && cache.has(id)) {
      const result = cache.get(id);
      cache.delete(id);
      cache.set(id, result);
      return { promise: Promise.resolve(result), cancel() {} };
    }
    if (waiting.length >= 100) throw new Error('翻译队列已满，请稍后重试');
    const job = { config, key, text, id, cancelled: false, generation: cacheGeneration, bypassCache };
    const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (priority) waiting.unshift(job); else waiting.push(job);
    pump();
    return {
      promise,
      cancel() {
        if (job.cancelled) return;
        job.cancelled = true;
        const index = waiting.indexOf(job);
        if (index >= 0) waiting.splice(index, 1);
        job.reject(new Error('请求已取消'));
        job.task?.cancel();
      },
    };
  }
  return { enqueue, clearCache };
}
