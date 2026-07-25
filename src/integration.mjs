/**
 * Astro integration: writes the MCP catalog into the build output.
 *
 * The catalog is a plain JSON file, so it ships with the site on any host —
 * GitHub Pages included. Nothing about serving MCP happens here; that is the
 * `mcp-starlight` binary, which runs on the reader's machine and fetches this
 * file. Splitting it that way is what removes the hosting requirement: a static
 * host only ever has to answer GET for a file, which is the one thing it does.
 *
 *   import starlightMcp from '@stellayazilim/mcp-starlight';
 *
 *   export default defineConfig({
 *     integrations: [starlight({ … }), starlightMcp()],
 *   });
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, collectPages } from "./catalog.mjs";

const DEFAULT_FILENAME = "mcp-catalog.json";

/**
 * Name of the sentinel written beside the catalog.
 *
 * It exists so a client can answer "has this changed?" with one small request
 * instead of downloading the catalog — which for a documented API surface runs
 * to hundreds of kilobytes, and would be pulled on a timer forever.
 */
export function versionFilenameFor(filename) {
  return `${filename.replace(/\.json$/i, "")}.version.json`;
}

/**
 * Astro's `i18n.locales` is either `["en", "tr"]` or
 * `[{ path: "tr", codes: [...] }]`, and Starlight generates whichever suits the
 * config it was given. Treating it as an object yields `["0", "1"]` — array
 * indices — which then never match a real path segment.
 */
export function localeSegments(i18n) {
  if (!i18n?.locales) return [];
  const raw = Array.isArray(i18n.locales) ? i18n.locales : Object.keys(i18n.locales);
  return raw
    .map((locale) => (typeof locale === "string" ? locale : locale?.path))
    .filter((locale) => locale && locale !== i18n.defaultLocale && locale !== "root");
}

/**
 * Splits a site URL into the origin the routes should hang off.
 *
 * Routes already carry `base`, and deployments disagree about whether `site`
 * does too — the GitHub Pages convention is `site: "https://user.github.io"` and
 * `base: "/repo"`, but writing the full deployed URL into `site` is just as
 * common. Normalising once here keeps every emitted link correct either way.
 */
export function originFor(site, base) {
  if (!site) return null;
  const trimmed = String(site).replace(/\/+$/, "");
  if (base && trimmed.endsWith(base)) return trimmed.slice(0, -base.length);
  return trimmed;
}

/**
 * @param {object} [options]
 * @param {string} [options.filename]     output name inside the build (default `mcp-catalog.json`)
 * @param {string} [options.siteLabel]    human name for the docs, shown in tool output
 * @param {string[]} [options.versions]   route segments that denote a docs line, e.g. ["preview"]
 * @param {string[]} [options.exclude]    top-level content directories to leave out
 * @param {object|Function} [options.collections]
 *        Structured entries to publish alongside the prose, or a function
 *        returning them. Anything shaped `{ name: { label, entries: [...] } }`
 *        becomes searchable; entries need `id`, `title`, and free-form fields.
 * @param {string} [options.revision]
 *        Identifier for this build of the catalog, published in the sentinel so
 *        clients can detect a new one. Pass the commit it was built from —
 *        `process.env.GITHUB_SHA` in Actions — to make a served catalog
 *        traceable to a source revision. Defaults to a hash of the catalog's
 *        contents, which changes only when the content does.
 */
export default function starlightMcp(options = {}) {
  const {
    filename = DEFAULT_FILENAME,
    siteLabel,
    versions = [],
    exclude = [],
    collections = {},
    revision,
  } = options;

  let config;

  return {
    name: "@stellayazilim/mcp-starlight",
    hooks: {
      "astro:config:done": ({ config: resolved }) => {
        config = resolved;
      },

      "astro:build:done": async ({ dir, logger }) => {
        const contentDir = path.join(fileURLToPath(config.srcDir), "content", "docs");

        if (!fs.existsSync(contentDir)) {
          logger.warn(
            `No Starlight content at ${contentDir}; skipping the MCP catalog.`,
          );
          return;
        }

        // Starlight registers its locales on the Astro config, so a multilingual
        // site needs no extra configuration here.
        const locales = localeSegments(config.i18n);
        const base = config.base === "/" ? "" : config.base.replace(/\/+$/, "");

        const pages = collectPages({
          contentDir,
          base,
          locales,
          versions,
          exclude,
        });

        const resolvedCollections =
          typeof collections === "function" ? await collections() : collections;

        const catalog = buildCatalog({
          site: originFor(config.site, base),
          siteLabel: siteLabel ?? "Documentation",
          base,
          pages,
          locales,
          versions,
          collections: resolvedCollections,
          revision,
        });

        const outDir = fileURLToPath(dir);
        fs.writeFileSync(path.join(outDir, filename), JSON.stringify(catalog), "utf8");

        // Written second so a client that reads the sentinel and then fetches the
        // catalog can never see a new revision pointing at the old file.
        const versionFilename = versionFilenameFor(filename);
        fs.writeFileSync(
          path.join(outDir, versionFilename),
          JSON.stringify({
            schema: catalog.version,
            revision: catalog.revision,
            generatedAt: new Date().toISOString(),
          }),
          "utf8",
        );

        const extra = Object.values(resolvedCollections).reduce(
          (n, c) => n + (c.entries?.length ?? 0),
          0,
        );
        logger.info(
          `MCP catalog: ${pages.length} pages` +
            (extra ? ` + ${extra} collection entries` : "") +
            ` -> /${filename} (revision ${catalog.revision}, /${versionFilename})`,
        );
      },
    },
  };
}
