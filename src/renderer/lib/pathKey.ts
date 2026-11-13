// Windows paths compare case-insensitively and may mix separators, but the
// stores here are keyed by the exact string the file was opened with. A watcher
// event can spell the same file differently, so match on a normalised key and
// hand back the store's own spelling.

export function pathKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** The member of `keys` that names the same file as `p`, or undefined. Exact match wins. */
export function findKey(keys: Iterable<string>, p: string): string | undefined {
  const want = pathKey(p);
  let found: string | undefined;
  for (const k of keys) {
    if (k === p) return k;
    if (found === undefined && pathKey(k) === want) found = k;
  }
  return found;
}
