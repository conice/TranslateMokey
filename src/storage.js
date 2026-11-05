import { DEFAULT_SETTINGS, SCHEMA_VERSION, entryId, validateEntry, validateSettings } from './core.js';

export function createStore(api) {
  const settingsKey = 'tm:settings';
  const wordPrefix = 'tm:word:';
  const signalKey = 'tm:changed';
  const logKey = 'tm:logs';
  function unpack(record) {
    if (!record || record.version !== SCHEMA_VERSION) throw new Error('本地数据版本不支持，已停止读取；请勿清空原数据');
    return record.value;
  }
  function write(key, value) {
    api.set(key, { version: SCHEMA_VERSION, value });
    api.set(signalKey, `${Date.now()}:${Math.random()}`);
  }
  function entries() {
    return api.list().filter((key) => key.startsWith(wordPrefix)).flatMap((key) => {
      const value = unpack(api.get(key));
      return value === null ? [] : [validateEntry(value)];
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  return {
    settings() {
      const record = api.get(settingsKey);
      return validateSettings(record === undefined ? DEFAULT_SETTINGS : unpack(record));
    },
    saveSettings(value) { write(settingsKey, validateSettings(value)); },
    entries,
    saveEntry(value, overwrite = false) {
      const entry = validateEntry(value);
      const key = wordPrefix + entryId(entry);
      const existing = api.get(key);
      if (existing !== undefined && unpack(existing) !== null && !overwrite) return false;
      if ((existing === undefined || unpack(existing) === null) && entries().length >= 5000) throw new Error('生词本已达 5000 条上限');
      write(key, entry);
      return true;
    },
    removeEntry(entry) { write(wordPrefix + entryId(entry), null); },
    key(endpoint) { return api.get(`tm:secret:${endpoint}`, ''); },
    saveKey(endpoint, key) {
      if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效');
      api.set(`tm:secret:${endpoint}`, key.trim());
    },
    logs() {
      const record = api.get(logKey);
      if (!record || record.version !== SCHEMA_VERSION || !Array.isArray(record.value)) return [];
      return record.value.slice(-300);
    },
    appendLog(value) {
      try {
        api.set(logKey, { version: SCHEMA_VERSION, value: [...this.logs(), value].slice(-300) });
      } catch {
        return false;
      }
      return true;
    },
    clearLogs() { api.set(logKey, { version: SCHEMA_VERSION, value: [] }); },
    subscribe(callback) { api.listen(signalKey, (_key, _old, _next, remote) => { if (remote) callback(); }); },
  };
}
