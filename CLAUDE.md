# Handbook: notes for Claude and other contributors

Company handbook (SOPs) and team training app. One static frontend on GitHub Pages serves every company; each company runs its own Bunny edge script, Bunny Database and Bunny Storage zone. The functional brief is the source of truth for features; this file records how the code is organised and the decisions taken along the way, so they can be checked and updated later.

## Commands

```bash
node dev/server.mjs                 # whole app locally: frontend :8080, API :8787 (workspace URL http://localhost:8787, setup code dev-setup-code)
node --test 'tests/*.test.mjs'      # all tests (Node 22 built-ins only)
node edge/build.mjs                 # join edge/src into edge/dist/edge.mjs, the single file Bunny runs
```

Delete `dev/local.db` and `dev/uploads/` (with the dev server stopped) to start from an empty workspace.

## Layout

| Path | What |
|---|---|
| `web/` | Frontend, published as-is to GitHub Pages. Plain HTML, CSS, ES modules. Hash routing (`#/doc/12/step/34`). |
| `web/js/app.js` | Boot, session, app shell, router. Views in `web/js/views/` export `render(main, params)`. |
| `web/js/lib/` | Hand-written helpers: DOM (`h()`, never `innerHTML`), CSV parser, import rules, icons, marks, sortable, emoji picker. |
| `edge/src/main.js` | Edge script entry point. Everything else is plain modules under `edge/src/lib/`. |
| `edge/src/app.js` | Router, CORS, migrations, error handling. `createApp({ db, env, fetchImpl })` so it runs in Node tests too. |
| `edge/src/lib/permissions.js` | The one implementation of permission resolution. Every read and write uses it. |
| `edge/build.mjs` | Joins `edge/src` (and any module it imports, including `web/js/lib/import-rules.js`) into one file. |
| `dev/` | Local dev server and the `node:sqlite` adapter shared with the tests. |
| `tests/` | `node:test` tests against the real handlers with an in-memory SQLite database. |

## Decisions

### Platform
- **No build step for the frontend.** No framework, no TypeScript, no bundler.
- **The edge script is one file at deploy time**, but written as modules. `edge/build.mjs` (hand-written, no bundler) joins them. Rules: local imports are `import { a } from "./x.js";`, exports are inline (`export function`, `export const`), and top-level names are unique across modules (the build fails otherwise).
- **Database access goes through a five-method interface** (`all`, `first`, `value`, `run`, `batch`) in `edge/src/lib/db.js`. Production wraps `@bunny.net/database-client`; tests and the dev server wrap `node:sqlite`. `batch()` is one transaction.
- **Bunny injects the database secrets** as `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN` ("Add Secrets to Edge Script"). Other secrets: `ALLOWED_ORIGINS`, `SETUP_CODE`, `STORAGE_ZONE`, `STORAGE_KEY`, `STORAGE_REGION_HOST`, `PUBLIC_FILES_URL`.
- **Deployment** uses per-script deploy keys from the `BUNNY_TENANTS` repository secret (JSON list of `{ script_id, deploy_key }`), never printed in logs. Companies may use their own Bunny account and their own copy of the repo.
- **Uploads** are sent as the raw request body (not multipart) with an `X-File-Name` header. Images are recognised from their bytes; SVG is refused.
- **AI prompts** will live in `web/prompts/*.md`, published on GitHub Pages. The edge script fetches them from the request's `Origin` (or the first non-local `ALLOWED_ORIGINS` entry). The browser only sends the prompt's name, never its text.

### Security
- PBKDF2-SHA-256, **1,000,000 iterations** (measured on Bunny: about 200 ms per hash). Iterations are stored per user; logging in upgrades older hashes.
- Session tokens: 32 random bytes; only the SHA-256 hash is stored; 30-day sliding expiry.
- Every response has `Cache-Control: no-store`. A website missing from `ALLOWED_ORIGINS` gets a readable 403 explaining what to add.
- Documents a member can't see return 404, not 403.

### Product rules agreed with the product owner
- An automatic **Everyone** department contains every active member; it can't be renamed or deleted.
- Team leaders manage only the departments they lead, never admins, never leader or admin flags. An existing email added by a leader joins the department; a deactivated account needs an admin.
- The workspace always keeps one active admin; nobody deactivates or demotes themselves.
- Until drafts (milestone 5), edits save directly: *Edit with review* may only change unpublished documents.
- Titles are Bleached Cedar with a Golden Grass accent bar; completion checks are a Golden Grass circle with a Bleached Cedar tick (Golden Grass on white fails contrast for text).
- Reordering uses pointer events (mouse and touch) plus Move up / Move down for keyboards.
- The Documents tree in the sidebar only shows in the Knowledge section.
- The interface and documents never use em dashes; use a semicolon. No horizontal rules in documents.

## Dependencies

Only these. Ask the product owner before adding anything.

| Where | Package | Version | How it is loaded | How to update |
|---|---|---|---|---|
| Edge script | `@bunny.net/edgescript-sdk` | 0.13.0 | `npm:` import in `edge/src/main.js` | Change the version in the import, run the tests, deploy |
| Edge script | `@bunny.net/database-client` | 0.0.3 | `npm:` import in `edge/src/main.js` | Same |
| Browser | Montserrat | | Bunny Fonts stylesheet in `web/index.html` | Nothing to pin |
| Browser | Tiptap 3.33.1 (`@tiptap/core`, `pm`, `starter-kit`, `extension-table`, `extension-image`, `extensions`), DOMPurify 3.4.17, and their dependencies | see `web/vendor/manifest.json` | Copied into `web/vendor/` and mapped in the import map of `web/index.html`; no CDN at runtime | See "Vendored browser libraries" |
| CI | `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v4`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4` | | `.github/workflows/` | Bump the major version when GitHub deprecates one |

Never use Google Fonts. Never load a library from a CDN at runtime.

### Vendored browser libraries

Browser libraries are not loaded from jsDelivr or any CDN. `tools/vendor.mjs` (hand-written, uses only Node and npm) does this:

1. installs the exact versions listed in `tools/vendor.json` into a temporary folder;
2. fails if npm installed two versions of any package (Tiptap breaks with several copies of a `prosemirror-*` package);
3. follows the imports from the entry points listed in `tools/vendor.json` and copies only the files reached, as published (ES modules, no bundling), into `web/vendor/<package>@<version>/`, with each package's licence;
4. writes `web/vendor/manifest.json` (every package and version) and rewrites the import map in `web/index.html`.

To update: change the versions (or add an entry point) in `tools/vendor.json`, run `node tools/vendor.mjs`, run the tests (`tests/vendor.test.mjs` checks that every import resolves locally and that each package exists once), then try the editor in the browser. Commit `web/vendor/` and `web/index.html` together. Never edit files in `web/vendor/` by hand.

Packages currently vendored (from `web/vendor/manifest.json`): Tiptap 3.33.1 (core, pm, starter-kit and the extensions it uses, extension-table, extension-image, extensions), DOMPurify 3.4.17, linkifyjs 4.4.0, prosemirror-commands 1.7.2, prosemirror-dropcursor 1.8.4, prosemirror-gapcursor 1.4.1, prosemirror-history 1.5.1, prosemirror-keymap 1.2.3, prosemirror-model 1.25.13, prosemirror-schema-list 1.6.0, prosemirror-state 1.4.4, prosemirror-tables 1.8.5, prosemirror-transform 1.12.5, prosemirror-view 1.42.9, orderedmap 2.1.1, rope-sequence 1.3.4, w3c-keyname 2.2.8. About 1.3 MB uncompressed, loaded only when a document is opened.

## Writing style (interface text and documentation)

- English only. Direct, plain sentences; second person for instructions.
- Semicolons instead of em dashes.
- The company is "OneTake AI"; the product and AI agent is "OneTake", never "the AI", "a tool" or "a platform".
