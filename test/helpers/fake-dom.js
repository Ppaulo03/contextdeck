'use strict';

// Minimal DOM and a loader that bundles a renderer module with esbuild (so its imports resolve exactly
// as in the real build) and runs it against that DOM. Enough for the components in src/renderer; it
// is intentionally not a browser: it models only what those components use.
const esbuild = require('esbuild');

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(' '); }
  add(...n) { const s = this._set(); n.forEach((x) => s.add(x)); this._write(s); }
  remove(...n) { const s = this._set(); n.forEach((x) => s.delete(x)); this._write(s); }
  contains(n) { return this._set().has(n); }
  toggle(n, force) { const on = force === undefined ? !this.contains(n) : Boolean(force); on ? this.add(n) : this.remove(n); return on; }
}

class El {
  constructor(tag, doc) {
    this.tag = tag; this.doc = doc; this.children = []; this.parent = null; this.attrs = {}; this.listeners = {};
    this.className = ''; this.id = ''; this._text = ''; this.hidden = false; this.disabled = false; this.title = ''; this.value = '';
    this.style = {}; this.dataset = {}; this.classList = new ClassList(this); this.offsetWidth = 260; this.offsetHeight = 100; this.focusCount = 0;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : (k === 'id' && this.id ? this.id : null); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  focus() { this.focusCount += 1; this.doc.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 100, top: 20, width: 200, height: 26 }; }
  querySelector(sel) { const all = this._all(); const cls = sel.replace(/^li\./, '').replace(/^\./, ''); return all.find((n) => n.classList.contains(cls)) || null; }
  _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
  async fire(type, event = {}) {
    const e = { type, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] || []) await fn(e);
    return e;
  }
}

function createDocument(ids) {
  const doc = { activeElement: null, listeners: {}, elements: {} };
  doc.createElement = (tag) => new El(tag, doc);
  doc.getElementById = (id) => doc.elements[id] || Object.values(doc.elements).flatMap((e) => e._all()).find((n) => n.id === id) || null;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn); };
  doc.fire = async (type, event = {}) => { const e = { type, target: doc, preventDefault() { this.defaultPrevented = true; }, ...event }; for (const fn of doc.listeners[type] || []) await fn(e); return e; };
  doc.documentElement = new El('html', doc);
  for (const id of ids) { const el = new El(id.includes('list') ? 'ul' : 'div', doc); el.id = id; doc.elements[id] = el; }
  return doc;
}

// Bundles `file` (with its imports) and returns its exports. `globals` become free variables.
function load(file, globals = {}) {
  const out = esbuild.buildSync({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'neutral', write: false, logLevel: 'silent', external: ['@xterm/*'] });
  const code = out.outputFiles[0].text;
  const module = { exports: {} };
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', ...names, code)(module, module.exports, ...names.map((n) => globals[n]));
  return module.exports;
}

module.exports = { El, createDocument, load };
