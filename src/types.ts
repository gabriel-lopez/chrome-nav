export const DAEMON_FLAG = "--__chrome-nav-daemon__";

export interface State {
  chromePort: number;
  chromePid: number | null;
  daemonPort: number;
  daemonPid: number | null;
  token?: string;
  allowEval?: boolean;
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
  seq: number;
  tabId: string;
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  seq: number;
  tabId: string;
  method: string;
  url: string;
  status: number | null;
  timestamp: number;
}

export interface SnapshotElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  checked?: boolean;
  href?: string;
  disabled?: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  total: number;
  truncated: boolean;
  elements: SnapshotElement[];
}
