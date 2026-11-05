export const SCHEMA_VERSION = 1;
export const BACKUP_VERSION = 2;
export const INDEX_PRESET = Object.freeze({
  endpoint: 'https://index-translate.bilibili.com/v1',
  model: 'index-mt-9b',
  extra: { chat_template_kwargs: { enable_thinking: false } },
});
export const DEFAULT_SETTINGS = Object.freeze({
  ...INDEX_PRESET,
  protocol: 'openai',
  lookupProvider: 'ai',
  launcherAction: 'translate',
  source: 'auto',
  target: 'zh-CN',
  annotations: false,
  autoTranslate: false,
  hideFeePopup: false,
  annotationFrequency: 'all',
  annotationStyle: 'inline',
  annotationFontSize: 0.85,
  annotationColor: '#17684a',
  annotationSpacing: 0,
  annotationHighlightColor: '#ffe69a',
  translationStyle: 'muted',
  translationMode: 'bilingual',
  translationFontSize: 1,
  translationLineHeight: 1.5,
  translationColor: 'inherit',
  translationSpacing: 0.6,
  masteredDisplay: 'hide',
  knownLanguages: [],
  siteRules: [],
});

export function boundedText(value, name, limit, optional = false) {
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) {
    throw new Error(`${name}必须是${optional ? '不超过' : '非空且不超过'} ${limit} 字符的文本`);
  }
  return value.trim();
}

export function language(value, allowAuto = false) {
  if (allowAuto && value === 'auto') return value;
  if (typeof value !== 'string' || value.toLowerCase() === 'auto' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(value) || value.length > 35) {
    throw new Error('语言请填写 BCP 47 代码，例如 en、zh-CN、ja');
  }
  return value.toLowerCase();
}

export function completionEndpoint(value) {
  return serviceEndpoint({ endpoint: value, protocol: 'openai' });
}

export function serviceEndpoint({ endpoint, protocol = 'openai', model }) {
  let url;
  try {
    url = new URL(boundedText(endpoint, '服务地址', 2048));
  } catch {
    throw new Error('服务地址必须是有效的 HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持 HTTPS，地址中不得包含凭据、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!['openai', 'anthropic', 'gemini'].includes(protocol)) throw new Error('服务协议无效');
  const suffix = protocol === 'openai' ? '/chat/completions' : protocol === 'anthropic' ? '/messages' : '';
  if (protocol === 'gemini') {
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model)) throw new Error('Gemini 模型需填写不含路径的模型 ID');
    if (/\/(chat\/completions|messages)$|:generateContent$/.test(url.pathname)) throw new Error('Gemini 请填写 API 基础地址，不含模型路径');
    url.pathname += `/models/${model}:generateContent`;
  } else {
    if ((protocol === 'anthropic' && url.pathname.endsWith('/chat/completions'))
      || (protocol === 'openai' && url.pathname.endsWith('/messages')) || url.pathname.endsWith(':generateContent')) throw new Error('服务地址与协议不匹配');
    if (!url.pathname.endsWith(suffix)) url.pathname += suffix;
  }
  return url.href;
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
  const lookupProvider = value.lookupProvider ?? 'ai';
  if (!['ai', 'dictionary'].includes(lookupProvider)) throw new Error('默认查询来源必须是 AI 或词典');
  const launcherAction = value.launcherAction ?? 'translate';
  if (!['translate', 'reading', 'words', 'review', 'menu'].includes(launcherAction)) throw new Error('右下角按钮功能无效');
  const protocol = value.protocol ?? 'openai';
  serviceEndpoint({ ...value, protocol });
  const extra = value.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('附加参数必须是 JSON 对象');
  if (JSON.stringify(extra).length > 8000) throw new Error('附加参数过长');
  const allowed = new Set(protocol === 'openai' ? ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'chat_template_kwargs']
    : ['temperature', 'top_p', 'max_tokens']);
  for (const [key, item] of Object.entries(extra)) {
    if (!allowed.has(key)) throw new Error(`不支持的附加参数：${key}`);
    if (key === 'chat_template_kwargs') {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some((field) => field !== 'enable_thinking')
        || (Object.hasOwn(item, 'enable_thinking') && typeof item.enable_thinking !== 'boolean')) {
        throw new Error('chat_template_kwargs 仅支持布尔值 enable_thinking');
      }
    } else if (typeof item !== 'number' || !Number.isFinite(item) || item < 0
      || (key === 'temperature' && item > (protocol === 'anthropic' ? 1 : 2)) || (key === 'top_p' && item > 1)
      || (key.startsWith('max_') && (!Number.isInteger(item) || item < 1))) {
      throw new Error(`附加参数 ${key} 的数值无效`);
    }
  }
  if (typeof value.annotations !== 'boolean') throw new Error('标注开关格式无效');
  for (const key of ['autoTranslate', 'hideFeePopup']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('自动翻译与弹窗开关必须是布尔值');
  }
  const annotationFrequency = value.annotationFrequency ?? 'all';
  const annotationStyle = value.annotationStyle ?? 'inline';
  const annotationFontSize = value.annotationFontSize ?? DEFAULT_SETTINGS.annotationFontSize;
  const annotationColor = value.annotationColor ?? DEFAULT_SETTINGS.annotationColor;
  const annotationSpacing = value.annotationSpacing ?? DEFAULT_SETTINGS.annotationSpacing;
  const annotationHighlightColor = value.annotationHighlightColor ?? DEFAULT_SETTINGS.annotationHighlightColor;
  const translationStyle = value.translationStyle ?? 'muted';
  const translationMode = value.translationMode ?? 'bilingual';
  const translationFontSize = value.translationFontSize ?? DEFAULT_SETTINGS.translationFontSize;
  const translationLineHeight = value.translationLineHeight ?? DEFAULT_SETTINGS.translationLineHeight;
  const translationColor = value.translationColor ?? (translationStyle === 'accent' ? 'accent' : 'inherit');
  const translationSpacing = value.translationSpacing ?? DEFAULT_SETTINGS.translationSpacing;
  const masteredDisplay = value.masteredDisplay ?? 'hide';
  if (!['hide', 'dim', 'show'].includes(masteredDisplay)) throw new Error('已掌握词显示策略无效');
  if (!Array.isArray(value.knownLanguages ?? []) || (value.knownLanguages ?? []).length > 30) throw new Error('已掌握语言列表无效');
  const knownLanguages = [...new Set((value.knownLanguages ?? []).map((code) => language(code)))];
  if (!['all', 'page', 'paragraph'].includes(annotationFrequency)) throw new Error('标注频率无效');
  if (!['inline', 'compact', 'underline', 'highlight'].includes(annotationStyle)) throw new Error('标注样式无效');
  for (const [number, minimum, maximum, title] of [
    [annotationFontSize, 0.5, 2, '释义字号'], [annotationSpacing, 0, 2, '原词与释义间距'],
    [translationSpacing, 0, 3, '原文与译文间距'],
  ]) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${title}无效`);
  }
  for (const color of [annotationColor, annotationHighlightColor]) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('标注颜色无效');
  }
  if (!['muted', 'accent'].includes(translationStyle)) throw new Error('译文样式无效');
  if (!['bilingual', 'translation-only'].includes(translationMode)) throw new Error('网页阅读模式无效');
  if (typeof translationFontSize !== 'number' || !Number.isFinite(translationFontSize)
    || translationFontSize < 0.75 || translationFontSize > 2) throw new Error('译文字号无效');
  if (typeof translationLineHeight !== 'number' || !Number.isFinite(translationLineHeight)
    || translationLineHeight < 1.2 || translationLineHeight > 3) throw new Error('译文行距无效');
  if (typeof translationColor !== 'string'
    || (!['inherit', 'accent', 'muted'].includes(translationColor) && !/^#[0-9a-f]{6}$/i.test(translationColor))) throw new Error('译文颜色无效');
  const rules = value.siteRules ?? [];
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('网站规则最多 100 条');
  const siteRules = rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || typeof rule.host !== 'string'
      || !/^[a-z0-9.-]+$/.test(rule.host) || rule.host.length > 253
      || new URL(`https://${rule.host}`).hostname !== rule.host
      || !['manual', 'auto', 'disabled'].includes(rule.mode)
      || typeof rule.annotations !== 'boolean') throw new Error('网站规则格式无效');
    return { host: rule.host, mode: rule.mode, annotations: rule.annotations,
      ...(rule.source ? { source: language(rule.source, true) } : {}),
      ...(rule.target ? { target: language(rule.target) } : {}) };
  });
  if (new Set(siteRules.map((rule) => rule.host)).size !== siteRules.length) throw new Error('网站规则重复');
  return {
    protocol, lookupProvider, launcherAction, endpoint: value.endpoint.trim(), model: boundedText(value.model, '模型', 200),
    source: language(value.source, true), target: language(value.target),
    extra: JSON.parse(JSON.stringify(extra)), annotations: value.annotations,
    autoTranslate: value.autoTranslate ?? false, hideFeePopup: value.hideFeePopup ?? false,
    annotationFrequency, annotationStyle, translationStyle, siteRules,
    annotationFontSize, annotationColor, annotationSpacing, annotationHighlightColor,
    translationMode, translationFontSize, translationLineHeight, translationColor, translationSpacing,
    masteredDisplay, knownLanguages,
  };
}

export function annotationAppearance(settings) {
  return {
    label: `color:${settings.annotationColor ?? DEFAULT_SETTINGS.annotationColor};font:${settings.annotationFontSize ?? DEFAULT_SETTINGS.annotationFontSize}em/1.5 system-ui;overflow-wrap:anywhere`,
    note: `margin-inline-start:${settings.annotationSpacing ?? DEFAULT_SETTINGS.annotationSpacing}em`,
    word: settings.annotationStyle === 'underline' ? 'text-decoration:underline dotted;cursor:pointer'
      : `background:${settings.annotationHighlightColor ?? DEFAULT_SETTINGS.annotationHighlightColor};color:#222;cursor:pointer`,
  };
}

export function translationAppearance(settings) {
  const color = settings.translationColor === 'accent' ? '#17684a'
    : settings.translationColor === 'muted' ? '#666' : settings.translationColor;
  return `display:block;font:400 ${settings.translationFontSize}em/${settings.translationLineHeight} system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;letter-spacing:normal;white-space:pre-wrap;overflow-wrap:anywhere;padding:${settings.translationSpacing ?? DEFAULT_SETTINGS.translationSpacing}em 0;color:${color};opacity:1`;
}

export function sitePolicy(settings, hostname) {
  return settings.siteRules?.find((rule) => rule.host === hostname)
    ?? { mode: 'manual', annotations: true };
}

export function siteSettings(settings, hostname) {
  const rule = sitePolicy(settings, hostname);
  return { ...settings, source: rule.source || settings.source, target: rule.target || settings.target };
}

export function validateEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('词条格式无效');
  const entry = {
    term: boundedText(value.term, '原词', 200),
    source: language(value.source, true), target: language(value.target),
    meaning: boundedText(value.meaning, '释义', 2000),
    example: boundedText(value.example ?? '', '例句', 2000, true),
    note: boundedText(value.note ?? '', '备注', 2000, true),
    title: boundedText(value.title ?? '', '来源标题', 500, true),
    url: boundedText(value.url ?? '', '来源链接', 2048, true),
    createdAt: boundedText(value.createdAt, '收藏时间', 40),
  };
  if (value.mastered !== undefined) {
    if (typeof value.mastered !== 'boolean') throw new Error('已掌握状态无效');
    entry.mastered = value.mastered;
  }
  if (value.lemma !== undefined) entry.lemma = boundedText(value.lemma, '原形', 200, true);
  if (value.forms !== undefined) {
    if (!Array.isArray(value.forms) || value.forms.length > 20) throw new Error('关联词形最多 20 个');
    entry.forms = [...new Set(value.forms.map((form) => boundedText(form, '关联词形', 200)))];
  }
  if (value.senses !== undefined) {
    if (!Array.isArray(value.senses) || value.senses.length > 20) throw new Error('其他义项最多 20 个');
    entry.senses = value.senses.map((sense) => {
      if (!sense || typeof sense !== 'object' || Array.isArray(sense)) throw new Error('义项格式无效');
      return { meaning: boundedText(sense.meaning, '义项释义', 2000), example: boundedText(sense.example ?? '', '义项例句', 2000, true) };
    });
  }
  if (value.review !== undefined) {
    const review = value.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)
      || !Number.isSafeInteger(review.count) || review.count < 1
      || !Number.isInteger(review.step) || review.step < 0 || review.step > 6
      || !['known', 'fuzzy', 'again'].includes(review.feedback)) throw new Error('复习记录无效');
    for (const date of [review.lastAt, review.dueAt]) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error('复习时间无效');
    }
    if (review.dueAt <= review.lastAt) throw new Error('复习到期时间必须晚于上次复习');
    entry.review = { count: review.count, step: review.step, feedback: review.feedback, lastAt: review.lastAt, dueAt: review.dueAt };
  }
  if (!Number.isFinite(Date.parse(entry.createdAt))) throw new Error('收藏时间无效');
  if (entry.url) {
    let url;
    try { url = new URL(entry.url); } catch { throw new Error('来源链接无效'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('来源链接必须是无凭据的 HTTP(S) 地址');
    url.search = '';
    url.hash = '';
    entry.url = url.href;
  }
  return entry;
}

export function entryId(entry) {
  return JSON.stringify([entry.term, entry.source, entry.target]);
}

export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new Error('备份不得超过 5 MiB');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('备份不是有效 JSON'); }
  if (!data || data.format !== 'TranslateMokey' || ![1, BACKUP_VERSION].includes(data.version)
    || !Array.isArray(data.entries) || data.entries.length > 5000) throw new Error('备份格式、版本或词条数量无效（上限 5000）');
  const entries = data.entries.map(validateEntry);
  if (new Set(entries.map(entryId)).size !== entries.length) throw new Error('备份内有重复词条，请先去重');
  return entries;
}

export function exportBackup(entries) {
  const output = JSON.stringify({ format: 'TranslateMokey', version: BACKUP_VERSION, entries: entries.map(validateEntry) }, null, 2);
  if (new TextEncoder().encode(output).length > 5 * 1024 * 1024) throw new Error('备份超过 5 MiB，请先缩减词条内容；尚未导出');
  return output;
}

export function createMatcher(entries, target, source = 'auto') {
  const selected = entries.filter((entry) => entry.target === language(target)
    && (entry.source === 'auto' || entry.source === source));
  const meanings = new Map();
  for (const entry of selected.sort((left, right) => Number(left.source !== 'auto') - Number(right.source !== 'auto'))) {
    meanings.set(entry.term, entry);
  }
  const aliases = new Map();
  for (const entry of selected) {
    for (const form of new Set([entry.lemma, ...(entry.forms ?? [])].filter(Boolean))) {
      if (meanings.has(form)) continue;
      aliases.set(form, aliases.has(form) && aliases.get(form) !== entry ? null : entry);
    }
  }
  for (const [form, entry] of aliases) if (entry) meanings.set(form, entry);
  const terms = [...meanings.keys()].sort((left, right) => right.length - left.length);
  if (!terms.length) return () => [];
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
  const wordCharacter = /[\p{L}\p{N}\p{M}_]/u;
  return (text) => {
    const matches = [];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const before = [...text.slice(Math.max(0, match.index - 2), match.index)].at(-1) || '';
      const after = [...text.slice(match.index + match[0].length, match.index + match[0].length + 2)][0] || '';
      if ((wordCharacter.test([...match[0]][0]) && wordCharacter.test(before))
        || (wordCharacter.test([...match[0]].at(-1)) && wordCharacter.test(after))) continue;
      matches.push({ start: match.index, end: match.index + match[0].length, entry: meanings.get(match[0]) });
    }
    return matches;
  };
}
