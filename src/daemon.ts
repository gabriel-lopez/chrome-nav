import * as http from "http";
import * as crypto from "crypto";
import { BrowserManager } from "./browser-manager";
import { readState, writeState } from "./paths";
import type { CommandRequest, CommandResponse } from "./types";

function tokensMatch(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function runDaemon(daemonPort: number, chromePort: number): void {
  const token = readState()?.token;
  if (!token) {
    throw new Error("No auth token in state.json; run 'chrome-nav start' to initialize.");
  }
  const manager = new BrowserManager();

  async function ensureConnected(): Promise<void> {
    if (!manager.isConnected()) {
      await manager.connect(chromePort);
    }
  }

  async function dispatch(req: CommandRequest): Promise<unknown> {
    const p = req.params ?? {};

    switch (req.action) {
      case "status": {
        const connected = manager.isConnected();
        return { connected, tabs: connected ? await manager.listTabs() : [] };
      }
      case "shutdown": {
        setTimeout(() => process.exit(0), 100);
        return { shuttingDown: true };
      }
    }

    await ensureConnected();

    switch (req.action) {
      case "tabs":
        return manager.listTabs();
      case "open-tab":
        return { tabId: await manager.openTab(p.url) };
      case "switch-tab":
        manager.setActiveTab(p.tabId);
        return { ok: true };
      case "close-tab":
        await manager.closeTab(p.tabId);
        return { ok: true };
      case "navigate":
        await manager.navigate(p.url, p.waitUntil ?? "load", p.tabId);
        return { ok: true };
      case "back":
        await manager.back(p.tabId);
        return { ok: true };
      case "forward":
        await manager.forward(p.tabId);
        return { ok: true };
      case "snapshot":
        return manager.snapshot(p.limit ?? 200, p.tabId);
      case "click":
        await manager.click(p.selector, p.tabId);
        return { ok: true };
      case "hover":
        await manager.hover(p.selector, p.tabId);
        return { ok: true };
      case "type":
        await manager.type(p.selector, p.text, Boolean(p.pressEnter), p.tabId);
        return { ok: true };
      case "press":
        await manager.press(p.key, p.selector, p.tabId);
        return { ok: true };
      case "select":
        return { selected: await manager.select(p.selector, p.values, p.tabId) };
      case "check":
        await manager.setChecked(p.selector, p.checked, p.tabId);
        return { ok: true };
      case "upload":
        await manager.upload(p.selector, p.files, p.tabId);
        return { ok: true };
      case "drag":
        await manager.drag(p.from, p.to, p.tabId);
        return { ok: true };
      case "scroll":
        await manager.scroll({ selector: p.selector, x: p.x, y: p.y }, p.tabId);
        return { ok: true };
      case "wait":
        await manager.waitFor({ ...p, timeout: p.timeout ?? 10000 }, p.tabId);
        return { ok: true };
      case "screenshot":
        await manager.screenshot(p.path, Boolean(p.fullPage), p.tabId);
        return { path: p.path };
      case "text":
        return { text: await manager.getText(p.selector, p.maxLength, p.tabId) };
      case "dom":
        return { html: await manager.getDom(p.selector, p.maxLength ?? 5000, p.tabId) };
      case "eval":
        if (readState()?.allowEval === false) {
          throw new Error("eval is disabled. Restart with 'chrome-nav start' (without --no-eval) to enable it.");
        }
        return { result: await manager.evalJs(p.code, p.tabId) };
      case "trace-start":
        await manager.traceStart();
        return { ok: true };
      case "trace-stop":
        await manager.traceStop(p.path);
        return { path: p.path };
      case "console": {
        if (p.clear) manager.clearConsoleLogs();
        return manager.getConsoleLogs(p.tabId, p.tail, p.since);
      }
      case "network": {
        if (p.clear) manager.clearNetworkLogs();
        return manager.getNetworkLogs(p.tabId, p.tail, p.filter, p.since);
      }
      default:
        throw new Error(`Unknown action "${req.action}"`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/command") {
      if (!tokensMatch(req.headers.authorization, `Bearer ${token}`)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Content-Type must be application/json" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        let response: CommandResponse;
        try {
          const parsed = JSON.parse(body) as CommandRequest;
          const data = await dispatch(parsed);
          response = { ok: true, data };
        } catch (err) {
          response = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        res.writeHead(response.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(daemonPort, "127.0.0.1", () => {
    writeState({ daemonPort, daemonPid: process.pid, chromePort });
    console.log(`chrome-nav daemon listening on 127.0.0.1:${daemonPort}, targeting Chrome CDP on :${chromePort}`);
  });
}
