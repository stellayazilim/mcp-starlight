import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildCatalog,
  collectPages,
  parseFrontmatter,
  routeFor,
  toPlainish,
} from "../src/catalog.mjs";

const CONTENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixture/src/content/docs",
);

const routes = (pages) => pages.map((p) => p.route);

describe("parseFrontmatter", () => {
  it("reads YAML frontmatter and returns the body", () => {
    const { data, body } = parseFrontmatter("---\ntitle: Hi\n---\nBody text.");
    assert.equal(data.title, "Hi");
    assert.equal(body, "Body text.");
  });

  it("handles values containing colons", () => {
    // A line-splitting parser truncates at the first colon; titles and
    // descriptions contain them constantly.
    const { data } = parseFrontmatter(
      '---\ndescription: "How to install: the short version"\n---\nx',
    );
    assert.equal(data.description, "How to install: the short version");
  });

  it("treats a file with no frontmatter as all body", () => {
    const { data, body } = parseFrontmatter("Just prose.");
    assert.deepEqual(data, {});
    assert.equal(body, "Just prose.");
  });

  it("does not throw on malformed YAML", () => {
    const { data, body } = parseFrontmatter("---\n: : :\n---\nstill here");
    assert.deepEqual(data, {});
    assert.equal(body, "still here");
  });
});

describe("routeFor", () => {
  it("drops the extension", () => {
    assert.equal(routeFor("guides/install.md"), "/guides/install");
  });

  it("maps index files to their directory", () => {
    assert.equal(routeFor("guides/index.md"), "/guides");
    assert.equal(routeFor("index.mdx"), "/");
  });

  it("prefixes the base without doubling slashes", () => {
    assert.equal(routeFor("guides/install.md", { base: "/docs" }), "/docs/guides/install");
    assert.equal(routeFor("guides/install.md", { base: "/docs/" }), "/docs/guides/install");
  });

  it("supports every Starlight page extension", () => {
    for (const ext of ["md", "mdx", "mdoc", "markdoc"]) {
      assert.equal(routeFor(`a/b.${ext}`), "/a/b");
    }
  });
});

describe("toPlainish", () => {
  it("removes imports and component tags but keeps prose and code", () => {
    const out = toPlainish(
      ["import X from './X.astro';", "", "Real prose.", "", "<X prop='1' />", "", "```js", "code()", "```"].join("\n"),
    );
    assert.ok(!out.includes("import X"));
    assert.ok(!out.includes("<X"));
    assert.ok(out.includes("Real prose."));
    assert.ok(out.includes("code()"), "code fences are usually the answer");
  });

  it("strips Markdoc tags", () => {
    const out = toPlainish("{% aside type=\"note\" %}\nInner.\n{% /aside %}");
    assert.ok(!out.includes("{%"));
    assert.ok(out.includes("Inner."));
  });
});

describe("collectPages", () => {
  it("walks the tree and reads frontmatter", () => {
    const pages = collectPages({ contentDir: CONTENT });
    assert.equal(pages.length, 9);

    const install = pages.find((p) => p.route === "/guides/install");
    assert.equal(install.title, "Installation");
    assert.equal(install.description, "How to install: the short version");
    assert.ok(install.body.includes("npm install"));
  });

  it("returns pages sorted by route", () => {
    const list = routes(collectPages({ contentDir: CONTENT }));
    assert.deepEqual(list, [...list].sort());
  });

  it("tags locales only when configured", () => {
    const without = collectPages({ contentDir: CONTENT });
    assert.equal(without.every((p) => p.locale === null), true);

    const withTr = collectPages({ contentDir: CONTENT, locales: ["tr"] });
    const tr = withTr.filter((p) => p.locale === "tr");
    assert.equal(tr.length, 3);
    assert.ok(tr.every((p) => p.route.startsWith("/tr")));
  });

  it("tags versions, including under a locale", () => {
    const pages = collectPages({
      contentDir: CONTENT,
      locales: ["tr"],
      versions: ["preview"],
    });

    const preview = pages.filter((p) => p.version === "preview");
    assert.equal(preview.length, 3);
    assert.ok(preview.some((p) => p.locale === "tr"), "tr/preview must be tagged too");
  });

  it("excludes a directory across every locale and version", () => {
    // Regression: `exclude` originally only matched top-level directories, so
    // `preview/reference` and `tr/preview/reference` leaked into the catalog.
    const pages = collectPages({
      contentDir: CONTENT,
      locales: ["tr"],
      versions: ["preview"],
      exclude: ["reference"],
    });

    assert.equal(
      pages.some((p) => p.route.includes("/reference")),
      false,
      "no variant of the excluded directory may survive",
    );
    assert.equal(pages.length, 7);
  });

  it("excludes a nested prefix", () => {
    // `preview/reference` is only reachable as a nested prefix; excluding
    // `reference` with `preview` a known version must still catch it.
    const pages = collectPages({
      contentDir: CONTENT,
      versions: ["preview"],
      exclude: ["reference"],
    });
    assert.equal(pages.some((p) => p.route.includes("/reference")), false);
  });

  it("matches an exclude prefix only after known locale/version segments", () => {
    // Without `tr` declared as a locale, `tr/guides` is an ordinary path and the
    // `guides` prefix does not reach into it — exclusion is deliberate, not
    // accidental substring matching.
    const pages = collectPages({ contentDir: CONTENT, exclude: ["guides"] });
    assert.equal(pages.some((p) => p.route === "/guides/install"), false);
    assert.ok(
      pages.some((p) => p.route === "/tr/guides/install"),
      "tr/guides survives when tr is not a declared locale",
    );

    const withScope = collectPages({
      contentDir: CONTENT,
      locales: ["tr"],
      versions: ["preview"],
      exclude: ["guides"],
    });
    assert.equal(
      withScope.some((p) => p.route.includes("/guides")),
      false,
      "with tr and preview declared, guides is excluded under every combination",
    );
  });

  it("leaves everything in place when nothing is excluded", () => {
    assert.equal(collectPages({ contentDir: CONTENT, exclude: [] }).length, 9);
  });

  it("throws a useful error when the content directory is missing", () => {
    assert.throws(
      () => collectPages({ contentDir: path.join(CONTENT, "nope") }),
      /No Starlight content at/,
    );
  });
});

describe("buildCatalog", () => {
  it("carries the metadata the tools need", () => {
    const catalog = buildCatalog({
      site: "https://example.com",
      siteLabel: "Docs",
      base: "/d",
      pages: collectPages({ contentDir: CONTENT }),
      locales: ["tr"],
      versions: ["preview"],
      collections: { api: { label: "API", entries: [{ id: "a", title: "A" }] } },
    });

    assert.equal(catalog.version, 1);
    assert.equal(catalog.site, "https://example.com");
    assert.deepEqual(catalog.locales, ["tr"]);
    assert.deepEqual(catalog.versions, ["preview"]);
    assert.equal(catalog.collections.api.entries.length, 1);
  });
});
