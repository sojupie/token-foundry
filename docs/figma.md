# Figma and TokenFoundry

The TokenFoundry Figma plugin edits Figma variables mapped from a DTCG source workspace while keeping TokenFoundry as the source of truth for files, references, units, and metadata. Figma holds the rendered variable projection and a revisioned copy of the source snapshot.

## Local development setup

Run from the `token-foundry` root with Node.js 24 or later:

```powershell
npm ci
npm run check
$env:FOUNDRY_FIGMA_LIBRARY = '../sevan-design-system/figma/library.ts'
npm run build:figma
node scripts/figma-snapshot.ts ../sevan-design-system/tokens figma/dist/sevan-source.json Sevan
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

In desktop Figma, choose **Plugins → Development → Import plugin from manifest…** and select `figma/dist/manifest.json`. Plugin output is written to `figma/dist/`, separate from the web app build in `dist/`.

- **Registered plugin ID:** Keep the maintained plugin ID in `figma/dist/manifest.json`; private plugin metadata in Figma is scoped to that ID.
- **System adapter:** `FOUNDRY_FIGMA_LIBRARY` injects a design-system component builder (for example Sevan's `figma/library.ts`). Without it, `npm run build:figma` builds the generic token-only plugin.
- **Private API flag:** `FOUNDRY_FIGMA_PRIVATE_API=1` enables Figma's private development APIs (such as reading `fileKey`) locally; ordinary builds work without it.
- **Workers & Durable Objects:** When testing hosted sync locally or on staging, ensure Durable Object code updates apply immediately rather than waiting on delayed rollout defaults so client storage journals and server state versions stay aligned.

## Plugin views

The plugin shell organizes work across three bottom-navigation views:

- **Tokens:** Live selected-layer token strip, dynamic group filter (plus a **Modified** filter when changes exist), searchable variable list, master-detail token editor (with color picker, unit-aware numeric inputs, easing coordinates, reference picker, and **Revert to source**), and preserved source details.
- **Changes:** Local diff list (`before → after` with per-token **Revert**), sync status, interrupted pull recovery, native unit reviews, incoming three-way conflict reviews, and proposal downloads.
- **Workspace:** One-click workspace pairing, custom Foundry URL override, pairing/connection code input, **Build UI kit** (under **Library maintenance**), and offline snapshot/edit file controls.

## Workspace workflow

1. **Open a workspace:** In TokenFoundry, open **Workspace** to load a GitHub repository (`Choose repository`) or pick an existing draft (`Switch workspace`). Name workspaces so concurrent drafts in the same repository stay distinct.
2. **Connect a Figma file:** Open the plugin in Figma, switch to **Workspace**, and click **Connect workspace**. TokenFoundry opens in your browser to choose or create the shared workspace, select **Library** or **Concept**, and approve the connection (or issue a one-time pairing code under **Manual connection**).
   - **Library** files import and edit variables in the shared workspace draft.
   - **Concept** files inspect and bind against the shared library without duplicating editable token definitions locally.
3. **Edit variables:** In the library plugin's **Tokens** view, change variable values or aliases and click **Apply in Figma**. Unchanged values perform no write. Unfinished edits are stored per token on the device so reopening the plugin resumes your draft input.
4. **Automatic sync:** Accepted plugin edits sync directly into the workspace draft without manual Send/Share/Pull steps. **Saved to workspace** confirms draft persistence; saving a GitHub commit or pull request happens separately in TokenFoundry.
5. **Resolve conflicts:** Concurrent edits to the same token appear in **Changes** with **Before**, **Figma**, **Foundry**, and optional **Current Figma** values. Choose a side or enter a custom value or reference, then apply the resolution. Unfinished custom inputs survive reloads and source updates (reselecting a resolution option is required if the underlying values changed).
6. **Submit to GitHub:** In TokenFoundry's **Changes** view, select **Review and save proposal** to inspect affected tokens, resolved values, and file diffs before creating or updating the pull request. Interrupted Git saves are journaled and can be resumed via **Resume reviewed save**.

## Device connections, security, and copied files

- Scoped 256-bit connection capabilities are stored in Figma device storage (`clientStorage`), never inside document metadata or downloadable recovery exports.
- GitHub and Cloudflare credentials never enter the plugin sandbox.
- Grants expire automatically (default 8 hours). Reconnecting renews device access without touching the workspace draft.
- Each connected device tracks its own baseline revision, offered snapshot, receipt sequence, and queued conflict reviews independently. Active device grants can be managed or revoked individually from TokenFoundry's **Figma** view.
- Duplicating a Figma file assigns new native collection/file identities; copied files cannot silently reuse the original file's write capability and must pair explicitly if needed.

## Source fidelity and unit boundaries

The Figma bridge currently maps **colors (sRGB + alpha)**, **numbers**, **dimensions (`px`, `dp`, `sp`)**, **durations (`TIMING`, stored natively in seconds while preserving authored `ms`/`s`)**, **cubic Bézier easings (`EASING`, preserving control points and rejecting native presets until repaired)**, **font weights**, and **single font family strings**.

To avoid destroying richer source definitions:

- Whole-token aliases remain native Figma aliases and export as token path references.
- Unmapped composite types, inheritance (`$extends`), JSON Pointers, unknown `$extensions`, BOMs, and line endings stay intact in source files.
- Source formatting (such as inline token objects vs. multiline objects) is preserved on leaf updates.
- Native float32 storage precision is normalized against source baselines so opening an unmodified file produces zero false edits. Values that cannot round-trip at float32 retain user input with a prompt to edit in TokenFoundry's source editor.
- Percentage-mapped tokens (such as Sevan opacities scaled 0–1 to 0–100% in Figma) use a per-variable migration journal and prompt explicitly if an interrupted edit is ambiguous.

## Local recovery

- **Browser:** TokenFoundry saves open workspace files, baseline snapshots, pinned GitHub metadata, and unfinished forms (token, bulk, metadata, raw source, and conflict inputs) to IndexedDB. Use **File → Recover local work…** or export a JSON recovery file (stripped of Figma secrets) if local storage is unavailable.
- **Plugin:** Pull operations journal snapshots across two storage slots before mutating native variables. If Figma closes mid-pull, **Resume interrupted pull** completes the baseline update and preserves intervening local edits for review. Failed device form saves can also be exported and reopened under **Connect → Manual link and files → Offline snapshots and edits**.

## Hosted relay architecture

Hosted environments split editor traffic, plugin sync, and SQLite persistence across three routes/workers:

1. **Editor API (`/git/workspaces*`):** Authenticated via Cloudflare Access and GitHub repository write permissions. Creates and updates shared workspaces, approves plugin pairing requests (`/git/workspaces/:id/pair`), issues manual file grants (`/git/workspaces/:id/documents`), and revokes device access (`/git/workspaces/:id/revoke`).
2. **Plugin sync relay (`/figma/pairing/:id` and `/figma/workspaces/:workspace/files/:grant`):** Accepts CORS requests from Figma's opaque plugin sandbox (`Origin: null`), authenticates file requests via HMAC-SHA-256 256-bit bearer capability, and forwards no browser cookies or Access identity headers.
3. **Private SQLite state (`SharedWorkspaceStore` and `WorkspaceRegistry` Durable Objects):** Enforces source-generation writes before advancing revision pointers, receipt monotonic ordering, submission de-duplication, and source validation via TokenFoundry's DTCG engine before committing updates.
