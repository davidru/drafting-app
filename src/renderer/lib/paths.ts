// Path helpers for the renderer, which has no Node `path` module. Paths on
// Windows arrive with backslashes from every main-process API; keep them as-is
// so Map/Set keys stay consistent, and only reason about separators here.

export const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';

export function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export function joinPath(dir: string, name: string): string {
  if (dir.endsWith('\\') || dir.endsWith('/')) return dir + name;
  return dir + SEP + name;
}

export function extName(p: string): string {
  const name = baseName(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** Path relative to `root`, with forward slashes, for use in Claude prompts (`@docs/file.md`). */
export function relativeTo(root: string | null, p: string): string {
  if (!root) return p;
  const r = root.replace(/[/\\]+$/, '');
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  if (norm(p).startsWith(norm(r) + '/')) return p.slice(r.length + 1).replace(/\\/g, '/');
  return p;
}

export function isUnder(root: string, p: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(p).startsWith(norm(root) + '/');
}

/** Quote a path for a shell prompt if it has spaces. */
export function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.tsv',
  '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less', '.html', '.htm',
  '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  '.env', '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc',
  '.cfg', '.ini', '.conf', '.log', '.svg',
]);

export const PROSE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '']);

export function isProse(p: string): boolean {
  return PROSE_EXTENSIONS.has(extName(p));
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown', '.txt': 'markdown', '.text': 'markdown', '': 'markdown',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.xml': 'xml', '.csv': 'plaintext', '.tsv': 'plaintext',
  '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.htm': 'html', '.svg': 'xml',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.bat': 'bat', '.cmd': 'bat', '.ps1': 'powershell',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.log': 'plaintext', '.env': 'ini',
};

export function languageFor(p: string): string {
  return LANGUAGE_BY_EXT[extName(p)] ?? 'plaintext';
}
