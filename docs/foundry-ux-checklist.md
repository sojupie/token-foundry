# Foundry editing UX checklist

Foundry presents a token library with groups, tokens, and variants. Source
files remain available for storage, Git, exact JSON repair, and export.

## Library and variants

- [x] Keep one token grid, group tree, and inspector when a Resolver is open.
- [x] Put Set up variants and Manage variants in the library. Keep the manifest
  editor available for advanced setup.
- [x] Show named variant options above the grid. Compare two selections using
  their names and show changed, added, removed, and invalid tokens.
- [x] Show Shared value or the named override next to the value being edited.
  Offer Edit shared value and Override for the selected option.
- [x] Show source history under Where this value comes from.
- [x] Use Token sets, Variant options, Default option, and Order of overrides in
  setup. Keep sets distinct from files and groups.
- [x] Keep file actions in Workspace. Infer the destination for a new token when
  unambiguous and ask when the group has multiple possible sources.

## Tokens and groups

- [x] Label the rich editor Edit token. Open it by tapping the name on narrow
  screens and retain desktop inline editing.
- [x] Show the origin of an inferred token type. Disclose advanced color fields.
- [x] Make choosing a linked token and entering a value clear alternatives.
  Show linked field names and label indirect uses plainly.
- [x] Show resolved values where links or variants change the result. Keep the
  full resolved-value column on desktop.
- [x] Name the group targeted by its menu and keep New group easy to find.
- [x] Use Inherit from group and Mark as not deprecated. Keep description in
  normal editing and put vendor extensions in advanced metadata.
- [x] Offer Add group value for a group's root token.
- [x] Show labeled bulk actions with the number selected. Retain move and paste
  collision review and identify deleted tokens and broken links.

## Issues, review, and export

- [x] Show Issues above the grid and provide an explicit Open source action.
- [x] Distinguish Apply to workspace from Save to folder, Download patch, and
  Create pull request. Put token changes, broken links, and variant effects
  before the file diff.
- [x] Label proposal import and editable ZIP export by what they contain. Name
  the selected variant combination when exporting resolved tokens.

## Top command menu

- [x] Include File, Edit, View, and Variants with the applicable open, save,
  import, export, editing, visibility, diagnostics, and variant commands.


## Editing scope

Variant rows open the scoped value editor. Shared values and overrides update
their authored source through review. Group metadata, bulk edits, and structural
moves remain available in the authored token workspace. In a variant workspace,
use Workspace → Source files for structural or source-level repairs.
