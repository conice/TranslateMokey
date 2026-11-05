import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotator, isExcluded } from '../src/annotations.js';
import { createDOM } from './dom.js';

function fixture(texts, excluded = false) {
  const children = [];
  const body = {
    closest: () => excluded ? body : null,
    append(child) { children.push(child); child.parentNode = body; child.parentElement = body; },
  };
  function nodeMethods(node) {
    Object.defineProperties(node, {
      isConnected: { get: () => node.parentNode === body },
      nextSibling: { get: () => children[children.indexOf(node) + 1] },
    });
    node.remove = () => {
      const index = children.indexOf(node);
      if (index >= 0) children.splice(index, 1);
      node.parentNode = null;
    };
    node.before = (other) => {
      children.splice(children.indexOf(node), 0, other);
      other.parentNode = body;
      other.parentElement = body;
    };
    return node;
  }
  function textNode(text) {
    const node = nodeMethods({ nodeType: 3, data: text });
    Object.defineProperty(node, 'textContent', { get: () => node.data });
    node.appendData = (data) => { node.data += data; };
    node.splitText = (offset) => {
      const tail = textNode(node.data.slice(offset));
      node.data = node.data.slice(0, offset);
      children.splice(children.indexOf(node) + 1, 0, tail);
      tail.parentNode = body;
      tail.parentElement = body;
      return tail;
    };
    return node;
  }
  const originals = texts.map(textNode);
  originals.forEach((node) => body.append(node));
  const document = {
    body,
    documentElement: { lang: 'en' },
    createElement() {
      const element = nodeMethods({ nodeType: 1, dataset: {}, style: {}, closest: () => element,
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, callback) { this[name] = callback; } });
      element.attachShadow = () => ({ append(label) { element.label = label; } });
      return element;
    },
    createTreeWalker(_root, _type, filter) {
      const walker = { currentNode: body };
      walker.nextNode = () => {
        for (let index = walker.currentNode === body ? 0 : children.indexOf(walker.currentNode) + 1; index < children.length; index += 1) {
          const node = children[index];
          if (node.nodeType === 3 && filter.acceptNode(node) === 1) { walker.currentNode = node; return node; }
        }
        return null;
      };
      walker.previousNode = () => {
        for (let index = children.indexOf(walker.currentNode) - 1; index >= 0; index -= 1) {
          const node = children[index];
          if (node.nodeType === 3 && filter.acceptNode(node) === 1) { walker.currentNode = node; return node; }
        }
        return null;
      };
      return walker;
    },
  };
  const jobs = [];
  const annotator = createAnnotator(document, (job) => jobs.push(job));
  return {
    children, originals, annotator, document,
    flush() { let count = 0; while (jobs.length) { assert.ok(count++ < 1000, '批处理必须终止'); jobs.shift()(); } },
    notes: () => children.filter((node) => node.nodeType === 1),
  };
}

const entries = [{ term: 'robust', source: 'en', target: 'zh-cn', meaning: '<img onerror=alert(1)>' }];
const settings = { annotations: true, source: 'auto', target: 'zh-cn' };

for (const annotationStyle of ['underline', 'highlight']) {
  test(`${annotationStyle} 装饰原词、点击显示纯文本卡片、关闭恢复节点身份`, () => {
    const { document } = createDOM();
    const paragraph = document.createElement('p');
    const original = document.createTextNode('A robust design.');
    paragraph.append(original);
    document.body.append(paragraph);
    const jobs = [];
    const annotator = createAnnotator(document, (job) => jobs.push(job));
    annotator.refresh(entries, { ...settings, annotationStyle });
    while (jobs.length) jobs.shift()();
    const marked = paragraph.querySelector('[data-tm-mark]');
    const note = paragraph.querySelector('[data-tm-note]');
    assert.equal(marked.textContent, 'robust');
    assert.equal(note.style.display, 'none');
    marked.click();
    assert.equal(note.style.display, '');
    assert.equal(note.label.textContent, '〔<img onerror=alert(1)>〕');
    annotator.clear();
    assert.deepEqual(paragraph.childNodes, [original]);
    assert.equal(original.textContent, 'A robust design.');
  });
}

test('动态标注局部刷新不重建未变化段落，译文与控件不触发重扫', async () => {
  const { document, scans } = createDOM();
  let callback;
  document.defaultView = { MutationObserver: class {
    constructor(handler) { this.handler = handler; }
    observe() { callback = this.handler; }
    disconnect() { callback = undefined; }
  } };
  const paragraphs = ['robust', 'plain'].map((text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    document.body.append(paragraph);
    return paragraph;
  });
  const jobs = [];
  const annotator = createAnnotator(document, (job) => jobs.push(job));
  annotator.refresh(entries, settings);
  while (jobs.length) jobs.shift()();
  const originalNote = paragraphs[0].querySelector('[data-tm-note]');
  scans.length = 0;
  paragraphs[1].firstChild.data = 'robust';
  callback([{ type: 'characterData', target: paragraphs[1].firstChild }]);
  await new Promise((resolve) => setTimeout(resolve, 280));
  while (jobs.length) jobs.shift()();
  assert.deepEqual(scans, [paragraphs[1]]);
  assert.equal(paragraphs[0].querySelector('[data-tm-note]'), originalNote);
  assert.ok(paragraphs[1].querySelector('[data-tm-note]'));
  scans.length = 0;
  const translation = document.createElement('span');
  translation.dataset.tmTranslation = '';
  callback([{ type: 'childList', target: paragraphs[0], addedNodes: [translation], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(scans.length, 0);
  annotator.clear();
});

test('已掌握词可隐藏、淡化或正常显示，变化后不残留旧标注', () => {
  const mastered = [{ ...entries[0], mastered: true }];
  for (const [masteredDisplay, expected] of [['hide', 0], ['dim', 1], ['show', 1]]) {
    const page = fixture(['robust']);
    page.annotator.refresh(mastered, { ...settings, masteredDisplay });
    page.flush();
    assert.equal(page.notes().length, expected);
    if (expected) assert.equal(page.notes()[0].style.opacity, masteredDisplay === 'dim' ? '0.45' : undefined);
    page.annotator.clear();
    assert.deepEqual(page.children, page.originals);
  }
});

test('紧凑样式点击展开纯文本释义并可恢复', () => {
  const page = fixture(['robust']);
  page.annotator.refresh(entries, { ...settings, annotationStyle: 'compact' });
  page.flush();
  const label = page.notes()[0].label;
  assert.equal(label.textContent, '〔释义〕');
  label.click();
  assert.equal(label.textContent, '〔<img onerror=alert(1)>〕');
  assert.equal(label['aria-expanded'], 'true');
  label.click();
  assert.equal(label.textContent, '〔释义〕');
  page.annotator.clear();
  assert.deepEqual(page.children, page.originals);
});

test('动态文本变化触发去抖刷新，关闭后断开观察器', async () => {
  const page = fixture(['plain']);
  let observe;
  let disconnected = 0;
  page.document.defaultView = { MutationObserver: class {
    constructor(callback) { observe = callback; }
    observe() {}
    disconnect() { disconnected += 1; }
  } };
  page.annotator.refresh(entries, settings);
  page.flush();
  page.originals[0].data = 'robust';
  observe([{ type: 'characterData', target: page.originals[0] }]);
  await new Promise((resolve) => setTimeout(resolve, 280));
  page.flush();
  assert.equal(page.notes().length, 1);
  page.annotator.clear();
  assert.ok(disconnected >= 2);
});

test('每页或每段首次按正向文本顺序计数，重复刷新保持稳定', () => {
  for (const annotationFrequency of ['page', 'paragraph']) {
    const page = fixture(['robust and robust', 'robust']);
    page.annotator.refresh(entries, { ...settings, annotationFrequency });
    page.flush();
    assert.equal(page.notes().length, 1);
    assert.equal(page.children[0].textContent, 'robust');
    page.annotator.refresh(entries, { ...settings, annotationFrequency });
    page.flush();
    assert.equal(page.notes().length, 1);
    page.annotator.clear();
    assert.deepEqual(page.children, page.originals);
  }
});

test('词后插入纯文本，关闭恢复原始文本节点身份', () => {
  const page = fixture(['A robust and robust design.']);
  page.annotator.refresh(entries, settings);
  page.flush();
  assert.equal(page.notes().length, 2);
  assert.equal(page.notes()[0].label.textContent, '〔<img onerror=alert(1)>〕');
  assert.equal(page.children.filter((node) => node.nodeType === 3).map((node) => node.data).join(''), 'A robust and robust design.');
  page.annotator.clear();
  assert.deepEqual(page.children, page.originals);
  assert.equal(page.originals[0].data, 'A robust and robust design.');
});

test('刷新不重复插入，关闭与代次切换取消旧批次', () => {
  const page = fixture(['robust']);
  page.annotator.refresh(entries, settings);
  page.annotator.refresh(entries, settings);
  page.flush();
  assert.equal(page.notes().length, 1);
  page.annotator.refresh(entries, settings);
  page.annotator.refresh(entries, { ...settings, annotations: false });
  page.flush();
  assert.equal(page.notes().length, 0);
  assert.equal(page.originals[0].data, 'robust');
});

test('批处理跨 100 节点边界不漏标且能够恢复', () => {
  const page = fixture(Array.from({ length: 205 }, () => 'robust'));
  page.annotator.refresh(entries, settings);
  page.flush();
  assert.equal(page.notes().length, 205);
  page.annotator.clear();
  assert.deepEqual(page.children, page.originals);
});

test('排除区域不扫描，缺失节点安全拒绝', () => {
  const page = fixture(['robust'], true);
  page.annotator.refresh(entries, settings);
  page.flush();
  assert.equal(page.notes().length, 0);
  assert.equal(isExcluded(null), true);
});

test('关闭时不覆盖网页在拆分文本上的新内容', () => {
  const page = fixture(['robust tail']);
  page.annotator.refresh(entries, settings);
  page.flush();
  page.children.at(-1).data = ' changed';
  page.annotator.clear();
  assert.equal(page.originals[0].data, 'robust changed');
});
