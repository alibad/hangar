import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as recovery from "../src/lib/chunk-load-recovery.ts";
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_COOLDOWN_MS, isChunkLoadError, reloadAfterChunkError } from "../src/lib/chunk-load-recovery.ts";

const chunkError = Object.assign(new Error("Loading chunk 9501 failed.\n(error: http://localhost:8003/_next/static/chunks/9501-old.js)"), { name: "ChunkLoadError" });
function browser() {
  const values = new Map();
  let reloads = 0;
  return {
    sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    location: { reload: () => reloads++ }, navigator: { onLine: true },
    get reloads() { return reloads; },
  };
}

test("recognizes missing webpack, CSS and native import assets, not ordinary render/API errors", () => {
  for (const error of [chunkError, { code: "CSS_CHUNK_LOAD_FAILED" },
    new Error("Loading CSS chunk 42 failed."), new Error("Failed to load chunk /_next/static/chunks/42.js from module 12"),
    new TypeError("Failed to fetch dynamically imported module: https://example.test/a.js"),
    new TypeError("Importing a module script failed."), new TypeError("error loading dynamically imported module")]) {
    assert.equal(isChunkLoadError(error), true);
  }
  for (const error of [null, undefined, "failed", new Error("Failed to fetch"), new TypeError("Cannot read properties of undefined"), new Error("Products API returned 503")]) {
    assert.equal(isChunkLoadError(error), false);
  }
});

test("a missing asset refreshes once; another failure after reload cannot loop", () => {
  const page = browser();
  assert.equal(reloadAfterChunkError(chunkError, page, 100_000), true);
  // The same storage survives navigation. Even a DIFFERENT chunk/tool failing
  // after the refresh must not trigger another refresh in the cooldown.
  const nextDocument = { ...page, location: { reload: () => assert.fail("reload loop") } };
  assert.equal(reloadAfterChunkError(new Error("Loading chunk 123 failed."), nextDocument, 100_100), false);
  assert.equal(page.reloads, 1);
  assert.equal(reloadAfterChunkError(chunkError, page, 100_000 + CHUNK_RELOAD_COOLDOWN_MS), true);
  assert.equal(page.reloads, 2);
});

test("offline and ordinary failures leave the page and recovery budget intact", () => {
  const page = browser();
  page.navigator.onLine = false;
  assert.equal(reloadAfterChunkError(chunkError, page), false);
  page.navigator.onLine = true;
  assert.equal(reloadAfterChunkError(new Error("render failed"), page), false);
  assert.equal(page.reloads, 0);
  assert.equal(page.sessionStorage.getItem(CHUNK_RELOAD_KEY), null);
});

test("blocked session storage never causes an unguarded automatic reload", () => {
  for (const method of ["getItem", "setItem"]) {
    const page = browser();
    page.sessionStorage[method] = () => { throw new Error("SecurityError"); };
    assert.equal(reloadAfterChunkError(chunkError, page), false);
    assert.equal(page.reloads, 0);
  }
});

test("a corrupt timestamp can recover; a future timestamp remains guarded", () => {
  const page = browser();
  page.sessionStorage.setItem(CHUNK_RELOAD_KEY, "invalid");
  assert.equal(reloadAfterChunkError(chunkError, page, 100_000), true);
  assert.equal(reloadAfterChunkError(chunkError, page, 99_000), false);
});

// Exercise the actual fallback and button handler as well as the reload policy.
const nativeRequire = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/tab-error-boundary.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const component = {};
new Function("require", "exports", compiled)(name => name === "@/lib/chunk-load-recovery" ? recovery : nativeRequire(name), component);

test("chunk fallback reloads the document; ordinary failures keep their in-place retry", t => {
  const page = browser();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: page });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
  const boundary = new component.default({ label: "Products", children: null });
  boundary.state = { error: chunkError };
  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /Products needs a refresh/);
  assert.match(markup, /Reload Hangar/);
  boundary.retry();
  assert.equal(page.reloads, 1, "a cached rejected import requires document reload");

  boundary.state = { error: new Error("render failed") };
  assert.match(renderToStaticMarkup(boundary.render()), /Retry Products/);
  boundary.setState = state => { boundary.state = state; };
  boundary.retry();
  assert.equal(boundary.state.error, null);
  assert.equal(page.reloads, 1, "ordinary render errors must not reload the page");
});
