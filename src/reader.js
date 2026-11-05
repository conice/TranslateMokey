import { serviceEndpoint, validateSettings, translationAppearance } from './core.js';
import { EXCLUDED, isExcluded } from './annotations.js';

export function createReader({ document, queue, key, onStatus }) {
  const window = document.defaultView;
  const blocks = new Map();
  let config;
  let enabled = false;
  let paused = false;
  let generation = 0;
  let timer;
  let routeTimer;
  let observer;
  let viewport;
  let scanning = false;
  let rescan = false;
  let route;
  let lastError = '';
  const dirty = new Set();
  let fullScan = false;
  let automatic = true;
  const observeOptions = { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'contenteditable', 'translate', 'class', 'style'] };
  const blockSelector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,div,section,article';
  function status() {
    const counts = { waiting: 0, translating: 0, done: 0, failed: 0, skipped: 0 };
    for (const record of blocks.values()) counts[record.state] += 1;
    onStatus(`${paused ? '已暂停' : config?.translationMode === 'translation-only' ? '仅译文' : '双语阅读'}：等待 ${counts.waiting}，翻译中 ${counts.translating}，完成 ${counts.done}，失败 ${counts.failed}，跳过 ${counts.skipped}${lastError ? `；${lastError}` : ''}`);
  }
  function mutatePage(action) {
    if (enabled) collectChanges(observer?.takeRecords?.() || []);
    observer?.disconnect();
    try { return action(); }
    finally { if (enabled) observer?.observe(document.body, observeOptions); }
  }
  function discard(record) {
    record.task?.cancel();
    record.note?.remove();
    record.control?.remove();
    restoreOriginal(record);
    viewport?.unobserve(record.block);
  }
  function stop() {
    enabled = false;
    generation += 1;
    clearTimeout(timer);
    clearInterval(routeTimer);
    observer?.disconnect();
    viewport?.disconnect();
    window.removeEventListener?.('scroll', scheduleScan);
    window.removeEventListener?.('resize', scheduleScan);
    for (const record of blocks.values()) discard(record);
    blocks.clear();
    scanning = false;
    rescan = false;
    dirty.clear();
    fullScan = false;
  }
  function visible(block) {
    const rect = block.getBoundingClientRect();
    const style = window.getComputedStyle(block);
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight
      && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function current(record) {
    if (!enabled || window.location.href !== route || blocks.get(record.block) !== record || !record.block.isConnected) return false;
    return !isExcluded(record.block) && readBlock(record.block) === record.text;
  }
  function readBlock(block) {
    const walker = document.createTreeWalker(block, 4);
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      if (readable(node) && node.parentElement.closest(blockSelector) === block) text += node.textContent;
      if (text.length > 10000) break;
    }
    return text.trim();
  }
  function readable(node) {
    if (node.parentElement.closest(EXCLUDED)) return false;
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.dataset && Object.hasOwn(parent.dataset, 'tmOriginal')) continue;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  function restoreOriginal(record) {
    for (const wrapper of record.originals || []) {
      if (wrapper.parentNode) {
        while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
        wrapper.remove();
      }
    }
    record.originals = [];
    if (record.block.dataset) delete record.block.dataset.tmTranslationOnly;
  }
  function prepareTranslationOnly(record) {
    if (config.translationMode !== 'translation-only' || record.originals?.length) return;
    const walker = document.createTreeWalker(record.block, 4);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (readable(node) && node.parentElement.closest(blockSelector) === record.block) textNodes.push(node);
    }
    record.originals = [];
    for (const textNode of textNodes) {
      const wrapper = document.createElement('span');
      wrapper.dataset.tmOriginal = '';
      wrapper.style.cssText = 'display:none !important';
      textNode.before(wrapper);
      wrapper.append(textNode);
      record.originals.push(wrapper);
    }
    record.block.dataset.tmTranslationOnly = '';
    for (const note of record.block.querySelectorAll('[data-tm-note]')) {
      if (note.closest(blockSelector) !== record.block) continue;
      const wrapper = document.createElement('span');
      wrapper.dataset.tmOriginal = '';
      wrapper.style.cssText = 'display:none !important';
      note.before(wrapper);
      wrapper.append(note);
      record.originals.push(wrapper);
    }
  }
  function retranslate(record) {
    if (!enabled || paused || !current(record)) return;
    record.attempt = undefined;
    record.task?.cancel();
    record.task = undefined;
    mutatePage(() => {
      record.note?.remove();
      record.note = undefined;
      restoreOriginal(record);
    });
    record.state = 'waiting';
    dispatch(record, true, true);
  }
  function paragraphButton(label, pathData) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.style.cssText = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;width:44px;height:44px;min-width:44px;min-height:44px;padding:12px;border:0;background:transparent;color:inherit;cursor:pointer';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
    svg.style.cssText = 'display:block;width:20px;height:20px;flex:none';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    button.append(svg);
    return button;
  }
  function addControls(record) {
    if (record.control) return;
    const control = document.createElement('span');
    control.dataset.tmControl = '';
    control.style.cssText = 'display:block;margin:0.25em 0;font:12px/1.4 system-ui;opacity:0.7';
    const shadow = control.attachShadow({ mode: 'closed' });
    const translateButton = paragraphButton('翻译本段', 'M3 5h12M9 3v2M12 5c-1 5-4 8-9 10M5 8c1 3 4 5 7 6M13 21l4-10 4 10M14.5 17h5');
    translateButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (record.state === 'failed') record.state = 'waiting';
      dispatch(record, true);
    });
    const retryButton = paragraphButton('重新翻译', 'M20 7V3m0 4h-4M20 7a8 8 0 1 0 1 8');
    retryButton.addEventListener('click', (event) => { if (event.isTrusted) retranslate(record); });
    shadow.append(translateButton, retryButton);
    record.block.append(control);
    record.control = control;
  }
  function dispatch(record, force = false, bypassCache = false) {
    if (paused || (!automatic && !force) || record.state !== 'waiting' || !visible(record.block) || !current(record)) return;
    if (config.source !== 'auto' && config.knownLanguages.includes(config.source)) { record.state = 'skipped'; status(); return; }
    if ([...blocks.values()].filter((item) => item.state === 'translating').length >= 20) return;
    record.state = 'translating';
    const attempt = Symbol();
    record.attempt = attempt;
    const valid = () => record.attempt === attempt && current(record) && !paused;
    status();
    Promise.resolve().then(() => {
      if (!valid()) return;
      record.task = queue.enqueue(config, key(serviceEndpoint(config)), record.text, force, bypassCache);
      return record.task.promise;
    }).then((result) => {
      if (!result || !valid()) return;
      mutatePage(() => {
        prepareTranslationOnly(record);
        const note = document.createElement('span');
        note.dataset.tmTranslation = '';
        note.style.cssText = 'display:block;clear:both';
        const shadow = note.attachShadow({ mode: 'closed' });
        const text = document.createElement('span');
        text.textContent = result;
        styleTranslation(text);
        record.translationText = text;
        shadow.append(text);
        record.note = note;
        if (record.control?.before) record.control.before(note); else record.block.append(note);
        record.state = 'done';
      });
    }).catch((error) => {
      if (valid()) { record.state = 'failed'; lastError = error.message; }
    }).finally(() => {
      if (record.attempt === attempt) record.task = undefined;
      if (enabled) {
        if (!current(record) && record.block.isConnected) dirty.add(record.block);
        status(); scheduleScan();
      }
    });
  }
  function styleTranslation(text) {
    text.style.cssText = translationAppearance(config);
  }
  function scheduleScan() {
    if (!enabled || paused) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 150);
  }
  function scan() {
    if (!enabled || paused) return;
    if (window.location.href !== route) { stop(); onStatus('页面地址已变化，已取消翻译并恢复原文；请重新开启。'); return; }
    if (scanning) { rescan = true; return; }
    scanning = true;
    const currentGeneration = generation;
    const candidates = new Map();
    const roots = fullScan ? [document.body] : [...dirty].filter((root) => root.isConnected);
    const initialScan = fullScan;
    fullScan = false;
    dirty.clear();
    const affected = new Set();
    for (const [block] of blocks) {
      if (initialScan || roots.some((root) => root === block || root.contains(block))) affected.add(block);
    }
    let rootIndex = 0;
    let walker;
    const encountered = new Set();
    function batch() {
      if (!enabled || currentGeneration !== generation) return;
      let node;
      let count = 0;
      while (count < 200) {
        if (!walker) {
          if (rootIndex >= roots.length) break;
          walker = document.createTreeWalker(roots[rootIndex++], 4);
        }
        node = walker.nextNode();
        if (!node) { walker = undefined; continue; }
        count += 1;
        if (encountered.has(node)) continue;
        encountered.add(node);
        if (!readable(node)) continue;
        const block = node.parentElement.closest(blockSelector);
        if (!block || isExcluded(block)) continue;
        const text = candidates.get(block) || '';
        if (text.length <= 10000) candidates.set(block, text + node.textContent);
      }
      if (count === 200) { setTimeout(batch, 0); return; }
      scanning = false;
      mutatePage(() => {
        for (const [block, record] of blocks) {
          if (!block.isConnected || (affected.has(block) && candidates.get(block)?.trim() !== record.text) || isExcluded(block)) {
            discard(record);
            blocks.delete(block);
          }
        }
        for (const [block, content] of candidates) {
          const text = content.trim();
          if (!text || text.length > 10000 || !block.isConnected) continue;
          if (!blocks.has(block)) {
            blocks.set(block, { block, text, state: 'waiting', originals: [] });
            addControls(blocks.get(block));
            viewport?.observe(block);
          }
        }
      });
      for (const record of blocks.values()) dispatch(record);
      status();
      if (rescan) { rescan = false; scheduleScan(); }
    }
    batch();
  }
  function collectChanges(records) {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!element || element.closest('[data-tm-host],[data-tm-note],[data-tm-control],[data-tm-translation]')) continue;
      if (record.type === 'childList') {
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (changed.length && changed.every((node) => node.nodeType === 1
          && node.matches('[data-tm-host],[data-tm-note],[data-tm-control],[data-tm-translation]'))) continue;
        for (const node of record.addedNodes) if (node.nodeType === 1) dirty.add(node);
        const block = element.closest(blockSelector);
        if (block) dirty.add(block);
      } else {
        dirty.add(element.closest(blockSelector) || element);
        if (record.type === 'attributes') dirty.add(element);
      }
    }
    if (records.length) scheduleScan();
  }
  function start(settings, options = {}) {
    stop();
    if (settings.source === settings.target) throw new Error('源语言与目标语言相同，无须翻译');
    config = validateSettings(settings);
    automatic = options.automatic !== false;
    route = window.location.href;
    enabled = true;
    paused = false;
    lastError = '';
    if (window.IntersectionObserver) {
      viewport = new window.IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting && blocks.has(entry.target)) dispatch(blocks.get(entry.target));
      });
    }
    if (window.MutationObserver) {
      observer = new window.MutationObserver(collectChanges);
      observer.observe(document.body, observeOptions);
    }
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan);
    routeTimer = setInterval(() => {
      if (window.location.href !== route) { stop(); onStatus('页面地址已变化，已取消翻译并恢复原文；请重新开启。'); }
    }, 500);
    fullScan = true;
    scan();
  }
  return {
    start, stop,
    state: () => ({ enabled, paused, mode: config?.translationMode || 'bilingual' }),
    updateAppearance(settings) {
      if (!enabled) return;
      const next = validateSettings(settings);
      config = { ...config, translationFontSize: next.translationFontSize,
        translationLineHeight: next.translationLineHeight, translationColor: next.translationColor,
        translationSpacing: next.translationSpacing };
      mutatePage(() => {
        for (const record of blocks.values()) if (record.translationText) styleTranslation(record.translationText);
      });
      this.setMode(next.translationMode);
    },
    setMode(mode) {
      if (!['bilingual', 'translation-only'].includes(mode)) throw new Error('网页阅读模式无效');
      if (!enabled) return;
      config = { ...config, translationMode: mode };
      mutatePage(() => {
        for (const record of blocks.values()) {
          if (mode === 'bilingual') restoreOriginal(record);
          else if (record.state === 'done') prepareTranslationOnly(record);
        }
      });
      status();
    },
    pause() {
      paused = true;
      generation += 1;
      scanning = false;
      fullScan = true;
      for (const record of blocks.values()) {
        if (record.state === 'translating') { record.attempt = undefined; record.task?.cancel(); record.task = undefined; record.state = 'waiting'; }
      }
      status();
    },
    resume() { if (enabled) { paused = false; scan(); } },
    retry() { lastError = ''; for (const record of blocks.values()) if (record.state === 'failed') { record.state = 'waiting'; record.note?.remove(); record.note = undefined; } this.resume(); },
  };
}
