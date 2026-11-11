# Token Editor

Open design token files or a folder, browse references across files, edit a token,
and review the file diff. Folder selection imports `tokens.json` and files
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

Choose **Open folder**, make and apply edits in the editor, then choose
**Review and save** to see the combined diff. On browsers with native
directory access, **Save to folder** asks for write access and saves the
reviewed changes to the existing files. The save checks for external edits
across the workspace, including files used by references. If writing stops
partway through, you can retry the same review to finish the remaining files.
Browsers with the standard folder picker can open the same files and
**Download patch**. **Download JSON** exports a copy of a single open file.

## Value proposals

Open the source token files, then choose **Open proposal** to review a JSON
batch from another tool. Version 1 accepts changes to existing token values.
The editor compares each `before` value to the open workspace and shows the
file diffs before applying the batch.

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

Connected workspaces read the default branch at a pinned commit. Proposals can
modify existing `*.tokens.json`, `*.tokens`, and `tokens.json` files inside the
configured folder. The Worker rechecks the default branch and original file
contents and then opens a pull request. The limit is 24 files and 2 MiB per
workspace, 512 KiB per file, and 16 changed files per proposal.

`npm run build:worker` validates the Worker bundle locally. The tests exercise
OAuth, authorization, repository reads and pull-request retries with mocked
providers.
