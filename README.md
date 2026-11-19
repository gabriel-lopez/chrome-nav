# chrome-nav

A CLI to drive a real Chrome instance via the Chrome DevTools Protocol (CDP). Navigate, click, type, scroll, take screenshots, extract DOM/text, evaluate JS, and read console and network logs, all from the shell. It is a stand-in for the "Claude in Chrome" extension when that isn't available.

## How it works

`chrome-nav start` launches Chrome with remote debugging enabled and a background daemon that holds a Playwright CDP connection. Every other command is a thin client that sends a request to the daemon and prints the JSON result. The daemon keeps tab state and buffers console and network events between calls.

Runtime files live in `~/.chrome-nav/`:

| Path | Purpose |
| --- | --- |
| `profile/` | Chrome user-data-dir (cookies and logins persist across restarts) |
| `screenshots/` | Default screenshot output |
| `traces/` | Default trace output |
| `state.json` | Ports, PIDs, and the daemon auth token (mode 0600) |
| `daemon.log`, `chrome.log` | Logs |

Set `CHROME_NAV_HOME` to use a different runtime directory (separate state, token, and profile), e.g. to run an isolated instance alongside your normal one.

## Setup

```sh
npm install
npm run build      # bundles to build/app/cli.cjs
npm run dev -- <command>   # run from source via tsx
```

Building or running from source requires Node.js 22.12 or newer. Browser commands require a local Chrome or Chromium. If it isn't found automatically, set `CHROME_NAV_BINARY` to the executable path.

## Releases

Download `chrome-nav-macos-arm64` and `chrome-nav-macos-arm64.sha256` from [GitHub Releases](https://github.com/gabriel-lopez/chrome-nav/releases). From the download directory:

```sh
shasum -a 256 -c chrome-nav-macos-arm64.sha256
chmod +x chrome-nav-macos-arm64
./chrome-nav-macos-arm64 --help
```

The binary is a single file that includes Node, so no separate Node install is needed. No npm package is published.

### Publishing a release

CI checks pull requests and pushes to `main`. Releases run on version tag pushes. Update the version in `package.json` and `package-lock.json` (for example with `npm version <version> --no-git-tag-version`), commit it to `main`, then tag and push:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds the native binary on a macOS arm64 runner (a Node.js single executable application, see `sea-config.json`) and publishes the binary, its SHA-256 checksum, and generated release notes to GitHub.

## Usage

```sh
chrome-nav start --url https://example.com   # add --headless for no window
chrome-nav tabs
chrome-nav navigate https://example.com
chrome-nav click "text=More information"
chrome-nav type "input[name=q]" "hello" --enter
chrome-nav text --selector h1
chrome-nav screenshot out.png --full-page
chrome-nav eval "document.title"
chrome-nav console --tail 20
chrome-nav network --filter /api/
chrome-nav stop
```

### Commands

| Command | Description |
| --- | --- |
| `start` | Launch Chrome and the daemon (`--headless`, `--url`, `--chrome-port`, `--daemon-port`, `--profile`, `--no-eval`) |
| `stop` | Shut down the daemon and the managed Chrome |
| `status` | Show connection status and open tabs |
| `tabs` | List open tabs |
| `open-tab [url]` | Open a new tab and make it active |
| `switch-tab <id>` | Set the active tab |
| `close-tab <id>` | Close a tab |
| `navigate <url>` | Go to a URL (`--wait-until load\|domcontentloaded\|networkidle\|commit`) |
| `back` / `forward` | History navigation |
| `snapshot` | List visible interactive elements with refs like `@e3` (`--limit`) |
| `click <selector>` | Click an element |
| `hover <selector>` | Hover over an element |
| `type <selector> <text>` | Fill a field (`--enter` to submit) |
| `press <key>` | Press a key such as `Escape` or `Control+A` (`--selector` to target an element) |
| `select <selector> <values...>` | Choose options in a `<select>` by value or label |
| `check` / `uncheck <selector>` | Toggle a checkbox or radio button |
| `upload <selector> <files...>` | Set files on a file input |
| `drag <from> <to>` | Drag one element onto another |
| `scroll` | Scroll the page or an element into view (`--selector`, `--x`, `--y`) |
| `wait [selector]` | Wait for an element (`--state`), `--text`, `--url`, or `--load-state` (plus `--timeout`) |
| `screenshot [path]` | Save a PNG (`--full-page`) |
| `text` | Visible text of the page or a selector (`--selector`, `--max-length`) |
| `dom` | HTML of the page or a selector (`--max-length`) |
| `eval <code>` | Evaluate JS in the page and print the result |
| `console` | Dump buffered console logs (`--tail`, `--clear`, `--follow`) |
| `network` | Dump buffered network requests (`--tail`, `--filter`, `--clear`, `--follow`) |
| `trace start` / `trace stop [path]` | Record a Playwright trace (DOM snapshots, screenshots, actions) to a `.zip` |

Most commands accept `--tab <id>` to target a tab other than the active one. Selectors use Playwright syntax: CSS, `text=Sign in`, `role=button[name=Submit]`, and so on.

### Snapshot refs

`chrome-nav snapshot` stamps each visible interactive element with a ref (`@e1`, `@e2`, ...) and lists its role, accessible name, and state. Pass a ref anywhere a selector is accepted:

```sh
chrome-nav snapshot
chrome-nav type @e4 "hello"
chrome-nav click @e1
```

Refs are valid until the next `snapshot` or a page navigation. A stale ref fails with a message telling you to snapshot again. Password values are never included in snapshots.

### Output and errors

Commands print JSON. Pass the global `--json` flag (before or after the subcommand) to also get plain-text messages (`stop`, `start` progress) and errors as JSON; errors become `{"ok": false, "error": "..."}` with a non-zero exit code. `console --follow` and `network --follow` stream one JSON object per line until interrupted.

Selector failures are explicit: an ambiguous selector reports that it matched multiple elements, and a missing one suggests `snapshot` or `wait`.

## Security

- The daemon listens on `127.0.0.1` only and requires a random bearer token (stored in `state.json`, readable only by you) on every command. Requests without it get `401`, and non-JSON content types get `415`, which blocks cross-site requests from web pages.
- `chrome-nav start --no-eval` disables the `eval` command for that daemon.
- The Chrome profile holds your cookies and logins, so treat anyone who can run `chrome-nav` as you.
