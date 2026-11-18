import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { CHROME_LOG_FILE } from "./paths";

const CANDIDATE_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findChromePath(): string {
  const platform = os.platform();
  const candidates = CANDIDATE_PATHS[platform] ?? [];
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate a Chrome/Chromium binary on platform "${platform}". Set CHROME_NAV_BINARY env var to the full path of your Chrome executable.`
  );
}

export interface SpawnChromeOptions {
  port: number;
  profileDir: string;
  headless?: boolean;
  startUrl?: string;
}

export function spawnChrome(opts: SpawnChromeOptions): number {
  const binary = process.env.CHROME_NAV_BINARY ?? findChromePath();
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.headless) args.push("--headless=new");
  if (opts.startUrl) args.push(opts.startUrl);

  const out = fs.openSync(CHROME_LOG_FILE, "a");
  const child = spawn(binary, args, { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  if (!child.pid) throw new Error("Failed to spawn Chrome process.");
  return child.pid;
}

export async function isChromeReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export function killProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}
