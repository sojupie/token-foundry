# DTCG 2025.10 conformance checklist

Conformance requirements for Token Foundry against the
[Format](https://www.designtokens.org/tr/2025.10/format/),
[Color](https://www.designtokens.org/tr/2025.10/color/), and
[Resolver](https://www.designtokens.org/tr/2025.10/resolver/) 2025.10
specifications. Use this checklist to verify new builds or rewrites across all
normal editor entry points and save/export paths.

## 1. Document validation and round trips

- [x] Validate file structure, token and group names, reserved keys, token vs. group shape, and `$root` placement.
- [x] Validate metadata types (`$description`, `$deprecated`, `$extensions`).
- [x] Resolve effective token type in spec order (explicit `$type` → reference target → closest group `$type`) and report missing effective types.
- [x] Validate all 13 scalar and composite value types, reporting the exact invalid field or array index.
- [x] Validate a reference target's declared type independently of its resolved value shape.
- [x] Apply the same validation rules across open, edit, paste, proposal import, and save review.
- [x] Surface workspace diagnostics with file, token/group, field, severity, and jump-to-source.
- [x] Keep valid entries editable while malformed or invalid entries remain repairable; preserve legacy values until edited.
- [x] Round-trip authored literals, references, source paths, metadata, unknown vendor `$extensions`, UTF-8 BOMs, and line endings across folder saves, patches, downloads, and hosted PRs.

## 2. Groups and metadata

- [x] Resolve `$extends` and group `$ref` (chained extensions, local overrides, inherited group types).
- [x] Diagnose missing or non-group extension targets, cycles, and invalid inherited overrides.
- [x] Display inherited children, local overrides, and their source locations in the tree and inspector.
- [x] Support choosing an extension target, overriding an inherited entry, and reverting to the inherited value.
- [x] Edit group descriptions and default `$type` with a preview of affected tokens and validation errors.
- [x] Edit token and group `$deprecated` (message and explicit `false` override) and namespaced `$extensions` without dropping unknown namespaces.
- [x] Create, inspect, and reference `$root` tokens without confusing them with their containing group.

## 3. References

- [x] Resolve document-scoped JSON Pointers across token values, object fields, array indices, metadata, and escaped segments.
- [x] Resolve nested/chained aliases and relative references from their defining document.
- [x] Track field-level dependencies and report exact paths for missing targets, type mismatches, and cycles.
- [x] Pick whole tokens or compatible fields in the reference picker and write the matching alias or JSON Pointer.
- [x] Show authored pointer, resolved value, target field, and direct/downstream consumers in the inspector.
- [x] Preserve reference syntax and suffixes across rename, move, duplicate, and file relocation; warn and block before breaking links on delete.

## 4. Scalar, color, and composite editors

- [x] Typed editors for numbers, dimensions, durations, font families (with fallback order), font weights, and cubic Bézier curves.
- [x] Color editor supporting all 14 Color Module spaces, alpha, `none` components, optional fallback hex, and display-gamut warnings without altering stored coordinates.
- [x] Typed editors for stroke styles (keywords or dash array + line cap), borders, transitions, multi-layer shadows, multi-stop gradients, and typography (with live previews).
- [x] Switch reference-capable fields between literal and link without resetting sibling fields; retain a raw JSON view with field-level diagnostics.

## 5. Resolver and contexts

- [x] Open, create, validate, and save versioned Resolver documents alongside their source files.
- [x] Author named sets, ordered sources (inline tokens and document references), modifiers, contexts, defaults, and `resolutionOrder` with cycle/duplicate diagnostics.
- [x] Select and validate context inputs, applying precedence before alias resolution and showing which file/set/modifier won and what it overrode.
- [x] Edit shared definitions and context overrides against the right source; compare two contexts (changed, added, removed, invalid).
- [x] Export either the authored resolver + sources or a resolved token snapshot for a chosen context, and preview cross-context impact during review.

## 6. Editor workflows

- [x] Workspace-scoped undo/redo for edits, structural changes, and bulk transactions.
- [x] Duplicate and copy/paste tokens and groups with collision handling and reference-rewrite previews.
- [x] Bulk field edits and validated replacements with affected-record review.
- [x] Create, rename, move, and delete source files and token sets, rebasing inbound/outbound pointers.
- [x] Combined review showing authored changes, resolved changes, broken links, and downstream impact across local save, patch download, and hosted PRs.
