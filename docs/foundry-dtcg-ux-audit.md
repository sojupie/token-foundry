# Foundry DTCG workflow audit

Reviewed Foundry at `1330f07` against DTCG 2025.10. The checklist tracks the changes made after the audit. The [editing UX checklist](foundry-ux-checklist.md) records which entry points exist.

Foundry often exposes the exchange format at the point where someone wants to make an edit. A token author needs to understand the target and effect of an action. Foundry can generate the corresponding file names, reserved keys, and references from those choices.

## Library and variants

- [x] **Keep editing available when a variant configuration is open.** In the Tokens view, a valid configuration with a required choice and no default can show zero rows and disable New token even when the authored library contains tokens. Choosing a variant restores rows, but bulk and structural actions are still unavailable. Provide **Edit library** and **Preview variant**. When a preview needs a choice, show which dimension needs one. Keep the inspector in the same mode as the grid.
- [x] **Make Set up variants create a usable variant.** The dialog asks for a name and adds every open token file to a base set. The user must then create a **New variant option**, which is a dimension such as Appearance, add choices such as Light and Dark, and add the dimension to **Order of overrides**. Let users choose base sources, name the dimension and choices, optionally set a default, and see when the dimension takes effect. Show order entries as file, set, or dimension names and explain that later entries win.
- [x] **Connect Compare variants to editing.** The differences table shows values but does not open the relevant token or override. Let a row open both values and their winning sources in the inspector. Offer the action that edits each source. Make it clear which side added or removed the token.

## Tokens, groups, and references

- [x] **Carry the Group value label through the workflow.** **Edit → Add group value** and **Groups → More actions → Add group value** already supply the reserved name. After creation, the grid and link picker display `$root`. A search for “group value” misses the token. Show **Group value** under its group in the grid, inspector, and picker. Put the actual path, such as `spacing.$root`, in **Copy token path** and source details. A group value is a distinct token and the group remains a separate object. [DTCG root tokens](https://www.designtokens.org/TR/2025.10/format/#root-tokens-in-groups)
- [x] **Use the typed editor when replacing a link.** In **Link a token → Enter a value**, typography opens a JSON textarea even though the inspector has structured typography fields. Give **Enter a value** and **Link a token** equal placement in the value editor. Reuse the same typed fields and keep raw JSON available under advanced controls.
- [x] **Name linked fields and offer direct repairs.** The picker and reference details show parts such as **Components / 0**. Diagnostics can open the source but offer few field-specific repairs. Share a field description across the inspector, picker, comparison, and diagnostics. Use names such as **Red**, **Font weight**, or **Gradient stop 1**, with the raw path available in details. Let an issue open the link picker or target field directly.
- [x] **Offer bulk fields from the type schema.** **Change value** omits Alpha if one selected color lacks an authored alpha. It can also show a suggested default that Review rejects as missing. Let the user choose any supported field and preview which rows will add it, replace it, or be skipped. For linked values, show the link and let the user choose whether to replace it. Distinguish a suggested value from one that will be applied.

## Sources and metadata

- [x] **Edit variant sources with forms.** **Add inline tokens** starts with a JSON textarea. **Add reference** accepts a raw string, and the pencil in **Order of overrides** opens JSON. Reuse the token grid and inspector for tokens inside a source. Add a picker for files, sets, and supported fragments. Serialize the selected target as a reference. Keep an advanced source editor for exact edits. [DTCG Resolver](https://www.designtokens.org/TR/2025.10/resolver/)
- [x] **Make the scope of group metadata clear.** A group can have definitions in several source files. The dialog remembers drafts per file but submits only the active file and closes after applying it. Show the definition and affected tokens, and preserve the other drafts or review them together. Offer namespace rows and structured extension fields when Foundry knows their schema.
- [x] **Generate file suffixes.** **Workspace → New source file** requires an accepted suffix as part of the typed path. Let the user pick a destination and enter a name. Derive the suffix from the file type and show the resulting path before review.

## Verification

Live Chromium checks covered the Group value label and search, composite literal replacement, a Resolver without a default, the raw order labels, and bulk Alpha on two colors. The rest of the findings come from tracing the current UI and its handlers. See [DTCG technical reports](https://www.designtokens.org/TR/2025.10/) for the exchange format and Resolver definitions.


## Implementation notes

- **Edit library** shows authored values even when a Resolver needs a choice. **Preferred source** resolves overlap in the library while keeping references to other open sources available. **Preview variant** shows the resolved combination. The comparison inspector can show both winners and make the compared choice active for editing.
- The setup dialog accepts a shared foundation, a first dimension with two choices, an optional source per choice, and an optional default. Manage variants can add more choices. Override order shows descriptive names and lets users replace named entries through the selector.
- **Group value** is searchable by name. **Copy token path** keeps the serialized path available. The link picker and reference details name fields. A broken whole-token link can open the linker from Workspace issues. Other value problems open the inspector. Field-specific repair still depends on the inspector, and raw source remains available.
- The inline source editor handles common typed token additions and edits. Advanced JSON remains available for full inline Resolver entries, structural changes such as renames inside inline sources, and arbitrary extension payloads. Extension namespaces can be added or removed without hand-editing the JSON object.
