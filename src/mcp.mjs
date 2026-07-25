/**
 * Builds a configured `McpServer` from a catalog.
 *
 * Separate from the stdio entry point so tests can attach an in-memory transport
 * and exercise the real protocol — tool listing, argument validation, results —
 * without spawning a process.
 */
import { registerTools } from "./tools.mjs";

/**
 * @param {object} storeOrCatalog a catalog store, or a bare catalog
 */
export function createServer(storeOrCatalog, { McpServer, version = "0.2.0" }) {
  const catalog = storeOrCatalog?.ensureFresh ? storeOrCatalog.current : storeOrCatalog;

  const server = new McpServer({
    name: catalog.siteLabel ? `${catalog.siteLabel} docs` : "starlight-docs",
    version,
  });

  registerTools(server, storeOrCatalog);
  return server;
}
