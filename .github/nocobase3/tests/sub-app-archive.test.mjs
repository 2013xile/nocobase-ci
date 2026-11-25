import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
test('validates real tar/gzip fixtures: identity, Portals, targets, traversal, links and truncation', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./sub-app-archive-fixtures.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
});
