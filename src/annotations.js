import { createMatcher } from './core.js';

export const EXCLUDED = 'script,style,noscript,textarea,input,select,option,button,pre,code,kbd,samp,svg,math,audio,video,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],[data-tm-host],[data-tm-note]';

export function isExcluded(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return !element || Boolean(element.closest(EXCLUDED));
}

export function createAnnotator(document, schedule = (callback) => setTimeout(callback, 0)) {
  const notes = new Set();
  const splits = [];
  let generation = 0;
  function clear() {
    generation += 1;
    for (const note of notes) note.remove();
    notes.clear();
    for (const { head, tail } of splits.reverse()) {
      if (head.parentNode && head.nextSibling === tail) {
        head.appendData(tail.data);
        tail.remove();
      }
    }
    splits.length = 0;
  }
  function refresh(entries, settings) {
    clear();
    if (!settings.annotations || !entries.length) return;
    const pageLanguage = document.documentElement.lang.toLowerCase();
    const source = settings.source !== 'auto' ? settings.source : pageLanguage || 'auto';
    const match = createMatcher(entries, settings.target, source);
    const current = generation;
    const walker = document.createTreeWalker(document.body, 4, {
      acceptNode(node) { return isExcluded(node) || !node.textContent.trim() ? 2 : 1; },
    });
    function batch() {
      if (current !== generation) return;
      const nodes = [];
      for (let count = 0; count < 100; count += 1) {
        const node = walker.nextNode();
        if (!node) break;
        nodes.push(node);
      }
      const next = walker.nextNode();
      for (const node of nodes) {
        if (!node.isConnected || isExcluded(node)) continue;
        const matches = match(node.textContent);
        for (const hit of matches.reverse()) {
          const remainder = node.splitText(hit.end);
          splits.push({ head: node, tail: remainder });
          const note = document.createElement('span');
          note.dataset.tmNote = '';
          const shadow = note.attachShadow({ mode: 'closed' });
          const label = document.createElement('span');
          label.textContent = `〔${hit.entry.meaning}〕`;
          label.style.cssText = 'color:#17684a;font:0.85em/1.5 system-ui;overflow-wrap:anywhere';
          shadow.append(label);
          remainder.before(note);
          notes.add(note);
        }
      }
      if (next) {
        walker.currentNode = next;
        walker.previousNode();
        schedule(batch);
      }
    }
    schedule(batch);
  }
  return { clear, refresh };
}
