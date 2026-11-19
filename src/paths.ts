import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import type { State } from "./types";

export const RUNTIME_DIR = process.env.CHROME_NAV_HOME ?? path.join(os.homedir(), ".chrome-nav");
export const PROFILE_DIR = path.join(RUNTIME_DIR, "profile");
export const SCREENSHOT_DIR = path.join(RUNTIME_DIR, "screenshots");
export const TRACE_DIR = path.join(RUNTIME_DIR, "traces");
export const STATE_FILE = path.join(RUNTIME_DIR, "state.json");
export const DAEMON_LOG_FILE = path.join(RUNTIME_DIR, "daemon.log");
export const CHROME_LOG_FILE = path.join(RUNTIME_DIR, "chrome.log");

export function ensureRuntimeDirs(): void {
  for (const dir of [RUNTIME_DIR, PROFILE_DIR, SCREENSHOT_DIR, TRACE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readState(): State | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as State;
  } catch {
    return null;
  }
}

export function writeState(patch: Partial<State>): State {
  const current: State = readState() ?? {
    chromePort: 9222,
    chromePid: null,
    daemonPort: 9223,
    daemonPid: null,
  };
  const next = { ...current, ...patch };
  ensureRuntimeDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE_FILE, 0o600);
  return next;
}

export function ensureAuthToken(): string {
  const existing = readState()?.token;
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  writeState({ token });
  return token;
}
