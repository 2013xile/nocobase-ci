import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const actionPath = path.join(root, '.github/nocobase3/studio-framework');
const action = readFileSync(path.join(actionPath, 'action.yml'), 'utf8');

// The shell of the action's one `run: |` block, unindented.
function script() {
  const lines = action.split('\n');
  const begin = lines.findIndex((line) => line === '      run: |');
  assert.notEqual(begin, -1);
  return lines
    .slice(begin + 1)
    .filter((line) => line.startsWith('        ') || line === '')
    .map((line) => line.slice(8))
    .join('\n');
}

const env = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

const workspace = (packages, react) => `packages:\n${packages.map((p) => `  - ${p}`).join('\n')}\n\ncatalog:\n  react: ${react}\n`;

// A public repository with v3-develop and a feature branch, and a Studio repository whose vendor/nocobase3 points at
// v3-develop; a fake `gh` answers the merged pull request lookup with FAKE_MERGED.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-framework-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' }).toString().trim();
  const pub = path.join(dir, 'public');
  mkdirSync(pub);
  git(pub, 'init', '-q', '-b', 'v3-develop');
  writeFileSync(path.join(pub, 'pnpm-workspace.yaml'), workspace(['packages/*/*'], '^18.0.0'));
  git(pub, 'add', '-A');
  git(pub, 'commit', '-q', '-m', 'base');
  const pointer = git(pub, 'rev-parse', 'HEAD');
  git(pub, 'checkout', '-q', '-b', 'agent/PM-1');
  writeFileSync(path.join(pub, 'pnpm-workspace.yaml'), workspace(['packages/*/*'], '^19.0.0'));
  git(pub, 'commit', '-q', '-am', 'feature');
  const tip = git(pub, 'rev-parse', 'HEAD');
  git(pub, 'checkout', '-q', 'v3-develop');

  const studio = path.join(dir, 'studio');
  mkdirSync(studio);
  git(studio, 'init', '-q', '-b', 'dev');
  git(studio, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', pub, 'vendor/nocobase3');
  writeFileSync(path.join(studio, 'pnpm-workspace.yaml'), workspace(['.', 'vendor/nocobase3/packages/*/*'], '^18.0.0'));
  git(studio, 'add', '-A');
  git(studio, 'commit', '-q', '-m', 'studio');

  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s" "$FAKE_MERGED"\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { dir, pub, studio, bin, pointer, tip, git };
}

function choose(context, headRef, merged = '') {
  const output = path.join(context.dir, 'output');
  const summary = path.join(context.dir, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const result = spawnSync('bash', ['-c', script()], {
    cwd: context.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PATH: `${context.bin}:${process.env.PATH}`,
      STUDIO: 'studio',
      HEAD_REF: headRef,
      GH_TOKEN: 'token',
      PUBLIC_URL: context.pub,
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_MERGED: merged,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/su).slice(0, 2)),
  );
  return {
    status: result.status,
    stderr: result.stderr,
    outputs,
    summary: readFileSync(summary, 'utf8'),
    vendor: context.git(path.join(context.studio, 'vendor/nocobase3'), 'rev-parse', 'HEAD'),
    workspace: readFileSync(path.join(context.studio, 'pnpm-workspace.yaml'), 'utf8'),
  };
}

test('builds a pull request against the unmerged same-name framework branch, with its workspace settings', () => {
  const context = fixture();
  try {
    const result = choose(context, 'agent/PM-1');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.outputs, { source: 'branch', sha: context.tip, 'install-flag': '--no-frozen-lockfile' });
    assert.equal(result.vendor, context.tip);
    assert.equal(result.workspace, workspace(['.', 'vendor/nocobase3/packages/*/*'], '^19.0.0'));
    assert.match(result.summary, /### Framework\n\nvendor\/nocobase3 is nocobase\/nocobase's `agent\/PM-1`/u);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('keeps the committed pointer without a same-name branch, for a push, a long-lived name or a merged branch', () => {
  const context = fixture();
  try {
    for (const [headRef, merged, reason] of [
      ['agent/PM-9', '', /has no branch `agent\/PM-9`/u],
      ['', '', /No pull request head branch/u],
      ['v3-develop', '', /long-lived branch name/u],
      ['main', '', /long-lived branch name/u],
      ['agent/PM-1', '42', /nocobase\/nocobase#42 \(`agent\/PM-1`\) has merged/u],
    ]) {
      const result = choose(context, headRef, merged);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.outputs, { source: 'pointer', sha: context.pointer, 'install-flag': '--frozen-lockfile' }, headRef);
      assert.equal(result.vendor, context.pointer, headRef);
      assert.equal(result.workspace, workspace(['.', 'vendor/nocobase3/packages/*/*'], '^18.0.0'), headRef);
      assert.match(result.summary, /vendor\/nocobase3 is the committed pointer/u, headRef);
      assert.match(result.summary, reason, headRef);
    }
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('refuses a head branch that is not a valid branch name', () => {
  const context = fixture();
  try {
    for (const headRef of ['-x', 'a..b', 'a b']) {
      const result = choose(context, headRef);
      assert.notEqual(result.status, 0, headRef);
      assert.equal(result.vendor, context.pointer);
    }
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('fetches the public repository without a credential', () => {
  assert.match(action, /PUBLIC_URL: https:\/\/github\.com\/nocobase\/nocobase\.git\n/u);
  assert.doesNotMatch(action, /x-access-token|extraheader|token@/u);
});
