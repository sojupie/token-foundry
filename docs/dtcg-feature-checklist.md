# Foundry DTCG 2025.10 feature checklist

Scope covers the stable [Format](https://www.designtokens.org/tr/2025.10/format/),
[Color](https://www.designtokens.org/tr/2025.10/color/), and
[Resolver](https://www.designtokens.org/tr/2025.10/resolver/) modules and the
editor workflows from the audit. Check items off when the normal editor
entry points and relevant export or save paths have been verified.

## 1. Document validation and round trips

- [x] Validate file structure, token and group names, reserved keys, token vs group shape, and `$root` placement.
- [x] Validate token and group metadata types, including `$description`, `$deprecated`, and `$extensions`.
- [x] Validate explicit type names and apply the effective type order (explicit token type, reference, closest group type). Report a missing effective type.
- [x] Validate all scalar and composite values and report the specific invalid field or array index.
- [x] Validate the declared type of a reference target independently of the shape of its resolved value.
- [x] Use the same rules when opening, editing, pasting, importing a proposal, and reviewing changes.
- [x] Show a workspace diagnostics list with file, token or group, field, severity, and navigation to the source.
- [x] Keep valid parts of an opened workspace repairable when other entries have diagnostics. Preserve legacy values until explicitly changed.
- [x] Round-trip authored literals, references, source paths, metadata, and unknown vendor extensions through every save and export path.
- [x] Validate all of the above with positive and negative Format examples and regression fixtures for existing token sets.

## 2. Groups and metadata

- [x] Resolve `$extends` and group `$ref` according to the Format rules, including chained extensions, local overrides, and inherited group types.
- [x] Diagnose missing or non-group extension targets, cycles, and invalid inherited overrides.
- [x] Show inherited children, authored overrides, and their source locations in the tree and inspector.
- [x] Let users choose an extension target, override an inherited entry, and remove an override to inherit again.
- [x] Show and edit group descriptions and default types, and preview which tokens a group type change affects.
- [x] Show and edit token and group deprecation, including an explanation and the explicit `false` override.
- [x] Show and edit namespaced extension data while preserving every unknown namespace.
- [x] Create, inspect, and reference `$root` tokens without confusing them with the containing group.

## 3. References

- [x] Implement document-scoped JSON Pointer traversal for token values, object fields, array indices, metadata, and escaped path segments.
- [x] Resolve nested and chained aliases and relative references from the correct source document.
- [x] Track dependencies at field granularity and report the exact path in missing-target, type mismatch, and cycle diagnostics.
- [x] Let the reference picker choose a whole token or compatible field and write the corresponding alias or pointer.
- [x] Show the authored pointer, resolved value, target field, and direct and downstream consumers in the inspector.
- [x] Preserve reference syntax and target suffixes across rename, move, duplicate, and file relocation. Review broken links before deleting a target.
- [x] Test references to inherited tokens, whole composites, fields, array elements, and references across source files and contexts.

## 4. Scalar, color, and composite editors

- [x] Provide typed editing for numbers, dimensions, durations, font families (including fallback order), font weights, and cubic Bézier curves.
- [x] Provide a color-space selector and space-specific component fields for every Color module space.
- [x] Edit alpha, missing components (`none`), and the optional fallback hex independently.
- [x] Preview authored colors and indicate display-gamut fallback while preserving the stored source values.
- [x] Edit stroke keywords or structured dash patterns and line caps.
- [x] Edit borders with color, width, and stroke style fields.
- [x] Edit transitions with duration, delay, and a timing-curve preview.
- [x] Edit shadows as a single shadow or a list of layers, with add, remove, reorder, and preview.
- [x] Edit gradients with add, remove, and reorder for stops, plus position, color, and preview.
- [x] Edit typography with font family, size, weight, spacing, and line height, with a live sample.
- [x] Let reference-capable fields switch between a literal and a compatible link without resetting sibling values.
- [x] Keep a raw JSON view with field-level diagnostics.
- [x] Verify each editor through create, edit, reopen, round-trip, reference selection, and keyboard flows.

## 5. Resolver and contexts

- [x] Recognize, open, create, validate, and save versioned Resolver documents.
- [x] Author named sets and ordered sources, including inline tokens and referenced documents.
- [x] Author named modifiers, contexts, context sources, and defaults.
- [x] Author `resolutionOrder` and inline entries, with diagnostics for invalid references, cycles, and duplicate names.
- [x] Select and validate context inputs and apply the specified precedence before resolving aliases.
- [x] Show which file, set, and modifier supplied the winning value and which sources it overrode.
- [x] Edit shared definitions and context overrides as explicit operations targeting the right source.
- [x] Compare two selected contexts and show changed, added, removed, and invalid tokens.
- [x] Export the authored resolver and sources or a resolved token snapshot for a chosen context.
- [x] Preview the impact of an edit in other contexts and add multi-context acceptance fixtures.

## 6. Editor workflows

- [x] Undo and redo authored edits, structural operations, and bulk transactions.
- [x] Duplicate and copy/paste tokens and groups, with collision handling and a preview of destination and reference changes.
- [x] Apply a field edit or validated replacement to selected tokens with a review of affected records.
- [x] Create, rename, move, and remove source files and token sets and update affected source references.
- [x] Carry multi-file changes through local saves, downloads or patches, and hosted review.
- [x] Show authored changes, resolved changes, broken links, and downstream impact in one review.
- [x] Verify ordering, selection, focus restoration, cancellation, and failure recovery for these operations.

## Implementation status

### Section 1 review

- Document diagnostics cover malformed entries, mixed token/group shapes,
  metadata, reserved names, conflicting source definitions, and invalid values.
  Foundry preserves source text and opaque vendor metadata. Diagnostics can jump
  to the token or group or open a source draft at the offending value.
- Workspace review blocks newly invalid values and structural diagnostics and
  carries existing metadata diagnostics to the new location on moves and renames.
  Nested aliases and whole-token pointers are checked against their declared types.
- Terra reviewed the section and inspected the rendered diagnostics. The CUA
  browser could reach Foundry. The invalid fixture needed an isolated Playwright
  browser because CUA lacked file-upload permission. Findings led to support for
  valid inset shadows, a visible diagnostics entry, editable source repair,
  repairable duplicate paths, and relocation-aware diagnostic checks. Follow-up
  testing verified that renaming a token preserves an existing unresolved
  reference diagnostic, and that source repair scrolls to a selected error in
  a long file, retains the draft when leaving review, and clears repaired errors.
- A malformed or duplicate-key file now stays available for source repair
  while valid files remain editable. The diagnostics list records parse offsets
  and all detected fields in invalid composites. File repairs can clear
  individual existing errors. Review names files whose references could not
  be checked, and final and refreshed review accept previously reviewed
  relocations with existing diagnostics.
- Terra inspected this follow-up in the computer-use browser and verified
  fixture rendering in isolated Firefox due to the upload permission limit.
  Its save-review and unchecked-reference findings have regression coverage.
- Positive and negative fixtures cover all 13 types and exact failing fields.
  They compare validation in source edits, token edits, paste, bulk edits, and
  imported proposals. Raw Resolver source and final save review now validate
  affected manifests, including combinations of active modifiers. Hosted
  proposals use the same validation before creating a branch. Existing
  diagnostics stay repairable, and unreferenced token files are checked with
  access to open linked definitions.
- Round-trip checks cover UTF-8 BOMs, CRLF, exponent spelling, references and
  opaque extensions in raw downloads and hosted commit bytes. Browser tests
  also cover folder writes, applicable patches and Resolver source bundles.
- Standalone JSON Pointers use the file they name when contextual sources
  define the same token path. Type checks and dependent-token inspection
  follow that definition through nested references. An unqualified alias
  reports ambiguity when the open files contain multiple targets.
- A browser worker handles raw source, Resolver authoring, and final save
  review. Validation reuses equivalent source choices and repeated composed
  graphs. The review groups identical impacts, with all matching context
  labels available. Hosted proposals validate within the request, so cost
  still grows with the number of distinct combinations.
- Terra reproduced the scoped reference issue and confirmed the fix. In the
  browser it verified that worker-backed review reports invalid fields and
  broken dependants and keeps Apply unavailable while they remain.

### Section 2 review

- Group extensions resolve inherited groups and tokens by alias or pointer.
  Nested groups merge and a local token replaces its inherited definition.
  Foundry reports invalid targets, extension cycles, and values that fail
  inherited constraints.
- Group actions open metadata for the selected group and source. The editor
  exposes inherited descriptions, vendor extensions, default types, and
  deprecation. A type change previews affected tokens and any validation
  errors before it can be applied. Unedited extension data stays in its
  original file.
- An inherited token shows its source. Editing it creates a local override
  after review. **Use inherited value** removes the override. Structural
  reviews list inherited paths they add, remove, or redirect. The grid
  and reference finder address root tokens by their explicit `$root` path.
- Terra inspected the metadata dialog in the computer-use browser. In isolated
  Firefox, it verified inherited metadata, type-change diagnostics and the
  disabled Apply button, and inheritance impact on deletion after its findings
  were fixed. Browser tests on Chromium and Firefox cover choosing a base,
  overriding and restoring a token, and creating and linking to a root token.
- Section 3 covers tested reference rewrites through inherited paths.
  Context-aware inheritance still needs verification in Section 5.

### Section 3 review

- References resolve through object properties, array indices, metadata, and
  escaped names. Field traversal follows aliases without resolving unrelated
  fields in the target token. Diagnostics list each broken authored field.
- The finder offers compatible whole tokens and fields, including independent
  fields of a partially unresolved token. The inspector displays authored
  links, source and target fields, resolved values, and direct and downstream
  consumers.
- Renames and moves rewrite references through inherited paths, including
  inherited children of locally edited groups. Duplicate updates links inside
  the copy. A move or deletion that would break references shows them in
  review and disables Apply.
- Terra inspected field selection with computer use and independently
  verified a cross-file link and its inspector. Follow-up checks cover alias
  provenance, safe field selection, and inherited move and rename reviews.
- File relocation and references across Resolver contexts remain open.
  The duplicate command is available. Clipboard copy and paste remain part
  of Section 6.

### Section 4 review

- The token form and inspector provide structured controls for all 13 DTCG
  types. Color, shadow, gradient, timing, and typography previews sit above
  the controls. Gradient stops and shadow layers expand individually, and
  ordered fields can be added, removed, or moved with the keyboard.
- The color editor supports all 14 Color Module spaces. Alpha, missing
  components, and fallback hex can be edited independently. The display
  uses the authored fallback when appropriate. A conversion that clips
  coordinates shows a warning and can be undone before applying.
- Nested fields can link to compatible values, including independent fields
  in the same token. Returning a field to a literal keeps its siblings.
  Switching type keeps a separate unsaved draft per type. The Raw JSON view
  keeps the authored representation and reports the fields that fail
  validation.
- Terra inspected the color, gradient, and shadow forms with computer use.
  Isolated Firefox verified type-switch recovery, authored links surviving
  shadow reordering, preserved legacy coordinates, and conversion warning
  and undo. Unit tests cover the display and conversion behavior of all
  color spaces.
- Chromium and Firefox created and reopened all 13 types, linked each
  through the finder, and downloaded and reopened the authored JSON.
  Browser regressions also cover field edits, keyboard-driven reordering,
  in-token links, and the live preview of an unsaved linked field.

### Section 5 review

- The Resolver workspace opens and creates versioned manifests alongside their
  sources. It supports active and comparison inputs, ordered resolution,
  diagnostics, token provenance, source editing, and contextual overrides.
- Named sets and modifiers have structured source lists, document and set
  pickers, source ordering, inline token JSON, context editing, and a default
  context selector. Removing a source or context returns focus to its add
  control. Contexts show their source count while collapsed.
- Authored export bundles the manifest and referenced files. Resolved export
  materializes aliases and inherited values and retains group metadata and
  empty groups. Edit review shows the active and selected comparison inputs
  and single-modifier alternatives. Other combinations appear when they have
  changes or newly introduced diagnostics.
- A new Resolver stays in the original workspace with its edit history and
  save target. Chromium saved it through the folder workflow. Chromium and
  Firefox exported a patch that Git applied as a new file. The hosted Worker
  test exercised a new Resolver proposal and retry against a mocked GitHub
  API. Optional remote source loading remains outside this checklist item.
- Terra inspected creation and authoring in the browser. Follow-up fixes retain
  form drafts when returning from review, distinguish tokens named
  `sources` or `contexts` from Resolver entries, preserve inherited group
  members during merges, and retain group metadata and empty groups in snapshots.

### Section 6 review

- Workspace source management creates, renames, moves and removes files through
  review and history. File moves rebase inbound and outbound document pointers
  and preserve opaque extension metadata, line formatting and UTF-8 BOMs.
  Local paths support spaces and Unicode.
- Resolver set rename updates references, including pointers from another
  manifest. Removal review lists links that would break and blocks applying those
  changes until the links are repaired. Moving a set between manifests rebases
  relative sources and consuming references and keeps both orders intact.
  Terra verified the destination, rename collision, review, Back to edit, and
  focus restoration. Chromium and Firefox applied the exported move patch.
- Terra inspected the source and set workflows in the browser. Follow-up fixes
  preserve UTF-8 BOMs on disk, allow local filenames with spaces and Unicode,
  and restore focus to the moved source after review.
- Git applied patches containing additions, modifications and removals.
  Chromium's folder test verified a move and byte preservation. The mocked
  GitHub test verified a file move and safe retry.

- Bulk editing supports whole values, existing nested value fields, token
  types, and descriptions across source files. Review shows before and after
  for the selected records, authored file changes, and downstream resolved
  changes. Any invalid selected edit blocks the batch. Chromium and Firefox
  covered Back to edit, Apply, focus and selection restoration, Undo, and Redo.
- Terra checked the bulk dialog and review in the browser. Validation now
  checks a referenced field’s declared type even when a sibling reference
  remains unresolved. A compatible replacement retains the existing sibling
  diagnostics.


- Copy and paste capture authored token and group definitions with their
  original reference scopes. Paste supports keyboard clipboard events and
  command menus, proposes collision-free names, and previews the destination,
  rewritten references, and broken links. Duplicate and Paste keep original
  definitions intact and support inherited entries.
- Terra checked copying and applying a group in the browser. Paste now
  reveals the selected destination in a collapsed branch. Chromium and
  Firefox covered selection copy, name collisions, backing out of review,
  applying, and focus restoration. Unit tests cover cross-workspace group
  fragments and inherited references. The full workflow suite passed in both
  browsers, with browser-specific folder tests skipped where not applicable.

### Other implemented paths

- **Edit → Undo / Redo** works for applied workspace changes, including value
  edits and group creation. History is scoped to the current workspace.
