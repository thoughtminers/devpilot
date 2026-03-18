import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  SessionCreateOptions,
  SessionDataHandler,
  SessionExitHandler,
  SessionInfo,
} from '../types.js';

const DEFAULT_SCROLLBACK_LIMIT = 10000;

interface Session {
  id: string;
  name: string;
  command: string;
  cwd: string;
  createdAt: Date;
  pty: pty.IPty;
  scrollback: string[];
  dataHandlers: Set<SessionDataHandler>;
  exitHandlers: Set<SessionExitHandler>;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private nextId = 1;
  private scrollbackLimit: number;

  constructor(scrollbackLimit = DEFAULT_SCROLLBACK_LIMIT) {
    super();
    this.scrollbackLimit = scrollbackLimit;
  }

  create(options: SessionCreateOptions): string {
    const id = String(this.nextId++);
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    // Resolve command to full path (detached daemon may not have PATH)
    let command = options.command;
    if (!command.startsWith('/')) {
      try {
        command = execSync(`which ${command}`, { encoding: 'utf-8' }).trim();
      } catch {
        // Fall through — let node-pty try as-is
      }
    }

    const ptyProcess = pty.spawn(command, options.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    });

    const session: Session = {
      id,
      name: options.name ?? `session-${id}`,
      command: options.command,
      cwd: options.cwd,
      createdAt: new Date(),
      pty: ptyProcess,
      scrollback: [],
      dataHandlers: new Set(),
      exitHandlers: new Set(),
    };

    ptyProcess.onData(data => {
      this.appendScrollback(session, data);
      for (const handler of session.dataHandlers) {
        handler(data);
      }
      this.emit('data', id, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      for (const handler of session.exitHandlers) {
        handler(exitCode, signal);
      }
      this.emit('exit', id, exitCode, signal);
      this.sessions.delete(id);
      this.emit('session_removed', id);
    });

    this.sessions.set(id, session);
    this.emit('session_created', id);

    return id;
  }

  write(id: string, data: string): void {
    const session = this.getSession(id);
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.getSession(id);
    session.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const session = this.getSession(id);
    session.pty.kill();
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  getScrollback(id: string): string {
    const session = this.getSession(id);
    return session.scrollback.join('');
  }

  onData(id: string, handler: SessionDataHandler): () => void {
    const session = this.getSession(id);
    session.dataHandlers.add(handler);
    return () => {
      session.dataHandlers.delete(handler);
    };
  }

  onExit(id: string, handler: SessionExitHandler): () => void {
    const session = this.getSession(id);
    session.exitHandlers.add(handler);
    return () => {
      session.exitHandlers.delete(handler);
    };
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      command: s.command,
      cwd: s.cwd,
      createdAt: s.createdAt,
      pid: s.pty.pid,
      cols: s.pty.cols,
      rows: s.pty.rows,
    }));
  }

  getInfo(id: string): SessionInfo {
    const s = this.getSession(id);
    return {
      id: s.id,
      name: s.name,
      command: s.command,
      cwd: s.cwd,
      createdAt: s.createdAt,
      pid: s.pty.pid,
      cols: s.pty.cols,
      rows: s.pty.rows,
    };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private getSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    return session;
  }

  private appendScrollback(session: Session, data: string): void {
    session.scrollback.push(data);
    if (session.scrollback.length > this.scrollbackLimit) {
      session.scrollback = session.scrollback.slice(-this.scrollbackLimit);
    }
  }
}
