import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const UI_MODULE = pathToFileURL(path.join(process.cwd(), "public/js/v2/ui.js")).href;

function createShellHarness() {
  let activeElement = null;
  const byId = new Map();
  const docListeners = new Map();

  class ClassList {
    constructor(el) {
      this.el = el;
    }
    _set() {
      this.el.className = [...this.el._classes].join(" ");
    }
    add(...names) {
      for (const n of names) this.el._classes.add(n);
      this._set();
    }
    remove(...names) {
      for (const n of names) this.el._classes.delete(n);
      this._set();
    }
    contains(name) {
      return this.el._classes.has(name);
    }
  }

  class FakeNode {
    constructor(tagName) {
      this.tagName = String(tagName || "").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this._classes = new Set();
      this.classList = new ClassList(this);
      this.className = "";
      this.id = "";
      this._listeners = new Map();
      this.disabled = false;
      this.ownerDocument = null;
      this._text = "";
    }
    setAttribute(name, value) {
      const key = String(name);
      const val = String(value);
      this.attributes.set(key, val);
      if (key === "id") {
        if (this.id && byId.get(this.id) === this) byId.delete(this.id);
        this.id = val;
        byId.set(val, this);
      }
      if (key === "class") {
        this.className = val;
        this._classes = new Set(val.split(/\s+/).filter(Boolean));
      }
    }
    getAttribute(name) {
      return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
    }
    removeAttribute(name) {
      this.attributes.delete(String(name));
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    dispatchEvent(event) {
      for (const fn of this._listeners.get(event.type) || []) fn(event);
      return true;
    }
    focus() {
      activeElement = this;
    }
    click() {
      this.dispatchEvent({ type: "click", target: this });
    }
    appendChild(child) {
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }
    querySelector(sel) {
      const all = [];
      const walk = (n) => {
        for (const c of n.children) {
          all.push(c);
          walk(c);
        }
      };
      walk(this);
      if (sel.startsWith("#")) return all.find((n) => n.id === sel.slice(1)) || null;
      return null;
    }
    set innerHTML(html) {
      this.children = [];
      this._text = String(html || "");
      // Lightweight parse: materialize elements that have ids we care about.
      const host = this;
      const re = /<(main|aside|nav|div|button|a|header|small|ul|li|p|span)([^>]*)>/gi;
      let m;
      while ((m = re.exec(this._text))) {
        const el = new FakeNode(m[1]);
        el.ownerDocument = host.ownerDocument;
        el.parentNode = host;
        const attrs = m[2] || "";
        for (const am of attrs.matchAll(/([:@a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g)) {
          const name = am[1];
          if (name === "/" || name.startsWith("/")) continue;
          el.setAttribute(name, am[2] ?? am[3] ?? "");
        }
        host.children.push(el);
        if (el.id) byId.set(el.id, el);
      }
    }
    get innerHTML() {
      return this._text;
    }
  }

  const body = new FakeNode("body");
  const document = {
    body,
    get activeElement() {
      return activeElement;
    },
    createElement(tag) {
      const el = new FakeNode(tag);
      el.ownerDocument = document;
      return el;
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of docListeners.get(event.type) || []) fn(event);
      return true;
    },
  };
  body.ownerDocument = document;
  activeElement = body;

  return {
    document,
    docListeners,
    setActive(el) {
      activeElement = el;
    },
  };
}

test("shell exposes skip link, main landmark, toast live region, and Admin v2 footer", async () => {
  globalThis.document = createShellHarness().document;
  const mod = await import(`${UI_MODULE}?shell=${Date.now()}`);
  const html = mod.shell({ active: "summary", email: "a@b.c" });
  assert.match(html, /class="sg-skip-link"/);
  assert.match(html, /href="#sg-page"/);
  assert.match(html, /Skip to main content/);
  assert.match(html, /<main class="sg-content" id="sg-page" tabindex="-1">/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, />Admin v2</);
  assert.doesNotMatch(html, /read-only preview/i);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-controls="sg-sidebar"/);
  assert.match(html, /aria-expanded="false"/);
});

test("only the active nav item receives aria-current=page", async () => {
  globalThis.document = createShellHarness().document;
  const mod = await import(`${UI_MODULE}?nav=${Date.now()}`);
  const html = mod.sidebar("orders");
  const matches = [...html.matchAll(/aria-current="page"/g)];
  assert.equal(matches.length, 1);
  assert.match(html, /href="\/admin-v2\/orders"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/admin-v2\/orders"/);
  assert.doesNotMatch(html, /href="\/admin-v2\/summary"[^>]*aria-current/);
});

test("initShellInteractions wires Escape once and restores focus to menu button", async () => {
  const harness = createShellHarness();
  globalThis.document = harness.document;
  const mod = await import(`${UI_MODULE}?shell-init=${Date.now()}-${Math.random()}`);

  const root = harness.document.createElement("div");
  root.id = "sg-root";
  harness.document.body.appendChild(root);
  root.innerHTML = mod.shell({ active: "summary", email: "x@y.z" });

  // Ensure ids are registered from parsed shell markup.
  assert.ok(harness.document.getElementById("sg-menu-btn"));
  assert.ok(harness.document.getElementById("sg-sidebar"));
  assert.ok(harness.document.getElementById("sg-overlay"));

  mod.initShellInteractions();
  const keyCount1 = (harness.docListeners.get("keydown") || []).length;
  mod.initShellInteractions();
  const keyCount2 = (harness.docListeners.get("keydown") || []).length;
  assert.equal(keyCount2, keyCount1, "document Escape listener must not stack");

  const menuBtn = harness.document.getElementById("sg-menu-btn");
  const sidebar = harness.document.getElementById("sg-sidebar");
  const overlay = harness.document.getElementById("sg-overlay");
  assert.equal(menuBtn.getAttribute("aria-expanded"), "false");

  menuBtn.click();
  assert.equal(sidebar.classList.contains("is-open"), true);
  assert.equal(overlay.classList.contains("is-open"), true);
  assert.equal(menuBtn.getAttribute("aria-expanded"), "true");

  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(sidebar.classList.contains("is-open"), false);
  assert.equal(menuBtn.getAttribute("aria-expanded"), "false");
  assert.equal(harness.document.activeElement, menuBtn);
});
