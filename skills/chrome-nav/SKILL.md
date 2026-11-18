---
name: chrome-nav
description: Drive a real Chrome instance from the CLI via CDP — navigate, click, type, scroll, screenshot, extract DOM/text, eval JS, read console/network logs. Use this whenever a task needs a live browser (testing a web app, checking a page's rendered state, scraping/reading page content, filling forms, reproducing a UI bug) and the "Claude in Chrome" extension is unavailable or blocked. It is a stand-in for that extension, controlled entirely by shelling out to the `chrome-nav` command.
---

# chrome-nav

CLI that drives a real Chrome instance over the Chrome DevTools Protocol. Every
command is `chrome-nav <subcommand> ...`, run via Bash, and every command
prints JSON to stdout, except `start` (plain-text progress, then the tab list
as JSON) and `stop` (prints `Stopped.`).

## Before anything else

1. Check the daemon is up: `chrome-nav status`.
2. If that fails (daemon not running, or `command not found`):
   - Not running → `chrome-nav start [--url <url>]`. This launches Chrome
     with remote debugging and starts the background daemon; cookies/logins
     persist across restarts (profile at `~/.chrome-nav/profile`), so a
     previously-logged-in site stays logged in.
   - `command not found` → the CLI isn't linked yet. From the project root:
     `npm install && npm run build && npm link`.
3. When fully done with the browser for this task, `chrome-nav stop` to kill
   the daemon and the managed Chrome process. Don't stop it if the user may
   want the session (logins, open tabs) to persist for a follow-up.

Do not call `chrome-nav start` again if `status` already shows it connected —
`start` is idempotent but pointless overhead; just proceed with other commands.

## Command reference

Lifecycle:
```
chrome-nav start [--url <url>] [--headless] [--chrome-port <n>] [--daemon-port <n>] [--profile <dir>]
                                      # defaults: CDP port 9222, daemon port 9223,
                                      # profile ~/.chrome-nav/profile; --headless = no window
chrome-nav stop
```

Tabs:
chrome-nav status                     # daemon/Chrome connection + open tabs
chrome-nav tabs                       # list open tabs
chrome-nav switch-tab <id>            # make a tab the default target
chrome-nav close-tab <id>
```

Navigation:
```
chrome-nav navigate <url>
chrome-nav back
chrome-nav forward
```

Interaction:
```
chrome-nav click <selector>
chrome-nav type <selector> <text> [--enter]      # --enter presses Enter after typing
chrome-nav scroll [--selector <sel>] [--x <n>] [--y <n>]
chrome-nav wait <selector> [--timeout <ms>]      # default timeout 10000ms
```

Reading page state:
```
chrome-nav screenshot [path] [--full-page]       # default path: ~/.chrome-nav/screenshots/<timestamp>.png
chrome-nav text [--selector <sel>]               # innerText
chrome-nav dom [--selector <sel>] [--max-length <n>]   # HTML, truncated (default 5000 chars)
chrome-nav eval <js-expression>                  # runs in page context, prints JSON-serializable result
```

Logs:
```
chrome-nav console [--tail <n>] [--clear]
chrome-nav network [--tail <n>] [--filter <substring>] [--clear]
```

Every command above accepts `--tab <id>` to target a specific tab; without
it, the active tab is used. The active tab is the first tab the daemon saw;
it changes only via `switch-tab` (navigating does not change it), or falls
back to the first remaining tab if the active one is closed. Check `tabs`
(`active: true`) if unsure.

## Selectors

Playwright syntax — plain CSS, or:
- `text=Sign in` — match by visible text
- `role=button[name=Submit]` — ARIA role + accessible name
- `xpath=//div[@id="x"]`

Prefer `text=` / `role=` over brittle CSS when the page's markup is unknown.

## Typical workflow

```bash
chrome-nav status || chrome-nav start
chrome-nav navigate https://example.com
chrome-nav wait "#main-content"
chrome-nav text --selector "#main-content"     # read what's there before acting
chrome-nav click "text=Sign in"
chrome-nav type "input[name=email]" "user@example.com"
chrome-nav type "input[name=password]" "secret" --enter
chrome-nav screenshot                          # visually verify the result
```

Read before you act: use `text`/`dom` to confirm a selector target exists and
what the page actually looks like before `click`/`type`, rather than guessing
selectors blind. Use `wait` for anything that loads asynchronously instead of
retrying immediately.

## Debugging a page

- `chrome-nav console --tail 50` — recent console output (errors, logs).
- `chrome-nav network --tail 50 --filter api` — recent requests matching a
  substring (e.g. an API path), to check what the page actually called.
- Both buffers persist in the daemon until `--clear`; use `--clear` when you
  want a clean window before triggering an action, so a subsequent read only
  shows what happened after.

## Troubleshooting

- `~/.chrome-nav/daemon.log` — daemon errors.
- `~/.chrome-nav/chrome.log` — Chrome process errors.
- `~/.chrome-nav/state.json` — recorded ports/pids.
- `Could not locate a Chrome/Chromium binary` → set `CHROME_NAV_BINARY` to the
  full path of the Chrome executable.
- If `chrome-nav start` hangs or times out waiting for the CDP port, the
  org's MDM may block `--remote-debugging-port` outright — this tool can't
  work around that; report it rather than retrying in a loop.
- If commands return connection errors after Chrome was closed manually
  (not via `chrome-nav stop`), re-run `chrome-nav start` to relaunch and
  reconnect the daemon.
