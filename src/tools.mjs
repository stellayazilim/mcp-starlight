/**
 * The tools, over whatever catalog was loaded.
 *
 * Three cover any Starlight site — search, read, list. The fourth only appears
 * when the site published structured collections of its own, so a plain docs
 * site is not cluttered with a tool that would always come back empty.
 */
import { z } from "zod";

/**
 * Ranks a candidate. Title matches dominate body matches: someone searching a
 * page name wants that page, not the forty pages that mention it in passing.
 */
export function score(query, title, body = "") {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = title.toLowerCase();

  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;

  const haystack = body.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = terms.filter((term) => haystack.includes(term)).length;
  if (hits === 0) return 0;

  // All terms present beats a single incidental match.
  return 10 + Math.round((hits / terms.length) * 20);
}

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

function urlFor(catalog, route) {
  return catalog.site ? `${catalog.site}${route}` : route;
}

function filterPages(catalog, { locale, version }) {
  return catalog.pages.filter((page) => {
    if (locale !== undefined && (page.locale ?? null) !== (locale || null)) return false;
    if (version !== undefined && (page.version ?? null) !== (version || null)) return false;
    return true;
  });
}

export function registerTools(server, catalog) {
  const label = catalog.siteLabel ?? "the documentation";

  const localeEnum =
    catalog.locales?.length > 0
      ? z
          .enum(["default", ...catalog.locales])
          .optional()
          .describe(
            `Locale to restrict to. "default" is the primary language; also available: ${catalog.locales.join(", ")}.`,
          )
      : undefined;

  const versionEnum =
    catalog.versions?.length > 0
      ? z
          .enum(["default", ...catalog.versions])
          .optional()
          .describe(
            `Documentation line. "default" is the main one; also available: ${catalog.versions.join(", ")}.`,
          )
      : undefined;

  const scopeSchema = {
    ...(localeEnum ? { locale: localeEnum } : {}),
    ...(versionEnum ? { version: versionEnum } : {}),
  };

  const scopeOf = ({ locale, version }) => ({
    locale: locale === undefined ? undefined : locale === "default" ? null : locale,
    version: version === undefined ? undefined : version === "default" ? null : version,
  });

  server.registerTool(
    "search_docs",
    {
      title: `Search ${label}`,
      description: `Find pages in ${label} by title or content. Returns ranked matches with their route and description. Start here when you do not know which page covers something.`,
      inputSchema: {
        query: z.string().describe("What to look for."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
        ...scopeSchema,
      },
    },
    async ({ query, limit, locale, version }) => {
      const scope = scopeOf({ locale, version });
      const ranked = filterPages(catalog, scope)
        .map((page) => ({ page, s: score(query, page.title, `${page.description} ${page.body}`) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit ?? 10);

      if (ranked.length === 0) return text(`No page matches "${query}".`);

      return text(
        [
          `${ranked.length} page(s) matching "${query}":`,
          "",
          ...ranked.map(({ page }) =>
            [
              `**${page.title}**${page.version ? ` *(${page.version})*` : ""}`,
              page.description,
              `\`${page.route}\` — ${urlFor(catalog, page.route)}`,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          "",
          "Call get_doc with a `route` to read one in full.",
        ].join("\n\n"),
      );
    },
  );

  server.registerTool(
    "get_doc",
    {
      title: `Read a page from ${label}`,
      description: `Return one documentation page as Markdown. Use the route from search_docs or list_docs.`,
      inputSchema: {
        route: z.string().describe("Page route, e.g. /guides/getting-started."),
      },
    },
    async ({ route }) => {
      const normalized = route.replace(/\/+$/, "") || "/";
      const page =
        catalog.pages.find((p) => p.route === route) ??
        catalog.pages.find((p) => p.route.replace(/\/+$/, "") === normalized) ??
        catalog.pages.find((p) => p.route.endsWith(normalized));

      if (!page) {
        return text(`No page at "${route}". Use search_docs or list_docs to find one.`);
      }

      return text(
        [
          `# ${page.title}`,
          page.description,
          urlFor(catalog, page.route),
          "",
          "---",
          "",
          page.body,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    },
  );

  server.registerTool(
    "list_docs",
    {
      title: `List ${label}`,
      description: `Every page with its route, title and description — a cheap way to see the shape of the documentation before drilling in.`,
      inputSchema: scopeSchema,
    },
    async ({ locale, version }) => {
      const pages = filterPages(catalog, scopeOf({ locale, version }));
      if (pages.length === 0) return text("No pages match that scope.");

      return text(
        [
          `${pages.length} page(s):`,
          "",
          ...pages.map(
            (p) =>
              `- \`${p.route}\` — ${p.title}${p.description ? `: ${p.description}` : ""}`,
          ),
        ].join("\n"),
      );
    },
  );

  // Only registered when the site actually published structured data, so a plain
  // docs site never sees a tool that can only answer "nothing here".
  const collections = Object.entries(catalog.collections ?? {}).filter(
    ([, c]) => c?.entries?.length,
  );

  if (collections.length > 0) {
    const names = collections.map(([name]) => name);

    server.registerTool(
      "search_reference",
      {
        title: `Search ${label} reference data`,
        description:
          `Search the structured reference this site publishes alongside its prose: ${collections
            .map(([name, c]) => `${name} (${c.label ?? name}, ${c.entries.length} entries)`)
            .join(", ")}. Use this for exact names and signatures rather than explanatory text.`,
        inputSchema: {
          query: z.string().describe("Name or a word from the description."),
          collection: z
            .enum(names)
            .optional()
            .describe("Restrict to one collection. All of them when omitted."),
          limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
        },
      },
      async ({ query, collection, limit }) => {
        const searched = collection
          ? collections.filter(([name]) => name === collection)
          : collections;

        const ranked = [];
        for (const [name, group] of searched) {
          for (const entry of group.entries) {
            const body = [entry.summary, entry.signature, entry.detail]
              .filter(Boolean)
              .join(" ");
            const s = score(query, entry.title ?? entry.id, body);
            if (s) ranked.push({ s, name, group, entry });
          }
        }

        if (ranked.length === 0) return text(`No reference entry matches "${query}".`);

        ranked.sort((a, b) => b.s - a.s);
        const shown = ranked.slice(0, limit ?? 10);

        return text(
          [
            `${ranked.length} entry(ies) matching "${query}":`,
            "",
            ...shown.map(({ name, entry }) =>
              [
                `**${entry.title ?? entry.id}** *(${name})*`,
                entry.signature ? `\`${entry.signature}\`` : "",
                entry.summary,
                entry.route ? urlFor(catalog, entry.route) : "",
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          ].join("\n\n"),
        );
      },
    );
  }

  return server;
}
