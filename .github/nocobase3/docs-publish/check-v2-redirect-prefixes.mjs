#!/usr/bin/env node
// Fails when the v3 documentation build has a top-level entry whose name the docs.nocobase.com CDN redirects to the v2
// documentation (see v2-redirect-prefixes.txt), since every page under it would be unreachable once published.
//
// Usage: node check-v2-redirect-prefixes.mjs <dist directory> [prefix list]
//
// The CDN rule matches the first path segment exactly, so an entry conflicts only when its whole name is on the list:
// a directory `guide/` (served as /guide/...) or an extensionless file `guide` does, while `guide.html` does not.
// Zero dependencies, so `Docs build` can run it without installing anything.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIST = fileURLToPath(new URL('./v2-redirect-prefixes.txt', import.meta.url));

export function parsePrefixes(text) {
  const prefixes = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  for (const prefix of prefixes) {
    if (!/^[A-Za-z0-9._-]+$/u.test(prefix)) {
      throw new Error(`Invalid prefix ${JSON.stringify(prefix)}: expected a single path segment.`);
    }
  }
  if (prefixes.length === 0) {
    throw new Error('The prefix list is empty.');
  }
  return new Set(prefixes);
}

export function findConflicts(distDir, prefixes) {
  return readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => prefixes.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

function main(argv) {
  const [distDir, listFile = DEFAULT_LIST] = argv;
  if (!distDir) {
    console.error('Usage: node check-v2-redirect-prefixes.mjs <dist directory> [prefix list]');
    return 2;
  }
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`::error::${distDir} is not a directory.`);
    return 2;
  }
  const prefixes = parsePrefixes(readFileSync(listFile, 'utf8'));
  const conflicts = findConflicts(distDir, prefixes);
  if (conflicts.length === 0) {
    console.log(`No top-level entry of ${distDir} is redirected to the v2 documentation (${prefixes.size} prefixes checked).`);
    return 0;
  }
  const listName = path.relative(process.cwd(), listFile) || listFile;
  for (const name of conflicts) {
    console.error(
      `::error::The build has a top-level ${name}, which the docs.nocobase.com CDN redirects to nocode.docs.nocobase.com (${listName}). Rename it, or remove the prefix from both ${listName} and the EdgeScript rule v2_paths_to_nocode_301.`,
    );
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
