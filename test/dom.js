export function createDOM() {
  let body;
  class Node {
    constructor(tag, data = '') {
      this.tagName = tag.toUpperCase();
      this.nodeType = tag === '#text' ? 3 : 1;
      this.data = data;
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.childNodes = [];
      this.events = new Map();
      this.top = 0;
    }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get firstChild() { return this.childNodes[0]; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { return this === body || Boolean(this.parentNode?.isConnected); }
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1]; }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join(''); }
    set textContent(value) {
      if (this.nodeType === 3) this.data = value;
      else { for (const node of [...this.childNodes]) node.remove(); this.append(new Node('#text', value)); }
    }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); }
    }
    before(node) {
      const parent = this.parentNode;
      if (!parent) return;
      node.remove();
      parent.childNodes.splice(parent.childNodes.indexOf(this), 0, node);
      node.parentNode = parent;
    }
    remove() {
      if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some((part) => {
        if (part === '[contenteditable]:not([contenteditable="false"])') return this.attributes.contenteditable !== undefined && this.attributes.contenteditable !== 'false';
        const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!attribute) return this.tagName.toLowerCase() === part;
        const name = attribute[1];
        const value = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] : this.attributes[name];
        return value !== undefined && (attribute[2] === undefined || value === attribute[2]);
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelector(selector) { return this.children.find((node) => node.matches(selector)) || this.children.map((node) => node.querySelector(selector)).find(Boolean) || null; }
    querySelectorAll(selector) { return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    click(trusted = true) { this.events.get('click')?.({ isTrusted: trusted }); }
    attachShadow() { this.shadow = new Node('shadow'); return this.shadow; }
    get label() { return this.shadow?.firstChild; }
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 50, width: 500, height: 50 }; }
    appendData(data) { this.data += data; }
    splitText(offset) {
      const tail = new Node('#text', this.data.slice(offset));
      this.data = this.data.slice(0, offset);
      const next = this.nextSibling;
      if (next) next.before(tail); else this.parentNode.append(tail);
      return tail;
    }
  }
  body = new Node('body');
  const scans = [];
  const document = {
    body, documentElement: { lang: 'en' },
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new Node('#text', text),
    createTreeWalker(root, type, filter) {
      scans.push(root);
      function nodes() {
        const found = [];
        function visit(node) {
          for (const child of node.childNodes) {
            if (child.nodeType === 3 && (!filter || filter.acceptNode(child) === 1)) found.push(child);
            visit(child);
          }
        }
        visit(root);
        return found;
      }
      return { currentNode: root,
        nextNode() { const all = nodes(); const next = all[this.currentNode === root ? 0 : all.indexOf(this.currentNode) + 1]; if (next) this.currentNode = next; return next || null; },
        previousNode() { const all = nodes(); const previous = all[all.indexOf(this.currentNode) - 1]; if (previous) this.currentNode = previous; return previous || null; },
      };
    },
  };
  return { document, scans };
}
