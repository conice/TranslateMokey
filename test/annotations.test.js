import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotator, isExcluded } from '../src/annotations.js';

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
      const element = nodeMethods({ nodeType: 1, dataset: {}, style: {}, closest: () => element });
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
    children, originals, annotator,
    flush() { let count = 0; while (jobs.length) { assert.ok(count++ < 1000, '批处理必须终止'); jobs.shift()(); } },
    notes: () => children.filter((node) => node.nodeType === 1),
  };
}

const entries = [{ term: 'robust', source: 'en', target: 'zh-cn', meaning: '<img onerror=alert(1)>' }];
const settings = { annotations: true, source: 'auto', target: 'zh-cn' };

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
