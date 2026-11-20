# TokenFoundry

Browser-based editor for DTCG design token files and Resolver documents. Open a
local folder or connect a GitHub repository, edit tokens in a table, and review
the combined file diff before saving.

Hosted at [tokenfoundry.lindstruct.com](https://tokenfoundry.lindstruct.com/).

## Features

- **Local files & folders:** Recognizes DTCG tokens and Resolver documents in
  `.json`, `tokens.json`, `*.tokens.json`, `*.tokens`, and `*.resolver.json`
  (skipping `.git`, `node_modules`, and `dist`). Saves directly to disk via the
  File System Access API (checking for external edits), downloads a unified
  `git apply` patch, or exports single-file JSON.
- **DTCG 2025.10 editing:** Full support for Format, Color, and Resolver
  documents—group `$extends`, `$root` group values, JSON Pointer field
  references, all 13 token types, multi-context variants, diagnostics, undo/redo,
  and bulk edits. See [DTCG 2025.10 conformance](docs/dtcg-feature-checklist.md).
- **Material 3 sample:** **File → Open Material 3 sample** loads the Token
  Catalog tree across all six Light/Dark and contrast variants. Refresh it from
  a Catalog export with `node scripts/build-material-sample.ts /path/to/published/assets/dtcg`.
- **Hosted GitHub mode:** Optional Cloudflare Worker connector for opening pull
  requests against configured repositories.

## Run locally

Requires Node.js 24+.

```sh
npm ci
npm run check
npm run dev
```

`npm run build` outputs the static site to `dist/`. Run browser integration
tests with:

```sh
npx playwright install chromium firefox
npm run test:browser
```

Set `MD3_TOKEN_BENCHMARK` to a 6,818-token Material 3 export to run the
large-workspace unresolved-reference test (also enables **File → Open Material 3
benchmark** in dev builds).

## Work on the UI

Foundry is a React + Vite app. `lib/` owns token parsing, references, and
reviewed diffs; `editor/main.tsx` and `editor/token-grid.tsx` own workspace
state, grid navigation/selection, and cell editing; `editor/workspace.css` owns
workspace layout.

UI controls come from `@token-catalog/forge-react` (bundled as a pinned tarball
in `vendor/`). Import its stylesheet once, place `data-component-assets` on the
workspace and any portals, and set `data-theme` / `data-contrast` on `<html>`.

To update Forge React from [Token Catalog](https://github.com/sojupie/tokens/tree/main/forge/react),
pack the new tarball into `vendor/`, install it, and remove the old tarball:

```sh
npm install "./vendor/token-catalog-forge-react-VERSION.tgz"
```

Commit the tarball, `package.json`, and `package-lock.json` together, then run
`npm run check`, `npm run build`, `npm run build:hosted`, and
`npm run test:browser`.

## Imports

### Penpot tokens
Export a single JSON file from Penpot, open the matching token files in Foundry,
and choose **File → Import Penpot tokens…** to update existing token values
(Penpot imports do not create or delete tokens).

### Value proposals
Choose **File → Import proposal…** to apply a `token-proposal.json` (e.g. from a
Figma plugin) matched by token path. If any `before` value differs from the open
workspace, the import stops and names the token:

```json
{
  "schemaVersion": 1,
  "changes": [
    { "path": "reference.space.small", "before": { "value": 8, "unit": "px" }, "after": { "value": 12, "unit": "px" } }
  ]
}
```

Producers can also open Foundry with `#proposal=<percent-encoded JSON>` (up to
8,000 encoded characters); the editor strips the fragment and holds the proposal
in memory for review.

## Deployment

### Public build
Run `npm run deploy:public` (uses `wrangler.public.jsonc`) from a clean checkout
with Wrangler signed in to deploy the local-only editor to
[tokenfoundry.lindstruct.com](https://tokenfoundry.lindstruct.com/).

### Hosted Git (Cloudflare Worker + GitHub App)
`npm run build:hosted` enables the GitHub connector. Serve `dist/` as static
assets, deploy the Worker (`npm run build:worker` to validate locally), route
only `<editor-host>/git/*` to it, and protect that route with Cloudflare Access.

Register a GitHub App with **Contents** and **Pull requests** (read & write)
permissions and callback URL `https://<editor-host>/git/callback`, installed on
the target repositories only.

| Worker variable / secret | Value |
| --- | --- |
| `EDITOR_ORIGIN` | HTTPS editor origin (no trailing slash) |
| `ACCESS_ISSUER` | Cloudflare Access team origin (`https://<team>.cloudflareaccess.com`) |
| `ACCESS_AUDIENCE` | Access application audience tag |
| `GIT_PROJECTS` | JSON map of `"org/repo": "tokens-folder"` |
| `GITHUB_CLIENT_ID` | GitHub App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret (secret) |
| `GIT_SESSION_KEY` | Random 32-byte unpadded base64url key (secret) |

Connected workspaces read the default branch at a pinned commit and open pull
requests against existing `*.tokens.json`, `*.tokens`, and `tokens.json` files
(limits: 40 files / 2 MiB per workspace, 512 KiB per file, 16 changed files per
PR). If the base branch moves during review, **Review latest revision** rebases
clean files and lets you download a patch for conflicting ones.

### Invite-only staging
Run `npm run deploy:sevan` (`wrangler.staging.jsonc`) to deploy the private
editor + Git API to
[sevan.tokenfoundry.lindstruct.com](https://sevan.tokenfoundry.lindstruct.com/).
Before the first deploy, add `https://sevan.tokenfoundry.lindstruct.com/git/callback`
to the GitHub App, protect the Worker with Cloudflare Access for **All traffic**,
and set the Worker variables/secrets above in Cloudflare.
