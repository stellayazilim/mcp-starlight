import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalog } from "../src/catalog.mjs";
import { loadCatalog } from "../src/load.mjs";
import { createCatalogStore, staticStore } from "../src/store.mjs";

const catalogAt = (revision, pages = []) => ({ revision, pages, collections: {} });

/**
 * Builds a store over a controllable clock and a scripted sentinel, so the
 * timing rules can be asserted without waiting for real time to pass.
 */
function harness({ revisions, catalogs, ttlMs = 1000, initial = catalogAt("r1") }) {
  let time = 0;
  const calls = { revision: 0, load: 0 };
  const refreshes = [];
  const errors = [];

  const store = createCatalogStore({
    source: "https://example.com/mcp-catalog.json",
    catalog: initial,
    ttlMs,
    now: () => time,
    readRevision: async () => {
      calls.revision += 1;
      const next = revisions.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    load: async () => {
      calls.load += 1;
      return { source: "x", catalog: catalogs.shift() };
    },
    onRefresh: (e) => refreshes.push(e),
    onError: (e) => errors.push(e),
  });

  return { store, calls, refreshes, errors, advance: (ms) => (time += ms) };
}

describe("createCatalogStore", () => {
  it("serves the loaded catalog without checking inside the TTL", async () => {
    const h = harness({ revisions: ["r2"], catalogs: [catalogAt("r2")] });

    assert.equal((await h.store.ensureFresh()).revision, "r1");
    assert.equal(h.calls.revision, 0, "no check should happen before the TTL elapses");
  });

  it("swaps in a new catalog when the published revision differs", async () => {
    const h = harness({ revisions: ["r2"], catalogs: [catalogAt("r2", [{ route: "/new" }])] });
    h.advance(1000);

    const catalog = await h.store.ensureFresh();

    assert.equal(catalog.revision, "r2");
    assert.deepEqual(catalog.pages, [{ route: "/new" }]);
    assert.equal(h.store.current.revision, "r2");
    assert.deepEqual(h.refreshes, [{ from: "r1", to: "r2", catalog }]);
  });

  it("does not re-download when the revision is unchanged", async () => {
    const h = harness({ revisions: ["r1"], catalogs: [] });
    h.advance(1000);

    await h.store.ensureFresh();

    assert.equal(h.calls.revision, 1);
    assert.equal(h.calls.load, 0, "an unchanged revision must not pull the catalog");
  });

  it("treats an unreadable sentinel as 'cannot tell' and keeps serving", async () => {
    const h = harness({ revisions: [null], catalogs: [] });
    h.advance(1000);

    const catalog = await h.store.ensureFresh();

    assert.equal(catalog.revision, "r1");
    assert.equal(h.calls.load, 0);
    assert.deepEqual(h.errors, [], "a missing sentinel is expected, not an error");
  });

  it("keeps the current catalog when the check throws", async () => {
    const h = harness({ revisions: [new Error("offline")], catalogs: [] });
    h.advance(1000);

    const catalog = await h.store.ensureFresh();

    assert.equal(catalog.revision, "r1", "a failed check must not empty the server");
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /offline/);
  });

  it("recovers on the next window after a failed check", async () => {
    const h = harness({
      revisions: [new Error("blip"), "r2"],
      catalogs: [catalogAt("r2")],
    });

    h.advance(1000);
    await h.store.ensureFresh();
    h.advance(1000);
    const catalog = await h.store.ensureFresh();

    assert.equal(catalog.revision, "r2");
  });

  it("collapses concurrent calls into one check", async () => {
    const h = harness({ revisions: ["r2"], catalogs: [catalogAt("r2")] });
    h.advance(1000);

    const [a, b, c] = await Promise.all([
      h.store.ensureFresh(),
      h.store.ensureFresh(),
      h.store.ensureFresh(),
    ]);

    assert.equal(h.calls.revision, 1, "a burst of tool calls should check once");
    assert.equal(h.calls.load, 1);
    assert.equal(a.revision, "r2");
    assert.equal(b.revision, "r2");
    assert.equal(c.revision, "r2");
  });

  it("checks on every call when the TTL is zero", async () => {
    const h = harness({ revisions: ["r1", "r1"], catalogs: [], ttlMs: 0 });

    await h.store.ensureFresh();
    await h.store.ensureFresh();

    assert.equal(h.calls.revision, 2);
  });
});

describe("staticStore", () => {
  it("serves its catalog and never refreshes", async () => {
    const catalog = catalogAt("fixed");
    const store = staticStore(catalog);

    assert.equal(store.current, catalog);
    assert.equal(await store.ensureFresh(), catalog);
  });
});

describe("createCatalogStore over real files", () => {
  it("picks up a rebuilt catalog through the real loader and sentinel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-starlight-"));
    const catalogPath = path.join(dir, "mcp-catalog.json");
    const sentinelPath = path.join(dir, "mcp-catalog.version.json");

    // Exactly what the integration writes: catalog first, sentinel second.
    const publish = (pages, revision) => {
      const catalog = buildCatalog({
        site: "https://x.com",
        siteLabel: "X",
        pages,
        ...(revision ? { revision } : {}),
      });
      fs.writeFileSync(catalogPath, JSON.stringify(catalog));
      fs.writeFileSync(
        sentinelPath,
        JSON.stringify({ schema: catalog.version, revision: catalog.revision }),
      );
      return catalog;
    };

    const first = publish([{ route: "/a", title: "A" }]);
    const { catalog } = await loadCatalog(catalogPath);
    const store = createCatalogStore({ source: catalogPath, catalog, ttlMs: 0 });

    assert.equal(store.current.revision, first.revision);
    assert.equal((await store.ensureFresh()).pages.length, 1);

    const second = publish([
      { route: "/a", title: "A" },
      { route: "/b", title: "B" },
    ]);
    assert.notEqual(second.revision, first.revision, "content changed, so should the revision");

    const refreshed = await store.ensureFresh();
    assert.equal(refreshed.revision, second.revision);
    assert.equal(refreshed.pages.length, 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops against a site that publishes no sentinel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-starlight-"));
    const catalogPath = path.join(dir, "mcp-catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, pages: [], collections: {} }));

    const { catalog } = await loadCatalog(catalogPath);
    const store = createCatalogStore({ source: catalogPath, catalog, ttlMs: 0 });

    assert.equal((await store.ensureFresh()).pages.length, 0, "should not throw or empty");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
