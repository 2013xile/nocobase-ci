import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../pro-preview-gate.sh', import.meta.url));
const head = 'a'.repeat(40);
const repo = 'nocobase/nocobase3-pro';

for (const [branch, sha, state, source, eligible] of [
  ['agent/PM-1899', head, 'open', repo, true],
  ['feat/preview', head, 'open', repo, false],
  ['agent/PM-1899-fix', head, 'open', repo, false],
  ['agent/PM-18', 'b'.repeat(40), 'open', repo, false],
  ['agent/PM-18', head, 'closed', repo, false],
  ['agent/PM-18', head, 'open', 'fork/pro', false],
]) {
  test(`gate ${branch}, ${sha[0]}, ${state}, ${source}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'pro-preview-gate-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s" "$PR_JSON"\n', { mode: 0o700 });
    const output = join(dir, 'output');
    execFileSync('bash', [gate], { env: {
      ...process.env, PATH: dir + ':' + process.env.PATH, PR: '17', HEAD_SHA: head, REPOSITORY: repo,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      PR_JSON: JSON.stringify({ state, head: { sha, ref: branch, repo: { full_name: source } }, labels: [{ name: 'no-preview' }] }),
    } });
    assert.equal(readFileSync(output, 'utf8'), eligible ? 'eligible=true\nlabeled=true\n' : 'eligible=false\n');
  });
}
