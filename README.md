# Token Foundry

Open design token files or a folder, edit tokens in the table, and review the file diff. Folder selection imports `tokens.json` and files
ending in `.tokens.json` or `.tokens`. It preserves their relative paths
and skips `.git`, `node_modules`, and `dist` within the selected folder.
The built-in example uses two files.

```sh
npm ci
npm run check
npm run dev
```

Use Node.js 24. `npm run build` produces a static site under `dist/`.
The editor parses files in the browser. The workspace model accepts paths and
file text and produces reviewed changes. The React UI handles file selection and
downloads.

Choose **Open token folder…**, make and apply edits in the editor, then choose
**Review and save** to see the combined diff. On browsers with native
directory access, **Save to folder** asks for write access and saves the
reviewed changes to the existing files. The save checks for external edits
across the workspace, including files used by references. If writing stops
partway through, you can retry the same review to finish the remaining files.
Browsers with the standard folder picker can open the same files and
**Download patch**. Run `git apply token-changes.patch` in your checkout.
**Download token JSON** exports a copy of a single open file.

Use the arrow keys to move between rows, checkboxes, and cells. Press Space
to check a row. Press Escape to clear selection while keeping your place.
Double-click a cell or press Enter or F2 to edit. Names, descriptions, and
simple values edit in the cell. In that editor, Enter applies the edit and
moves down. Tab applies it and moves to the next editable cell. Escape cancels
and returns focus to the cell. References and structured values open an
anchored editor.

Drag the right edge of a column heading to resize it. With the keyboard, focus
the resize handle, press Enter, adjust the width with the arrow keys, then
press Enter to finish.

The grid toolbar creates tokens and groups, searches the current group,
and filters unresolved tokens. Selecting tokens enables Move and Delete there. The group menu handles moves and deletes for the current
group. The final review shows the affected files.

Open and export commands live under **File**. Use the sidebar icon to show or hide groups. The hosted editor
connects to GitHub under **Integrations**. **File → Open Material 3 sample**
opens the full Token Catalog tree and six Light/Dark and contrast combinations.
Use **Preview variant** to switch appearances, or **Workspace → Manage variants**
to inspect the shared sets and appearance sources.

To refresh the bundled sample from a Catalog publication, pass its DTCG
export directory (the directory containing `index.json`) to
`node scripts/build-material-sample.ts /path/to/published/assets/dtcg`.
The script checks that each appearance reconstructs its original export.

**Unresolved** filters the current group to tokens whose references could not
be resolved. Select a cell and choose **References** to see the diagnostic.

Run the browser integration tests with `npx playwright install chromium firefox`
and `npm run test:browser`. Set `MD3_TOKEN_BENCHMARK` to the path of the
6,818-token Material 3 export to exercise the same unresolved-reference flow
at that size. In a dev build, this also enables **File → Open Material 3 benchmark**.

## Work on the UI

Foundry is a React and Vite app for editing DTCG token files. Start in
[`editor/main.tsx`](editor/main.tsx) for the workspace and
[`editor/token-grid.tsx`](editor/token-grid.tsx) for cell editing.
The `lib/` directory owns token parsing, references, and reviewed file
changes. The UI owns focus, drafts, and review state.

Use `@token-catalog/forge-react` for buttons, icon buttons, text fields,
links styled as buttons, and native dialogs. Import the package stylesheet
once. Place `data-component-assets` on the workspace root and on any portal
surface that renders Forge controls outside it. Set both `data-theme` and
`data-contrast` on the document element to select a Forge theme.
The file open in the editor supplies token data for the table. The Forge
package supplies the theme of the editor itself.

React Aria owns grid navigation, row selection, resizing, command menus, and
the anchored cell editor. Keep the grid's focused cell independent of the
checked rows. Use Forge color roles for styles in
[`editor/components/ui/primitives.css`](editor/components/ui/primitives.css).
Keep Foundry-specific layout in [`editor/workspace.css`](editor/workspace.css).

If a change only affects this workspace or token editing, make it here.
For a shared primitive or a Forge style or behavior change, edit the source in
the [Forge React package](https://github.com/sojupie/tokens/tree/main/forge/react)
and follow its build guide. Then copy the new versioned tarball into
`vendor/` and install it from the Foundry root. Replace `VERSION` with the tarball version.

```sh
npm install "./vendor/token-catalog-forge-react-VERSION.tgz"
```

Remove the superseded tarball and commit the new tarball, `package.json`, and
`package-lock.json` together. Foundry builds from that pinned package, so it
can build on its own. Run `npm run check`, `npm run build`,
`npm run build:hosted`, and `npm run test:browser`. For changes to the grid
or a popup, test keyboard navigation, selection, Escape, and focus return.

## Import value changes

Foundry matches changes by token path in the current workspace. Open the files
that contain those tokens together. Choose **File → Import value changes…** and select
`token-proposal.json` from your Figma token plugin or a JSON file in the format
below. Review the old and new values, then apply the changes.
Your other edits stay in place. If an old value differs from the open value,
the import stops and names the token. Apply downloaded `.patch` files with Git.

```json
{
  "schemaVersion": 1,
  "changes": [
    { "path": "reference.space.small", "before": { "value": 8, "unit": "px" }, "after": { "value": 12, "unit": "px" } }
  ]
}
```

A producer can also open the editor with the same JSON encoded as
`#proposal=<percent-encoded JSON>` (up to 8,000 encoded characters). The editor
removes the fragment from the address bar and keeps the proposal in memory for
review. Opening this URL leaves the workspace and Git untouched.

## Public build

Run `npm run deploy:public` to build and deploy the local-file editor to
[tokenfoundry.lindstruct.com](https://tokenfoundry.lindstruct.com/). The command
uses `wrangler.public.jsonc` and updates the `token-foundry` Worker. GitHub Actions
checks changes. Deploy from a clean checkout with Wrangler signed in to the
Cloudflare account that owns the Worker.

## Hosted Git

`npm run build:hosted` enables the GitHub connector. Serve its `dist/` as static
assets. Deploy the Worker separately and route only `your-editor-host/git/*` to
it. Protect that route with Cloudflare Access before exposing it. Add the invited
email addresses or organization group to the Access policy. The public editor
loads and edits local files with no API calls. The Worker checks the Access JWT
on each Git request. The default configuration disables alternate Worker URLs.

Register a GitHub App with repository **Contents** and **Pull requests** read
and write permissions. Set its user authorization callback to
`https://your-editor-host/git/callback`. Install it on the intended repositories
only. Each signed-in GitHub user must already have the repository permissions
needed for the proposed action.

| Worker setting | Value |
| --- | --- |
| `EDITOR_ORIGIN` | The HTTPS editor origin, without a trailing slash |
| `ACCESS_ISSUER` | The Cloudflare Access team origin, `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | The Access application's audience tag |
| `GIT_PROJECTS` | A JSON object mapping exact GitHub repository names to token folders, such as `{"org/design-system":"tokens"}` |
| `GITHUB_CLIENT_ID` | GitHub App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret, set as a Worker secret |
| `GIT_SESSION_KEY` | A random 32-byte key encoded as unpadded base64url, set as a Worker secret |

After signing in, the editor shows your GitHub account and the configured
repositories available through the GitHub App. Choose a repository to open it.

Connected workspaces read the default branch at a pinned commit. Proposals can
modify existing `*.tokens.json`, `*.tokens`, and `tokens.json` files inside the
configured folder. The Worker rechecks the default branch and original file
contents and then opens a pull request. The limit is 40 files and 2 MiB per
workspace, 512 KiB per file, and 16 changed files per proposal.

If the base revision changes during review, choose **Review latest revision**.
The editor retains changes to files that still match their original contents
and recalculates the diff and resolved values against the latest snapshot.
If the repository also changed one of those files, download the original patch
to reconcile it. Opening a pull request requires confirming the refreshed review.

`npm run build:worker` validates the Worker bundle locally. The tests exercise
OAuth, authorization, repository reads and pull-request retries with mocked
providers.

### Invite-only staging

Run `npm run deploy:sevan` to build and deploy the private editor and Git API to
[sevan.tokenfoundry.lindstruct.com](https://sevan.tokenfoundry.lindstruct.com/).
The command updates the `token-foundry-staging` Worker using
`wrangler.staging.jsonc`.

Before the first deploy to that hostname, add
`https://sevan.tokenfoundry.lindstruct.com/git/callback` to the GitHub App's
callback URLs. Protect the Worker in Cloudflare Access for **All traffic** before
attaching its custom domain. Set the Worker variables and secrets above in
Cloudflare. The Wrangler config sets `EDITOR_ORIGIN` and keeps the other
dashboard variables. Manage both Foundry custom domains in **Domains & Routes**.
Both deploy configs disable the `workers.dev` and version URLs.

After deploying, check that the Sevan editor asks signed-out visitors to sign in.
As an invited user, connect GitHub and open the configured repository. Use the
custom domain when starting a new GitHub session.
