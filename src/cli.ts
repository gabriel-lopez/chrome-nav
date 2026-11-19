import { Command, Option } from "commander";
import * as path from "path";
import { DAEMON_FLAG } from "./types";
import {
  PROFILE_DIR,
  SCREENSHOT_DIR,
  TRACE_DIR,
  ensureAuthToken,
  ensureRuntimeDirs,
  readState,
  writeState,
} from "./paths";
import { sendCommand, shutdownDaemon } from "./client";
import { isChromeReachable, killProcess, spawnChrome } from "./chrome-launcher";
import { runDaemon } from "./daemon";

if (process.argv[2] === DAEMON_FLAG) {
  const daemonPort = Number(process.argv[3]);
  const chromePort = Number(process.argv[4]);
  if (!daemonPort || !chromePort) {
    console.error(`Usage: ${DAEMON_FLAG} <daemonPort> <chromePort>`);
    process.exit(1);
  }
  runDaemon(daemonPort, chromePort);
} else {
  main();
}

function main(): void {
  const program = new Command();
  program
    .name("chrome-nav")
    .description(
      "CLI to drive a real Chrome instance (navigate, click, type, inspect DOM/console/network) — a Claude-in-Chrome-style tool for automation without the extension."
    )
    .option("--json", "machine-readable output: plain-text messages and errors are emitted as JSON");

  const jsonMode = (): boolean => Boolean(program.opts().json);

  function printJson(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  // In --json mode, status messages are suppressed and `data` is printed instead.
  function report(data: unknown, text: string): void {
    if (jsonMode()) printJson(data);
    else console.log(text);
  }

  function info(text: string): void {
    if (!jsonMode()) console.log(text);
  }

  function tabOpt(cmd: Command): Command {
    return cmd.option("--tab <id>", "target tab id (defaults to the active tab)");
  }

  program
    .command("start")
    .description("Launch Chrome with remote debugging enabled and start the control daemon")
    .option("--headless", "launch Chrome headless", false)
    .option("--url <url>", "URL to open on launch")
    .option("--chrome-port <port>", "Chrome CDP port", "9222")
    .option("--daemon-port <port>", "daemon control port", "9223")
    .option(
      "--profile <dir>",
      "Chrome user-data-dir (persists cookies/logins across restarts)",
      PROFILE_DIR
    )
    .option("--no-eval", "disable the 'eval' command for this daemon")
    .action(async (opts) => {
      ensureRuntimeDirs();
      ensureAuthToken();
      const chromePort = Number(opts.chromePort);
      const daemonPort = Number(opts.daemonPort);
      writeState({ chromePort, daemonPort, allowEval: opts.eval !== false });

      if (await isChromeReachable(chromePort)) {
        info(`Chrome already reachable on :${chromePort}, reusing it.`);
      } else {
        const pid = spawnChrome({
          port: chromePort,
          profileDir: opts.profile,
          headless: opts.headless,
          startUrl: opts.url,
        });
        writeState({ chromePid: pid });
        info(`Launched Chrome (pid ${pid}) with profile ${opts.profile}, CDP on :${chromePort}`);

        const deadline = Date.now() + 10000;
        while (!(await isChromeReachable(chromePort))) {
          if (Date.now() > deadline) {
            throw new Error("Chrome did not become reachable on the CDP port in time.");
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      const tabs = await sendCommand("tabs");
      info("Daemon connected. Open tabs:");
      printJson(tabs);
    });

  program
    .command("stop")
    .description("Shut down the daemon and close the managed Chrome instance")
    .action(async () => {
      await shutdownDaemon();
      const state = readState();
      if (state?.chromePid) {
        killProcess(state.chromePid);
        writeState({ chromePid: null });
      }
      report({ stopped: true }, "Stopped.");
    });

  program
    .command("status")
    .description("Show daemon/Chrome connection status and open tabs")
    .action(async () => {
      printJson(await sendCommand("status"));
    });

  program
    .command("tabs")
    .description("List open tabs")
    .action(async () => {
      printJson(await sendCommand("tabs"));
    });

  program
    .command("switch-tab <id>")
    .description("Set the active tab (subsequent commands default to it)")
    .action(async (id: string) => {
      printJson(await sendCommand("switch-tab", { tabId: id }));
    });

  program
    .command("close-tab <id>")
    .description("Close a tab")
    .action(async (id: string) => {
      printJson(await sendCommand("close-tab", { tabId: id }));
    });

  program
    .command("open-tab [url]")
    .description("Open a new tab (optionally at a URL) and make it the active tab")
    .action(async (url: string | undefined) => {
      printJson(await sendCommand("open-tab", { url }));
    });

  tabOpt(
    program
      .command("navigate <url>")
      .description("Navigate the active (or specified) tab to a URL")
      .addOption(
        new Option("--wait-until <event>", "when navigation counts as done")
          .choices(["load", "domcontentloaded", "networkidle", "commit"])
          .default("load")
      )
  ).action(async (url: string, opts) => {
    printJson(await sendCommand("navigate", { url, waitUntil: opts.waitUntil, tabId: opts.tab }));
  });

  tabOpt(program.command("back").description("Go back in history")).action(async (opts) => {
    printJson(await sendCommand("back", { tabId: opts.tab }));
  });

  tabOpt(program.command("forward").description("Go forward in history")).action(async (opts) => {
    printJson(await sendCommand("forward", { tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("snapshot")
      .description(
        "List visible interactive elements with refs (@eN) that can be passed to click/type/hover/etc. Refs are valid until the next snapshot or navigation"
      )
      .option("--limit <n>", "maximum number of elements to return", "200")
  ).action(async (opts) => {
    printJson(await sendCommand("snapshot", { limit: Number(opts.limit), tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("click <selector>")
      .description(
        'Click an element. Selector accepts Playwright syntax, e.g. CSS, "text=Sign in", "role=button[name=Submit]"'
      )
  ).action(async (selector: string, opts) => {
    printJson(await sendCommand("click", { selector, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("type <selector> <text>")
      .description("Fill a form field with text")
      .option("--enter", "press Enter after typing", false)
  ).action(async (selector: string, text: string, opts) => {
    printJson(await sendCommand("type", { selector, text, pressEnter: opts.enter, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("scroll")
      .description("Scroll the page, or scroll an element into view")
      .option("--selector <selector>", "scroll this element into view")
      .option("--x <n>", "horizontal scroll position", "0")
      .option("--y <n>", "vertical scroll position", "0")
  ).action(async (opts) => {
    printJson(
      await sendCommand("scroll", {
        selector: opts.selector,
        x: Number(opts.x),
        y: Number(opts.y),
        tabId: opts.tab,
      })
    );
  });

  tabOpt(
    program
      .command("wait [selector]")
      .description(
        "Wait for an element, text, URL, or load state. Pass exactly one of: <selector>, --text, --url, --load-state"
      )
      .addOption(
        new Option("--state <state>", "element state to wait for (with <selector>)")
          .choices(["attached", "detached", "visible", "hidden"])
      )
      .option("--text <text>", "wait until the page body contains this text")
      .option("--url <substring>", "wait until the page URL contains this substring")
      .addOption(
        new Option("--load-state <state>", "wait for a page load state").choices([
          "load",
          "domcontentloaded",
          "networkidle",
        ])
      )
      .option("--timeout <ms>", "timeout in milliseconds", "10000")
  ).action(async (selector: string | undefined, opts) => {
    const modes = [selector, opts.text, opts.url, opts.loadState].filter((v) => v !== undefined);
    if (modes.length !== 1) {
      throw new Error("wait needs exactly one of: <selector>, --text, --url, --load-state");
    }
    if (opts.state && !selector) throw new Error("--state only applies when waiting for a <selector>");
    printJson(
      await sendCommand("wait", {
        selector,
        state: opts.state,
        text: opts.text,
        url: opts.url,
        loadState: opts.loadState,
        timeout: Number(opts.timeout),
        tabId: opts.tab,
      })
    );
  });

  tabOpt(
    program
      .command("hover <selector>")
      .description("Hover over an element (or a snapshot ref)")
  ).action(async (selector: string, opts) => {
    printJson(await sendCommand("hover", { selector, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("press <key>")
      .description("Press a key, e.g. Enter, Escape, Tab, or Control+A. Sends to --selector if given, otherwise the page")
      .option("--selector <selector>", "focus this element first and press the key on it")
  ).action(async (key: string, opts) => {
    printJson(await sendCommand("press", { key, selector: opts.selector, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("select <selector> <values...>")
      .description("Choose one or more options in a <select> element, by value or visible label")
  ).action(async (selector: string, values: string[], opts) => {
    printJson(await sendCommand("select", { selector, values, tabId: opts.tab }));
  });

  tabOpt(
    program.command("check <selector>").description("Check a checkbox or radio button")
  ).action(async (selector: string, opts) => {
    printJson(await sendCommand("check", { selector, checked: true, tabId: opts.tab }));
  });

  tabOpt(program.command("uncheck <selector>").description("Uncheck a checkbox")).action(
    async (selector: string, opts) => {
      printJson(await sendCommand("check", { selector, checked: false, tabId: opts.tab }));
    }
  );

  tabOpt(
    program
      .command("upload <selector> <files...>")
      .description("Set files on a <input type=file> element (paths are resolved to absolute paths)")
  ).action(async (selector: string, files: string[], opts) => {
    const absolute = files.map((f) => path.resolve(f));
    printJson(await sendCommand("upload", { selector, files: absolute, tabId: opts.tab }));
  });

  tabOpt(
    program.command("drag <from> <to>").description("Drag one element onto another (selectors or refs)")
  ).action(async (from: string, to: string, opts) => {
    printJson(await sendCommand("drag", { from, to, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("screenshot [path]")
      .description("Save a screenshot (default: ~/.chrome-nav/screenshots/<timestamp>.png)")
      .option("--full-page", "capture the full scrollable page", false)
  ).action(async (outPath: string | undefined, opts) => {
    ensureRuntimeDirs();
    const finalPath = outPath ?? path.join(SCREENSHOT_DIR, `${Date.now()}.png`);
    printJson(await sendCommand("screenshot", { path: finalPath, fullPage: opts.fullPage, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("text")
      .description("Extract visible text (innerText) of the page or a selector")
      .option("--selector <selector>", "limit to this element")
      .option("--max-length <n>", "truncate output to this many characters")
  ).action(async (opts) => {
    printJson(
      await sendCommand("text", {
        selector: opts.selector,
        maxLength: opts.maxLength ? Number(opts.maxLength) : undefined,
        tabId: opts.tab,
      })
    );
  });

  tabOpt(
    program
      .command("dom")
      .description("Extract HTML of the page or a selector")
      .option("--selector <selector>", "limit to this element")
      .option("--max-length <n>", "truncate output to this many characters", "5000")
  ).action(async (opts) => {
    printJson(
      await sendCommand("dom", { selector: opts.selector, maxLength: Number(opts.maxLength), tabId: opts.tab })
    );
  });

  tabOpt(
    program
      .command("eval <code>")
      .description("Evaluate a JS expression in the page context and print the (JSON-serializable) result")
  ).action(async (code: string, opts) => {
    printJson(await sendCommand("eval", { code, tabId: opts.tab }));
  });

  tabOpt(
    program
      .command("console")
      .description("Dump buffered console logs for a tab")
      .option("--tail <n>", "only show the last n entries")
      .option("--clear", "clear the buffer after reading", false)
      .option("--follow", "keep printing new entries as JSON lines until interrupted", false)
  ).action(async (opts) => {
    if (opts.follow) {
      if (opts.clear) throw new Error("--follow cannot be combined with --clear");
      await followLogs("console", { tabId: opts.tab }, opts.tail ? Number(opts.tail) : undefined);
      return;
    }
    printJson(
      await sendCommand("console", {
        tabId: opts.tab,
        tail: opts.tail ? Number(opts.tail) : undefined,
        clear: opts.clear,
      })
    );
  });

  tabOpt(
    program
      .command("network")
      .description("Dump buffered network requests for a tab")
      .option("--tail <n>", "only show the last n entries")
      .option("--filter <substring>", "only show requests whose URL contains this substring")
      .option("--clear", "clear the buffer after reading", false)
      .option("--follow", "keep printing new entries as JSON lines until interrupted", false)
  ).action(async (opts) => {
    if (opts.follow) {
      if (opts.clear) throw new Error("--follow cannot be combined with --clear");
      await followLogs(
        "network",
        { tabId: opts.tab, filter: opts.filter },
        opts.tail ? Number(opts.tail) : undefined
      );
      return;
    }
    printJson(
      await sendCommand("network", {
        tabId: opts.tab,
        tail: opts.tail ? Number(opts.tail) : undefined,
        filter: opts.filter,
        clear: opts.clear,
      })
    );
  });

  const trace = program.command("trace").description("Record a Playwright trace (DOM snapshots, screenshots, actions)");
  trace
    .command("start")
    .description("Start tracing the browser context")
    .action(async () => {
      printJson(await sendCommand("trace-start"));
    });
  trace
    .command("stop [path]")
    .description("Stop tracing and write a .zip (default: ~/.chrome-nav/traces/<timestamp>.zip)")
    .action(async (outPath: string | undefined) => {
      ensureRuntimeDirs();
      const finalPath = outPath ? path.resolve(outPath) : path.join(TRACE_DIR, `${Date.now()}.zip`);
      printJson(await sendCommand("trace-stop", { path: finalPath }));
    });

  async function followLogs(
    action: "console" | "network",
    params: Record<string, unknown>,
    tail: number | undefined
  ): Promise<void> {
    let since = 0;
    const initial = (await sendCommand(action, { ...params, tail })) as Array<{ seq: number }>;
    for (const entry of initial) {
      console.log(JSON.stringify(entry));
      since = Math.max(since, entry.seq);
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const fresh = (await sendCommand(action, { ...params, since })) as Array<{ seq: number }>;
      for (const entry of fresh) {
        console.log(JSON.stringify(entry));
        since = Math.max(since, entry.seq);
      }
    }
  }

  program.parseAsync(process.argv).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode()) {
      printJson({ ok: false, error: message });
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  });
}
