import { createStore } from './storage.js';
import { createAnnotator } from './annotations.js';
import { mountUI } from './ui.js';

if (window.top === window.self) {
  try {
    if ([typeof GM_getValue, typeof GM_setValue, typeof GM_listValues, typeof GM_addValueChangeListener,
      typeof GM_registerMenuCommand, typeof GM_xmlhttpRequest].some((type) => type !== 'function')) {
      throw new Error('需要支持 GM_* 存储、值变更监听、菜单和跨域请求 API 的用户脚本管理器');
    }
    const store = createStore({ get: GM_getValue, set: GM_setValue, list: GM_listValues, listen: GM_addValueChangeListener });
    mountUI({ document, store, request: GM_xmlhttpRequest, annotator: createAnnotator(document), registerMenu: GM_registerMenuCommand });
  } catch (error) {
    window.alert(`TranslateMokey 启动失败：${error.message}`);
  }
}
