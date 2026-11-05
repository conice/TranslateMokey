import { createMatcher } from './core.js';

export const EXCLUDED = 'script,style,noscript,textarea,input,select,option,button,pre,code,kbd,samp,svg,math,audio,video,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],[translate="no"],[data-tm-host],[data-tm-note],[data-tm-translation],[data-tm-control]';

export function isExcluded(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return !element || Boolean(element.closest(EXCLUDED) || element.closest('[data-tm-original]'));
}

export function createAnnotator(document, schedule = (callback) => setTimeout(callback, 0)) {
  const notes = new Set();
  const splits = [];
  const highlights = new Set();
  const dirtyRoots = new Set();
  let generation = 0;
  let observer;
  let refreshTimer;
  function clear() {
    observer?.disconnect();
    clearTimeout(refreshTimer);
    generation += 1;
    for (const note of notes) note.remove();
    notes.clear();
    for (const wrapper of highlights) unwrap(wrapper);
    highlights.clear();
    for (const { head, tail } of splits.reverse()) {
      if (head.parentNode && head.nextSibling === tail) {
        head.appendData(tail.data);
        tail.remove();
      }
    }
    splits.length = 0;
    dirtyRoots.clear();
  }
  function unwrap(wrapper) {
    if (!wrapper.parentNode) return;
    while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
    wrapper.remove();
  }
  function refresh(entries, settings, root = document.body) {
    if (root === document.body) clear();
    else {
      observer?.disconnect();
      generation += 1;
      for (const note of notes) if (!note.isConnected || root.contains(note)) { note.remove(); notes.delete(note); }
      for (const wrapper of highlights) if (!wrapper.isConnected || root.contains(wrapper)) { unwrap(wrapper); highlights.delete(wrapper); }
      for (let index = splits.length - 1; index >= 0; index -= 1) {
        const { head, tail } = splits[index];
        if (!head.isConnected || root.contains(head)) {
          if (head.parentNode && head.nextSibling === tail) { head.appendData(tail.data); tail.remove(); }
          splits.splice(index, 1);
        }
      }
    }
    if (!settings.annotations || !entries.length) return;
    const pageLanguage = document.documentElement.lang.toLowerCase();
    const source = settings.source !== 'auto' ? settings.source : pageLanguage || 'auto';
    const selected = entries.filter((entry) => !entry.mastered || settings.masteredDisplay !== 'hide');
    const match = createMatcher(selected, settings.target, source);
    const current = generation;
    const seen = new Map();
    const walker = document.createTreeWalker(root, 4, {
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
        const scope = settings.annotationFrequency === 'paragraph'
          ? node.parentElement.closest('p,li,td,th,blockquote,div,section,article') || document.body : document.body;
        if (!seen.has(scope)) seen.set(scope, new Set());
        const terms = seen.get(scope);
        const matches = match(node.textContent).filter((hit) => {
          if (settings.annotationFrequency === 'all' || !settings.annotationFrequency) return true;
          if (terms.has(hit.entry.term)) return false;
          terms.add(hit.entry.term);
          return true;
        });
        for (const hit of matches.reverse()) {
          const remainder = node.splitText(hit.end);
          splits.push({ head: node, tail: remainder });
          const decorated = ['underline', 'highlight'].includes(settings.annotationStyle);
          let word;
          if (decorated) {
            word = node.splitText(hit.start);
            splits.push({ head: node, tail: word });
            const wrapper = document.createElement('span');
            wrapper.dataset.tmMark = '';
            wrapper.style.cssText = settings.annotationStyle === 'underline'
              ? 'text-decoration:underline dotted;cursor:pointer' : 'background:#ffe69a;color:#222;cursor:pointer';
            wrapper.setAttribute('role', 'button');
            wrapper.setAttribute('tabindex', '0');
            wrapper.setAttribute('aria-label', `${hit.entry.term}：查看释义`);
            word.before(wrapper);
            wrapper.append(word);
            highlights.add(wrapper);
            word = wrapper;
          }
          const note = document.createElement('span');
          note.dataset.tmNote = '';
          if (hit.entry.mastered && settings.masteredDisplay === 'dim') {
            note.style.opacity = '0.45';
            if (word) word.style.opacity = '0.45';
          }
          const shadow = note.attachShadow({ mode: 'closed' });
          const compact = settings.annotationStyle === 'compact';
          const label = document.createElement(compact ? 'button' : 'span');
          label.textContent = compact ? '〔释义〕' : `〔${hit.entry.meaning}〕`;
          label.style.cssText = 'color:#17684a;font:0.85em/1.5 system-ui;overflow-wrap:anywhere';
          if (decorated) {
            note.style.display = 'none';
            const toggle = () => { note.style.display = note.style.display === 'none' ? '' : 'none'; };
            word.addEventListener('click', toggle);
            word.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
            });
            if (settings.annotationStyle === 'underline') {
              word.addEventListener('mouseenter', () => { note.style.display = ''; });
              word.addEventListener('mouseleave', () => { note.style.display = 'none'; });
            }
          }
          if (compact) {
            label.type = 'button';
            label.setAttribute('aria-label', `${hit.entry.term}：查看释义`);
            label.setAttribute('aria-expanded', 'false');
            label.style.cssText += ';min-height:44px;cursor:pointer';
            label.addEventListener('click', () => {
              const expanded = label.textContent === '〔释义〕';
              label.textContent = expanded ? `〔${hit.entry.meaning}〕` : '〔释义〕';
              label.setAttribute('aria-expanded', String(expanded));
            });
          }
          shadow.append(label);
          remainder.before(note);
          notes.add(note);
        }
      }
      if (next) {
        walker.currentNode = next;
        walker.previousNode();
        schedule(batch);
      } else if (document.defaultView?.MutationObserver) {
        observer = new document.defaultView.MutationObserver((records) => {
          for (const record of records) {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (!element || element.closest('[data-tm-host],[data-tm-note],[data-tm-control],[data-tm-translation]')) continue;
            if (record.type === 'childList') {
              const changed = [...record.addedNodes, ...record.removedNodes];
              if (changed.length && changed.every((node) => node.nodeType === 1
                && node.matches('[data-tm-host],[data-tm-note],[data-tm-control],[data-tm-translation]'))) continue;
            }
            dirtyRoots.add(record.type === 'attributes' ? element : element.closest('p,li,td,th,blockquote,div,section,article') || document.body);
          }
          if (!dirtyRoots.size) return;
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            let nextRoot = dirtyRoots.values().next().value;
            for (const candidate of dirtyRoots) {
              while (nextRoot !== document.body && !nextRoot.contains(candidate)) nextRoot = nextRoot.parentElement || document.body;
            }
            dirtyRoots.clear();
            refresh(entries, settings, settings.annotationFrequency === 'page' ? document.body : nextRoot);
          }, 250);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'contenteditable', 'translate'] });
      }
    }
    schedule(batch);
  }
  return { clear, refresh };
}
