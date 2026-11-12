# Token Editor

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

Click a cell to select it. Use the arrow keys to navigate, and double-click,
press Space, or press F2 to edit. Names, descriptions, and simple values
edit directly in the cell. Enter or Tab applies the edit and moves to the
next row or cell. Escape cancels. A reference opens the group tree and live
search. Structured values open a larger editor.

Drag the right edge of a column heading to resize it. Double-click that edge
to reset the width. You can also focus the resize handle and use the arrow
keys to resize or Enter to reset.

The grid toolbar creates tokens and groups, searches the current group,
and filters unresolved tokens. Selecting tokens enables Move and Delete there. The group menu handles moves and deletes for the current
group. The final review shows the affected files.

Open and export commands live under **File**. Use the sidebar icon to show or hide groups. The hosted editor
connects to GitHub under **Integrations**. To load the full MD3 benchmark in
the dev editor, set `MD3_TOKEN_BENCHMARK` to its local file path before
starting Vite and choose **File → Open Material 3 sample**.

**Unresolved** filters the current group to tokens whose references could not
be resolved. Select a cell and choose **References** to see the diagnostic.

Run the browser integration tests with `npx playwright install chromium firefox`
and `npm run test:browser`. Set `MD3_TOKEN_BENCHMARK` to the path of the
6,818-token Material 3 export to exercise the same unresolved-reference flow
at that size.

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
contents and then opens a pull request. The limit is 24 files and 2 MiB per
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

Run `npm run build:hosted -- --outDir .wrangler/staging-assets` and deploy with
`npx wrangler deploy --config wrangler.staging.jsonc` to a Cloudflare account
with Zero Trust enabled. The staging configuration serves the editor and Git
API from one Worker with the `workers.dev` route and preview URLs enabled.
When bootstrapping a new Worker, set `workers_dev` and `preview_urls` to
`false` for its first upload. In Cloudflare Access, protect this Worker for
**All traffic** with an allow policy for the pilot users before enabling the
URLs. The staging configuration preserves variables set in Cloudflare.

Set the Worker variables and secrets listed above for this staging deployment.
Use the main staging URL for `EDITOR_ORIGIN` and its `/git/callback` path for
the GitHub App callback. Use that URL for Git operations. Install the app on
the pilot repository and list it in `GIT_PROJECTS`. Verify that Access stops a
signed-out visitor and that an invited user can open the repository and submit
a reviewed pull request.
