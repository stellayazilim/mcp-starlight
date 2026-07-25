/**
 * Resolving a catalog reference to a catalog.
 *
 * Kept apart from the server entry point so the resolution rules — which are
 * where the surprises live — can be tested without spawning a process or
 * binding stdio.
 */
import fs from "node:fs";

export const CATALOG_FILENAME = "mcp-catalog.json";

/** `…/mcp-catalog.json` -> `…/mcp-catalog.version.json`. */
export function versionSourceFor(source) {
  const resolved = resolveCatalogUrl(source) ?? source;
  return `${resolved.replace(/\.json$/i, "")}.version.json`;
}

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

/**
 * The published revision of a catalog, read from its sentinel.
 *
 * Returns null rather than throwing when the sentinel is missing or unreadable:
 * a site built with an older version of this integration does not publish one,
 * and a docs server is more useful serving a possibly-stale catalog than not
 * starting. The caller decides what to do with "cannot tell".
 */
export async function loadRevision(source, { fetchImpl = fetch, readFile } = {}) {
  const target = versionSourceFor(source);

  try {
    if (/^https?:\/\//.test(target)) {
      // No-store: a cached sentinel is exactly the thing this is meant to detect.
      const response = await fetchImpl(target, { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.json())?.revision ?? null;
    }

    const read = readFile ?? ((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null));
    const raw = read(target);
    return raw ? (JSON.parse(raw)?.revision ?? null) : null;
  } catch {
    return null;
  }
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
