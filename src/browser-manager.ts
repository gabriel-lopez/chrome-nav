import { chromium, Browser, BrowserContext, Locator, Page } from "playwright-core";
import type { ConsoleEntry, NetworkEntry, Snapshot, TabInfo } from "./types";

const MAX_LOG_ENTRIES = 500;
const ACTION_TIMEOUT = 10000;
const REF_PATTERN = /^@e(\d+)$/;

export type LoadState = "load" | "domcontentloaded" | "networkidle" | "commit";

export interface WaitOptions {
  selector?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  text?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  timeout: number;
}

// Snapshot refs ("@e3") are stamped onto elements as a data attribute so every
// action can reuse the normal Locator machinery.
function resolveSelector(selector: string): string {
  const m = REF_PATTERN.exec(selector);
  return m ? `[data-cn-ref="e${m[1]}"]` : selector;
}

function explainError(selector: string, err: unknown, timeout: number): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (/strict mode violation/.test(error.message)) {
    return new Error(
      `Selector "${selector}" matched multiple elements. Make it more specific, or use a snapshot ref (@eN).`
    );
  }
  if (error.name === "TimeoutError") {
    return new Error(
      `No actionable element matched "${selector}" within ${timeout}ms. Run 'snapshot' to find refs, or 'wait' for it first.`
    );
  }
  return error;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private nextId = 1;
  private nextSeq = 1;
  private activeTabId: string | null = null;
  private consoleLogs: ConsoleEntry[] = [];
  private networkLogs: NetworkEntry[] = [];

  isConnected(): boolean {
    return this.browser !== null;
  }

  async connect(port: number): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? (await this.browser.newContext());
    for (const page of this.context.pages()) {
      this.registerPage(page);
    }
    this.context.on("page", (page) => this.registerPage(page));
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.pages.clear();
      this.activeTabId = null;
    }
  }

  private registerPage(page: Page): void {
    if ([...this.pages.values()].includes(page)) return;
    const id = `t${this.nextId++}`;
    this.pages.set(id, page);
    if (this.activeTabId === null) this.activeTabId = id;

    page.on("console", (msg) => {
      this.pushConsole(id, msg.type(), msg.text());
    });
    page.on("requestfinished", async (req) => {
      let status: number | null = null;
      try {
        const resp = await req.response();
        status = resp ? resp.status() : null;
      } catch {
        status = null;
      }
      this.pushNetwork(id, req.method(), req.url(), status);
    });
    page.on("requestfailed", (req) => {
      this.pushNetwork(id, req.method(), req.url(), null);
    });
    page.on("close", () => {
      this.pages.delete(id);
      if (this.activeTabId === id) {
        this.activeTabId = this.pages.keys().next().value ?? null;
      }
    });
  }

  private pushConsole(tabId: string, type: string, text: string): void {
    this.consoleLogs.push({ seq: this.nextSeq++, tabId, type, text, timestamp: Date.now() });
    if (this.consoleLogs.length > MAX_LOG_ENTRIES) this.consoleLogs.shift();
  }

  private pushNetwork(tabId: string, method: string, url: string, status: number | null): void {
    this.networkLogs.push({ seq: this.nextSeq++, tabId, method, url, status, timestamp: Date.now() });
    if (this.networkLogs.length > MAX_LOG_ENTRIES) this.networkLogs.shift();
  }

  private getPage(tabId?: string): Page {
    const id = tabId ?? this.activeTabId;
    if (!id) throw new Error("No active tab. Navigate to a URL first.");
    const page = this.pages.get(id);
    if (!page) throw new Error(`Unknown tab id "${id}". Run 'tabs' to list open tabs.`);
    return page;
  }

  private locate(selector: string, tabId?: string): Locator {
    return this.getPage(tabId).locator(resolveSelector(selector));
  }

  // Resolves refs and fails fast on stale ones instead of letting Playwright time out.
  private async locateChecked(selector: string, tabId?: string): Promise<Locator> {
    const loc = this.locate(selector, tabId);
    if (REF_PATTERN.test(selector) && (await loc.count()) === 0) {
      throw new Error(`Ref ${selector} is not on the page. Run 'snapshot' again to refresh refs.`);
    }
    return loc;
  }

  private async act(selector: string, tabId: string | undefined, fn: (loc: Locator) => Promise<void>): Promise<void> {
    const loc = await this.locateChecked(selector, tabId);
    try {
      await fn(loc);
    } catch (err) {
      throw explainError(selector, err, ACTION_TIMEOUT);
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    const result: TabInfo[] = [];
    for (const [id, page] of this.pages) {
      let title = "";
      try {
        title = await page.title();
      } catch {
        title = "";
      }
      result.push({ id, url: page.url(), title, active: id === this.activeTabId });
    }
    return result;
  }

  async openTab(url?: string): Promise<string> {
    if (!this.context) throw new Error("Not connected to Chrome.");
    const page = await this.context.newPage();
    this.registerPage(page);
    const id = [...this.pages.entries()].find(([, p]) => p === page)?.[0];
    if (!id) throw new Error("Failed to register the new tab.");
    this.activeTabId = id;
    if (url) await page.goto(url, { waitUntil: "load", timeout: 30000 });
    return id;
  }

  setActiveTab(tabId: string): void {
    if (!this.pages.has(tabId)) {
      throw new Error(`Unknown tab id "${tabId}". Run 'tabs' to list open tabs.`);
    }
    this.activeTabId = tabId;
  }

  async closeTab(tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.close();
  }

  async navigate(url: string, waitUntil: LoadState, tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.goto(url, { waitUntil, timeout: 30000 });
  }

  async back(tabId?: string): Promise<void> {
    await this.getPage(tabId).goBack({ timeout: 15000 });
  }

  async forward(tabId?: string): Promise<void> {
    await this.getPage(tabId).goForward({ timeout: 15000 });
  }

  async click(selector: string, tabId?: string): Promise<void> {
    await this.act(selector, tabId, (loc) => loc.click({ timeout: ACTION_TIMEOUT }));
  }

  async hover(selector: string, tabId?: string): Promise<void> {
    await this.act(selector, tabId, (loc) => loc.hover({ timeout: ACTION_TIMEOUT }));
  }

  async type(selector: string, text: string, pressEnter: boolean, tabId?: string): Promise<void> {
    await this.act(selector, tabId, async (loc) => {
      await loc.fill(text, { timeout: ACTION_TIMEOUT });
      if (pressEnter) await loc.press("Enter");
    });
  }

  async press(key: string, selector?: string, tabId?: string): Promise<void> {
    if (!selector) {
      await this.getPage(tabId).keyboard.press(key);
      return;
    }
    await this.act(selector, tabId, (loc) => loc.press(key, { timeout: ACTION_TIMEOUT }));
  }

  async select(selector: string, values: string[], tabId?: string): Promise<string[]> {
    let selected: string[] = [];
    await this.act(selector, tabId, async (loc) => {
      selected = await loc.selectOption(values, { timeout: ACTION_TIMEOUT });
    });
    return selected;
  }

  async setChecked(selector: string, checked: boolean, tabId?: string): Promise<void> {
    await this.act(selector, tabId, (loc) =>
      checked ? loc.check({ timeout: ACTION_TIMEOUT }) : loc.uncheck({ timeout: ACTION_TIMEOUT })
    );
  }

  async upload(selector: string, files: string[], tabId?: string): Promise<void> {
    await this.act(selector, tabId, (loc) => loc.setInputFiles(files, { timeout: ACTION_TIMEOUT }));
  }

  async drag(from: string, to: string, tabId?: string): Promise<void> {
    const source = await this.locateChecked(from, tabId);
    const target = await this.locateChecked(to, tabId);
    try {
      await source.dragTo(target, { timeout: ACTION_TIMEOUT });
    } catch (err) {
      throw explainError(`${from} -> ${to}`, err, ACTION_TIMEOUT);
    }
  }

  async scroll(opts: { selector?: string; x?: number; y?: number }, tabId?: string): Promise<void> {
    if (opts.selector) {
      await this.act(opts.selector, tabId, (loc) => loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }));
    } else {
      await this.getPage(tabId).evaluate(
        ([x, y]) => window.scrollTo(x, y),
        [opts.x ?? 0, opts.y ?? 0] as [number, number]
      );
    }
  }

  async waitFor(opts: WaitOptions, tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    const { timeout } = opts;
    if (opts.selector) {
      await page.waitForSelector(resolveSelector(opts.selector), { state: opts.state ?? "visible", timeout });
    } else if (opts.text !== undefined) {
      const needle = opts.text;
      await page.waitForFunction((t: string) => document.body?.innerText.includes(t) ?? false, needle, { timeout });
    } else if (opts.url !== undefined) {
      const fragment = opts.url;
      await page.waitForURL((u) => u.toString().includes(fragment), { timeout });
    } else if (opts.loadState) {
      await page.waitForLoadState(opts.loadState, { timeout });
    } else {
      throw new Error("wait needs a selector, --text, --url, or --load-state.");
    }
  }

  async snapshot(limit: number, tabId?: string): Promise<Snapshot> {
    return await this.getPage(tabId).evaluate((max: number) => {
      document.querySelectorAll("[data-cn-ref]").forEach((el) => el.removeAttribute("data-cn-ref"));

      const interactive = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "summary",
        "[contenteditable='true']",
        "[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[role=menuitem],[role=tab],[role=option],[role=switch],[role=combobox],[role=searchbox]",
      ].join(",");

      const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 100);

      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const nameOf = (el: Element): string => {
        const ariaLabel = clean(el.getAttribute("aria-label"));
        if (ariaLabel) return ariaLabel;
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = clean(
            labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          );
          if (text) return text;
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const labelText = clean(Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" "));
          if (labelText) return labelText;
        }
        return clean(
          el.getAttribute("placeholder") ||
            el.getAttribute("alt") ||
            el.getAttribute("title") ||
            (el as HTMLElement).innerText ||
            el.textContent ||
            el.getAttribute("value")
        );
      };

      const implicitRole = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "input") return (el as HTMLInputElement).type || "textbox";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        return tag;
      };

      const elements: object[] = [];
      let total = 0;
      for (const el of Array.from(document.querySelectorAll(interactive))) {
        if (!isVisible(el)) continue;
        total++;
        if (elements.length >= max) continue;

        const ref = `e${elements.length + 1}`;
        el.setAttribute("data-cn-ref", ref);

        const entry: Record<string, unknown> = {
          ref: `@${ref}`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || implicitRole(el),
          name: nameOf(el),
        };
        if (el instanceof HTMLInputElement) entry.type = el.type;
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          entry.checked = el.checked;
        } else if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          // Never echo password values back to the caller.
          if (!(el instanceof HTMLInputElement && el.type === "password") && el.value) entry.value = clean(el.value);
        }
        if (el instanceof HTMLAnchorElement) entry.href = el.href;
        if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
        elements.push(entry);
      }

      return {
        url: location.href,
        title: document.title,
        total,
        truncated: total > elements.length,
        elements,
      } as Snapshot;
    }, limit);
  }

  async traceStart(): Promise<void> {
    if (!this.context) throw new Error("Not connected to Chrome.");
    await this.context.tracing.start({ screenshots: true, snapshots: true });
  }

  async traceStop(path: string): Promise<void> {
    if (!this.context) throw new Error("Not connected to Chrome.");
    await this.context.tracing.stop({ path });
  }

  async screenshot(path: string, fullPage: boolean, tabId?: string): Promise<void> {
    await this.getPage(tabId).screenshot({ path, fullPage });
  }

  async getText(selector: string | undefined, maxLength: number | undefined, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    let text: string;
    if (selector) {
      const loc = await this.locateChecked(selector, tabId);
      text = await loc.innerText({ timeout: ACTION_TIMEOUT });
    } else {
      text = await page.evaluate(() => document.body.innerText);
    }
    if (maxLength !== undefined && text.length > maxLength) {
      return (
        text.slice(0, maxLength) +
        `\n... [truncated, ${text.length} total chars, use --selector or raise --max-length]`
      );
    }
    return text;
  }

  async getDom(selector: string | undefined, maxLength: number, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    let html: string;
    if (selector) {
      const loc = await this.locateChecked(selector, tabId);
      html = await loc.evaluate((el) => el.outerHTML);
    } else {
      html = await page.content();
    }
    if (html.length > maxLength) {
      return (
        html.slice(0, maxLength) +
        `\n... [truncated, ${html.length} total chars, use --selector or raise --max-length]`
      );
    }
    return html;
  }

  async evalJs(code: string, tabId?: string): Promise<unknown> {
    return await this.getPage(tabId).evaluate(code);
  }

  getConsoleLogs(tabId?: string, tail?: number, since?: number): ConsoleEntry[] {
    let logs = this.consoleLogs;
    if (tabId) logs = logs.filter((l) => l.tabId === tabId);
    if (since !== undefined) logs = logs.filter((l) => l.seq > since);
    if (tail) logs = logs.slice(-tail);
    return logs;
  }

  getNetworkLogs(tabId?: string, tail?: number, filter?: string, since?: number): NetworkEntry[] {
    let logs = this.networkLogs;
    if (tabId) logs = logs.filter((l) => l.tabId === tabId);
    if (filter) logs = logs.filter((l) => l.url.includes(filter));
    if (since !== undefined) logs = logs.filter((l) => l.seq > since);
    if (tail) logs = logs.slice(-tail);
    return logs;
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  clearNetworkLogs(): void {
    this.networkLogs = [];
  }
}
