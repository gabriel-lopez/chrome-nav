import { Command } from "commander";
import * as path from "path";
import { DAEMON_FLAG } from "./types";
import {
  PROFILE_DIR,
  SCREENSHOT_DIR,
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
    );

  function printJson(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
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
    .action(async (opts) => {
      ensureRuntimeDirs();
      const chromePort = Number(opts.chromePort);
      const daemonPort = Number(opts.daemonPort);
      writeState({ chromePort, daemonPort });

      if (await isChromeReachable(chromePort)) {
        console.log(`Chrome already reachable on :${chromePort}, reusing it.`);
      } else {
        const pid = spawnChrome({
          port: chromePort,
          profileDir: opts.profile,
          headless: opts.headless,
          startUrl: opts.url,
        });
        writeState({ chromePid: pid });
        console.log(`Launched Chrome (pid ${pid}) with profile ${opts.profile}, CDP on :${chromePort}`);

        const deadline = Date.now() + 10000;
        while (!(await isChromeReachable(chromePort))) {
          if (Date.now() > deadline) {
            throw new Error("Chrome did not become reachable on the CDP port in time.");
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      const tabs = await sendCommand("tabs");
      console.log("Daemon connected. Open tabs:");
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
      console.log("Stopped.");
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

  tabOpt(
    program.command("navigate <url>").description("Navigate the active (or specified) tab to a URL")
  ).action(async (url: string, opts) => {
    printJson(await sendCommand("navigate", { url, tabId: opts.tab }));
  });

  tabOpt(program.command("back").description("Go back in history")).action(async (opts) => {
    printJson(await sendCommand("back", { tabId: opts.tab }));
  });

  tabOpt(program.command("forward").description("Go forward in history")).action(async (opts) => {
    printJson(await sendCommand("forward", { tabId: opts.tab }));
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
      .command("wait <selector>")
      .description("Wait for an element to appear")
      .option("--timeout <ms>", "timeout in milliseconds", "10000")
  ).action(async (selector: string, opts) => {
    printJson(await sendCommand("wait", { selector, timeout: Number(opts.timeout), tabId: opts.tab }));
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
  ).action(async (opts) => {
    printJson(await sendCommand("text", { selector: opts.selector, tabId: opts.tab }));
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
  ).action(async (opts) => {
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
  ).action(async (opts) => {
    printJson(
      await sendCommand("network", {
        tabId: opts.tab,
        tail: opts.tail ? Number(opts.tail) : undefined,
        filter: opts.filter,
        clear: opts.clear,
      })
    );
  });

  program.parseAsync(process.argv).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
