import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localeSegments, originFor, versionFilenameFor } from "../src/integration.mjs";

describe("localeSegments", () => {
  // Regression: Astro's i18n.locales is an array, not an object. Treating it as
  // an object yielded ["0", "1"] — indices — which matched no path segment, so
  // every localized page was mis-tagged as default.
  it("reads a plain string array", () => {
    assert.deepEqual(
      localeSegments({ locales: ["en", "tr"], defaultLocale: "en" }),
      ["tr"],
    );
  });

  it("reads the object form Astro also accepts", () => {
    assert.deepEqual(
      localeSegments({
        locales: [
          { path: "en", codes: ["en-US"] },
          { path: "tr", codes: ["tr-TR"] },
        ],
        defaultLocale: "en",
      }),
      ["tr"],
    );
  });

  it("drops the default locale and the root pseudo-locale", () => {
    assert.deepEqual(
      localeSegments({ locales: ["root", "tr"], defaultLocale: "root" }),
      ["tr"],
    );
  });

  it("returns nothing for a monolingual site", () => {
    assert.deepEqual(localeSegments(undefined), []);
    assert.deepEqual(localeSegments({}), []);
  });
});

describe("originFor", () => {
  // Regression: routes already carry `base`. When `site` also includes it —
  // which is one of the two accepted conventions — links came out doubled, e.g.
  // https://x.github.io/repo/repo/guides/...
  it("strips base when site already contains it", () => {
    assert.equal(
      originFor("https://x.github.io/repo", "/repo"),
      "https://x.github.io",
    );
  });

  it("leaves a bare origin untouched", () => {
    assert.equal(
      originFor("https://example.com", "/repo"),
      "https://example.com",
    );
  });

  it("tolerates a trailing slash on site", () => {
    assert.equal(
      originFor("https://x.github.io/repo/", "/repo"),
      "https://x.github.io",
    );
  });

  it("returns null when there is no site", () => {
    assert.equal(originFor(null, "/repo"), null);
    assert.equal(originFor(undefined, ""), null);
  });
});

describe("versionFilenameFor", () => {
  it("puts the sentinel beside the catalog", () => {
    assert.equal(versionFilenameFor("mcp-catalog.json"), "mcp-catalog.version.json");
  });

  it("follows a custom catalog filename", () => {
    assert.equal(versionFilenameFor("api.json"), "api.version.json");
  });
});
