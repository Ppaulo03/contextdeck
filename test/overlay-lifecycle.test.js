'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// main/overlay.js is one of the few modules allowed to require('electron'); load it against a fake.
function loadOverlay() {
  const created = [];
  class FakeView {
    constructor() {
      this.closed = false;
      this.webContents = {
        isDestroyed: () => this.closed,
        setWindowOpenHandler() {}, on() {}, send() {}, focus() {},
        loadFile: async () => {},
        close: () => { this.closed = true; }
      };
      created.push(this);
    }
    setBackgroundColor() {}
    setBounds() {}
  }
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { WebContentsView: FakeView };
    return original.call(this, request, ...rest);
  };
  const file = path.join(__dirname, '..', 'src', 'main', 'overlay.js');
  delete require.cache[file];
  try { return { ...require(file), created }; } finally { Module._load = original; }
}

function fakeWindow() {
  const children = new Set();
  return {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 800, height: 600 }),
    contentView: { addChildView: (v) => children.add(v), removeChildView: (v) => children.delete(v) },
    webContents: { focus() {} },
    children
  };
}

test('overlay renderer is released after idle and recreated on demand', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createOverlay, created } = loadOverlay();
  const win = fakeWindow();
  const overlay = createOverlay({ getWindow: () => win, preloadPath: 'p', html: 'h', onBeforeInput() {} });

  await overlay.show({});
  assert.equal(created.length, 1);
  overlay.hide();
  t.mock.timers.tick(29000);
  assert.equal(created[0].closed, false, 'kept while recently used');

  await overlay.show({});                      // reopened in time: same view, timer cancelled
  t.mock.timers.tick(60000);
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false, 'never released while open');

  overlay.hide();
  t.mock.timers.tick(30000);
  assert.equal(created[0].closed, true, 'released after the idle period');

  await overlay.show({});
  assert.equal(created.length, 2, 'a fresh view is created on the next open');
  assert.equal(win.children.size, 1);
  overlay.destroy();
  assert.equal(created[1].closed, true);
});
