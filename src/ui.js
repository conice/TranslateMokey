import { INDEX_PRESET, serviceEndpoint, entryId, exportBackup, parseBackup, validateSettings, sitePolicy, siteSettings } from './core.js';
import { EXCLUDED, isExcluded } from './annotations.js';
import { createTranslationQueue } from './queue.js';
import { createReader } from './reader.js';
import { dueEntries } from './review.js';
import { DEFAULT_DICTIONARY, dictionaryURL, validateDictionary, lookupDictionary } from './dictionary.js';
import { createSpeech } from './speech.js';

export function mountUI({ document, store, request, annotator, registerMenu }) {
  const window = document.defaultView;
  const queue = createTranslationQueue(request);
  const speech = createSpeech(window);
  let dictionaryTask;
  let dictionarySerial = 0;
  let dictionaryEntry;
  const host = document.createElement('div');
  host.dataset.tmHost = '';
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme:light dark; font:16px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; } [hidden] { display:none!important; }
    button,input,textarea { font:inherit; } button,input,textarea { border:1px solid #8887; border-radius:8px; padding:8px; }
    button { cursor:pointer; min-height:44px; background:Canvas; color:CanvasText; }
    button:hover { border-color:#32836b; } button:disabled { cursor:wait; opacity:.6; }
    input,textarea { width:100%; color:CanvasText; background:Canvas; }
    textarea { min-height:88px; resize:vertical; } label { display:block; margin:10px 0; }
    :focus-visible { outline:3px solid #389a80; outline-offset:2px; }
    .launcher { position:fixed; right:12px; bottom:calc(20px + env(safe-area-inset-bottom)); pointer-events:auto; box-shadow:0 2px 12px #0003; }
    .panel { position:fixed; right:12px; bottom:calc(74px + env(safe-area-inset-bottom)); width:420px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 100px); overflow:auto; overscroll-behavior:contain; padding:16px; border:1px solid #8887; border-radius:14px; background:Canvas; color:CanvasText; pointer-events:auto; box-shadow:0 4px 24px #0003; }
    header,.row,nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; } header strong { flex:1; } nav { margin:12px 0; }
    p { margin:8px 0; overflow-wrap:anywhere; } .hint { font-size:.85em; opacity:.8; } .status { white-space:pre-wrap; }
    .word { border-top:1px solid #8885; padding:10px 0; overflow-wrap:anywhere; } .word strong,.word p { white-space:pre-wrap; }
    @media(max-width:600px) { .panel { right:0; bottom:0; width:100%; max-width:100%; max-height:85dvh; border-radius:14px 14px 0 0; padding:16px 16px calc(16px + env(safe-area-inset-bottom)); } }
  `;
  root.append(style);
  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const status = element('p', '', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const session = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const recentLogs = [];
  function log(event, details = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) safe[key] = value;
      else if (typeof value === 'string') safe[key] = value.slice(0, 160);
    }
    const entry = { at: new Date().toISOString(), session, event, ...safe };
    recentLogs.push(entry);
    if (recentLogs.length > 300) recentLogs.shift();
    store.appendLog(entry);
  }
  function report(error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = message;
    if (error instanceof Error) log('error', { type: errorType(error) });
  }
  function errorType(error) {
    return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'SecurityError', 'InvalidStateError', 'NotAllowedError'].includes(error?.name) ? error.name : 'OtherError';
  }
  function activeElementInfo() {
    const active = root.activeElement;
    return { focus: !active ? 'none' : active === launcher ? 'launcher' : 'panel' };
  }
  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', (event) => {
      log('button-click', { button: text, trusted: Boolean(event.isTrusted), panelHidden: panel?.hidden ?? true, ...activeElementInfo() });
      if (!event.isTrusted) {
        log('button-rejected', { button: text, reason: 'untrusted-event' });
        return;
      }
      Promise.resolve().then(action).catch(report);
    });
    return node;
  }
  function field(parent, title, multiline = false, maxLength = 200) {
    const label = element('label', title);
    const input = element(multiline ? 'textarea' : 'input');
    input.maxLength = maxLength;
    if (!multiline) input.type = 'text';
    label.append(input);
    parent.append(label);
    return input;
  }
  let settings = store.settings();
  let activeTask;
  let serial = 0;
  let translated;
  let previousFocus;
  let selectionText = '';
  let selectionTimer;
  let selectionGesture = false;
  let selectionSnapshot = '';
  let suppressLauncherClickUntil = 0;
  let launcherPointer;
  function activateLauncher(source = 'click') {
    const now = Date.now();
    if (source === 'click' && now < suppressLauncherClickUntil) {
      log('launcher-activation-skipped', { source, reason: 'duplicate' });
      return;
    }
    if (source === 'pointerup') suppressLauncherClickUntil = now + 700;
    log('launcher-activate', { source });
    const currentSelection = readSelectionText();
    const text = currentSelection || selectionSnapshot || selectionText;
    selectionSnapshot = '';
    clearTimeout(selectionTimer);
    open('translate', !text);
    if (text) {
      cancel();
      selectionText = text;
      original.value = text;
      translated = undefined;
      meaning.value = '';
      if (store.settings().autoTranslate) startTranslation().catch(report);
    }
    if (!text) original.focus();
  }
  const launcher = button('译', () => activateLauncher('click'));
  launcher.addEventListener('pointerdown', (event) => {
    log('launcher-pointerdown', { trusted: Boolean(event.isTrusted) });
    if (!event.isTrusted) return;
    suppressLauncherClickUntil = 0;
    launcherPointer = event.pointerType === 'touch' && event.isPrimary !== false
      ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
    clearTimeout(selectionTimer);
    selectionSnapshot = readSelectionText() || selectionText;
    log('launcher-snapshot', { length: selectionSnapshot.length });
  });
  launcher.addEventListener('pointermove', (event) => {
    if (launcherPointer && event.pointerId === launcherPointer.id
      && Math.hypot(event.clientX - launcherPointer.x, event.clientY - launcherPointer.y) > 10) {
      launcherPointer = undefined;
      selectionSnapshot = '';
    }
  });
  launcher.addEventListener('pointercancel', () => { log('launcher-pointercancel'); launcherPointer = undefined; selectionSnapshot = ''; });
  launcher.addEventListener('pointerup', (event) => {
    if (!event.isTrusted || !launcherPointer || event.pointerId !== launcherPointer.id) return;
    const pointer = launcherPointer;
    launcherPointer = undefined;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) return;
    Promise.resolve().then(() => activateLauncher('pointerup')).catch(report);
  });
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', '打开 TranslateMokey，可手动输入翻译');
  launcher.setAttribute('aria-expanded', 'false');
  const panel = element('section', '', 'panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'TranslateMokey');
  const header = element('header');
  header.append(element('strong', 'TranslateMokey · 0.3.0'), button('关闭', close));
  const nav = element('nav');
  nav.setAttribute('aria-label', '功能');
  const pages = new Map();
  for (const [name, title] of [['translate', '翻译'], ['dictionary', '词典 / 发音'], ['reading', '网页阅读'], ['words', '生词本'], ['review', '复习'], ['settings', '设置']]) {
    nav.append(button(title, () => open(name)));
    pages.set(name, element('section'));
    pages.get(name).setAttribute('aria-label', title);
  }
  panel.append(header, nav, ...pages.values(), status);
  root.append(launcher, panel);
  document.documentElement.append(host);

  function cancel() {
    serial += 1;
    activeTask?.cancel();
    activeTask = undefined;
    send.disabled = false;
    log('translation-cancel');
  }
  function close() {
    clearTimeout(selectionTimer);
    selectionGesture = false;
    selectionSnapshot = '';
    cancel();
    cancelDictionary();
    speech.stop();
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
    else launcher.focus();
    log('panel-close');
  }
  function readSelectionText() {
    try {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        log('selection-read', { result: 'empty', rangeCount: selection?.rangeCount || 0, collapsed: Boolean(selection?.isCollapsed) });
        return '';
      }
      const range = selection.getRangeAt(0);
      if (isExcluded(range.startContainer) || isExcluded(range.endContainer)) {
        log('selection-read', { result: 'excluded-boundary' });
        return '';
      }
      const fragment = range.cloneContents();
      if (fragment?.querySelector?.(EXCLUDED)) {
        log('selection-read', { result: 'excluded-content' });
        return '';
      }
      const text = selection.toString().trim();
      const result = text.length <= 10000 ? text : '';
      log('selection-read', { result: result ? 'ok' : 'empty-or-too-long', length: text.length });
      return result;
    } catch (error) {
      log('selection-read-error', { type: errorType(error) });
      return '';
    }
  }
  function open(name, focusInput = true) {
    if (panel.hidden) previousFocus = document.activeElement;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    for (const [key, page] of pages) page.hidden = key !== name;
    if (name === 'words') renderWords();
    if (name === 'review') renderReview();
    if (name === 'settings') loadSettings();
    const focusable = pages.get(name).querySelector('input,textarea,button');
    if (focusInput) focusable?.focus();
    log('panel-open', { page: name, focusInput, panelHidden: panel.hidden });
    setTimeout(() => recordLayout('panel-layout'), 0);
  }
  function recordLayout(event) {
    try {
      const bounds = panel.getBoundingClientRect?.();
      const styles = window.getComputedStyle?.(panel);
      log(event, { panelHidden: panel.hidden, hostConnected: Boolean(host.isConnected),
        x: bounds?.x, y: bounds?.y, width: bounds?.width, height: bounds?.height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        visualHeight: window.visualViewport?.height, visualOffsetTop: window.visualViewport?.offsetTop,
        displayNone: styles?.display === 'none', visibilityHidden: styles?.visibility === 'hidden',
        transparent: styles?.opacity === '0', ...activeElementInfo() });
    } catch (error) { log('layout-error', { type: errorType(error) }); }
  }
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });

  const translationPage = pages.get('translate');
  translationPage.append(element('p', '仅发送此处文本，不自动发送上下文或整页。自动源语言由服务判断，不展示未经核实的识别标签。', 'hint'));
  const original = field(translationPage, '原文（选区或手动粘贴，上限 10000 字符）', true, 10000);
  const source = field(translationPage, '源语言（auto 或语言代码）', false, 35);
  const target = field(translationPage, '目标语言代码', false, 35);
  source.value = siteSettings(settings, window.location?.hostname).source;
  target.value = siteSettings(settings, window.location?.hostname).target;
  const actions = element('div', '', 'row');
  const send = button('翻译 / 重试', startTranslation);
  async function startTranslation() {
    log('translation-start');
    cancel();
    translated = undefined;
    meaning.value = '';
    const config = validateSettings({ ...store.settings(), source: source.value.trim(), target: target.value.trim() });
    if (sitePolicy(config, window.location?.hostname).mode === 'disabled') throw new Error('此网站已禁用翻译');
    const text = original.value.trim();
    if (!text || text.length > 10000) throw new Error('请提供 1–10000 字符的原文');
    if (config.source === config.target) throw new Error('源语言与目标语言相同，无须翻译');
    const endpoint = serviceEndpoint(config);
    if (!config.hideFeePopup && !window.confirm(`将向 ${endpoint}\n模型 ${config.model} 发送输入框中的 ${text.length} 字符。不会发送整页。可能产生服务费用。\n是否继续？`)) {
      log('translation-confirm-cancel', { length: text.length });
      return;
    }
    const current = serial;
    const context = { title: document.title.slice(0, 500), url: window.location.origin + window.location.pathname };
    activeTask = queue.enqueue(config, store.key(endpoint), text, true);
    log('translation-request', { length: text.length, source: config.source, target: config.target, hiddenFeePopup: config.hideFeePopup });
    send.disabled = true;
    report(`翻译中… 接收方：${endpoint}；模型：${config.model}；${text.length} 字符，可能产生服务费用。`);
    try {
      const result = await activeTask.promise;
      if (serial !== current) return;
      meaning.value = result;
      translated = { term: text, source: config.source, target: config.target, ...context };
      report('翻译完成，可修改释义后收藏。');
      log('translation-success');
    } catch (error) {
      if (serial === current) report(error);
    } finally {
      if (serial === current) { activeTask = undefined; send.disabled = false; }
    }
  }
  actions.append(send, button('取消', () => { cancel(); report('已取消'); }), button('用词典查询', () => {
    cancelDictionary();
    dictionaryTerm.value = original.value;
    if (source.value !== 'auto') speechLanguage.value = source.value;
    open('dictionary');
  }), button('朗读原文', () => speech.speak(original.value, source.value === 'auto' ? speechLanguage.value : source.value, report)));
  translationPage.append(actions);
  const meaning = field(translationPage, '译文 / 收藏释义（可编辑）', true, 20000);
  const example = field(translationPage, '例句（可选，仅本地保存）', true, 2000);
  translationPage.append(button('收藏到生词本', () => {
    if (!translated) throw new Error('请先完成翻译');
    if (original.value.trim() !== translated.term || source.value.trim().toLowerCase() !== translated.source
      || target.value.trim().toLowerCase() !== translated.target) throw new Error('原文或语言已变化，请重新翻译后收藏');
    const entry = { ...translated, meaning: meaning.value, example: example.value, note: '', createdAt: new Date().toISOString() };
    if (!store.saveEntry(entry)) {
      if (!window.confirm('已存在相同原词和语言的词条，是否补充为其他义项？默认释义与复习记录保持不变。')) return;
      const existing = store.entries().find((item) => entryId(item) === entryId(entry));
      const senses = existing.senses ?? [];
      const duplicate = [existing, ...senses].some((sense) => sense.meaning === entry.meaning.trim() && sense.example === entry.example.trim());
      if (!duplicate) store.saveEntry({ ...existing, senses: [...senses, { meaning: entry.meaning, example: entry.example }] }, true);
    }
    refreshAnnotations();
    report('已收藏。标注仅使用本地释义，不请求 API。');
  }));
  for (const input of [original, source, target]) input.addEventListener('input', () => {
    cancel();
    translated = undefined;
    meaning.value = '';
  });

  const readingPage = pages.get('reading');
  const readingStatus = element('p', '尚未开启网页翻译', 'status');
  readingStatus.setAttribute('role', 'status');
  const reader = createReader({ document, queue, key: (endpoint) => store.key(endpoint),
    onStatus: (message) => { readingStatus.textContent = message; } });
  function startReading(automatic = false, paragraphsOnly = false) {
    const config = siteSettings(store.settings(), window.location?.hostname);
    const policy = sitePolicy(config, window.location?.hostname);
    if (policy.mode === 'disabled') throw new Error('此网站已禁用翻译');
    const endpoint = serviceEndpoint(config);
    if (!automatic && !window.confirm(`将向 ${endpoint}\n模型 ${config.model} ${paragraphsOnly ? '发送你点击翻译按钮的段落正文' : '持续发送当前可见正文、滚动后出现及动态加载的正文'}，可能产生多次请求和费用。不发送 URL、输入框或代码。\n是否开启网页阅读？`)) return;
    reader.start(config, { automatic: !paragraphsOnly });
  }
  readingPage.append(element('p', '按设置选择双语或仅译文模式；仅发送进入可见区域的正文，动态内容继续处理。网页阅读始终单独确认，不受“关闭弹窗”影响。SPA 地址变化后停止，需重新开启。每段提供翻译和重新翻译按钮。', 'hint'),
    button('开启双语阅读', () => startReading()), button('仅启用逐段翻译', () => startReading(false, true)),
    button('切换双语显示', () => reader.setMode('bilingual')), button('切换仅译文', () => reader.setMode('translation-only')),
    button('暂停网页翻译', () => reader.pause()),
    button('继续网页翻译', () => reader.resume()), button('重试失败段落', () => reader.retry()),
    button('恢复原文', () => { reader.stop(); readingStatus.textContent = '已取消网页任务并恢复原文'; }), readingStatus);
  const wordsPage = pages.get('words');
  const search = field(wordsPage, '搜索原词或释义', false, 200);
  const wordActions = element('div', '', 'row');
  const list = element('div');
  const importInput = element('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.setAttribute('aria-label', '导入 JSON 生词本备份');
  wordActions.append(button('导出 JSON', () => {
    const blob = new Blob([exportBackup(store.entries())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = 'TranslateMokey-v2.json';
    root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report('已请求下载生词本备份（不含设置和密钥）；移动端下载能力需实测。');
  }));
  wordsPage.append(wordActions, element('p', '导入仅补充新词，重复词跳过，不覆盖现有内容。备份不含服务设置和密钥。', 'hint'), importInput, list);
  importInput.addEventListener('change', async (event) => {
    if (!event.isTrusted) return;
    let added = 0;
    try {
      const file = importInput.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw new Error('备份不得超过 5 MiB');
      const entries = parseBackup(await file.text());
      const existing = new Set(store.entries().map(entryId));
      const fresh = entries.filter((entry) => !existing.has(entryId(entry)));
      if (existing.size + fresh.length > 5000) throw new Error('导入后超过 5000 条上限');
      if (!window.confirm(`已校验 ${entries.length} 条：新增 ${fresh.length} 条，跳过重复 ${entries.length - fresh.length} 条。确认导入？`)) return;
      for (const entry of fresh) if (store.saveEntry(entry)) added += 1;
      renderWords();
      refreshAnnotations();
      report(`导入完成：新增 ${added} 条。`);
    } catch (error) { report(`已写入 ${added} 条；${error.message}。可重试，已写入词条会跳过。`); }
    finally { importInput.value = ''; }
  });
  search.addEventListener('input', renderWords);
  function renderWords() {
    const entries = store.entries();
    const query = search.value.toLowerCase();
    const visible = entries.filter((entry) => [entry.term, entry.meaning, entry.lemma, ...(entry.forms ?? []), ...(entry.senses ?? []).map((sense) => sense.meaning)].join('\n').toLowerCase().includes(query));
    list.replaceChildren(element('p', `共 ${entries.length} 条，匹配 ${visible.length} 条（最多展示 100 条，请搜索缩小范围）`));
    for (const entry of visible.slice(0, 100)) {
      const item = element('article', '', 'word');
      item.append(element('strong', entry.term), element('p', entry.meaning), element('p', `${entry.source} → ${entry.target} · ${entry.createdAt}`, 'hint'));
      if (entry.example) item.append(element('p', `例句：${entry.example}`));
      if (entry.note) item.append(element('p', `备注：${entry.note}`));
      if (entry.lemma || entry.forms?.length) item.append(element('p', `原形：${entry.lemma || '未指定'} · 关联词形：${(entry.forms ?? []).join('、')}`, 'hint'));
      for (const sense of entry.senses ?? []) item.append(element('p', `其他义项：${sense.meaning}${sense.example ? ` · 例句：${sense.example}` : ''}`));
      item.append(element('p', entry.mastered ? '已掌握（不参与复习）' : entry.review ? `已复习 ${entry.review.count} 次 · 下次：${new Date(entry.review.dueAt).toLocaleString()}` : '未学', 'hint'));
      if (entry.title || entry.url) item.append(element('p', `${entry.title}\n${entry.url}`, 'hint'));
      item.append(button('查询词典', () => {
        cancelDictionary();
        dictionaryTerm.value = entry.term;
        if (entry.source !== 'auto') speechLanguage.value = entry.source;
        open('dictionary');
      }), button('发音', () => speech.speak(entry.term, entry.source === 'auto' ? speechLanguage.value : entry.source, report)));
      item.append(button(entry.mastered ? '标记为未掌握' : '标记为已掌握', () => {
        if (entry.mastered && entry.review && !window.confirm('重新加入复习会重置此词的复习次数和间隔，确认继续？')) return;
        store.saveEntry({ ...entry, mastered: !entry.mastered, review: entry.mastered ? undefined : entry.review }, true);
        renderWords();
        refreshAnnotations();
      }), button('编辑', () => {
        const editor = element('div');
        const definition = field(editor, '释义', true, 2000);
        const sample = field(editor, '例句', true, 2000);
        const note = field(editor, '备注', true, 2000);
        const lemma = field(editor, '原形（手动确认；留空不关联）', false, 200);
        const forms = field(editor, '关联词形（每行一个，最多 20 个；区分大小写）', true, 4020);
        definition.value = entry.meaning;
        sample.value = entry.example;
        note.value = entry.note;
        lemma.value = entry.lemma ?? '';
        forms.value = (entry.forms ?? []).join('\n');
        const senseEditors = [];
        const senseList = element('div');
        function addSense(sense = { meaning: '', example: '' }) {
          if (senseEditors.length >= 20) throw new Error('其他义项最多 20 个');
          const row = element('div', '', 'word');
          const definitionInput = field(row, '其他义项释义', true, 2000);
          const exampleInput = field(row, '其他义项例句', true, 2000);
          definitionInput.value = sense.meaning;
          exampleInput.value = sense.example;
          const draft = { definitionInput, exampleInput };
          senseEditors.push(draft);
          row.append(button('设为默认义项', () => {
            [definition.value, definitionInput.value] = [definitionInput.value, definition.value];
            [sample.value, exampleInput.value] = [exampleInput.value, sample.value];
          }), button('移除此义项', () => {
            if (!window.confirm('确认移除此义项？保存修改后生效。')) return;
            senseEditors.splice(senseEditors.indexOf(draft), 1);
            row.remove();
          }));
          senseList.append(row);
        }
        for (const sense of entry.senses ?? []) addSense(sense);
        editor.append(element('p', '词形仅来自手动输入；网页使用默认义项，不自动判断语境。多个词条共用同一关联词形时不标注。', 'hint'), senseList, button('添加义项', () => addSense()));
        editor.append(button('保存修改', () => {
          store.saveEntry({ ...entry, meaning: definition.value, example: sample.value, note: note.value,
            lemma: lemma.value, forms: forms.value.split('\n').map((form) => form.trim()).filter(Boolean),
            senses: senseEditors.map((draft) => ({ meaning: draft.definitionInput.value, example: draft.exampleInput.value })) }, true);
          renderWords();
          refreshAnnotations();
          report('已更新词条');
        }), button('取消编辑', renderWords));
        item.replaceChildren(element('strong', entry.term), editor);
        definition.focus();
      }), button('删除', () => {
        if (!window.confirm(`确认删除「${entry.term}」？本次可撤销。`)) return;
        store.removeEntry(entry);
        renderWords();
        refreshAnnotations();
        status.replaceChildren(element('span', '词条已删除。'), button('撤销删除', () => {
          if (!store.saveEntry(entry)) throw new Error('已有同名词条，未覆盖');
          renderWords();
          refreshAnnotations();
          report('已恢复词条');
        }));
      }));
      list.append(item);
    }
  }

  const dictionaryPage = pages.get('dictionary');
  dictionaryPage.append(element('p', '默认微软 Bing 英汉词典，释义通常为中文，不随翻译目标语言改变。查询会发送当前词，不发送上下文、网页地址或翻译密钥；每次查询单独确认。JS 仅解析响应，不提供任意联网或页面操作。', 'hint'));
  const dictionaryTerm = field(dictionaryPage, '查询词（最多 200 字符）', false, 200);
  const speechLanguage = field(dictionaryPage, '发音语言（明确语言代码，不支持 auto）', false, 35);
  speechLanguage.value = 'en-US';
  dictionaryPage.append(element('p', '发音仅选浏览器报告为 localService 的语音；缺少本地语音时不会切换到远端。未确认源语言时使用这里的语言，默认 en-US，可手动修改。', 'hint'));
  const dictionaryOutput = element('div', '', 'word');
  function cancelDictionary() {
    dictionarySerial += 1;
    dictionaryTask?.cancel();
    dictionaryTask = undefined;
    dictionaryEntry = undefined;
    dictionaryOutput.replaceChildren();
  }
  dictionaryTerm.addEventListener('input', cancelDictionary);
  async function queryDictionary() {
    cancelDictionary();
    if (sitePolicy(store.settings(), window.location?.hostname).mode === 'disabled') throw new Error('当前网站已禁用翻译与词典请求');
    const config = store.dictionary();
    const term = dictionaryTerm.value.trim();
    const url = dictionaryURL(config.url, term);
    if (!window.confirm(`将向 ${url}\n发送当前查询词（最多 200 字符）。${config.mode === 'javascript' ? '随后执行你保存的词典解析 JS。' : ''}不发送翻译密钥或上下文。是否查询？`)) return;
    const current = dictionarySerial;
    const pageURL = window.location?.href;
    dictionaryTask = lookupDictionary(request, document, config, term);
    report('词典查询中…');
    try {
      const result = await dictionaryTask.promise;
      if (current !== dictionarySerial || term !== dictionaryTerm.value.trim() || pageURL !== window.location?.href) return;
      dictionaryEntry = { term, ...result, provider: config.mode === 'bing' ? '微软 Bing 词典' : '自定义词典', url };
      dictionaryOutput.replaceChildren(element('strong', `${dictionaryEntry.provider} · ${new URL(url).hostname}`),
        element('p', result.phonetic), element('p', result.meaning), element('p', result.example));
      report('词典查询完成；结果为词典来源，不是模型解释。');
    } catch (error) { if (current === dictionarySerial) report(error); }
    finally { if (current === dictionarySerial) dictionaryTask = undefined; }
  }
  dictionaryPage.append(button('查询词典释义', queryDictionary), button('取消词典查询', () => { cancelDictionary(); report('词典查询已取消'); }),
    button('播放本地发音', () => speech.speak(dictionaryTerm.value, speechLanguage.value, report)), button('停止发音', () => speech.stop()), dictionaryOutput);
  const dictionarySource = field(dictionaryPage, '收藏源语言（请确认；未知填 auto）', false, 35);
  const dictionaryTarget = field(dictionaryPage, '词典释义语言（请确认；Bing 默认 zh-CN）', false, 35);
  dictionarySource.value = 'auto';
  dictionaryTarget.value = 'zh-CN';
  dictionaryPage.append(button('收藏词典结果', () => {
    if (!dictionaryEntry || dictionaryEntry.term !== dictionaryTerm.value.trim()) throw new Error('请先完成词典查询');
    const entry = { term: dictionaryEntry.term, meaning: dictionaryEntry.meaning, example: dictionaryEntry.example,
      source: dictionarySource.value.trim(), target: dictionaryTarget.value.trim(), note: `来源：${dictionaryEntry.provider}${dictionaryEntry.phonetic ? `；${dictionaryEntry.phonetic}` : ''}`,
      title: dictionaryEntry.provider, url: dictionaryEntry.url, createdAt: new Date().toISOString() };
    if (!store.saveEntry(entry)) {
      if (!window.confirm('已有此词，是否将词典释义补充为其他义项？默认释义不变。')) return;
      const existing = store.entries().find((item) => item.term === entry.term && item.source === entry.source.toLowerCase() && item.target === entry.target.toLowerCase());
      const senses = existing.senses ?? [];
      if (![existing, ...senses].some((sense) => sense.meaning === entry.meaning && sense.example === entry.example)) {
        store.saveEntry({ ...existing, senses: [...senses, { meaning: entry.meaning, example: entry.example }] }, true);
      }
    }
    refreshAnnotations();
    report('已收藏词典释义；语言以你填写的值为准。');
  }));

  const reviewPage = pages.get('review');
  reviewPage.append(element('p', '本地复习，不请求服务。默认义项为答案；认识按 1/3/7/14/30/90/180 天安排，模糊为 1 天，不认识为 10 分钟。已掌握词不参与，可在生词本重新加入。', 'hint'));
  const reviewLimit = field(reviewPage, '每轮数量（1–100）', false, 3);
  reviewLimit.type = 'number';
  reviewLimit.min = '1';
  reviewLimit.max = '100';
  reviewLimit.value = '20';
  const reverseLabel = element('label', '反向卡片（看释义回忆原词）');
  const reverseReview = element('input');
  reverseReview.type = 'checkbox';
  reverseLabel.prepend(reverseReview);
  const reviewCard = element('div', '', 'word');
  reviewPage.append(reverseLabel, button('开始 / 刷新复习', renderReview), reviewCard);
  let reviewRound = [];
  let reviewIndex = 0;
  let reverseRound = false;
  function renderReview() {
    const limit = Number(reviewLimit.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每轮数量必须为 1–100 的整数');
    reviewRound = dueEntries(store.entries()).slice(0, limit);
    reviewIndex = 0;
    reverseRound = reverseReview.checked;
    showReviewCard();
  }
  function showReviewCard() {
    const entry = reviewRound[reviewIndex];
    if (!entry) {
      reviewCard.replaceChildren(element('p', `本轮完成 ${reviewIndex} 条。当前到期 ${dueEntries(store.entries()).length} 条；点击刷新开始下一轮。`));
      return;
    }
    reviewCard.replaceChildren(element('p', `${reviewIndex + 1} / ${reviewRound.length} · ${entry.source} → ${entry.target}`, 'hint'),
      element('strong', reverseRound ? entry.meaning : entry.term), button('显示答案', () => {
        const answer = element('div');
        answer.append(element('p', reverseRound ? entry.term : entry.meaning));
        answer.append(button('朗读词条', () => speech.speak(entry.term, entry.source === 'auto' ? speechLanguage.value : entry.source, report)));
        if (entry.example) answer.append(element('p', entry.example));
        const feedbackRow = element('div', '', 'row');
        for (const [feedback, title] of [['known', '认识'], ['fuzzy', '模糊'], ['again', '不认识']]) {
          feedbackRow.append(button(title, () => {
            store.reviewEntry(entry, feedback);
            reviewIndex += 1;
            showReviewCard();
          }));
        }
        answer.append(feedbackRow);
        reviewCard.replaceChildren(element('strong', reverseRound ? entry.meaning : entry.term), answer);
      }));
  }

  const settingsPage = pages.get('settings');
  settingsPage.append(element('p', '支持非流式 OpenAI Chat Completions、Anthropic Messages（2023-06-01）及 Gemini generateContent。切换协议需同时修改地址、模型与参数；不会自动把内容转发到其他服务。', 'hint'));
  const endpointInput = field(settingsPage, 'HTTPS 服务地址（例如 https://example.com/v1）', false, 2048);
  const modelInput = field(settingsPage, '模型', false, 200);
  const extraInput = field(settingsPage, '附加参数 JSON（temperature、top_p、max_tokens、max_completion_tokens、enable_thinking）', true, 8000);
  const defaultSource = field(settingsPage, '默认源语言', false, 35);
  const defaultTarget = field(settingsPage, '默认目标语言', false, 35);
  const autoLabel = element('label', '自动翻译（点击翻译选区打开面板后自动翻译）');
  const autoInput = element('input');
  autoInput.type = 'checkbox';
  autoInput.style.width = 'auto';
  autoLabel.prepend(autoInput);
  const popupLabel = element('label', '关闭弹窗（不再显示翻译请求前的费用确认）');
  const popupInput = element('input');
  popupInput.type = 'checkbox';
  popupInput.style.width = 'auto';
  popupLabel.prepend(popupInput);
  settingsPage.append(autoLabel, popupLabel, element('p', '两个选项默认关闭。仅选中文字不会发送请求；同时勾选后，点击翻译选区会打开面板并直接发送选中文本，可能产生费用。关闭弹窗不代表免费，不影响删除或覆盖确认。', 'hint'));
  const annotationLabel = element('label', '开启本地词后释义（区分大小写，动态内容自动刷新）');
  const annotationInput = element('input');
  annotationInput.type = 'checkbox';
  annotationInput.style.width = 'auto';
  annotationLabel.prepend(annotationInput);
  settingsPage.append(annotationLabel);
  function choice(title, options) {
    const label = element('label', title);
    const select = element('select');
    for (const [value, title] of options) {
      const option = element('option', title);
      option.value = value;
      select.append(option);
    }
    label.append(select);
    settingsPage.append(label);
    return select;
  }
  const protocolInput = choice('翻译服务协议', [['openai', 'OpenAI Chat Completions'], ['anthropic', 'Anthropic Messages'], ['gemini', 'Gemini generateContent']]);
  settingsPage.append(element('p', 'Anthropic 地址示例 https://api.anthropic.com/v1；Gemini 示例 https://generativelanguage.googleapis.com/v1beta。模型由你填写；两者附加参数仅支持 temperature、top_p、max_tokens（Gemini 自动映射）。', 'hint'));
  const dictionaryMode = choice('词典类型', [['bing', '微软 Bing 词典（默认）'], ['json', '自定义 JSON 词典'], ['javascript', '自定义 JS 解析词典']]);
  const dictionaryTemplate = field(settingsPage, '词典 HTTPS URL（用 {term} 表示查询词，不填写密钥）', false, 2048);
  const dictionaryScript = field(settingsPage, '词典 JS 函数体（参数 responseText、term；返回 meaning、phonetic、example）', true, 20000);
  settingsPage.append(element('p', 'JSON 返回 {"meaning":"释义","phonetic":"音标","example":"例句"}。JS 示例：const data = JSON.parse(responseText); return { meaning: data.definition }; 代码在禁网 Worker 内执行，不能访问 DOM/GM；2 秒超时。只保存可信代码，配置不进入备份。', 'hint'),
    button('保存词典配置', () => {
      const config = validateDictionary({ mode: dictionaryMode.value, url: dictionaryTemplate.value, script: dictionaryScript.value });
      if (config.mode === 'javascript' && !window.confirm('确认保存并启用此词典 JS？仅使用你信任的代码；查询时会在隔离环境执行，浏览器安全限制可能导致不可用。')) return;
      store.saveDictionary(config);
      cancelDictionary();
      report('词典配置已保存；未发送请求，也未执行 JS。');
    }), button('恢复微软词典', () => {
      if (!window.confirm('确认用微软 Bing 词典替换已保存的自定义词典配置？')) return;
      store.saveDictionary(DEFAULT_DICTIONARY);
      cancelDictionary();
      loadSettings();
      report('已恢复微软词典；未发送请求。');
    }));
  const frequencyInput = choice('标注频率', [['all', '每次出现'], ['page', '每页首次'], ['paragraph', '每段首次']]);
  const annotationStyleInput = choice('标注样式', [['inline', '词后释义'], ['compact', '点击展开释义'], ['underline', '下划线与词义卡片'], ['highlight', '仅高亮（点击查看）']]);
  const translationModeInput = choice('网页阅读模式', [['bilingual', '双语显示'], ['translation-only', '仅显示译文']]);
  const translationFontSizeInput = choice('译文字号', [['0.85', '小（85%）'], ['1', '标准（100%）'], ['1.15', '大（115%）'], ['1.3', '特大（130%）']]);
  const translationLineHeightInput = choice('译文行距', [['1.4', '紧凑'], ['1.7', '标准'], ['2.1', '宽松'], ['2.5', '特宽']]);
  const translationColorInput = choice('译文颜色', [['inherit', '跟随网页'], ['muted', '柔和灰'], ['accent', '绿色']]);
  const masteredDisplayInput = choice('已掌握词标注', [['hide', '隐藏'], ['dim', '淡化'], ['show', '正常显示']]);
  const knownLanguagesInput = field(settingsPage, '已掌握语言（逗号分隔；只跳过明确指定的源语言，不猜测 auto）', false, 1100);
  const siteModeInput = choice('当前域名翻译规则（精确匹配，不含子域名）', [['manual', '手动翻译'], ['auto', '自动双语阅读'], ['disabled', '禁用翻译']]);
  const siteSourceInput = field(settingsPage, '当前网站源语言（留空跟随默认）', false, 35);
  const siteTargetInput = field(settingsPage, '当前网站目标语言（留空跟随默认）', false, 35);
  const siteAnnotationLabel = element('label', '允许当前网站显示生词标注');
  const siteAnnotationInput = element('input');
  siteAnnotationInput.type = 'checkbox';
  siteAnnotationLabel.prepend(siteAnnotationInput);
  settingsPage.append(siteAnnotationLabel, element('p', '网站规则仅匹配当前域名。自动阅读需额外确认授权；保存后下次加载此网站时生效。禁用翻译也会关闭网站标注。', 'hint'));
  const keyStatus = element('p', '', 'hint');
  function exportDiagnostics() {
    recordLayout('export-layout');
    log('diagnostics-export');
    const combined = [...store.logs(), ...recentLogs];
    const unique = new Map(combined.map((entry) => [JSON.stringify(entry), entry]));
    const output = JSON.stringify({ format: 'TranslateMokey-diagnostics', version: 1, scriptVersion: '0.3.0',
      build: 'dictionary-protocols', exportedAt: new Date().toISOString(),
      logs: [...unique.values()].sort((left, right) => left.at.localeCompare(right.at)).slice(-300) }, null, 2);
    diagnosticPreview.value = output;
    diagnosticPreview.parentElement.hidden = false;
    const blob = new Blob([output], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = 'TranslateMokey-diagnostics.json';
    root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report('已请求下载日志；若无文件，可在设置底部手动复制日志文本。');
  }
  settingsPage.append(keyStatus, button('导出诊断日志', exportDiagnostics), button('清空诊断日志', () => {
    if (!window.confirm('确认清空本地诊断日志？不会删除设置、生词本或 API Key。')) return;
    store.clearLogs();
    recentLogs.length = 0;
    diagnosticPreview.value = '';
    diagnosticPreview.parentElement.hidden = true;
    report('诊断日志已清空。');
  }), button('填入 Index 预设', () => {
    endpointInput.value = INDEX_PRESET.endpoint;
    protocolInput.value = 'openai';
    modelInput.value = INDEX_PRESET.model;
    extraInput.value = JSON.stringify(INDEX_PRESET.extra, null, 2);
    updateKeyStatus();
  }), button('设置 / 清除 API Key', () => {
    const endpoint = serviceEndpoint({ endpoint: endpointInput.value, protocol: protocolInput.value, model: modelInput.value });
    const key = window.prompt(`为 ${endpoint} 设置 API Key。留空并确认可清除；取消则不修改。\n使用浏览器原生输入框，不回填到页面；输入可见，请避免旁人窥视。脚本存储不等于加密保险箱。`);
    if (key === null) return;
    if (!key.trim() && !window.confirm('确认清除此服务地址保存的 API Key？')) return;
    store.saveKey(endpoint, key);
    cancel();
    reader.stop();
    queue.clearCache();
    updateKeyStatus();
    report('凭据已更新，不会加入备份。');
  }), button('保存设置', () => {
    let extra;
    try { extra = JSON.parse(extraInput.value); } catch { throw new Error('附加参数不是有效 JSON'); }
    const previous = store.settings();
    const hostname = window.location?.hostname;
    const siteRules = previous.siteRules.filter((rule) => rule.host !== hostname);
    if (hostname && (siteModeInput.value !== 'manual' || !siteAnnotationInput.checked || siteSourceInput.value.trim() || siteTargetInput.value.trim())) {
      siteRules.push({ host: hostname, mode: siteModeInput.value, annotations: siteAnnotationInput.checked,
        source: siteSourceInput.value.trim(), target: siteTargetInput.value.trim() });
    }
    const next = validateSettings({ protocol: protocolInput.value, endpoint: endpointInput.value, model: modelInput.value, extra,
      source: defaultSource.value.trim(), target: defaultTarget.value.trim(), annotations: annotationInput.checked,
      autoTranslate: autoInput.checked, hideFeePopup: popupInput.checked,
      annotationFrequency: frequencyInput.value, annotationStyle: annotationStyleInput.value,
      translationStyle: 'muted', translationMode: translationModeInput.value,
      translationFontSize: Number(translationFontSizeInput.value), translationLineHeight: Number(translationLineHeightInput.value),
      translationColor: translationColorInput.value, masteredDisplay: masteredDisplayInput.value,
      knownLanguages: knownLanguagesInput.value.split(',').map((value) => value.trim()).filter(Boolean), siteRules });
    const automaticHosts = next.siteRules.filter((rule) => rule.mode === 'auto').map((rule) => rule.host);
    if (automaticHosts.length && !window.confirm(`授权以下域名下次加载时自动发送可见及动态正文：${automaticHosts.join('、')}\n接收方 ${serviceEndpoint(next)}，模型 ${next.model}，可能持续产生费用。授权使用本次保存的服务与语言设置，是否继续？`)) return;
    store.saveSettings(next);
    settings = next;
    cancelDictionary();
    speech.stop();
    log('settings-saved', { autoTranslate: next.autoTranslate, hideFeePopup: next.hideFeePopup });
    cancel();
    reader.stop();
    queue.clearCache();
    readingStatus.textContent = '设置已变化，网页阅读已停止；自动规则下次加载生效';
    translated = undefined;
    source.value = siteSettings(settings, hostname).source;
    target.value = siteSettings(settings, hostname).target;
    refreshAnnotations();
    report('设置已保存；未发送网络请求。');
  }), button('刷新网页标注', () => { refreshAnnotations(); report('已安排本地标注扫描'); }));
  settingsPage.append(element('p', '仅匹配单个文本节点内完整词/短语，跳过代码、编辑区域和译文；支持动态刷新，不支持 CJK 分词或跨标签短语。auto 词条表示源语言未确认。', 'hint'));
  settingsPage.append(element('p', '诊断日志最多保留 300 条，记录事件、长度、开关与面板尺寸，不含原文、译文、URL、密钥或错误正文；仅本地保存，不自动上传。', 'hint'));
  const diagnosticPreview = field(settingsPage, '诊断日志（下载失败时可全选复制）', true, 500000);
  diagnosticPreview.readOnly = true;
  diagnosticPreview.parentElement.hidden = true;
  function updateKeyStatus() {
    try { keyStatus.textContent = store.key(serviceEndpoint({ endpoint: endpointInput.value, protocol: protocolInput.value, model: modelInput.value })) ? '此地址已保存 API Key（不回显）' : '此地址未保存 API Key'; }
    catch { keyStatus.textContent = '请填写有效服务地址'; }
  }
  endpointInput.addEventListener('input', updateKeyStatus);
  protocolInput.addEventListener('change', updateKeyStatus);
  modelInput.addEventListener('input', updateKeyStatus);
  function loadSettings() {
    settings = store.settings();
    protocolInput.value = settings.protocol;
    const dictionary = store.dictionary();
    dictionaryMode.value = dictionary.mode;
    dictionaryTemplate.value = dictionary.url;
    dictionaryScript.value = dictionary.script;
    endpointInput.value = settings.endpoint;
    modelInput.value = settings.model;
    extraInput.value = JSON.stringify(settings.extra, null, 2);
    defaultSource.value = settings.source;
    defaultTarget.value = settings.target;
    annotationInput.checked = settings.annotations;
    autoInput.checked = settings.autoTranslate;
    popupInput.checked = settings.hideFeePopup;
    frequencyInput.value = settings.annotationFrequency;
    annotationStyleInput.value = settings.annotationStyle;
    translationModeInput.value = settings.translationMode;
    translationFontSizeInput.value = String(settings.translationFontSize);
    translationLineHeightInput.value = String(settings.translationLineHeight);
    translationColorInput.value = settings.translationColor;
    masteredDisplayInput.value = settings.masteredDisplay;
    knownLanguagesInput.value = settings.knownLanguages.join(', ');
    const policy = sitePolicy(settings, window.location?.hostname);
    siteModeInput.value = policy.mode;
    siteAnnotationInput.checked = policy.annotations;
    siteSourceInput.value = policy.source || '';
    siteTargetInput.value = policy.target || '';
    updateKeyStatus();
  }
  function refreshAnnotations() {
    const config = siteSettings(store.settings(), window.location?.hostname);
    const policy = sitePolicy(config, window.location?.hostname);
    annotator.refresh(store.entries(), { ...config, annotations: config.annotations && policy.annotations && policy.mode !== 'disabled' });
  }
  function queueSelection(gesture = false, eventType = 'selectionchange') {
    selectionGesture ||= gesture;
    log('selection-event', { type: eventType, gesture, panelHidden: panel.hidden, ...activeElementInfo() });
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const userGesture = selectionGesture;
      selectionGesture = false;
      const focused = root.activeElement;
      if ((!panel.hidden && focused && focused !== launcher) || (!panel.hidden && pages.get('translate').hidden)) {
        log('selection-skip', { reason: 'panel-focus-or-page', panelHidden: panel.hidden, ...activeElementInfo() });
        return;
      }
      const currentSelection = readSelectionText();
      if (currentSelection) {
        selectionText = currentSelection;
      } else if (!focused || focused === launcher) {
        selectionText = '';
      }
      launcher.textContent = selectionText ? '翻译选区' : '译';
      if (selectionText) log('selection-ready', { length: selectionText.length, gesture: userGesture });
    }, 300);
  }
  document.addEventListener('selectionchange', () => queueSelection());
  for (const type of ['pointerup', 'keyup']) {
    document.addEventListener(type, (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const insideHost = path.includes(host) || event.target === host;
      log('gesture-event', { type, trusted: Boolean(event.isTrusted), insideHost });
      if (event.isTrusted && !insideHost) queueSelection(true, type);
    });
  }
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click']) {
    document.addEventListener(type, (event) => {
      const insideHost = event.composedPath?.().includes(host) || event.target === host;
      log('input-capture', { type, trusted: Boolean(event.isTrusted), insideHost: Boolean(insideHost),
        prevented: Boolean(event.defaultPrevented), panelHidden: panel.hidden });
    }, { capture: true, passive: true });
  }
  registerMenu('打开 TranslateMokey', () => open('translate'));
  registerMenu('导出 TranslateMokey 诊断日志', () => {
    try { exportDiagnostics(); }
    catch (error) { report(error); window.alert('日志下载失败，请通过设置底部的诊断日志文本框手动复制。'); }
  });
  registerMenu('刷新本地生词标注', () => { try { refreshAnnotations(); } catch (error) { report(error); open('settings'); } });
  store.subscribe(() => {
    try {
      cancelDictionary();
      speech.stop();
      cancel();
      reader.stop();
      queue.clearCache();
      readingStatus.textContent = '其他标签页数据已变化，网页阅读已停止';
      translated = undefined;
      refreshAnnotations();
      if (!pages.get('words').hidden) renderWords();
      if (!pages.get('review').hidden) renderReview();
      report('其他标签页的数据已变化；下次翻译使用最新服务设置，语言仍以当前输入框为准。');
    } catch (error) { report(error); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(selectionTimer); selectionGesture = false; cancel(); cancelDictionary(); speech.stop(); reader.stop(); queue.clearCache(); annotator.clear(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) refreshAnnotations(); });
  for (const page of pages.values()) page.hidden = true;
  loadSettings();
  refreshAnnotations();
  if (sitePolicy(settings, window.location?.hostname).mode === 'auto') startReading(true);
  log('ready', { autoTranslate: settings.autoTranslate, hideFeePopup: settings.hideFeePopup,
    pointerEvents: typeof window.PointerEvent === 'function', touchPoints: window.navigator?.maxTouchPoints || 0,
    dynamicViewportUnits: Boolean(window.CSS?.supports?.('height', '100dvh')) });
}
