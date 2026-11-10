# Handbook

A web app for company handbooks (SOPs) and team training. One frontend, hosted on GitHub Pages, serves every company. Each company runs its own backend on Bunny: one edge script, one Bunny Database and one Storage zone.

This README covers what is built so far (milestone 1: foundations). It will become the full setup guide in milestone 9.

## How it fits together

```
Browser (GitHub Pages, static files in web/)
   │  HTTPS + JSON, Authorization: Bearer <session token>
   ▼
Bunny edge script (one per company, built from edge/src)
   ├── Bunny Database (one per company)
   ├── Bunny Storage zone + pull zone (milestone 5)
   └── Anthropic Messages API (milestone 8)
```

People log in with three things: the **workspace URL** (the address of their company's edge script, for example `https://police.academy.onetake.ai`), their email and their password. Admins can share a link that fills in the workspace URL:

```
https://academy.onetake.ai/?workspace=https://police.academy.onetake.ai
```

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The frontend: plain HTML, CSS and JavaScript modules, published as-is. |
| `edge/src/` | The backend, written as several modules. `edge/src/main.js` is the entry point. |
| `edge/build.mjs` | Joins `edge/src` into the single file Bunny runs: `edge/dist/edge.mjs`. |
| `dev/` | Local development server and the SQLite adapter used by the tests. |
| `tests/` | Automated tests, run with Node's built-in test runner. |
| `.github/workflows/` | Tests on every pull request, frontend publishing, edge script deployment. |

There are no npm dependencies to install. The edge script imports two packages directly from npm at runtime (`@bunny.net/edgescript-sdk` and `@bunny.net/database-client`), with exact versions.

## Running it on your computer

You need Node.js 22 or later.

```bash
node dev/server.mjs
```

Then open http://localhost:8080, enter `http://localhost:8787` as the workspace URL and `dev-setup-code` as the setup code. The local server uses a SQLite file, `dev/local.db`. Stop the server and delete that file to start again from an empty workspace.

To run the tests:

```bash
node --test 'tests/*.test.mjs'
```

To build the edge script:

```bash
node edge/build.mjs
```

## Setting up a company on Bunny

Each company does this once, in its own Bunny account.

### 1. Create the database

In the Bunny dashboard, open **Edge Platform → Database** and create a database. You don't need to create any tables: the edge script creates them on its first request.

### 2. Create the edge script

1. Open **Edge Platform → Scripting** and click **Add Script**.
2. Choose **Standalone** and the default template.
3. Bunny creates a pull zone for the script, with an address ending in `.b-cdn.net`. To use your own address, such as `police.academy.onetake.ai`, add it as a hostname on that pull zone and create the DNS record Bunny shows you.
4. In the pull zone's caching settings, make sure the pull zone respects the `Cache-Control` header sent by the script. Every API response is sent with `Cache-Control: no-store` and must never be cached.

### 3. Connect the database to the script

Open the database, then **Access**, click **Generate Tokens**, then **Add Secrets to Edge Script** and choose your script. This adds `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN` to the script.

### 4. Add the other secrets

On the script, open **Env Configuration → Environment Secrets** and add:

| Secret | Value |
|---|---|
| `ALLOWED_ORIGINS` | The websites allowed to use this workspace, separated by commas. For OneTake AI: `https://academy.onetake.ai`. Add `http://localhost:8080` while testing with the local frontend. |
| `SETUP_CODE` | A long random code, used once to create the first admin. Keep it private. |

The Storage secrets (`STORAGE_ZONE`, `STORAGE_KEY`, `STORAGE_REGION_HOST`, `PUBLIC_FILES_URL`) come with milestone 5.

### 5. Deploy the code

Either way works:

- **Automatically:** add the company to the `BUNNY_TENANTS` repository secret (see below). Every change to `edge/` merged into `main` is deployed to every company.
- **By hand:** download the `edge-script` file from the **Tests** workflow run of a pull request (or run `node edge/build.mjs` and take `edge/dist/edge.mjs`), paste its content into the script editor in the Bunny dashboard, then **Save** and **Publish**.

### 6. Create the first admin

Open the frontend, enter the workspace URL, and fill in the "Create the first admin" form with the setup code. This only works while the workspace has no users.

## Deploying the edge script

The **Deploy edge script** workflow reads one repository secret, `BUNNY_TENANTS`, a JSON list with one entry per company:

```json
[
  { "script_id": "12345", "deploy_key": "the-deploy-key" }
]
```

Find the script ID and deploy key in the Bunny dashboard, on the script, under **Deployments → Settings**. A deploy key can only deploy its own script. Add the secret in GitHub under **Settings → Secrets and variables → Actions → New repository secret**. Company names and IDs never appear in the repository or in the workflow logs.

A company that uses its own copy of this repository sets `BUNNY_TENANTS` in its copy with just its own entry.

## Publishing the frontend

The **Publish frontend** workflow publishes `web/` to GitHub Pages on every change merged into `main`. In the repository settings, under **Pages**, set the source to **GitHub Actions**, then set the custom domain.

## Security notes

- Passwords are hashed with PBKDF2-SHA-256 and a random 16-byte salt per user. Each user row stores its iteration count, so the count can be raised later without breaking existing passwords.
- Session tokens are 32 random bytes. The database only stores their SHA-256 hash. Sessions last 30 days and are extended while in use.
- After 5 failed logins for one email within 15 minutes, that email is locked for 15 minutes. The setup code has the same protection.
- Only the websites in `ALLOWED_ORIGINS` can call the API from a browser.

### Password hashing cost

The iteration count is `PBKDF2_ITERATIONS` in `edge/src/lib/crypto.js`, currently 600,000. It is being measured on Bunny with the temporary `POST /api/bench` endpoint; this section will record the result.

## Licence

MIT. See `LICENSE`.
