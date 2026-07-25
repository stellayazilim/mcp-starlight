/**
 * Builds the catalog an MCP client answers from, by reading a Starlight site's
 * content collection off disk.
 *
 * Reading the source files rather than hooking Astro's content APIs keeps this
 * working across Astro versions — the integration hooks have churned (`routes`
 * on `astro:build:done` was deprecated in v5), but `src/content/docs/**` has been
 * Starlight's layout throughout. It also means the catalog can be generated
 * without running a build at all, which is what makes the CLI useful in CI.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const PAGE_EXTENSIONS = /\.(md|mdx|mdoc|markdoc)$/;

/**
 * Splits frontmatter from body. Starlight frontmatter is YAML, and titles
 * routinely contain colons and quotes, so it gets a real parser rather than a
 * line-splitting approximation.
 */
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw.trim() };
  try {
    return { data: parseYaml(match[1]) ?? {}, body: match[2].trim() };
  } catch {
    return { data: {}, body: match[2].trim() };
  }
}

/**
 * Content path -> site route.
 *
 * `index` files map to their directory, and the configured locales are kept as
 * the leading segment so a multilingual site stays navigable — Starlight puts
 * the locale first, before any other path segment.
 */
export function routeFor(relativePath, { base = "" } = {}) {
  const withoutExtension = relativePath.replace(PAGE_EXTENSIONS, "");
  const segments = withoutExtension.split("/").filter(Boolean);
  if (segments.at(-1) === "index") segments.pop();
  const trimmedBase = base.replace(/\/+$/, "");
  return `${trimmedBase}/${segments.join("/")}`.replace(/\/+$/, "") || "/";
}

/**
 * Strips the markup that only matters to a renderer, so what reaches the model
 * is prose. Code fences are kept — they are usually the answer.
 */
export function toPlainish(body) {
  return body
    .replace(/^import\s+.*$/gm, "")
    .replace(/\{%\s*\/?[\s\S]*?%\}/g, "")
    .replace(/<\/?[A-Z][\w.]*(\s[^>]*)?\/?>/g, "")
    .replace(/^:{3}\w*\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectLocale(segments, locales) {
  return locales.includes(segments[0]) ? segments[0] : null;
}

/**
 * Whether a directory is excluded.
 *
 * Entries are path prefixes relative to the content root, matched *after* the
 * locale and version segments are stripped — so on a site with a `tr` locale and
 * a `preview` line, `exclude: ["api"]` covers `api/`, `tr/api/`, `preview/api/`
 * and `tr/preview/api/` in one entry rather than four. A nested prefix like
 * `reference/generated` works the same way.
 */
function isExcluded(segments, locales, versions, excludePrefixes) {
  if (excludePrefixes.length === 0) return false;

  let rest = locales.includes(segments[0]) ? segments.slice(1) : segments;
  if (versions.includes(rest[0])) rest = rest.slice(1);
  if (rest.length === 0) return false;

  const joined = rest.join("/");
  return excludePrefixes.some(
    (prefix) => joined === prefix || joined.startsWith(`${prefix}/`),
  );
}

function detectVersion(segments, versions, locale) {
  const rest = locale ? segments.slice(1) : segments;
  return versions.find((v) => v && rest[0] === v) ?? null;
}

/**
 * Walks a Starlight content directory into catalog pages.
 *
 * @param {object} options
 * @param {string} options.contentDir   e.g. `<site>/src/content/docs`
 * @param {string} [options.base]       Astro `base`, prefixed to every route
 * @param {string[]} [options.locales]  locale segments to recognise, e.g. ["tr"]
 * @param {string[]} [options.versions] version segments, e.g. ["preview"]
 * @param {string[]} [options.exclude]  top-level directories to skip
 */
export function collectPages({
  contentDir,
  base = "",
  locales = [],
  versions = [],
  exclude = [],
} = {}) {
  if (!fs.existsSync(contentDir)) {
    throw new Error(`No Starlight content at ${contentDir}`);
  }

  const excludePrefixes = exclude.map((e) => e.replace(/^\/+|\/+$/g, ""));
  const pages = [];

  const walk = (dir, segments) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const next = [...segments, entry.name];
        if (isExcluded(next, locales, versions, excludePrefixes)) continue;
        walk(path.join(dir, entry.name), next);
        continue;
      }
      if (!PAGE_EXTENSIONS.test(entry.name)) continue;

      const relative = [...segments, entry.name].join("/");
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const { data, body } = parseFrontmatter(raw);

      const routeSegments = relative.replace(PAGE_EXTENSIONS, "").split("/");
      const locale = detectLocale(routeSegments, locales);
      const version = detectVersion(routeSegments, versions, locale);

      pages.push({
        route: routeFor(relative, { base }),
        title: typeof data.title === "string" ? data.title : routeSegments.at(-1),
        description: typeof data.description === "string" ? data.description : "",
        locale,
        version,
        body: toPlainish(body),
      });
    }
  };

  walk(contentDir, []);
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Assembles the published artifact.
 *
 * `collections` is the extension point: a site with structured data of its own —
 * a generated .NET or TypeScript API surface, a changelog, a schema — passes it
 * here and it becomes searchable alongside the prose, without this package
 * needing to know what it is.
 */
/**
 * Fingerprint of a catalog's contents, used to tell a stale copy from a current
 * one without comparing the whole thing.
 *
 * `revision` is excluded from its own input, so re-running this over a finished
 * catalog reproduces the stored value — a client can verify what it was given
 * rather than trusting the field.
 *
 * This is the fallback. A build that knows its provenance should pass an
 * explicit revision instead (a commit SHA), which is traceable in a way a
 * content hash is not.
 */
export function catalogRevision(catalog) {
  const { revision, ...content } = catalog;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

export function buildCatalog({
  site,
  siteLabel,
  base = "",
  pages,
  locales = [],
  versions = [],
  collections = {},
  revision,
}) {
  const catalog = {
    // Schema version. Bumped when the shape changes, NOT when the content does —
    // that is what `revision` is for, and conflating the two is why a client
    // cannot tell staleness from this field.
    version: 1,
    site,
    siteLabel,
    base,
    locales,
    versions,
    pages,
    collections,
  };

  return { ...catalog, revision: revision || catalogRevision(catalog) };
}
