# chrome-nav

A CLI to drive a real Chrome instance via the Chrome DevTools Protocol (CDP). Navigate, click, type, scroll, take screenshots, extract DOM/text, evaluate JS, and read console and network logs, all from the shell. It is a stand-in for the "Claude in Chrome" extension when that isn't available.

## How it works

`chrome-nav start` launches Chrome with remote debugging enabled and a background daemon that holds a Playwright CDP connection. Every other command is a thin client that sends a request to the daemon and prints the JSON result. The daemon keeps tab state and buffers console and network events between calls.

Runtime files live in `~/.chrome-nav/`:

| Path | Purpose |
| --- | --- |
| `profile/` | Chrome user-data-dir (cookies and logins persist across restarts) |
| `screenshots/` | Default screenshot output |
| `state.json` | Ports and PIDs |
| `daemon.log`, `chrome.log` | Logs |

## Setup

```sh
npm install
npm run build      # bundles to build/app/cli.cjs
npm run dev -- <command>   # run from source via tsx
npm run package    # standalone macOS arm64 binary (chrome-nav-macos-arm64)
```

Requires Node and a local Chrome or Chromium. If it isn't found automatically, set `CHROME_NAV_BINARY` to the executable path.

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
| `start` | Launch Chrome and the daemon (`--headless`, `--url`, `--chrome-port`, `--daemon-port`, `--profile`) |
| `stop` | Shut down the daemon and the managed Chrome |
| `status` | Show connection status and open tabs |
| `tabs` | List open tabs |
| `switch-tab <id>` | Set the active tab |
| `close-tab <id>` | Close a tab |
| `navigate <url>` | Go to a URL |
| `back` / `forward` | History navigation |
| `click <selector>` | Click an element |
| `type <selector> <text>` | Fill a field (`--enter` to submit) |
| `scroll` | Scroll the page or an element into view (`--selector`, `--x`, `--y`) |
| `wait <selector>` | Wait for an element (`--timeout`) |
| `screenshot [path]` | Save a PNG (`--full-page`) |
| `text` | Visible text of the page or a selector |
| `dom` | HTML of the page or a selector (`--max-length`) |
| `eval <code>` | Evaluate JS in the page and print the result |
| `console` | Dump buffered console logs (`--tail`, `--clear`) |
| `network` | Dump buffered network requests (`--tail`, `--filter`, `--clear`) |

Most commands accept `--tab <id>` to target a tab other than the active one. Selectors use Playwright syntax: CSS, `text=Sign in`, `role=button[name=Submit]`, and so on.
