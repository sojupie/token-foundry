# Figma, TokenFoundry, and Sevan requirements

## Goal

A designer can inspect and edit design system tokens in Figma, preview those changes on reusable components, resolve concurrent edits, resume interrupted work, and open or update GitHub pull requests through TokenFoundry without editing raw JSON or running Git commands.

Across all workflows, source files in Git remain authoritative: aliases, units, contexts, metadata, formatting, and unsupported composite types must survive transfers cleanly. Schema checks and checksums establish transfer consistency only; design token correctness is audited separately against TokenCatalog and brand documentation.

## Ownership

| Repository | Scope |
| --- | --- |
| `token-foundry` | DTCG editor, shared workspace state, GitHub App connector, generic Figma bridge, plugin UI/controller, relay workers |
| `sevan-design-system` | Authoritative Sevan DTCG tokens, source register, explicit Material mappings, Figma component adapter, web exports |
| `tokens` | Captured Material reference data, `@token-catalog/forge-react` components, Forge tokens/styles/behaviors |
| `sevan-design-docs` | Swedish and English designer guidelines, token reference site, maintainer runbooks |

---

## 1. Workspace and interface

- [x] **UX-01 — Persistent shared workspace:** Store source files, repository baseline, current draft, pull request state, and linked Figma documents independently of expiring client grants.
- [x] **UX-02 — Visible save states:** Surface clear status across **Tokens**, **Variants**, **Workspace**, **Changes**, and **Figma**, distinguishing local recovery drafts, shared workspace saves, pending conflicts, and saved GitHub revisions.
- [x] **UX-03 — Persistent Figma management view:** Manage file role (`Library` vs. `Concept`), active device grants, pending reviews, and manual connection codes from **Figma**.
- [x] **UX-04 — Task-based Figma plugin:** Organize the plugin with bottom navigation (**Changes**, **Tokens**, **Inspect**, **Connect**), top app bar status, type-aware editors, searchable token lists, consumer binding inspection, and separated library maintenance.
- [ ] **UX-05 — End-to-end shared review flow:** Verify every sync, conflict rebase, and publication transition across real hosted Figma, TokenFoundry, and GitHub sessions without manual pull/share steps.
- [x] **UX-06 — Accessible, shift-free feedback:** Use Forge dialogs, alerts, progress indicators, and snackbars with `data-snackbar-avoid` protection on review actions and bounded paginated source lists.
- [x] **UX-07 — Bounded background sync:** Coalesce concurrent requests, pause polling when tabs/plugins are hidden, back off on network errors, and avoid idle writes.
- [x] **UX-08 — Durable workspace URLs & scoped recovery:** Bind URLs to workspace IDs, isolate unfinished local forms per workspace, and prevent late responses after switching workspaces from mutating active state.
- [x] **STATE-TEAM — Repository authorization:** Enforce GitHub repository write permissions for shared repository workspaces while keeping local-file workspaces private.
- [x] **STATE-PROPOSAL — Journaled GitHub saves:** Persist branch and commit intent before calling GitHub so interrupted saves resume cleanly via **Resume reviewed save** without duplicating PRs.
- [x] **STATE-CONNECTIONS — Multi-device support:** Track baseline snapshots, receipts, and unfinished conflict choices per device grant without allowing a second device to break the first.

---

## 2. Source fidelity

- [ ] **DATA-01 — Complete source audit:** Reconcile all 3,897 Sevan tokens against captured Material targets (`material-2026-10-15-review` / latest publication) and documented brand sources, resolving remaining unverified values and unit warnings.
- [ ] **DATA-02 — Stable token identity:** Keep token identity across renames, moves, collection splits, and library updates so native Figma bindings do not silently break or duplicate.
- [x] **DATA-03 — Deterministic revision hashes:** Compute canonical SHA-256 hashes over sorted normalized source entries (Unicode paths, BOMs, line endings, duplicate rejection).
- [ ] **DATA-04 — Byte-preserving edits:** Preserve file boundaries, untouched formatting, inline token layouts, descriptions, deprecations, and unknown `$extensions` across all edit and import paths.
- [x] **DATA-05 — Reference semantics:** Preserve aliases, JSON Pointers, `$root`, `$extends`, and contextual overrides; reject cycles and broken targets before saving.
- [ ] **DATA-06 — Native float32 precision & unit boundaries:** Normalize float32 round-trips without false diffs, handle Sevan percentage-scaled opacities via migration journals, and expand precision-safe editing for values beyond native float32.
- [ ] **DATA-07 — Complete DTCG type bridge:** Expand native plugin editing beyond scalar/easing/timing variables to composite typography, border, shadow, gradient, stroke style, and transition types.
- [ ] **DATA-08 — Atomic validation before writes:** Validate prospective combined graphs before persisting workspace or native document updates.

---

## 3. Conflict resolution

- [ ] **MERGE-01 — Three-way merge:** Compare shared baseline, TokenFoundry draft, and Figma changes automatically; merge independent edits cleanly across the same file.
- [x] **MERGE-02 — Explicit conflict controls:** Display **Before**, **Figma**, **Foundry**, and **Current Figma** values with choices for **Use Foundry**, **Keep Figma**, **Enter another value**, and **Reference another token**.
- [x] **MERGE-03 — Rebased proposals:** Rebasing **Keep Figma** produces a clean delta against the current Foundry baseline while preserving native variable IDs and aliases.
- [ ] **MERGE-04 — Consistent commit & staleness guards:** Validate the complete merged graph before commit; invalidate prior resolution selections (while retaining user input) if remote values change mid-review.
- [ ] **MERGE-05 — Full PR lifecycle:** Verify amendment, approval, closure, merge, superseding PRs, and deleted branch recovery against live GitHub App workflows.
- [ ] **MERGE-06 — Structural conflicts:** Resolve edit/delete, rename/edit, move/edit, type changes, removed modes, and missing alias targets cleanly.
- [ ] **MERGE-07 — End-to-end conflict acceptance:** Verify all conflict choices (`source`, `figma`, custom literal, custom reference) in both edit orders on live Figma library files.

---

## 4. Durable state and recovery

- [x] **STATE-CONCEPT — Empty concept anchoring:** Maintain hidden metadata-only connection identity in concept files without importing local variable copies, blocking accidental inheritance on duplicate files.
- [ ] **STATE-BULK — Unfinished selection recovery:** Recover bulk value, rename, type, metadata, and move/paste forms across reloads alongside their active Resolver context.
- [ ] **STATE-NATIVE-FORMS — Plugin form persistence:** Persist per-token draft values/references and conflicting window branches in client storage with offline JSON export/import.
- [x] **STATE-01 / STATE-02 — Browser recovery:** Persist workspace sources, baseline, pinned Git metadata, and active editor forms in IndexedDB with downloadable backups (without secrets).
- [ ] **STATE-03 / STATE-04 — Proposal resume & pull journaling:** Verify interrupted pull rollback/resume across all SDK mutation stages (variable creation, metadata, aliases, values).
- [x] **STATE-05 — Dual-bank snapshot storage:** Write full generations before advancing pointers in both SQLite Durable Objects and Figma client storage.
- [ ] **STATE-06 — Concurrency & race isolation:** Sequence submissions via monotonic receipts, UI-session IDs, and view/workspace revision guards across queued replies.
- [x] **STATE-SUBMISSIONS — Intent vs. retry disambiguation:** Scope submissions to workspace, source, changes, native sequence, and consumed receipt so genuine repeated edits are not misclassified as retries.
- [x] **STATE-INPUT-INTENT — Independent input kind:** Track whether custom input is a literal value or alias reference independently of temporary resolution dropdown selections.
- [ ] **STATE-07 — Native undo/redo fidelity:** Align plugin edits and acknowledgements with Figma's native Undo/Redo stack across single, bulk, alias, and closed-plugin edits.
- [x] **STATE-08 — Navigation protection:** Prompt with an in-app confirmation dialog before discarding unsaved edits across view/file switches, plus downloadable recovery.
- [x] **STATE-09 — Connection recovery:** Survive transient poll failures, surface expired/revoked grants clearly, and allow clean reconnection without draft loss.

---

## 5. GitHub workflows

- [x] **GIT-01 — Clear workspace states:** Distinguish **Saved locally**, **Saved to workspace**, **Conflicts need review**, **Draft needs attention**, and **Pull request** status across UI views.
- [x] **GIT-02 / GIT-03 — Live PR creation & sequential updates:** Create a pull request and append subsequent reviewed edits onto the same branch from updated commits.
- [ ] **GIT-04 / GIT-06 — Live recovery & proposal status:** Verify interrupted Git commits and closed/merged/deleted branch reconciliation against live GitHub App webhooks and edge workers.
- [x] **GIT-05 — In-UI repository reconciliation:** Merge independent repository updates automatically and resolve same-definition or raw-file conflicts in the UI without patch CLI workflows.
- [ ] **GIT-07 — Auth & rate-limit handling:** Recover cleanly from expired OAuth sessions, repository permission changes, rate limits, and branch protection errors.
- [ ] **GIT-08 / GIT-09 — Release & offline parity:** Keep local folder saves, unified patch downloads, and single-file JSON exports consistent with hosted PR saves.

---

## 6. DTCG → Figma projection coverage

| Feature | Current status | Remaining requirements |
| --- | --- | --- |
| Color (sRGB + alpha) | Mapped natively (`COLOR`), preserves hex fallbacks | Verify wide-gamut / non-sRGB conversion & gamut bounds |
| Dimension (`px`, `dp`, `sp`) | Mapped natively (`FLOAT`), retains unit metadata | Verify device-scale vs. unit mixing rules |
| Number | Mapped natively (`FLOAT`), normalized against float32 baseline | Enforced range checks on consuming properties |
| Font family | Single family strings (`STRING`) | Preserve fallback stacks & missing/preview font mapping |
| Font weight | Mapped natively | Bind all styles & verify licensed face availability |
| Duration (`ms`, `s`) | Mapped natively (`TIMING`, seconds internally, `ms`/`s` in UI) | Cross-mode timing verification |
| Cubic Bézier | Mapped natively (`EASING`) | Independent high-precision editing beyond float32 |
| Typography, Stroke, Border, Shadow, Gradient, Transition | Preserved intact in source files | Composite adapters with text/effect styles & field bindings |
| Aliases, JSON Pointers, `$extends`, `$root`, Resolver | Whole-token aliases mapped; pointers/`$extends` read-only | Multi-mode Resolver lifecycle (`MAP-02`, `MAP-03`, `MAP-05`) |

- [ ] **MAP-01 — Complete mapping coverage:** Verify each row above with unit, controller, and live Figma round trips.
- [ ] **MAP-02 / MAP-03 / MAP-05 — Multi-mode & multi-collection lifecycles:** Handle mode additions/removals/reordering, collection partitioning, and cross-collection aliases.
- [ ] **MAP-04 / MAP-06 — Token lifecycle & variable scoping:** Support safe creation, rename, move, deprecation, deletion, `$root` naming, and semantic Figma variable scopes.

---

## 7. Plugin & component library fidelity

- [ ] **PLUGIN-01 — Distribution:** Verify private organization plugin publishing and seamless version updates alongside local manifest installation.
- [ ] **PLUGIN-02 through PLUGIN-06 — Full plugin acceptance:** Complete live testing across all token types, accessibility/keyboard focus audits, dark/light themes, and ownership failure repairs.
- [ ] **KIT-01 through KIT-09 — Sevan Figma UI kit acceptance:** Complete all remaining Material component families (`36 sevan.comp.*` roots), typography weight bindings, prototype interactions, dynamic text wrapping, RTL/resizing, and cross-file library consumption tests.

---

## 8. Hosted deployment & verification gates

- [ ] **HOST-01 through HOST-09 — Production readiness:** Verify live Durable Object alarms, custom hostnames (`sevan.foundry.tokencatalog.dev`, `sevan.tokenfoundry.lindstruct.com`), GitHub OAuth callbacks, Cloudflare Access rules, payload/rate limits, rollback compatibility, and long-lived stale client transitions.
- [ ] **TEAM-01 through TEAM-06 — Library publication:** Confirm team seats, publish the approved Sevan library, test concept-file updates without instance detachment, and align `sevan-design-docs`.
- [ ] **QA-01 through QA-06 — Sustained performance & matrix completion:** Benchmark large workspaces (3,897+ tokens) end-to-end in browsers, verify leak-free sustained editing, and complete all remaining live SDK fault-injection scenarios.

---

## Acceptance matrix

End-to-end verification is complete only when each journey passes against real Figma, TokenFoundry, and GitHub services:

1. **First use:** Install plugin, sign in, open repository workspace, connect library/concept file, and inspect token references.
2. **Figma → GitHub:** Edit semantic color, spacing, duration, easing, and component override; inspect live canvas consumers; review and save PR.
3. **TokenFoundry → Figma:** Edit source tokens and context overrides; verify clean plugin update without losing local work or instance bindings.
4. **Concurrent edits:** Complete all conflict resolution options (`Use Foundry`, `Keep Figma`, custom value, custom alias) in both edit orders without manual JSON recovery.
5. **Interruption recovery:** Resume mid-pull, mid-save, post-reload, and post-grant-expiry with exact baselines and zero duplicated commits.
6. **Published library consumption:** Use the published kit in a standalone concept file, release a token update, and accept library updates cleanly.
