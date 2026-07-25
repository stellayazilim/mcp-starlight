import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCatalog,
  loadCatalog,
  loadRevision,
  resolveCatalogUrl,
  versionSourceFor,
} from "../src/load.mjs";

describe("resolveCatalogUrl", () => {
  it("returns a full catalog URL unchanged", () => {
    assert.equal(
      resolveCatalogUrl("https://x.com/mcp-catalog.json"),
      "https://x.com/mcp-catalog.json",
    );
  });

  it("appends the filename to a bare site URL", () => {
    assert.equal(
      resolveCatalogUrl("https://x.com"),
      "https://x.com/mcp-catalog.json",
    );
    assert.equal(
      resolveCatalogUrl("https://x.com/docs/"),
      "https://x.com/docs/mcp-catalog.json",
    );
  });

  it("returns null for a filesystem path", () => {
    assert.equal(resolveCatalogUrl("./dist/mcp-catalog.json"), null);
  });
});

describe("assertCatalog", () => {
  it("accepts a catalog with a pages array", () => {
    const c = { pages: [] };
    assert.equal(assertCatalog(c, "x"), c);
  });

  it("rejects anything without one", () => {
    assert.throws(() => assertCatalog({}, "x"), /not an mcp-starlight catalog/);
    assert.throws(() => assertCatalog(null, "x"), /not an mcp-starlight catalog/);
  });
});

describe("loadCatalog", () => {
  it("fetches over HTTP with an injected fetch", async () => {
    const catalog = { pages: [{ route: "/a" }] };
    const fetchImpl = async (url) => {
      assert.equal(url, "https://x.com/mcp-catalog.json");
      return { ok: true, json: async () => catalog };
    };
    const result = await loadCatalog("https://x.com", { fetchImpl });
    assert.equal(result.catalog.pages.length, 1);
    assert.equal(result.source, "https://x.com/mcp-catalog.json");
  });

  it("surfaces an HTTP error with a hint", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(
      loadCatalog("https://x.com", { fetchImpl }),
      /HTTP 404.*mcp-starlight integration/s,
    );
  });

  it("reads from a path with an injected reader", async () => {
    const readFile = () => JSON.stringify({ pages: [{ route: "/a" }] });
    const result = await loadCatalog("./local.json", { readFile });
    assert.equal(result.source, "./local.json");
    assert.equal(result.catalog.pages.length, 1);
  });

  it("rejects a file that is not a catalog", async () => {
    const readFile = () => JSON.stringify({ notPages: true });
    await assert.rejects(
      loadCatalog("./x.json", { readFile }),
      /not an mcp-starlight catalog/,
    );
  });
});

describe("versionSourceFor", () => {
  it("derives the sentinel from a catalog URL", () => {
    assert.equal(
      versionSourceFor("https://x.com/mcp-catalog.json"),
      "https://x.com/mcp-catalog.version.json",
    );
  });

  it("derives it from a bare site URL too", () => {
    assert.equal(
      versionSourceFor("https://x.com/docs"),
      "https://x.com/docs/mcp-catalog.version.json",
    );
  });

  it("works for a filesystem path", () => {
    assert.equal(
      versionSourceFor("./dist/mcp-catalog.json"),
      "./dist/mcp-catalog.version.json",
    );
  });
});

describe("loadRevision", () => {
  const ok = (body) => ({ ok: true, json: async () => body });

  it("reads the revision from the sentinel", async () => {
    const revision = await loadRevision("https://x.com/mcp-catalog.json", {
      fetchImpl: async (url) => {
        assert.equal(url, "https://x.com/mcp-catalog.version.json");
        return ok({ revision: "deadbeef" });
      },
    });
    assert.equal(revision, "deadbeef");
  });

  it("returns null when the sentinel is missing", async () => {
    const revision = await loadRevision("https://x.com/mcp-catalog.json", {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    assert.equal(revision, null);
  });

  it("returns null rather than throwing when the fetch fails", async () => {
    const revision = await loadRevision("https://x.com/mcp-catalog.json", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(revision, null);
  });

  it("returns null for a sentinel that is not JSON", async () => {
    const revision = await loadRevision("./dist/mcp-catalog.json", {
      readFile: () => "<html>404</html>",
    });
    assert.equal(revision, null);
  });
});
