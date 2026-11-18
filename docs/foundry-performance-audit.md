# Foundry performance audit

Reviewed Foundry at `1330f07`. The original measurements are kept here as a baseline.

## Everyday interactions in the Example

The built-in Example has 10 tokens. I used it to check group navigation, pointer and keyboard focus, row selection, and command menus. The inspector was closed. Tests used Chromium at 1440 × 900 with a local Vite dev server and a local hosted production build. The browser recorded click or key time through the next paint. These timings are specific to this machine. The traces cover the first 400 ms after input and include extra recording overhead. [Chrome runtime trace documentation](https://developer.chrome.com/docs/devtools/performance/reference/#record-runtime-performance)

### Input timing

Median Event Timing durations in milliseconds, with Chromium tracing off. Each condition used eight clicks for group navigation and regular cell selection, four for the other actions except dismissal, and eight for dismissal. The 4× condition throttles CPU on the same machine.

| Action | Development preview | Production build | Production build, 4× CPU |
| --- | ---: | ---: | ---: |
| Switch between reference and All tokens | 124 | 40 | 152 |
| Click a cell and select its row | 132 | 48 | 192 |
| Arrow Down to the next Name cell | 160 | 32 | 140 |
| Ctrl-click to toggle a row | 104 | 44 | 172 |
| Toggle a row checkbox | 112 | 24 | 96 |
| Open File | 60 | 24 | 104 |
| Open a token’s three-dot menu | 124 | 48 | 176 |
| Dismiss a command menu with Escape | 48 | 24 | 80 |

To reproduce, open the built-in Example with the inspector closed. Switch from **All tokens** to **reference** and back. Click **ink** in the Name column and press Down. Click **paper** in the Value column, Ctrl-click **ink**, and toggle the **ocean** checkbox. Open **File** and the three-dot menu for **ink**. Close each menu with Escape. Record hover separately so its animation does not overlap the click. Compare development and built output under the same viewport and CPU conditions.

### What causes the delay

- [x] **A click can update the grid twice.** A native focus event selects the active cell on pointer down. The click selects the row and sets its active cell again. In one production trace, the browser focused the Name button about 1 ms after pointer down, then spent about 26 ms before the click handler could start. The click handler took another 27 ms. The development trace shows the grid, tree, and top command bar running during the same gesture. Keep keyboard focus independent from checked rows, but give pointer selection one state update. Only rebuild UI that uses that state. Keep the link action mounted or reserve its space so moving focus between rows does not change cell padding and add or remove a control. [Grid events](../editor/token-grid.tsx#L258), [Editor selection](../editor/main.tsx#L405)
- [x] **Arrow keys can stop on an action inside a cell.** Plain Right from the Name button moved focus to its three-dot menu button. The active cell stayed on Name. A user expecting the Value cell sees no cell movement. Give the grid one clear focus stop per cell and preserve keyboard access to commands with Shift+F10 and a deliberate way to reach the cell actions. The animation-frame focus code handles programmatic restoration after edits and jumps. The ordinary click path does not call it. [Grid event handlers](../editor/token-grid.tsx#L185), [Focus restoration](../editor/main.tsx#L341)
- [x] **Group navigation rebuilds the collection.** A switch changes the group and clears selection, resets scroll, and replaces rows. Chromium recorded removed and added grid nodes. The memoized tree also receives a fresh selection callback whenever the editor renders. Stabilize the tree’s props, make unchanged selection resets a no-op, and retain the grid’s row and cell identity where the visible rows overlap. [Group selection](../editor/main.tsx#L396), [Tree and grid assembly](../editor/main.tsx#L1098)
- [x] **Command menus do more than draw a rounded panel.** File and row menus mount a React Aria popover, calculate placement, manage outside interaction and background inertness, and move focus. Production traces counted about 16 ms of style recalculation for File and 26 ms for the row menu in the first 400 ms. Paint recording took under 1 ms in each. Disabling the shadow did not materially improve input timing in the test. Investigate one shared row menu and a positioning path with fewer style updates. Check keyboard navigation, Escape, outside click, and focus restoration when changing the overlay. [Command menu](../editor/command-bar.tsx#L18)

### What repaints

A pointer hovering over the **reference** group scheduled paint across successive frames. The development trace shows CSS animation invalidations on the list item and no React tree or grid render. On the 4× CPU run, suppressing CSS transitions and animations reduced median hover Paint records from **50 to 3** in the 400 ms window, recorded paint work from **5.7 ms to 0.9 ms**, and raster tasks from **50 to 2**. Group switches and selection also recorded fewer paints with motion disabled. Cell clicks still took a median 184 ms, compared with 192 ms with motion enabled. This points to two separate costs: editor and grid work before feedback, and paint work while feedback animates.

The trace reported paint clips for the sidebar and viewport-sized document layers. In one baseline hover the 50 raster tasks reused four tile IDs on the document layer. That confirms repeated tile work outside of a single paint event. A viewport-sized paint record alone does not measure how much of the viewport was rasterized. Removing the active-cell inset shadow and menu shadow in a separate test left the overall timings in the same range. Start with the focus and collection paths. Then check whether the Forge state-layer animation can keep paint within the affected row. Verify the visible focus ring and the full press and selection motion. [Cell styles](../editor/workspace.css#L308), [Menu styles](../editor/components/ui/primitives.css#L18), [Chrome paint and layers](https://developer.chrome.com/docs/devtools/performance/reference/#view-layers-information)

## Large workspaces

These tests used generated tokens in the Chromium development preview or isolated Node measurements. They describe the tested workloads.

| Workload | Measurement | What to change |
| --- | --- | --- |
| Import 10,000 or 30,000 simple tokens | First row appeared in 662 or 990 ms. Long tasks reached 340 or 456 ms. | Move parsing and graph construction off the main thread. Keep the graph or a revisioned cache in the worker so requests can reuse it. |
| Review one edit at 10,000 or 30,000 tokens | 168 or 403 ms in Node. | Extend the review worker to ordinary edits, moves, and deletes. Check what validation can reuse when one token changes. |
| Search with 2,000 root groups | 2.1 s elapsed. Chromium counted 704 ms of script, 10 ms of style recalculation, and 1 ms of layout. | Stabilize the callback passed to the memoized tree. Limit mounted branches. Index search fields once per graph. |
| Drag a pane in 12 pointer steps with 2,000 groups | 1.98 s elapsed. Chromium counted 1,459 ms of style recalculation and 235 ms of layout. | Reduce the mounted tree and coalesce width changes to animation frames. |
| Check bulk rename collisions | 149 ms at 5,000 names and 462 ms at 10,000 names in Node. | Count destinations in one pass. Paginate the preview and other selected-value lists. |

### Additional code findings

- [x] **Separate grid focus and selection from unrelated editor updates.** Cell focus and row checks currently go through the editor. The grid receives new callbacks on each render. Keep state close to its consumers and pass stable inputs to the sidebar and rows. The grid already limits display to 100 tokens per page. Inline and inspector drafts already keep most keystrokes local. The inspected effects synchronize focus, theme, and browser subscriptions. [Editor](../editor/main.tsx), [Token grid](../editor/token-grid.tsx)
- [x] **Cache variant resolution by workspace revision and selected choices.** Switching choices merges, links, and validates a new graph on the main thread. Comparison needs two graphs. Resolve in the worker and ignore superseded results when the user changes choices again. Compute the difference once per pair and paginate or virtualize the result. [Resolver](../lib/resolver.ts), [Variant comparison](../editor/resolver-pane.tsx)
- [x] **Reuse the link picker’s candidate index.** Every new picker scans the token graph and nested fields, although the displayed matches are paginated. Index field and type compatibility per graph. Perform dependency checks on candidates as needed. [Reference picker](../editor/reference-picker.tsx)
- [ ] **Test large hosted workspaces separately.** The Git-backed service currently allows 40 files, 512 KiB per file, and 2 MiB per workspace. Local import and hosted opening exercise different paths. [Git worker](../worker/github.ts)


## Implementation notes

- Cell clicks and arrow moves follow separate paths. Click focus waits for the click to select the row, which eliminates a separate editor update. Arrow navigation skips controls inside cells. Shift+F10 opens a single shared row menu and Escape restores the invoking cell. The grid reserves the same link space in each Value cell.
- The group tree receives a stable selection callback and limits the initial render to 80 siblings per branch. Pane movement applies at most one width update per frame. The group list has its own composited surface. In a local A/B test at 1440 × 900, this reduced the median hover raster tasks from 48 to 24 and kept the same shape and color motion.
- Large imports, literal edits, move reviews, delete reviews, bulk reviews, and variant resolution use browser workers. Variant results are cached for up to four choices per compiled configuration. Changing choices cancels an obsolete resolution. This reduces main-thread work. Graph construction and transferring the result still take time.
- Bulk rename counts duplicate destinations in one pass. The rename preview, bulk review, and variant comparison bound the number of mounted rows. The link picker reuses field enumeration across searches and dialogs in the same graph.


### Paired input timing after implementation

Both builds ran locally in Chromium with 4× CPU throttling. The figures are medians from the same scripted interactions.

| Action | Before | After |
| --- | ---: | ---: |
| Click a cell and select its row | 192 ms | 140 ms |
| Arrow Down to the next cell | 136 ms | 112 ms |
| Ctrl-click to toggle a row | 168 ms | 112 ms |
| Toggle a row checkbox | 96 ms | 92 ms |
| Switch groups | 148 ms | 152 ms |

The 10-token group switch still rebuilds the visible collection. The group tree limits the initial DOM size for larger workspaces. A separate Chromium verification imported and edited 10,000 tokens and switched a 10,000-token Resolver from Light to Dark and back. That run checked correctness under concurrent test load. The graph transfer and first render still contribute to the time before the new values appear.

The separate six-run row-menu comparison measured **200 → 184 ms** for opening and **96 → 112 ms** for Escape dismissal. Opening now updates only the shared popover. Dismissal restores the invoking cell. [Shared menu](../editor/command-bar.tsx)

## Large-workspace follow-up

The later audit used matched Chromium development builds at 1440 × 900, with no CPU throttling. The table reports the median of four input-to-paint samples per action and dataset. The generated workspace contained 40,000 literal tokens in 50 groups. The Material 3 sample contained 6,814 resolved tokens. Each grid page retained its 100-row limit.

| Action | Material 3 before → after | 40,000 tokens before → after |
| --- | ---: | ---: |
| Select a cell | 476 → 36 ms | 684 → 44 ms |
| Move focus with Arrow Down | 456 → 24 ms | 616 → 24 ms |
| Open the token editor | 684 → 52 ms | 768 → 56 ms |
| Select a cell with the editor open | 508 → 40 ms | 636 → 48 ms |
| Open Edit | 364 → 72 ms | 532 → 84 ms |
| Open a row menu | 516 → 68 ms | 612 → 80 ms |
| Navigate between groups | 484 → 116 ms | 720 → 200 ms |
| Open Workspace | 388 → 64 ms | 432 → 48 ms |
| Return to Tokens | 312 → 68 ms | 516 → 80 ms |

To repeat the measurements, use the same browser size and both development builds. Open the Material 3 sample or import a document with 50 groups of 800 DTCG dimension tokens each. After the first grid is ready, alternate between comparable groups. Time a click on an unselected cell, Arrow Down, opening the top or row menu, and opening the token editor with a selected row. Wait for menus and focus feedback to settle between actions. Record Event Timing without a CDP trace for the timing table and make a separate trace for attribution.

Chromium traced the baseline cell click to roughly 733 ms of JavaScript on the 40,000-token file, versus about 16 ms for style and paint combined. React Aria's focus path updated the table collection on ordinary pointer and keyboard actions. The native grid owns cell navigation and column resizing, while an external selection store notifies only affected rows. The group tree subscribes through the group map instead of passing the token graph to every branch. Search reuses normalized token strings and ordinary browsing slices directly into the indexed group range.

A separate CPU profile caught React's development profiler comparing large graph props recursively on a variant switch. That comparison alone took about 2.65 seconds on a 40,001-token Resolver. Large read-only render data now crosses those component boundaries by snapshot identity, with development checks enabled.

The Material 3 editor for a token with 442 direct consumers went from a 472 ms paint to 40 ms. The first page of references now renders after the editor controls. It mounts 24 entries per list and reuses a reverse index for the graph revision.

The worker retains bounded workspace snapshots, receives selected Resolver contributions, and returns changed source files with updated graphs. A warm Material 3 review request took less than 0.1 ms to post. Full validation across variants still took 1.16–1.67 seconds on the worker. Comparison and file diff generation also run there. Review tables and file diffs mount one page at a time.

A separate Chromium run imported 40,001 tokens with 8,000 aliases and measured from the start of each action until the expected resolved value appeared in the grid. Import took 2,096 → 1,459 ms, the first switch to Dark took 1,886 → 1,022 ms, returning to the default Light took 1,579 → 175 ms, and switching back to cached Dark took 610 → 70 ms. The cache keys variants by effective context, so choosing Light explicitly reuses the graph already built for the implicit default. These are single-run timings.
