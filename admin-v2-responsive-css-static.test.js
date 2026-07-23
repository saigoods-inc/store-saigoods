import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

test("admin-v2.css includes skip-link, focus-visible, reduced-motion, touch targets", () => {
  const css = read("public/css/v2/admin-v2.css");
  assert.match(css, /\.sg-skip-link/);
  assert.match(css, /\.sg-btn:focus-visible/);
  assert.match(css, /\.sg-nav__link:focus-visible/);
  assert.match(css, /\.sg-menu-btn:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.sg-btn--icon-sm\s*\{[^}]*min-width:\s*44px/s);
  assert.match(css, /\.mo-qty__btn\s*\{[^}]*min-width:\s*44px/s);
  assert.match(css, /\.sg-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  // Orphan Walk-in CSS intentionally retained this PR.
  assert.match(css, /\.wi-/);
  assert.match(css, /\.sg-cell-product\s*\{[^}]*min-width:\s*120px/s);
});
