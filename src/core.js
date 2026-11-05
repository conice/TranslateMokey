export const SCHEMA_VERSION = 1;
export const INDEX_PRESET = Object.freeze({
  endpoint: 'https://index-translate.bilibili.com/v1',
  model: 'index-mt-9b',
  extra: { chat_template_kwargs: { enable_thinking: false } },
});
export const DEFAULT_SETTINGS = Object.freeze({
  ...INDEX_PRESET,
  source: 'auto',
  target: 'zh-CN',
  annotations: false,
  autoTranslate: false,
  hideFeePopup: false,
  annotationFrequency: 'all',
  annotationStyle: 'inline',
  translationStyle: 'muted',
  translationMode: 'bilingual',
  translationFontSize: 1,
  translationLineHeight: 1.7,
  translationColor: 'inherit',
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
  let url;
  try {
    url = new URL(boundedText(value, '服务地址', 2048));
  } catch {
    throw new Error('服务地址必须是有效的 HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持 HTTPS，地址中不得包含凭据、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
  completionEndpoint(value.endpoint);
  const extra = value.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('附加参数必须是 JSON 对象');
  if (JSON.stringify(extra).length > 8000) throw new Error('附加参数过长');
  const allowed = new Set(['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'chat_template_kwargs']);
  for (const [key, item] of Object.entries(extra)) {
    if (!allowed.has(key)) throw new Error(`不支持的附加参数：${key}`);
    if (key === 'chat_template_kwargs') {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some((field) => field !== 'enable_thinking')
        || (Object.hasOwn(item, 'enable_thinking') && typeof item.enable_thinking !== 'boolean')) {
        throw new Error('chat_template_kwargs 仅支持布尔值 enable_thinking');
      }
    } else if (typeof item !== 'number' || !Number.isFinite(item) || item < 0
      || (key === 'temperature' && item > 2) || (key === 'top_p' && item > 1)
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
  const translationStyle = value.translationStyle ?? 'muted';
  const translationMode = value.translationMode ?? 'bilingual';
  const translationFontSize = value.translationFontSize ?? 1;
  const translationLineHeight = value.translationLineHeight ?? 1.7;
  const translationColor = value.translationColor ?? (translationStyle === 'accent' ? 'accent' : 'inherit');
  const masteredDisplay = value.masteredDisplay ?? 'hide';
  if (!['hide', 'dim', 'show'].includes(masteredDisplay)) throw new Error('已掌握词显示策略无效');
  if (!Array.isArray(value.knownLanguages ?? []) || (value.knownLanguages ?? []).length > 30) throw new Error('已掌握语言列表无效');
  const knownLanguages = [...new Set((value.knownLanguages ?? []).map((code) => language(code)))];
  if (!['all', 'page', 'paragraph'].includes(annotationFrequency)) throw new Error('标注频率无效');
  if (!['inline', 'compact', 'underline', 'highlight'].includes(annotationStyle)) throw new Error('标注样式无效');
  if (!['muted', 'accent'].includes(translationStyle)) throw new Error('译文样式无效');
  if (!['bilingual', 'translation-only'].includes(translationMode)) throw new Error('网页阅读模式无效');
  if (typeof translationFontSize !== 'number' || !Number.isFinite(translationFontSize)
    || translationFontSize < 0.75 || translationFontSize > 2) throw new Error('译文字号无效');
  if (typeof translationLineHeight !== 'number' || !Number.isFinite(translationLineHeight)
    || translationLineHeight < 1.2 || translationLineHeight > 3) throw new Error('译文行距无效');
  if (!['inherit', 'accent', 'muted'].includes(translationColor)) throw new Error('译文颜色无效');
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
    endpoint: value.endpoint.trim(), model: boundedText(value.model, '模型', 200),
    source: language(value.source, true), target: language(value.target),
    extra: JSON.parse(JSON.stringify(extra)), annotations: value.annotations,
    autoTranslate: value.autoTranslate ?? false, hideFeePopup: value.hideFeePopup ?? false,
    annotationFrequency, annotationStyle, translationStyle, siteRules,
    translationMode, translationFontSize, translationLineHeight, translationColor,
    masteredDisplay, knownLanguages,
  };
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
  if (!data || data.format !== 'TranslateMokey' || data.version !== SCHEMA_VERSION
    || !Array.isArray(data.entries) || data.entries.length > 5000) throw new Error('备份格式、版本或词条数量无效（上限 5000）');
  const entries = data.entries.map(validateEntry);
  if (new Set(entries.map(entryId)).size !== entries.length) throw new Error('备份内有重复词条，请先去重');
  return entries;
}

export function exportBackup(entries) {
  const output = JSON.stringify({ format: 'TranslateMokey', version: SCHEMA_VERSION, entries: entries.map(validateEntry) }, null, 2);
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
