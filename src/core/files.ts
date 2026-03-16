import * as fs from 'node:fs';
import * as path from 'node:path';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileEntry[];
}

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
]);

function loadGitignore(cwd: string): Set<string> {
  const ignores = new Set(DEFAULT_IGNORE);
  const gitignorePath = path.join(cwd, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        // Simple pattern: strip trailing / for directory patterns
        ignores.add(trimmed.replace(/\/$/, ''));
      }
    }
  } catch {
    // no .gitignore
  }
  return ignores;
}

function shouldIgnore(name: string, ignores: Set<string>): boolean {
  return ignores.has(name) || name.startsWith('.');
}

export function getFileTree(
  cwd: string,
  relativePath = '',
  depth = 3
): FileEntry[] {
  if (depth <= 0) return [];

  const ignores = relativePath === '' ? loadGitignore(cwd) : new Set<string>();
  const fullPath = path.join(cwd, relativePath);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: FileEntry[] = [];

  // Sort: directories first, then files, alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (shouldIgnore(entry.name, ignores)) continue;

    const entryRelPath = path.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: entryRelPath,
        type: 'directory',
        children: getFileTree(cwd, entryRelPath, depth - 1),
      });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(path.join(fullPath, entry.name)).size;
      } catch {
        // ignore
      }
      result.push({
        name: entry.name,
        path: entryRelPath,
        type: 'file',
        size,
      });
    }
  }

  return result;
}

export function readFileContent(
  cwd: string,
  filePath: string
): { content: string; error?: string } {
  // Path traversal protection
  const resolved = path.resolve(cwd, filePath);
  if (!resolved.startsWith(path.resolve(cwd))) {
    return { content: '', error: 'Path traversal not allowed' };
  }

  try {
    const stat = fs.statSync(resolved);
    // Don't read files larger than 1MB
    if (stat.size > 1024 * 1024) {
      return { content: '', error: 'File too large (>1MB)' };
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    return { content };
  } catch {
    return { content: '', error: 'File not found' };
  }
}
