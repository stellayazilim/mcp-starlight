/**
 * Builds a configured `McpServer` from a catalog.
 *
 * Separate from the stdio entry point so tests can attach an in-memory transport
 * and exercise the real protocol — tool listing, argument validation, results —
 * without spawning a process.
 */
import { registerTools } from "./tools.mjs";

export function createServer(catalog, { McpServer, version = "0.1.0" }) {
  const server = new McpServer({
    name: catalog.siteLabel ? `${catalog.siteLabel} docs` : "starlight-docs",
    version,
  });

  registerTools(server, catalog);
  return server;
}
