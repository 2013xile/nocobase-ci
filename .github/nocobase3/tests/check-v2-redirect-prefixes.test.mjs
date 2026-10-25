import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findConflicts, parsePrefixes } from '../docs-publish/check-v2-redirect-prefixes.mjs';

const script = fileURLToPath(new URL('../docs-publish/check-v2-redirect-prefixes.mjs', import.meta.url));
const list = fileURLToPath(new URL('../docs-publish/v2-redirect-prefixes.txt', import.meta.url));

function dist(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'v3-docs-dist-'));
  for (const entry of entries) {
    if (entry.endsWith('/')) mkdirSync(path.join(dir, entry), { recursive: true });
    else writeFileSync(path.join(dir, entry), 'x');
  }
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

test('the list parses, ignoring comments, and leaves the current v3 top level alone', () => {
  const prefixes = parsePrefixes(readFileSync(list, 'utf8'));
  assert.ok(prefixes.has('guide') && prefixes.has('api') && prefixes.has('vi'));
  for (const name of ['assets', 'core', 'start', 'studio', 'zh-CN', 'en']) assert.ok(!prefixes.has(name), name);
  assert.throws(() => parsePrefixes('# only a comment\n'), /empty/u);
  assert.throws(() => parsePrefixes('guide/intro\n'), /single path segment/u);
});

test('passes a build whose top level is not redirected', () => {
  const dir = dist(['assets/', 'core/', 'start/', 'studio/', 'zh-CN/', 'index.html', '404.html', 'sitemap.xml', 'llms.txt', 'robots.txt', 'guide.html']);
  try {
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails a build with a redirected top-level directory and names it', () => {
  const dir = dist(['core/', 'guide/', 'api/', 'index.html']);
  try {
    assert.deepEqual(findConflicts(dir, parsePrefixes(readFileSync(list, 'utf8'))), ['api/', 'guide/']);
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::The build has a top-level api\//u);
    assert.match(result.stderr, /::error::The build has a top-level guide\//u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the directory is missing', () => {
  assert.equal(run(path.join(tmpdir(), 'v3-docs-dist-does-not-exist')).status, 2);
});
