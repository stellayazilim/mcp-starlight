# @stellayazilim/mcp-starlight

Give any [Astro Starlight](https://starlight.astro.build) docs site an MCP server.

**No hosting.** The integration writes a catalog into your build; the server runs
on the reader's machine via `npx` and fetches it. A static host only ever has to
answer `GET` for a JSON file — which is the one thing it does. GitHub Pages,
S3 and plain nginx all work unchanged.

Locale- and version-aware, and extensible with structured data of your own.

## Install

```bash
npm install @stellayazilim/mcp-starlight
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightMcp from '@stellayazilim/mcp-starlight';

export default defineConfig({
  site: 'https://example.com',
  integrations: [
    starlight({ title: 'My Docs' }),
    starlightMcp({ siteLabel: 'My Product' }),
  ],
});
```

Build the site. You now have `dist/mcp-catalog.json`, published with everything
else.

## Use

Point any MCP client at the published catalog — or at the site root, and the
filename is appended for you:

```json
{
  "mcpServers": {
    "my-docs": {
      "command": "npx",
      "args": ["-y", "@stellayazilim/mcp-starlight", "https://example.com"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add my-docs -- npx -y @stellayazilim/mcp-starlight https://example.com
```

While writing docs, point it at a local build instead:

```bash
npx @stellayazilim/mcp-starlight ./dist/mcp-catalog.json
```

## Tools

| Tool | Answers |
|---|---|
| `search_docs` | "Which page covers X?" — ranked matches with routes and descriptions |
| `get_doc` | "Show me that page" — full Markdown |
| `list_docs` | "What is in these docs?" — every page with title and description |
| `search_reference` | Exact names and signatures from your structured data — only registered when you provide some |

`search_docs` and `list_docs` take `locale` and `version` when your site has
them, so an answer can be scoped to one language or one documentation line.

## Options

```js
starlightMcp({
  siteLabel: 'My Product',        // shown in tool descriptions
  versions: ['preview', 'v1'],    // route segments that denote a docs line
  exclude: ['api'],               // content directories to leave out
  filename: 'mcp-catalog.json',   // output name inside the build
  collections: { … },             // structured data — object or function
  revision: process.env.GITHUB_SHA, // identifies this build of the catalog
})
```

**`versions`** turns a path segment into a facet. With `versions: ['preview']`,
`/preview/guides/x` is tagged `preview` and `/guides/x` is the default line, so a
reader can ask about one without the other bleeding in.

**`exclude`** matches path prefixes *after* the locale and version segments are
stripped, so `exclude: ['api']` covers `api/`, `tr/api/`, `preview/api/` and
`tr/preview/api/` in one entry instead of four.

**`locales`** need no configuration — they are read from the Astro i18n config
that Starlight generates.

**`revision`** identifies this build of the catalog. Pass the commit it came from
— `process.env.GITHUB_SHA` in Actions — and a served catalog is traceable to a
source revision. Left unset it defaults to a hash of the catalog's contents,
which changes only when the content does. Either way it drives staleness
detection, below.

## Staying current

Docs sites redeploy; long-lived MCP clients do not restart. A server that read
its catalog once at startup will keep answering from it for days, and nothing in
its replies says so — which is the kind of wrong that is worth preventing rather
than documenting.

Each build writes a small sentinel beside the catalog:

```
/mcp-catalog.json           the catalog
/mcp-catalog.version.json   { "schema": 1, "revision": "…", "generatedAt": "…" }
```

Before answering a tool call the server compares the published revision against
the one it loaded, and re-fetches the catalog only when they differ. The check
costs one request of a few dozen bytes; the catalog itself — which for a
documented API surface runs to hundreds of kilobytes — is pulled only when it
actually changed.

The checks are throttled and opportunistic: at most one per minute, and only
while tool calls are arriving, so an idle server makes no requests at all. Set
`MCP_STARLIGHT_TTL_MS` to change the interval, or `0` to check on every call.

Failure is deliberately quiet. A sentinel that is missing (an older site) or
unreachable (a blip) leaves the loaded catalog in place — being possibly one
revision behind beats answering with an error.

One limit worth knowing: tool *schemas* are fixed when the client connects,
because MCP clients cache the tool list. A refresh updates every answer, but a
site that adds a whole new locale or documentation line mid-session needs a
client restart before that facet appears as a filter.

## Structured collections

Prose search cannot answer "what is the exact signature of this type". If your
build already produces that information — a generated API surface, a schema, a
changelog — hand it over and it becomes searchable alongside the pages:

```js
starlightMcp({
  collections: () => ({
    api: {
      label: '.NET API reference',
      entries: types.map((t) => ({
        id: t.uid,
        title: t.name,
        signature: t.declaration,
        summary: t.summary,
        route: t.docPath,
      })),
    },
  }),
})
```

Entries need `id` and `title`; `signature`, `summary`, `detail` and `route` are
used when present. The integration knows nothing about where they came from — it
publishes them, and `search_reference` appears.

Pass a function when the data is produced by another build step, so it is read at
build time rather than when the config is loaded.

## Why not the Pagefind index?

Starlight already builds one, and reusing it is a fair instinct. It is the wrong
shape: Pagefind indexes *rendered pages* for browser-side search and ships a WASM
runtime that returns HTML excerpts. This catalog is Markdown with frontmatter
intact, plus whatever structured data you added — which is what a model can
actually use, and what makes locale and version filtering possible.

## Why a process at all?

MCP is JSON-RPC. A client POSTs a body and expects an answer *computed from it*;
a static host returns the same bytes for every request and rejects POST outright.
So something must run — but it does not have to be hosted. Here it runs where the
reader is:

```
your static host                  the reader's machine
────────────────                  ────────────────────
mcp-catalog.json   ──GET──►       npx …mcp-starlight   ──stdio──►   Claude, Cursor, …
```

## License

MIT
