export const DAEMON_FLAG = "--__chrome-nav-daemon__";

export interface State {
  chromePort: number;
  chromePid: number | null;
  daemonPort: number;
  daemonPid: number | null;
}

export interface CommandRequest {
  action: string;
  params?: Record<string, any>;
}

export interface CommandResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ConsoleEntry {
  tabId: string;
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  tabId: string;
  method: string;
  url: string;
  status: number | null;
  timestamp: number;
}
