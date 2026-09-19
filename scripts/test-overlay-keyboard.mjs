// Actual overlay functions and keyboard dispatcher, with synthetic DOM nodes.
// Exercises focus transitions and key ownership without credentials or data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('let modalFocusState ='), source.indexOf('function openMenu('));
const keyboard = source.slice(source.indexOf("document.addEventListener('keydown'", source.indexOf('/* ------------------------------- keyboard')),
  source.indexOf("window.addEventListener('beforeunload'"));

function fixture() {
  const listeners = new Map(), timers = [];
  const document = { activeElement: null,
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)); },
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    contains(node) { return this.body.contains(node); },
  };
  class Node {
    constructor(tag = 'button', { cls = '', data = {}, disabled = false, text = '', id = '' } = {}) {
      Object.assign(this, { tagName: tag.toUpperCase(), className: cls, dataset: data, disabled, textContent: text, id,
        children: [], parent: null, attrs: {}, events: {}, style: {}, isConnected: false, offsetParent: {},
        tabIndex: ['button', 'input', 'textarea', 'a', 'summary'].includes(tag) ? 0 : -1,
        offsetWidth: 200, offsetHeight: 150, scrolls: 0 });
      this.classList = { contains: (name) => this.className.split(' ').includes(name), add: (name) => { this.className += ' ' + name; } };
    }
    appendChild(node) { this.children.push(node); node.parent = this; node.connect(this.isConnected); return node; }
    connect(value) { this.isConnected = value; this.children.forEach((child) => child.connect(value)); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.connect(false); }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    matches(selector) { return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
      if (part === '[data-m]') return 'm' in this.dataset;
      if (part === '[tabindex]') return 'tabindex' in this.attrs;
      if (part === '[contenteditable="true"]') return false;
      if (part === 'a[href]') return this.tagName === 'A' && 'href' in this.attrs;
      if (part === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
      return this.tagName === part.toUpperCase();
    }); }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'tabindex') this.tabIndex = Number(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    focus() { document.activeElement = this; for (const fn of [...(listeners.get('focusin') || [])]) fn({ target: this }); }
    scrollIntoView() { this.scrolls++; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    getBoundingClientRect() { return this.rect || { left: 30, top: 25, bottom: 45 }; }
  }
  document.body = new Node('body'); document.body.connect(true); document.activeElement = document.body;
  const context = vm.createContext({ Store: { me: () => ({ email: 'member@example.com' }), isAdmin: () => false }, document, window: { addEventListener() {}, removeEventListener() {} }, UI: { modal: null, editor: null, menu: null },
    innerWidth: 800, innerHeight: 600,
    $: (selector) => document.querySelector(selector), $$: (selector) => document.querySelectorAll(selector),
    setTimeout(fn) { timers.push(fn); }, render() {}, nav() {}, route() {},
    edFindOpen() { throw new Error('Editor find stole dialog focus'); },
    edSave() { throw new Error('Editor save ran behind dialog'); },
  });
  vm.runInContext(helpers + keyboard, context);
  const run = (code) => vm.runInContext(code, context);
  const node = (tag, options, parent = document.body) => parent.appendChild(new Node(tag, options));
  const key = (value, target = document.activeElement, options = {}) => {
    const event = { key: value, target, defaultPrevented: false, stopped: false, ...options,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (let ancestor = target; ancestor && !event.stopped; ancestor = ancestor.parent) {
      for (const fn of ancestor.events.keydown || []) fn(event);
    }
    if (!event.stopped) for (const fn of listeners.get('keydown') || []) fn(event);
    return event;
  };
  return { run, context, document, node, key, timers, listeners };
}

// An application detail / destructive confirm has no enabled primary button.
// It still receives initial focus, traps both Tab directions and declares a modal.
{
  const f = fixture();
  const opener = f.node('button', { data: { action: 'interest-open', id: 'synthetic' } }); opener.focus();
  f.context.UI.modal = { kind: 'interest-row' }; f.run('captureModalFocus()');
  const dialog = f.node('div', { cls: 'modal' });
  const close = f.node('button', { data: { action: 'modal-close' } }, dialog);
  const disabled = f.node('button', { cls: 'btn--primary', disabled: true }, dialog);
  const download = f.node('a', {}, dialog); download.setAttribute('href', '/synthetic');
  f.run('mountModalFocus()');
  assert.equal(f.document.activeElement, close);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  download.focus(); assert.equal(f.key('Tab').defaultPrevented, true); assert.equal(f.document.activeElement, close);
  close.focus(); f.key('Tab', close, { shiftKey: true }); assert.equal(f.document.activeElement, download);
  opener.focus(); f.key('Tab', opener, { shiftKey: true }); assert.equal(f.document.activeElement, download, 'reverse Tab recaptures escaped focus');
  assert.notEqual(f.document.activeElement, disabled);
}

// Dialog re-renders preserve the active field and selection; closing restores
// its equivalent trigger after the old shell has been replaced.
{
  const f = fixture();
  const opener = f.node('button', { data: { action: 'user-menu' } }); opener.focus();
  f.context.UI.modal = { kind: 'profile' }; f.run('captureModalFocus()');
  const firstDialog = f.node('div', { cls: 'modal' });
  const field = f.node('input', { data: { m: 'pname' } }, firstDialog);
  field.setSelectionRange(2, 4); field.focus(); f.run('captureModalFocus()');
  firstDialog.remove(); opener.remove();
  const nextOpener = f.node('button', { data: { action: 'user-menu' } });
  const nextDialog = f.node('div', { cls: 'modal' });
  const nextField = f.node('input', { data: { m: 'pname' } }, nextDialog);
  f.run('mountModalFocus()');
  assert.equal(f.document.activeElement, nextField); assert.deepEqual([nextField.selectionStart, nextField.selectionEnd], [2, 4]);
  const event = f.key('Escape');
  assert.equal(event.defaultPrevented, true); assert.equal(f.context.UI.modal, null);
  assert.equal(f.document.activeElement, nextOpener);
}

// A modal without controls itself receives and keeps focus.
{
  const f = fixture(); f.context.UI.modal = { kind: 'synthetic-empty' };
  f.run('captureModalFocus()'); const dialog = f.node('div', { cls: 'modal' });
  f.run('mountModalFocus()'); assert.equal(f.document.activeElement, dialog);
  assert.equal(f.key('Tab').defaultPrevented, true); assert.equal(f.document.activeElement, dialog);
}

// A menu in a dialog owns its navigation; Tab dismisses into dialog order and
// Escape dismisses only the menu. Disabled items are skipped and long menus scroll.
{
  const f = fixture(); f.context.UI.modal = { kind: 'new-page' };
  const dialog = f.node('div', { cls: 'modal' });
  const anchor = f.node('button', { data: { action: 'dd' } }, dialog);
  const last = f.node('button', { data: { action: 'modal-close' } }, dialog);
  const host = f.node('div'); host.remove();
  const first = f.node('button', {}, host); f.node('button', { disabled: true }, host); const end = f.node('button', {}, host);
  f.context.host = host; f.context.anchor = anchor;
  f.context.UI.menu = {}; f.run('mountMenu(host, anchor)');
  assert.equal(f.document.activeElement, first); assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  f.key('ArrowDown'); assert.equal(f.document.activeElement, end); assert.equal(end.scrolls, 1);
  f.key('Home'); assert.equal(f.document.activeElement, first);
  f.key('End'); assert.equal(f.document.activeElement, end);
  f.key('Escape'); assert.equal(f.context.UI.menu, null); assert.ok(f.context.UI.modal); assert.equal(f.document.activeElement, anchor);
  f.context.UI.menu = {}; f.run('mountMenu(host, anchor)');
  const event = f.key('Tab'); assert.equal(f.context.UI.menu, null); assert.equal(f.document.activeElement, anchor);
  assert.equal(event.defaultPrevented, false, 'normal Tab continues from the trigger');
  last.focus(); f.key('Tab'); assert.equal(f.document.activeElement, anchor);
}

// Outside focus is not stolen; outside clicks close; repeat close is harmless.
{
  const f = fixture(); const anchor = f.node('button'); const host = f.node('div'); host.remove(); f.node('button', {}, host);
  f.context.host = host; f.context.anchor = anchor; f.context.UI.menu = {};
  f.run('savedClose = mountMenu(host, anchor)'); const elsewhere = f.node('input'); elsewhere.focus();
  assert.equal(f.context.UI.menu, null); assert.equal(f.document.activeElement, elsewhere);
  f.run('savedClose()'); assert.equal(f.document.activeElement, elsewhere);
  f.context.UI.menu = {}; f.run('mountMenu(host, anchor)');
  for (const handler of [...f.listeners.get('pointerdown')]) handler({ target: elsewhere });
  assert.equal(f.context.UI.menu, null); assert.equal(host.isConnected, false);
}

// Short, narrow viewports cannot place a menu at negative coordinates.
{
  const f = fixture(); const anchor = f.node('button'); anchor.rect = { left: -20, top: 18, bottom: 38 };
  const host = f.node('div'); host.remove(); f.node('button', {}, host); host.offsetHeight = 250;
  f.context.host = host; f.context.anchor = anchor; f.context.innerHeight = 220; f.context.innerWidth = 180;
  f.context.UI.menu = {}; f.run('mountMenu(host, anchor)');
  assert.equal(host.style.left, '10px'); assert.equal(host.style.top, '10px');
}

// Opening a conflict/close dialog over the editor blocks editor shortcuts.
{
  const f = fixture(); f.context.UI.editor = {}; f.context.UI.modal = { kind: 'conflict' };
  const dialog = f.node('div', { cls: 'modal' }); const cancel = f.node('button', {}, dialog); cancel.focus();
  f.key('f', cancel, { ctrlKey: true }); f.key('s', cancel, { metaKey: true });
  assert.equal(f.document.activeElement, cancel);
}

// Exit callbacks cannot leave an invisible veil or close a newer dialog.
{
  const f = fixture(); const closing = { kind: 'confirm' }; f.context.UI.modal = closing;
  const veil = f.node('div', { cls: 'modal-veil' });
  f.context.calls = 0; f.run('closeModal(() => { calls++; })');
  f.timers.shift()();
  assert.equal(veil.isConnected, false, 'veil removed even when callback never renders');
  assert.equal(f.context.calls, 1); assert.equal(f.context.UI.modal, null);
}
{
  const f = fixture(); f.context.UI.modal = { kind: 'profile' };
  const veil = f.node('div', { cls: 'modal-veil' });
  f.context.calls = 0; f.run('closeModal(() => { calls++; })');
  const newer = { kind: 'new-page' }; f.context.UI.modal = newer;
  f.timers.shift()();
  assert.equal(f.context.UI.modal, newer); assert.equal(f.context.calls, 0);
  assert.equal(veil.isConnected, false);
}
// Save-dialog shortcuts do not hijack a focused disclosure or Cancel button.
{
  const f = fixture(); f.context.UI.editor = {}; f.context.UI.modal = { kind: 'save-summary' };
  const dialog = f.node('div', { cls: 'modal' });
  const cancel = f.node('button', { data: { action: 'modal-close' } }, dialog); cancel.focus();
  assert.equal(f.key('Enter').defaultPrevented, false);
  const disclosure = f.node('summary', {}, dialog); disclosure.focus();
  assert.equal(f.key('Enter').defaultPrevented, false);
  f.key('Escape', disclosure, { isComposing: true }); assert.ok(f.context.UI.modal);
}
// A popup stays open while scrolling its own content, closes when its anchor moves.
{
  const f = fixture(); const anchor = f.node('button'); const host = f.node('div'); host.remove(); f.node('button', {}, host);
  f.context.host = host; f.context.anchor = anchor; f.context.UI.menu = {};
  f.run('mountMenu(host, anchor)');
  for (const fn of [...f.listeners.get('pointerdown')]) fn({ target: anchor });
  assert.ok(f.context.UI.menu, 'pointerdown on trigger leaves toggle ownership to click');
  for (const fn of [...f.listeners.get('scroll')]) fn({ target: host });
  assert.ok(f.context.UI.menu);
  for (const fn of [...f.listeners.get('scroll')]) fn({ target: f.document.body });
  assert.equal(f.context.UI.menu, null);
}

console.log('overlay keyboard tests passed: dialog focus/restore/traps, popup dismissal/navigation/bounds, editor isolation');
