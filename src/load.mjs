/**
 * Resolving a catalog reference to a catalog.
 *
 * Kept apart from the server entry point so the resolution rules — which are
 * where the surprises live — can be tested without spawning a process or
 * binding stdio.
 */
import fs from "node:fs";

export const CATALOG_FILENAME = "mcp-catalog.json";

/**
 * Accepts a full catalog URL, a bare site URL, or a filesystem path.
 *
 * Handing over the site root is the common case and the fix is unambiguous, so
 * the filename is appended rather than making the reader remember it.
 */
export function resolveCatalogUrl(source) {
  if (!/^https?:\/\//.test(source)) return null;
  return source.endsWith(".json")
    ? source
    : `${source.replace(/\/+$/, "")}/${CATALOG_FILENAME}`;
}

/** A catalog is only usable if it has the pages array the tools read. */
export function assertCatalog(catalog, source) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.pages)) {
    throw new Error(`${source} is not an mcp-starlight catalog.`);
  }
  return catalog;
}

export async function loadCatalog(source, { fetchImpl = fetch, readFile } = {}) {
  const url = resolveCatalogUrl(source);

  if (url) {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch ${url} (HTTP ${response.status}). ` +
          "Is the site built with the mcp-starlight integration?",
      );
    }
    return { source: url, catalog: assertCatalog(await response.json(), url) };
  }

  const read = readFile ?? ((p) => {
    if (!fs.existsSync(p)) throw new Error(`No catalog at ${p}`);
    return fs.readFileSync(p, "utf8");
  });

  return { source, catalog: assertCatalog(JSON.parse(read(source)), source) };
}
