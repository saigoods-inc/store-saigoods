import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const UI_MODULE = pathToFileURL(path.join(process.cwd(), "public/js/v2/ui.js")).href;

/** Minimal DOM harness — no dependency; enough to exercise drawer open/close at runtime. */
function createDomHarness() {
  let activeElement = null;
  const byId = new Map();
  const docListeners = new Map();

  class ClassList {
    constructor(el) {
      this.el = el;
    }
    _set() {
      const names = [...this.el._classes];
      this.el.className = names.join(" ");
      if (names.length) this.el.attributes.set("class", this.el.className);
      else this.el.attributes.delete("class");
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
      this._hidden = false;
      this._inert = false;
      this.disabled = false;
      this._text = "";
      this.ownerDocument = null;
    }

    get isConnected() {
      let n = this;
      while (n) {
        const doc = this.ownerDocument;
        if (doc && (n === doc.body || n === doc.documentElement || n === doc)) return true;
        n = n.parentNode;
      }
      return false;
    }

    get parentElement() {
      const p = this.parentNode;
      if (!p || !p.tagName) return null;
      return p;
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
      if (key === "hidden") this._hidden = true;
    }

    getAttribute(name) {
      const key = String(name);
      if (!this.attributes.has(key)) return null;
      return this.attributes.get(key);
    }

    removeAttribute(name) {
      const key = String(name);
      this.attributes.delete(key);
      if (key === "hidden") this._hidden = false;
      if (key === "id" && this.id) {
        if (byId.get(this.id) === this) byId.delete(this.id);
        this.id = "";
      }
    }

    hasAttribute(name) {
      return this.attributes.has(String(name));
    }

    get hidden() {
      return this._hidden || this.attributes.has("hidden");
    }

    set hidden(value) {
      this._hidden = Boolean(value);
      if (this._hidden) this.attributes.set("hidden", "");
      else this.attributes.delete("hidden");
    }

    get inert() {
      return this._inert || this.attributes.has("inert");
    }

    set inert(value) {
      this._inert = Boolean(value);
      if (this._inert) this.attributes.set("inert", "");
      else this.attributes.delete("inert");
    }

    appendChild(child) {
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }

    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    dispatchEvent(event) {
      const list = this._listeners.get(event.type) || [];
      for (const fn of list) fn(event);
      return true;
    }

    focus() {
      // Mirror browser-ish focusing: skip the element itself when hidden/inert/disabled.
      // Ancestor visibility is enforced by the production focus-trap filter, not focus().
      if (this.disabled || this.hidden || this.inert) return;
      activeElement = this;
    }

    click() {
      this.dispatchEvent({ type: "click", target: this });
    }

    querySelector(sel) {
      const all = [];
      const walk = (node) => {
        for (const c of node.children) {
          all.push(c);
          walk(c);
        }
      };
      walk(this);
      if (sel.startsWith("#")) {
        const id = sel.slice(1);
        return all.find((n) => n.id === id) || null;
      }
      return null;
    }

    querySelectorAll(sel) {
      const all = [];
      const walk = (node) => {
        for (const c of node.children) {
          all.push(c);
          walk(c);
        }
      };
      walk(this);
      if (sel.includes("button") || sel.includes("a[href]") || sel.includes("input") || sel.includes("[tabindex]")) {
        return all.filter((n) => {
          const tag = n.tagName;
          if (tag === "BUTTON" && !n.disabled) return true;
          if (tag === "A" && n.getAttribute("href")) return true;
          if (tag === "INPUT" && !n.disabled) return true;
          if (tag === "SELECT" && !n.disabled) return true;
          if (tag === "TEXTAREA" && !n.disabled) return true;
          const tab = n.getAttribute("tabindex");
          if (tab != null && tab !== "-1") return true;
          return false;
        });
      }
      return all;
    }

    contains(node) {
      let n = node;
      while (n) {
        if (n === this) return true;
        n = n.parentNode;
      }
      return false;
    }

    set innerHTML(html) {
      this.children = [];
      this._text = String(html || "");
      // Parse only structural/interactive tags — skip SVG internals (line/path/etc).
      const re = /<(main|aside|nav|div|button|a|header|h[1-6]|small|ul|li|p|span|input|select|textarea)([^>]*)>/gi;
      let m;
      while ((m = re.exec(this._text))) {
        const el = new FakeNode(m[1]);
        el.ownerDocument = this.ownerDocument;
        el.parentNode = this;
        const attrs = m[2] || "";
        for (const am of attrs.matchAll(/([:@a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g)) {
          const name = am[1];
          if (name === "/" || name.startsWith("/")) continue;
          const value = am[2] ?? am[3] ?? "";
          el.setAttribute(name, value);
        }
        this.children.push(el);
        if (el.id) byId.set(el.id, el);
      }
    }

    get innerHTML() {
      return this._text;
    }
  }

  const body = new FakeNode("body");
  const documentElement = new FakeNode("html");

  const document = {
    body,
    documentElement,
    get activeElement() {
      return activeElement;
    },
    set activeElement(el) {
      activeElement = el;
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
      const list = docListeners.get(event.type) || [];
      for (const fn of list) fn(event);
      return true;
    },
  };

  body.ownerDocument = document;
  documentElement.ownerDocument = document;
  documentElement.appendChild(body);
  activeElement = body;

  return {
    document,
    FakeNode,
    setActive(el) {
      activeElement = el;
    },
    assertClosed(aside, overlay) {
      assert.equal(aside.hidden, true, "drawer should be hidden when closed");
      assert.equal(aside.getAttribute("aria-hidden"), "true");
      assert.equal(aside.inert, true);
      assert.equal(aside.classList.contains("is-open"), false);
      assert.equal(overlay.hidden, true);
      assert.equal(overlay.classList.contains("is-open"), false);
    },
    assertOpen(aside, overlay) {
      assert.equal(aside.hidden, false, "drawer should not be hidden when open");
      assert.equal(aside.getAttribute("aria-hidden"), null);
      assert.equal(aside.inert, false);
      assert.equal(aside.classList.contains("is-open"), true);
      assert.equal(overlay.hidden, false);
      assert.equal(overlay.classList.contains("is-open"), true);
    },
  };
}

async function loadDrawerApi(harness) {
  globalThis.document = harness.document;
  const mod = await import(`${UI_MODULE}?drawer-a11y=${Date.now()}-${Math.random()}`);
  return mod;
}

test("closeDrawer before first open is harmless", async () => {
  const harness = createDomHarness();
  const { closeDrawer } = await loadDrawerApi(harness);
  assert.doesNotThrow(() => closeDrawer());
  assert.equal(harness.document.getElementById("sg-drawer"), null);
});

test("newly created drawer is closed / not exposed before open finishes applying open state", async () => {
  const harness = createDomHarness();
  const seen = [];
  const origAppend = harness.document.body.appendChild.bind(harness.document.body);
  harness.document.body.appendChild = (child) => {
    if (child.id === "sg-drawer") {
      seen.push({
        hidden: child.hidden,
        ariaHidden: child.getAttribute("aria-hidden"),
        inert: child.inert,
        role: child.getAttribute("role"),
        isOpen: child.classList.contains("is-open"),
      });
    }
    return origAppend(child);
  };

  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);
  openDrawer({ title: "A", bodyHtml: `<a href="/x">link</a>` });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hidden, true);
  assert.equal(seen[0].ariaHidden, "true");
  assert.equal(seen[0].inert, true);
  assert.equal(seen[0].role, "dialog");
  assert.equal(seen[0].isOpen, false);

  closeDrawer();
  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertClosed(aside, overlay);
});

test("openDrawer reveals dialog, focuses Close; close restores opener", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  trigger.id = "opener";
  trigger.setAttribute("type", "button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({ title: "Order 1", bodyHtml: `<p>detail</p><a href="/orders/1">View</a>` });

  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertOpen(aside, overlay);
  assert.match(aside.getAttribute("aria-labelledby") || "", /sg-drawer-title/);
  assert.match(aside.innerHTML, /id="sg-drawer-title"/);
  assert.match(aside.innerHTML, /Order 1/);
  assert.match(aside.innerHTML, /View/);

  const closeBtn = aside.querySelector("#sg-drawer-close");
  assert.ok(closeBtn);
  assert.equal(harness.document.activeElement, closeBtn);

  closeBtn.click();
  harness.assertClosed(aside, overlay);
  assert.equal(harness.document.activeElement, trigger);
  assert.match(aside.innerHTML, /View/, "close must not erase drawer content");
});

test("overlay click and Escape use the same close path", async () => {
  const harness = createDomHarness();
  const { openDrawer } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({ title: "Overlay path", bodyHtml: `<span>body</span>` });
  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertOpen(aside, overlay);

  overlay.click();
  harness.assertClosed(aside, overlay);
  assert.equal(harness.document.activeElement, trigger);

  harness.setActive(trigger);
  openDrawer({ title: "Escape path", bodyHtml: `<span>esc</span>` });
  harness.assertOpen(aside, overlay);
  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertClosed(aside, overlay);
  assert.equal(harness.document.activeElement, trigger);
});

test("repeated close is harmless; reopen works with fresh title/body", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({ title: "First", bodyHtml: `<p id="first-body">one</p>` });
  closeDrawer();
  assert.doesNotThrow(() => closeDrawer());
  assert.doesNotThrow(() => closeDrawer());

  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertClosed(aside, overlay);

  harness.setActive(trigger);
  openDrawer({ title: "Second", bodyHtml: `<p id="second-body">two</p>` });
  harness.assertOpen(aside, overlay);
  assert.equal(aside.getAttribute("aria-labelledby"), "sg-drawer-title");
  assert.match(aside.innerHTML, /Second/);
  assert.match(aside.innerHTML, /id="second-body"/);
  assert.match(aside.innerHTML, />two</);
  assert.doesNotMatch(aside.innerHTML, /id="first-body"/);
  assert.equal(harness.document.activeElement, aside.querySelector("#sg-drawer-close"));
});

test("disconnected opener does not throw during focus restoration", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({ title: "Gone", bodyHtml: `<p>x</p>` });
  harness.document.body.removeChild(trigger);
  assert.equal(trigger.isConnected, false);
  assert.doesNotThrow(() => closeDrawer());

  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertClosed(aside, overlay);
});

test("openDrawer uses aria-labelledby on the title id", async () => {
  const harness = createDomHarness();
  const { openDrawer } = await loadDrawerApi(harness);
  openDrawer({ title: "Labeled", bodyHtml: `<button type="button" id="inner-a">A</button>` });
  const aside = harness.document.getElementById("sg-drawer");
  assert.equal(aside.getAttribute("aria-modal"), "true");
  assert.equal(aside.getAttribute("aria-labelledby"), "sg-drawer-title");
  assert.match(aside.innerHTML, /id="sg-drawer-title"/);
  assert.equal(aside.getAttribute("aria-label"), null);
});

test("Tab cycles final to first; Shift+Tab cycles first to final", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);

  openDrawer({
    title: "Trap",
    bodyHtml: `<button type="button" id="inner-a">A</button><button type="button" id="inner-b">B</button>`,
  });
  const aside = harness.document.getElementById("sg-drawer");
  const closeBtn = aside.querySelector("#sg-drawer-close");
  const a = aside.querySelector("#inner-a");
  const b = aside.querySelector("#inner-b");
  assert.ok(closeBtn && a && b);

  // Focus order from querySelectorAll: close, a, b (document order in parsed HTML).
  harness.setActive(b);
  harness.document.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: false, preventDefault() { this._pd = true; } });
  // After Tab from last, first (close) should receive focus via trap
  assert.equal(harness.document.activeElement, closeBtn);

  harness.setActive(closeBtn);
  const shiftEv = { type: "keydown", key: "Tab", shiftKey: true, preventDefault() { this._pd = true; } };
  harness.document.dispatchEvent(shiftEv);
  assert.equal(harness.document.activeElement, b);

  closeDrawer();
  harness.assertClosed(aside, harness.document.getElementById("sg-drawer-overlay"));
});

test("focus trap skips hidden/aria-hidden/inert ancestors and re-evaluates on each Tab", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  trigger.id = "opener-dyn";
  trigger.setAttribute("type", "button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({
    title: "Dynamic hide",
    bodyHtml: `<button type="button" id="first-visible">First</button><button type="button" id="final-visible">Final</button>`,
  });
  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  const closeBtn = aside.querySelector("#sg-drawer-close");
  const firstVisible = aside.querySelector("#first-visible");
  const finalVisible = aside.querySelector("#final-visible");
  assert.ok(closeBtn && firstVisible && finalVisible);
  harness.assertOpen(aside, overlay);

  function appendWrappedButton(wrapId, btnId, mode) {
    const wrap = harness.document.createElement("div");
    wrap.id = wrapId;
    if (mode === "hidden") wrap.hidden = true;
    if (mode === "aria") wrap.setAttribute("aria-hidden", "true");
    if (mode === "inert") wrap.inert = true;
    const btn = harness.document.createElement("button");
    btn.id = btnId;
    btn.setAttribute("type", "button");
    wrap.appendChild(btn);
    // Append after existing visible controls so revealed buttons become eligible
    // after final-visible in document order (production filters on each Tab).
    aside.appendChild(wrap);
    return { wrap, btn };
  }

  const hidden = appendWrappedButton("hidden-wrap", "hidden-btn", "hidden");
  const ariaH = appendWrappedButton("aria-wrap", "aria-btn", "aria");
  const inertW = appendWrappedButton("inert-wrap", "inert-btn", "inert");

  const tab = (shiftKey = false) => {
    harness.document.dispatchEvent({
      type: "keydown",
      key: "Tab",
      shiftKey,
      preventDefault() {
        this._pd = true;
      },
    });
  };

  // Trap bookends among *currently* visible controls: Close … Final
  harness.setActive(finalVisible);
  tab(false);
  assert.equal(harness.document.activeElement, closeBtn, "Tab from final visible cycles to first visible (Close)");
  assert.notEqual(harness.document.activeElement, hidden.btn);
  assert.notEqual(harness.document.activeElement, ariaH.btn);
  assert.notEqual(harness.document.activeElement, inertW.btn);

  harness.setActive(closeBtn);
  tab(true);
  assert.equal(harness.document.activeElement, finalVisible, "Shift+Tab from first visible cycles to final visible");
  assert.notEqual(harness.document.activeElement, hidden.btn);
  assert.notEqual(harness.document.activeElement, ariaH.btn);
  assert.notEqual(harness.document.activeElement, inertW.btn);

  // Reveal hidden wrapper — re-evaluated on next Tab; new last becomes the revealed control.
  hidden.wrap.hidden = false;
  harness.setActive(closeBtn);
  tab(true);
  assert.equal(harness.document.activeElement, hidden.btn, "removing hidden makes button eligible on next Tab");
  assert.notEqual(harness.document.activeElement, ariaH.btn);
  assert.notEqual(harness.document.activeElement, inertW.btn);

  // Reveal aria-hidden wrapper.
  ariaH.wrap.removeAttribute("aria-hidden");
  harness.setActive(closeBtn);
  tab(true);
  assert.equal(harness.document.activeElement, ariaH.btn, "removing aria-hidden makes button eligible on next Tab");
  assert.notEqual(harness.document.activeElement, inertW.btn);

  // Reveal inert wrapper.
  inertW.wrap.inert = false;
  harness.setActive(closeBtn);
  tab(true);
  assert.equal(harness.document.activeElement, inertW.btn, "removing inert makes button eligible on next Tab");

  // Last visible is now inert button; Tab cycles to Close.
  harness.setActive(inertW.btn);
  tab(false);
  assert.equal(harness.document.activeElement, closeBtn);

  // Close / reopen must not stack handlers; Escape still closes once.
  closeDrawer();
  harness.assertClosed(aside, overlay);
  assert.equal(harness.document.activeElement, trigger);

  harness.setActive(trigger);
  openDrawer({
    title: "Dynamic hide again",
    bodyHtml: `<button type="button" id="first-visible">First</button><button type="button" id="final-visible">Final</button>`,
  });
  harness.assertOpen(aside, overlay);
  const final2 = aside.querySelector("#final-visible");
  harness.setActive(final2);
  tab(false);
  assert.equal(harness.document.activeElement, aside.querySelector("#sg-drawer-close"));
  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertClosed(aside, overlay);
  // Second Escape while closed is harmless (no stack reopen).
  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertClosed(aside, overlay);
});

test("setDrawerCloseGuard blocks Escape/overlay/Close until cleared", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer, setDrawerCloseGuard } = await loadDrawerApi(harness);

  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  let block = true;
  setDrawerCloseGuard(() => (block ? false : true));
  openDrawer({ title: "Guarded", bodyHtml: `<p>x</p>` });
  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertOpen(aside, overlay);

  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertOpen(aside, overlay);
  overlay.click();
  harness.assertOpen(aside, overlay);
  aside.querySelector("#sg-drawer-close").click();
  harness.assertOpen(aside, overlay);

  block = false;
  setDrawerCloseGuard(null);
  closeDrawer({ force: true });
  harness.assertClosed(aside, overlay);
});

test("reopen does not stack key handlers; single Escape closes once", async () => {
  const harness = createDomHarness();
  const { openDrawer, closeDrawer } = await loadDrawerApi(harness);
  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  harness.setActive(trigger);

  openDrawer({ title: "One", bodyHtml: `<p>1</p>` });
  closeDrawer();
  openDrawer({ title: "Two", bodyHtml: `<p>2</p>` });
  const aside = harness.document.getElementById("sg-drawer");
  const overlay = harness.document.getElementById("sg-drawer-overlay");
  harness.assertOpen(aside, overlay);
  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertClosed(aside, overlay);
  // Second Escape while closed is harmless
  harness.document.dispatchEvent({ type: "keydown", key: "Escape" });
  harness.assertClosed(aside, overlay);
});
