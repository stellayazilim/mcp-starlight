#!/usr/bin/env node
/**
 * MCP server for a Starlight docs site — stdio transport.
 *
 * The client spawns this on the reader's machine and talks JSON-RPC over
 * stdin/stdout, so the docs site itself never has to answer a POST. That is the
 * whole point: MCP is JSON-RPC, a static host cannot answer it, but the process
 * that can does not have to be hosted — it can run wherever the reader is.
 *
 *   npx @stellayazilim/mcp-starlight https://example.com/mcp-catalog.json
 *
 * Or against a local build while writing docs:
 *
 *   npx @stellayazilim/mcp-starlight ./dist/mcp-catalog.json
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCatalog } from "./load.mjs";
import { createServer } from "./mcp.mjs";
import { createCatalogStore, DEFAULT_TTL_MS } from "./store.mjs";

function usage() {
  return [
    "Usage: mcp-starlight <catalog-url|path|site-url>",
    "",
    "  https://example.com/mcp-catalog.json   the published catalog",
    "  https://example.com                    site root; /mcp-catalog.json is appended",
    "  ./dist/mcp-catalog.json                a local build",
    "",
    "Environment:",
    "  MCP_STARLIGHT_CATALOG    used when no argument is given",
    `  MCP_STARLIGHT_TTL_MS     ms between staleness checks (default ${DEFAULT_TTL_MS}; 0 checks every call)`,
  ].join("\n");
}

const arg = process.argv[2] ?? process.env.MCP_STARLIGHT_CATALOG;

if (!arg || arg === "--help" || arg === "-h") {
  console.error(usage());
  process.exit(arg ? 0 : 1);
}

const { source, catalog } = await loadCatalog(arg);

const ttlEnv = Number(process.env.MCP_STARLIGHT_TTL_MS);
const ttlMs = Number.isFinite(ttlEnv) && ttlEnv >= 0 ? ttlEnv : undefined;

const store = createCatalogStore({
  source,
  catalog,
  ...(ttlMs === undefined ? {} : { ttlMs }),
  onRefresh: ({ from, to, catalog: next }) =>
    console.error(
      `mcp-starlight refreshed — revision ${from ?? "unknown"} -> ${to}, ${next.pages.length} pages`,
    ),
  onError: (error) =>
    console.error(`mcp-starlight: staleness check failed, serving the loaded catalog (${error.message})`),
});

const server = createServer(store, { McpServer });

await server.connect(new StdioServerTransport());

// stdout is the JSON-RPC channel; diagnostics have to go to stderr.
console.error(
  `mcp-starlight ready — ${catalog.pages.length} pages from ${source}` +
    (catalog.revision ? ` (revision ${catalog.revision})` : " (no revision published; staleness checks will no-op)"),
);
