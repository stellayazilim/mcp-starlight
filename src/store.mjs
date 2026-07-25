/**
 * Keeps a served catalog current.
 *
 * The server used to read its catalog once at startup and hold that object for
 * the life of the process. Docs sites redeploy; long-lived MCP clients do not
 * restart. The result was a server confidently answering from a snapshot taken
 * days earlier, with nothing in its replies to say so — the failure is silent,
 * which is what makes it worth code rather than a note in the README.
 *
 * The check is cheap by design: the build publishes a small sentinel next to the
 * catalog carrying its revision, so staleness costs one request of a few dozen
 * bytes. The catalog itself is re-fetched only when that revision actually
 * changes.
 *
 * Refreshing is opportunistic. It happens on tool calls, never on a timer, so an
 * idle server makes no requests at all; and a failed check leaves the current
 * catalog in place, because answering from a catalog that might be one revision
 * behind beats answering with an error.
 */
import { loadCatalog, loadRevision } from "./load.mjs";

/** Long enough that a burst of tool calls checks once; short enough to notice a deploy. */
export const DEFAULT_TTL_MS = 60_000;

/**
 * @param {object} options
 * @param {string} options.source        catalog URL or path, as resolved at startup
 * @param {object} options.catalog       the catalog already loaded from it
 * @param {number} [options.ttlMs]       minimum gap between revision checks
 * @param {Function} [options.now]       clock, injectable for tests
 * @param {Function} [options.load]      catalog loader, injectable for tests
 * @param {Function} [options.readRevision] sentinel reader, injectable for tests
 * @param {Function} [options.onRefresh] called with ({ from, to, catalog }) after a swap
 * @param {Function} [options.onError]   called with (error) when a check fails
 */
export function createCatalogStore({
  source,
  catalog,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  load = loadCatalog,
  readRevision = loadRevision,
  onRefresh,
  onError,
}) {
  let current = catalog;
  let checkedAt = now();
  let inFlight = null;

  async function refresh() {
    const published = await readRevision(source);

    // Null means the sentinel could not be read — an older site, or a blip. Not
    // knowing is not the same as knowing it changed, so nothing is thrown away.
    if (published === null || published === current.revision) return false;

    const { catalog: next } = await load(source);
    const from = current.revision;
    current = next;
    onRefresh?.({ from, to: next.revision, catalog: next });
    return true;
  }

  return {
    get current() {
      return current;
    },

    get source() {
      return source;
    },

    /**
     * Revalidate if the TTL has elapsed. Concurrent callers share one check
     * rather than each opening their own; tool calls arrive in bursts.
     */
    async ensureFresh() {
      // Joining an in-flight check comes first, deliberately. `checkedAt` is
      // stamped when a check starts, not when it finishes, so callers arriving
      // during one would otherwise see a fresh TTL and be handed the catalog
      // that check is in the middle of replacing.
      if (inFlight) {
        await inFlight;
        return current;
      }

      if (now() - checkedAt < ttlMs) return current;

      checkedAt = now();
      inFlight = refresh()
        .catch((error) => {
          onError?.(error);
          return false;
        })
        .finally(() => {
          inFlight = null;
        });

      await inFlight;
      return current;
    },
  };
}

/** Wraps a catalog so tools can take a store unconditionally. Never refreshes. */
export function staticStore(catalog, source = null) {
  return {
    get current() {
      return catalog;
    },
    get source() {
      return source;
    },
    async ensureFresh() {
      return catalog;
    },
  };
}
