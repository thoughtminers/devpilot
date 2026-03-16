import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { getDaemonPaths, isDaemonRunning, sendToDaemon } from './daemon.js';
import type { DaemonMessage, SessionInfo } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getLocalIp(): string {
  try {
    const result = execSync(
      "ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'",
      { encoding: 'utf-8' }
    ).trim();
    return result || 'localhost';
  } catch {
    return 'localhost';
  }
}

async function ensureDaemon(port: number): Promise<void> {
  if (isDaemonRunning()) return;

  const { dir } = getDaemonPaths();
  fs.mkdirSync(dir, { recursive: true });

  const daemonScript = path.join(__dirname, 'daemon.js');
  const logFile = path.join(dir, 'daemon.log');
  const out = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      DEVPILOT_PORT: String(port),
    },
  });

  child.unref();

  // Wait for daemon to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const resp = await sendToDaemon({ type: 'ping' });
      if (resp.type === 'pong') return;
    } catch {
      // not ready yet
    }
  }

  // If we get here, show the log
  const log = fs.readFileSync(logFile, 'utf-8').trim();
  throw new Error(`Daemon failed to start within 6 seconds.\nLog: ${log}`);
}

const DETACH_COMMAND = '/detach';

async function attachToSession(sessionId: string, port = 3010): Promise<void> {
  const { WebSocket } = await import('ws');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      // Subscribe to session
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));

      // Enter raw mode so keystrokes go straight to the PTY
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      // Buffer for detecting detach command
      let inputBuffer = '';
      let buffering = false;

      const sendTopty = (data: string) => {
        ws.send(JSON.stringify({ type: 'input', sessionId, data }));
      };

      const flushBuffer = () => {
        if (inputBuffer) {
          sendTopty(inputBuffer);
          inputBuffer = '';
        }
        buffering = false;
      };

      // Forward local input to PTY, intercepting detach command
      process.stdin.on('data', (data: Buffer) => {
        const str = data.toString();

        for (const char of str) {
          if (char === '/' && !buffering) {
            buffering = true;
            inputBuffer = '/';
            continue;
          }

          if (buffering) {
            // Enter pressed — check if buffer is the detach command
            if (char === '\r' || char === '\n') {
              if (inputBuffer === DETACH_COMMAND) {
                console.log('\nDetached. Session continues in background.');
                console.log(`Reattach with: devpilot attach ${sessionId}`);
                cleanup();
                resolve();
                return;
              }
              // Not detach — flush buffer + enter to PTY
              inputBuffer += char;
              flushBuffer();
              continue;
            }

            inputBuffer += char;

            // Check if buffer still matches detach command prefix
            if (!DETACH_COMMAND.startsWith(inputBuffer)) {
              flushBuffer();
            }
            continue;
          }

          // Normal mode — send directly
          sendTopty(char);
        }
      });

      // Send terminal size
      const sendResize = () => {
        ws.send(
          JSON.stringify({
            type: 'resize',
            sessionId,
            cols: process.stdout.columns,
            rows: process.stdout.rows,
          })
        );
      };
      sendResize();
      process.stdout.on('resize', sendResize);
    });

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'scrollback':
        case 'output':
          process.stdout.write(msg.data);
          break;
        case 'session_ended':
          console.log('\nSession ended.');
          cleanup();
          resolve();
          break;
        case 'error':
          console.error('\nError:', msg.error);
          break;
      }
    });

    ws.on('close', () => {
      cleanup();
      resolve();
    });

    ws.on('error', err => {
      cleanup();
      reject(err);
    });

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      ws.close();
    };
  });
}

const program = new Command();

program
  .name('devpilot')
  .description('Remote dev session dashboard')
  .version('0.1.0');

program
  .command('start')
  .description('Start a new session')
  .argument('[command]', 'Command to run', process.env.SHELL ?? 'bash')
  .option('-n, --name <name>', 'Session name')
  .option('-p, --port <port>', 'Web server port', '3010')
  .action(async (command: string, opts: { name?: string; port: string }) => {
    const port = parseInt(opts.port, 10);

    await ensureDaemon(port);

    const ip = getLocalIp();
    console.log(`Dashboard: http://${ip}:${port}`);

    // Resolve command to full path before sending to daemon
    let resolvedCommand = command;
    if (!command.startsWith('/')) {
      try {
        resolvedCommand = execSync(`which ${command}`, {
          encoding: 'utf-8',
        }).trim();
      } catch {
        console.error(`Command not found: ${command}`);
        process.exit(1);
      }
    }

    const response = (await sendToDaemon({
      type: 'create',
      name: opts.name,
      command: resolvedCommand,
      args: [],
      cwd: process.cwd(),
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      env: process.env,
    })) as DaemonMessage & { session?: SessionInfo };

    if (response.type === 'error') {
      console.error('Failed to create session:', response.error);
      process.exit(1);
    }

    const session = response.session as unknown as SessionInfo;
    console.log(`Session ${session.id} (${session.name}) started.`);
    console.log('Attaching... (session persists if you disconnect)\n');

    await attachToSession(session.id, port);
  });

program
  .command('attach')
  .description('Attach to a running session')
  .argument('<session>', 'Session ID')
  .option('-p, --port <port>', 'Web server port', '3010')
  .action(async (sessionId: string, opts: { port: string }) => {
    if (!isDaemonRunning()) {
      console.error('No daemon running. Start a session first.');
      process.exit(1);
    }

    await attachToSession(sessionId, parseInt(opts.port, 10));
  });

program
  .command('list')
  .description('List active sessions')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    const response = await sendToDaemon({ type: 'list' });
    const sessions = (response.sessions ?? []) as unknown as SessionInfo[];

    if (sessions.length === 0) {
      console.log('No active sessions.');
      return;
    }

    console.log('Active sessions:\n');
    for (const s of sessions) {
      const age = Math.round(
        (Date.now() - new Date(s.createdAt).getTime()) / 1000
      );
      console.log(
        `  ${s.id}  ${s.name}  ${s.command}  ${s.cwd}  (${age}s ago)`
      );
    }
  });

program
  .command('stop')
  .description('Stop a session or all sessions')
  .argument('[session]', 'Session ID (omit for --all)')
  .option('-a, --all', 'Stop all sessions and shut down daemon')
  .action(async (sessionId?: string, opts?: { all?: boolean }) => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    if (opts?.all) {
      await sendToDaemon({ type: 'kill_all' });
      console.log('All sessions stopped. Daemon shutting down.');
    } else if (sessionId) {
      const response = await sendToDaemon({ type: 'kill', id: sessionId });
      if (response.type === 'error') {
        console.error(response.error);
        process.exit(1);
      }
      console.log(`Session ${sessionId} stopped.`);
    } else {
      console.error('Provide a session ID or use --all.');
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show daemon and session status')
  .option('-p, --port <port>', 'Web server port', '3010')
  .action(async (opts: { port: string }) => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    const ip = getLocalIp();
    console.log(`Dashboard: http://${ip}:${opts.port}`);

    const response = await sendToDaemon({ type: 'list' });
    const sessions = (response.sessions ?? []) as unknown as SessionInfo[];
    console.log(`Sessions: ${sessions.length}`);

    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.name}  ${s.command}  ${s.cwd}`);
    }
  });

program.parse();
