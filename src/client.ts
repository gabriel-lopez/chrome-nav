import { spawn } from "child_process";
import * as fs from "fs";
import { DAEMON_FLAG, CommandResponse } from "./types";
import { DAEMON_LOG_FILE, ensureAuthToken, ensureRuntimeDirs, readState, writeState } from "./paths";

async function isDaemonReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonReachable(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Daemon did not become reachable on port ${port} within ${timeoutMs}ms. Check ${DAEMON_LOG_FILE}`
  );
}

async function ensureDaemonRunning(daemonPort: number, chromePort: number): Promise<void> {
  if (await isDaemonReachable(daemonPort)) return;
  ensureRuntimeDirs();
  const out = fs.openSync(DAEMON_LOG_FILE, "a");
  const child = spawn(
    process.execPath,
    [process.argv[1] ?? "", DAEMON_FLAG, String(daemonPort), String(chromePort)],
    { detached: true, stdio: ["ignore", out, out] }
  );
  child.unref();
  await waitForDaemon(daemonPort, 5000);
}

export async function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const state = readState();
  const daemonPort = state?.daemonPort ?? 9223;
  const chromePort = state?.chromePort ?? 9222;
  const token = ensureAuthToken();
  await ensureDaemonRunning(daemonPort, chromePort);

  const res = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, params }),
  });
  const body = (await res.json()) as CommandResponse;
  if (!body.ok) {
    throw new Error(body.error ?? "Unknown daemon error");
  }
  return body.data;
}

export async function shutdownDaemon(): Promise<void> {
  const state = readState();
  if (!state) return;
  if (await isDaemonReachable(state.daemonPort)) {
    try {
      await fetch(`http://127.0.0.1:${state.daemonPort}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token ?? ""}` },
        body: JSON.stringify({ action: "shutdown", params: {} }),
      });
    } catch {
      // daemon exits before replying
    }
  }
  writeState({ daemonPid: null });
}
