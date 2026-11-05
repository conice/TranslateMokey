import { INDEX_PRESET, completionEndpoint, entryId, exportBackup, parseBackup, validateSettings } from './core.js';
import { EXCLUDED, isExcluded } from './annotations.js';
import { translate } from './service.js';

export function mountUI({ document, store, request, annotator, registerMenu }) {
  const window = document.defaultView;
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
  header.append(element('strong', 'TranslateMokey · 0.1.2'), button('关闭', close));
  const nav = element('nav');
  nav.setAttribute('aria-label', '功能');
  const pages = new Map();
  for (const [name, title] of [['translate', '翻译'], ['words', '生词本'], ['settings', '设置']]) {
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
  source.value = settings.source;
  target.value = settings.target;
  const actions = element('div', '', 'row');
  const send = button('翻译 / 重试', startTranslation);
  async function startTranslation() {
    log('translation-start');
    cancel();
    translated = undefined;
    meaning.value = '';
    const config = validateSettings({ ...store.settings(), source: source.value.trim(), target: target.value.trim() });
    const text = original.value.trim();
    if (!text || text.length > 10000) throw new Error('请提供 1–10000 字符的原文');
    if (config.source === config.target) throw new Error('源语言与目标语言相同，无须翻译');
    const endpoint = completionEndpoint(config.endpoint);
    if (!config.hideFeePopup && !window.confirm(`将向 ${endpoint}\n模型 ${config.model} 发送输入框中的 ${text.length} 字符。不会发送整页。可能产生服务费用。\n是否继续？`)) {
      log('translation-confirm-cancel', { length: text.length });
      return;
    }
    const current = serial;
    const context = { title: document.title.slice(0, 500), url: window.location.origin + window.location.pathname };
    activeTask = translate(request, config, store.key(endpoint), text);
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
  actions.append(send, button('取消', () => { cancel(); report('已取消'); }));
  translationPage.append(actions);
  const meaning = field(translationPage, '译文 / 收藏释义（可编辑）', true, 20000);
  const example = field(translationPage, '例句（可选，仅本地保存）', true, 2000);
  translationPage.append(button('收藏到生词本', () => {
    if (!translated) throw new Error('请先完成翻译');
    if (original.value.trim() !== translated.term || source.value.trim().toLowerCase() !== translated.source
      || target.value.trim().toLowerCase() !== translated.target) throw new Error('原文或语言已变化，请重新翻译后收藏');
    const entry = { ...translated, meaning: meaning.value, example: example.value, note: '', createdAt: new Date().toISOString() };
    if (!store.saveEntry(entry)) {
      if (!window.confirm('已存在相同原词和语言的词条，是否用当前释义及例句覆盖？')) return;
      const existing = store.entries().find((item) => entryId(item) === entryId(entry));
      store.saveEntry({ ...entry, createdAt: existing.createdAt, note: existing.note }, true);
    }
    refreshAnnotations();
    report('已收藏。标注仅使用本地释义，不请求 API。');
  }));
  for (const input of [original, source, target]) input.addEventListener('input', () => {
    cancel();
    translated = undefined;
    meaning.value = '';
  });

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
    link.download = 'TranslateMokey-v1.json';
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
    const visible = entries.filter((entry) => `${entry.term}\n${entry.meaning}`.toLowerCase().includes(query));
    list.replaceChildren(element('p', `共 ${entries.length} 条，匹配 ${visible.length} 条（最多展示 100 条，请搜索缩小范围）`));
    for (const entry of visible.slice(0, 100)) {
      const item = element('article', '', 'word');
      item.append(element('strong', entry.term), element('p', entry.meaning), element('p', `${entry.source} → ${entry.target} · ${entry.createdAt}`, 'hint'));
      if (entry.example) item.append(element('p', `例句：${entry.example}`));
      if (entry.note) item.append(element('p', `备注：${entry.note}`));
      if (entry.title || entry.url) item.append(element('p', `${entry.title}\n${entry.url}`, 'hint'));
      item.append(button('编辑', () => {
        const editor = element('div');
        const definition = field(editor, '释义', true, 2000);
        const sample = field(editor, '例句', true, 2000);
        const note = field(editor, '备注', true, 2000);
        definition.value = entry.meaning;
        sample.value = entry.example;
        note.value = entry.note;
        editor.append(button('保存修改', () => {
          store.saveEntry({ ...entry, meaning: definition.value, example: sample.value, note: note.value }, true);
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

  const settingsPage = pages.get('settings');
  settingsPage.append(element('p', 'Index 为示例预设，服务可用性、鉴权和条款待核实。自定义接口仅支持非流式 OpenAI chat.completions。', 'hint'));
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
  const annotationLabel = element('label', '开启本地词后释义（区分大小写，切换页面或新内容可手动刷新）');
  const annotationInput = element('input');
  annotationInput.type = 'checkbox';
  annotationInput.style.width = 'auto';
  annotationLabel.prepend(annotationInput);
  settingsPage.append(annotationLabel);
  const keyStatus = element('p', '', 'hint');
  function exportDiagnostics() {
    recordLayout('export-layout');
    log('diagnostics-export');
    const combined = [...store.logs(), ...recentLogs];
    const unique = new Map(combined.map((entry) => [JSON.stringify(entry), entry]));
    const output = JSON.stringify({ format: 'TranslateMokey-diagnostics', version: 1, scriptVersion: '0.1.2',
      build: 'selection-diagnostics-2', exportedAt: new Date().toISOString(),
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
    modelInput.value = INDEX_PRESET.model;
    extraInput.value = JSON.stringify(INDEX_PRESET.extra, null, 2);
    updateKeyStatus();
  }), button('设置 / 清除 API Key', () => {
    const endpoint = completionEndpoint(endpointInput.value);
    const key = window.prompt(`为 ${endpoint} 设置 API Key。留空并确认可清除；取消则不修改。\n使用浏览器原生输入框，不回填到页面；输入可见，请避免旁人窥视。脚本存储不等于加密保险箱。`);
    if (key === null) return;
    if (!key.trim() && !window.confirm('确认清除此服务地址保存的 API Key？')) return;
    store.saveKey(endpoint, key);
    updateKeyStatus();
    report('凭据已更新，不会加入备份。');
  }), button('保存设置', () => {
    let extra;
    try { extra = JSON.parse(extraInput.value); } catch { throw new Error('附加参数不是有效 JSON'); }
    const next = validateSettings({ endpoint: endpointInput.value, model: modelInput.value, extra,
      source: defaultSource.value.trim(), target: defaultTarget.value.trim(), annotations: annotationInput.checked,
      autoTranslate: autoInput.checked, hideFeePopup: popupInput.checked });
    store.saveSettings(next);
    settings = next;
    log('settings-saved', { autoTranslate: next.autoTranslate, hideFeePopup: next.hideFeePopup });
    cancel();
    translated = undefined;
    source.value = settings.source;
    target.value = settings.target;
    refreshAnnotations();
    report('设置已保存；未发送网络请求。');
  }), button('刷新网页标注', () => { refreshAnnotations(); report('已安排本地标注扫描'); }));
  settingsPage.append(element('p', '仅匹配单个文本节点内完整词/短语，跳过代码和编辑区域；CJK 连续文本分词、跨标签短语及动态页面自动扫描不在此版本。auto 词条表示源语言未确认。', 'hint'));
  settingsPage.append(element('p', '诊断日志最多保留 300 条，记录事件、长度、开关与面板尺寸，不含原文、译文、URL、密钥或错误正文；仅本地保存，不自动上传。', 'hint'));
  const diagnosticPreview = field(settingsPage, '诊断日志（下载失败时可全选复制）', true, 500000);
  diagnosticPreview.readOnly = true;
  diagnosticPreview.parentElement.hidden = true;
  function updateKeyStatus() {
    try { keyStatus.textContent = store.key(completionEndpoint(endpointInput.value)) ? '此地址已保存 API Key（不回显）' : '此地址未保存 API Key'; }
    catch { keyStatus.textContent = '请填写有效服务地址'; }
  }
  endpointInput.addEventListener('input', updateKeyStatus);
  function loadSettings() {
    settings = store.settings();
    endpointInput.value = settings.endpoint;
    modelInput.value = settings.model;
    extraInput.value = JSON.stringify(settings.extra, null, 2);
    defaultSource.value = settings.source;
    defaultTarget.value = settings.target;
    annotationInput.checked = settings.annotations;
    autoInput.checked = settings.autoTranslate;
    popupInput.checked = settings.hideFeePopup;
    updateKeyStatus();
  }
  function refreshAnnotations() { annotator.refresh(store.entries(), store.settings()); }
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
      cancel();
      translated = undefined;
      refreshAnnotations();
      if (!pages.get('words').hidden) renderWords();
      report('其他标签页的数据已变化；下次翻译使用最新服务设置，语言仍以当前输入框为准。');
    } catch (error) { report(error); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(selectionTimer); selectionGesture = false; cancel(); annotator.clear(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) refreshAnnotations(); });
  for (const page of pages.values()) page.hidden = true;
  loadSettings();
  refreshAnnotations();
  log('ready', { autoTranslate: settings.autoTranslate, hideFeePopup: settings.hideFeePopup,
    pointerEvents: typeof window.PointerEvent === 'function', touchPoints: window.navigator?.maxTouchPoints || 0,
    dynamicViewportUnits: Boolean(window.CSS?.supports?.('height', '100dvh')) });
}
