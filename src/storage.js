import { BUILTIN_API_ID, DEFAULT_SETTINGS, SCHEMA_VERSION, entryId, validateEntry, validateSettings } from './core.js';
import { gradeEntry } from './review.js';
import { BUILTIN_DICTIONARY_ID, resolveDictionaryStore, validateDictionary, validateDictionaryProfile, validateDictionaryStore } from './dictionary.js';

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
  function dictionaryState() {
    const record = api.get('tm:dictionary');
    return validateDictionaryStore(record === undefined ? undefined : unpack(record));
  }
  return {
    settings() {
      const record = api.get(settingsKey);
      return validateSettings(record === undefined ? DEFAULT_SETTINGS : unpack(record));
    },
    saveSettings(value) { write(settingsKey, validateSettings(value)); },
    dictionary() {
      return resolveDictionaryStore(dictionaryState());
    },
    dictionaryState,
    dictionaryProfiles() { return dictionaryState().profiles; },
    selectedDictionaryId() { return dictionaryState().selectedId; },
    saveDictionaryProfile(value) {
      const profile = validateDictionaryProfile(value);
      const state = dictionaryState();
      const profiles = [...state.profiles.filter((item) => item.id !== profile.id), profile];
      const next = validateDictionaryStore({ selectedId: profile.id, profiles });
      write('tm:dictionary', next);
      return profile;
    },
    selectDictionary(id) {
      const state = dictionaryState();
      const selectedId = typeof id === 'string' ? id : '';
      if (selectedId !== BUILTIN_DICTIONARY_ID && !state.profiles.some((profile) => profile.id === selectedId)) throw new Error('所选词典不存在');
      write('tm:dictionary', { selectedId, profiles: state.profiles });
    },
    deleteDictionaryProfile(id) {
      const state = dictionaryState();
      const profiles = state.profiles.filter((profile) => profile.id !== id);
      write('tm:dictionary', { selectedId: state.selectedId === id ? BUILTIN_DICTIONARY_ID : state.selectedId, profiles });
    },
    saveDictionary(value) {
      const config = validateDictionary(value);
      if (config.mode === 'bing') return this.selectDictionary(BUILTIN_DICTIONARY_ID);
      return this.saveDictionaryProfile({ id: 'legacy:dictionary', name: '自定义词典', ...config });
    },
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
    reviewEntry(value, feedback, now = Date.now()) {
      const expected = validateEntry(value);
      const key = wordPrefix + entryId(expected);
      const record = api.get(key);
      if (!record || unpack(record) === null) throw new Error('词条已删除，请刷新复习列表');
      const current = validateEntry(unpack(record));
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('词条已变化，请刷新复习列表');
      const updated = gradeEntry(current, feedback, now);
      write(key, updated);
      return updated;
    },
    key(id, endpoint = '') {
      if (typeof id !== 'string' || !id) return '';
      if (id === BUILTIN_API_ID) return '';
      const saved = api.get(`tm:secret:api:${id}`, undefined);
      if (typeof saved === 'string') return saved;
      return endpoint ? api.get(`tm:secret:${endpoint}`, '') : '';
    },
    saveKey(id, key) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(id)) throw new Error('API 标识无效');
      if (id === BUILTIN_API_ID) throw new Error('内置 API 凭据不可修改');
      if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效');
      api.set(`tm:secret:api:${id}`, key.trim());
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
