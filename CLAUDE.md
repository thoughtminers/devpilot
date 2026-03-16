# devpilot

Remote dev session dashboard. Monitor and interact with terminal sessions from your phone.

## Architecture

Single daemon process manages everything:
- **PTY sessions** via node-pty (spawn, attach, detach, kill)
- **Web server** on port 3000 (Fastify) serves dashboard + REST API
- **WebSocket** broadcasts live terminal output to browser clients
- **Unix socket** at `~/.devpilot/daemon.sock` for CLI ↔ daemon communication

```
CLI (devpilot start/attach/stop)
    ↕ Unix socket
Daemon process
    ├── SessionManager (node-pty instances)
    ├── Fastify server (REST API + static files)
    └── WebSocket server (terminal I/O)
        ↕
Phone browser (xterm.js + diff viewer + file browser)
```

## Project Structure

```
src/
├── cli.ts              # CLI entry point (commander)
├── daemon.ts           # Daemon process entry point
├── server.ts           # Fastify + WebSocket + REST API
├── core/
│   ├── session.ts      # PTY session manager
│   ├── git.ts          # Git operations (diff, status, log)
│   └── files.ts        # File tree & reading (.gitignore aware)
└── types.ts            # TypeScript types

public/
├── index.html          # Dashboard SPA
├── styles.css          # Mobile-first dark theme
└── app.js              # Frontend (xterm.js, diff2html, highlight.js)

bin/
└── devpilot            # Executable entry point
```

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript (strict mode)
- **Server**: Fastify
- **WebSocket**: ws
- **PTY**: node-pty
- **Frontend**: Vanilla JS (no framework)
  - xterm.js for terminal rendering
  - diff2html for diff rendering
  - highlight.js for syntax highlighting
- **Linting**: ESLint (flat config)
- **Formatting**: Prettier

## Code Style

- TypeScript strict mode
- ESLint flat config (eslint.config.js)
- Prettier for formatting
- Semicolons, single quotes, 2-space indent, trailing commas (es5)
- Prefer `async/await` over callbacks
- Use `const` by default, `let` when reassignment needed
- No `any` types — use `unknown` and narrow

## Commands

```
npm run build          # Compile TypeScript
npm run dev            # Run in dev mode
npm run lint           # ESLint check
npm run format         # Prettier format
```

## Key Design Decisions

- **node-pty over multiplexers**: Own the PTY directly. No tmux/Zellij dependency, no polling, no keybinding conflicts.
- **Single daemon**: One background process manages all sessions. First `devpilot start` launches it, subsequent ones connect to it.
- **Unix socket for CLI↔daemon**: Fast, local-only, no port conflicts.
- **Vanilla frontend**: No React/Vue/Svelte. Keep it light and fast-loading on mobile.
- **REST for diffs/files, WebSocket for terminal**: Different data patterns need different transports.
