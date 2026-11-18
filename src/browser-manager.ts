import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import type { ConsoleEntry, NetworkEntry, TabInfo } from "./types";

const MAX_LOG_ENTRIES = 500;

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private nextId = 1;
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
    this.consoleLogs.push({ tabId, type, text, timestamp: Date.now() });
    if (this.consoleLogs.length > MAX_LOG_ENTRIES) this.consoleLogs.shift();
  }

  private pushNetwork(tabId: string, method: string, url: string, status: number | null): void {
    this.networkLogs.push({ tabId, method, url, status, timestamp: Date.now() });
    if (this.networkLogs.length > MAX_LOG_ENTRIES) this.networkLogs.shift();
  }

  private getPage(tabId?: string): Page {
    const id = tabId ?? this.activeTabId;
    if (!id) throw new Error("No active tab. Navigate to a URL first.");
    const page = this.pages.get(id);
    if (!page) throw new Error(`Unknown tab id "${id}". Run 'tabs' to list open tabs.`);
    return page;
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

  async navigate(url: string, tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
  }

  async back(tabId?: string): Promise<void> {
    await this.getPage(tabId).goBack({ timeout: 15000 });
  }

  async forward(tabId?: string): Promise<void> {
    await this.getPage(tabId).goForward({ timeout: 15000 });
  }

  async click(selector: string, tabId?: string): Promise<void> {
    await this.getPage(tabId).click(selector, { timeout: 10000 });
  }

  async type(selector: string, text: string, pressEnter: boolean, tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.fill(selector, text, { timeout: 10000 });
    if (pressEnter) await page.press(selector, "Enter");
  }

  async scroll(opts: { selector?: string; x?: number; y?: number }, tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    if (opts.selector) {
      await page.locator(opts.selector).scrollIntoViewIfNeeded({ timeout: 10000 });
    } else {
      await page.evaluate(
        ([x, y]) => window.scrollTo(x, y),
        [opts.x ?? 0, opts.y ?? 0] as [number, number]
      );
    }
  }

  async waitFor(selector: string, timeout: number, tabId?: string): Promise<void> {
    await this.getPage(tabId).waitForSelector(selector, { timeout });
  }

  async screenshot(path: string, fullPage: boolean, tabId?: string): Promise<void> {
    await this.getPage(tabId).screenshot({ path, fullPage });
  }

  async getText(selector: string | undefined, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    if (selector) {
      return await page.locator(selector).innerText({ timeout: 10000 });
    }
    return await page.evaluate(() => document.body.innerText);
  }

  async getDom(selector: string | undefined, maxLength: number, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    let html: string;
    if (selector) {
      html = await page.locator(selector).evaluate((el) => el.outerHTML);
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

  getConsoleLogs(tabId?: string, tail?: number): ConsoleEntry[] {
    let logs = this.consoleLogs;
    if (tabId) logs = logs.filter((l) => l.tabId === tabId);
    if (tail) logs = logs.slice(-tail);
    return logs;
  }

  getNetworkLogs(tabId?: string, tail?: number, filter?: string): NetworkEntry[] {
    let logs = this.networkLogs;
    if (tabId) logs = logs.filter((l) => l.tabId === tabId);
    if (filter) logs = logs.filter((l) => l.url.includes(filter));
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
