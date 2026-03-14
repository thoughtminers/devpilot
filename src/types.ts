export interface SessionInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  createdAt: Date;
  pid: number;
  cols: number;
  rows: number;
}

export interface SessionCreateOptions {
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export type SessionDataHandler = (data: string) => void;
export type SessionExitHandler = (exitCode: number, signal?: number) => void;

export interface DaemonMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsClientMessage {
  type: 'input' | 'resize' | 'subscribe';
  sessionId?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

export interface WsServerMessage {
  type: 'output' | 'scrollback' | 'sessions' | 'session_ended' | 'error';
  sessionId?: string;
  data?: string;
  sessions?: SessionInfo[];
  error?: string;
}
