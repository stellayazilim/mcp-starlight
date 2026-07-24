import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { score } from "../src/tools.mjs";
import { createServer } from "../src/mcp.mjs";

/**
 * A catalog shaped exactly like the integration emits, so these exercise the
 * real protocol path — a genuine Client talking to a genuine McpServer over an
 * in-memory transport, with argument validation live.
 */
function makeCatalog(overrides = {}) {
  return {
    version: 1,
    site: "https://example.com",
    siteLabel: "Test Docs",
    base: "/d",
    locales: ["tr"],
    versions: ["preview"],
    pages: [
      { route: "/d/guides/install", title: "Installation", description: "How to install", locale: null, version: null, body: "Run npm install to begin." },
      { route: "/d/guides/routing", title: "Routing", description: "Route config", locale: null, version: null, body: "Routes are files on disk." },
      { route: "/d/preview/guides/install", title: "Installation", description: "Preview install", locale: null, version: "preview", body: "Run npm install --next." },
      { route: "/d/tr/guides/install", title: "Kurulum", description: "Nasıl kurulur", locale: "tr", version: null, body: "npm install çalıştırın." },
    ],
    collections: {
      api: {
        label: "API reference",
        entries: [
          { id: "T1", title: "CommandHandler", signature: "class CommandHandler", summary: "Handles commands.", route: "/d/api/command-handler" },
          { id: "T2", title: "QueryHandler", signature: "class QueryHandler", summary: "Handles queries.", route: "/d/api/query-handler" },
        ],
      },
    },
    ...overrides,
  };
}

async function connect(catalog) {
  const server = createServer(catalog, { McpServer });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

const textOf = (result) => result.content.map((c) => c.text).join("\n");

describe("score", () => {
  it("ranks an exact title above a prefix above a substring", () => {
    assert.ok(score("routing", "Routing") > score("rout", "Routing"));
    assert.ok(score("rout", "Routing") > score("ting", "Routing"));
  });

  it("falls back to body terms, rewarding coverage", () => {
    const all = score("npm install", "Setup", "run npm install now");
    const partial = score("npm install", "Setup", "run npm elsewhere");
    assert.ok(all > partial);
    assert.ok(partial > 0);
  });

  it("returns 0 for no match and empty queries", () => {
    assert.equal(score("zzz", "Routing", "files"), 0);
    assert.equal(score("", "Routing"), 0);
  });
});

describe("protocol", () => {
  let ctx;
  before(async () => {
    ctx = await connect(makeCatalog());
  });
  after(async () => {
    await ctx.client.close();
    await ctx.server.close();
  });

  it("lists the docs tools plus search_reference when collections exist", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_doc",
      "list_docs",
      "search_docs",
      "search_reference",
    ]);
  });

  it("exposes locale and version arguments only when the site has them", async () => {
    const { tools } = await ctx.client.listTools();
    const search = tools.find((t) => t.name === "search_docs");
    const props = Object.keys(search.inputSchema.properties);
    assert.ok(props.includes("locale"));
    assert.ok(props.includes("version"));
  });

  it("search_docs ranks a title match above an incidental body match", async () => {
    // "routing" is the Routing page's title and also appears in the Installation
    // page's body ("Routes are files"). The title match must come first.
    const res = await ctx.client.callTool({
      name: "search_docs",
      arguments: { query: "routing" },
    });
    const out = textOf(res);
    const routing = out.indexOf("**Routing**");
    assert.ok(routing !== -1, "the Routing page is returned");
    const installation = out.indexOf("**Installation**");
    assert.ok(
      installation === -1 || routing < installation,
      "Routing outranks an incidental body match",
    );
  });

  it("search_docs filters by version", async () => {
    const res = await ctx.client.callTool({
      name: "search_docs",
      arguments: { query: "install", version: "preview" },
    });
    const out = textOf(res);
    assert.ok(out.includes("/d/preview/guides/install"));
    assert.ok(!out.includes("/d/guides/install\n"));
  });

  it("search_docs filters by locale", async () => {
    const res = await ctx.client.callTool({
      name: "search_docs",
      arguments: { query: "kurulum", locale: "tr" },
    });
    const out = textOf(res);
    assert.ok(out.includes("Kurulum"));
    assert.ok(out.includes("/d/tr/guides/install"));
  });

  it("emits absolute URLs without doubling the base", async () => {
    const res = await ctx.client.callTool({
      name: "search_docs",
      arguments: { query: "routing" },
    });
    const out = textOf(res);
    assert.ok(out.includes("https://example.com/d/guides/routing"));
    assert.ok(!out.includes("/d/d/"), "base must not appear twice");
  });

  it("get_doc returns the full body, tolerating a trailing slash", async () => {
    const res = await ctx.client.callTool({
      name: "get_doc",
      arguments: { route: "/d/guides/install/" },
    });
    const out = textOf(res);
    assert.ok(out.includes("# Installation"));
    assert.ok(out.includes("Run npm install to begin."));
  });

  it("get_doc reports a missing page rather than throwing", async () => {
    const res = await ctx.client.callTool({
      name: "get_doc",
      arguments: { route: "/d/nope" },
    });
    assert.ok(textOf(res).includes("No page"));
  });

  it("search_reference finds structured entries by name", async () => {
    const res = await ctx.client.callTool({
      name: "search_reference",
      arguments: { query: "CommandHandler" },
    });
    const out = textOf(res);
    assert.ok(out.includes("class CommandHandler"));
    assert.ok(out.includes("/d/api/command-handler"));
  });

  it("flags an invalid enum argument at the protocol layer", async () => {
    // The SDK validates against the Zod schema and returns a protocol error
    // result (isError) rather than throwing — a bogus version is caught, not
    // silently treated as "no matches".
    const res = await ctx.client.callTool({
      name: "search_docs",
      arguments: { query: "x", version: "nonexistent" },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /invalid|validation/i);
  });
});

describe("protocol without extras", () => {
  it("omits search_reference and the scope args on a plain site", async () => {
    const ctx = await connect(
      makeCatalog({ locales: [], versions: [], collections: {} }),
    );
    try {
      const { tools } = await ctx.client.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(!names.includes("search_reference"), "no collections → no reference tool");

      const search = tools.find((t) => t.name === "search_docs");
      const props = Object.keys(search.inputSchema.properties);
      assert.ok(!props.includes("locale"));
      assert.ok(!props.includes("version"));
    } finally {
      await ctx.client.close();
      await ctx.server.close();
    }
  });
});
