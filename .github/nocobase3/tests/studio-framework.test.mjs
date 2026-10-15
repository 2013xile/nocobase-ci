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
const gatePath = path.join(root, '.github/nocobase3/studio-framework-gate');
const gate = readFileSync(path.join(gatePath, 'action.yml'), 'utf8');

// The shell of an action's one `run: |` block, unindented.
function script(source = action) {
  const lines = source.split('\n');
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
// v3-develop; a fake `gh` answers the pull request lookup with FAKE_PULLS, already in the `--jq` output's shape
// (`<number> <state> merged|unmerged <merge commit>` per line).
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
  git(pub, 'branch', 'v3-main');
  git(pub, 'checkout', '-q', '-b', 'agent/PM-1');
  writeFileSync(path.join(pub, 'pnpm-workspace.yaml'), workspace(['packages/*/*'], '^19.0.0'));
  git(pub, 'commit', '-q', '-am', 'feature');
  const tip = git(pub, 'rev-parse', 'HEAD');
  git(pub, 'checkout', '-q', 'v3-develop');
  // What a squash merge of agent/PM-1 would put on v3-develop, kept aside on a branch until a test merges it.
  git(pub, 'checkout', '-q', '-b', 'squash');
  writeFileSync(path.join(pub, 'pnpm-workspace.yaml'), workspace(['packages/*/*'], '^19.0.0'));
  git(pub, 'commit', '-q', '-am', 'feature (#5)');
  const squash = git(pub, 'rev-parse', 'HEAD');
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
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s" "$FAKE_PULLS"\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { dir, pub, studio, bin, pointer, tip, squash, git };
}

function run(context, source, headRef, pulls) {
  const output = path.join(context.dir, 'output');
  const summary = path.join(context.dir, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const result = spawnSync('bash', ['-c', script(source)], {
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
      FAKE_PULLS: pulls,
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

const choose = (context, headRef, pulls = '') => run(context, action, headRef, pulls);
const check = (context, headRef, pulls = '') => run(context, gate, headRef, pulls);

test('builds a pull request against the unmerged same-name framework branch, with its workspace settings', () => {
  const context = fixture();
  try {
    const result = choose(context, 'agent/PM-1', '5 open unmerged -');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.summary, /of the same name \(#5\)/u);
    assert.deepEqual(result.outputs, { source: 'branch', sha: context.tip, 'install-flag': '--no-frozen-lockfile' });
    assert.equal(result.vendor, context.tip);
    assert.equal(result.workspace, workspace(['.', 'vendor/nocobase3/packages/*/*'], '^19.0.0'));
    assert.match(result.summary, /### Framework\n\nvendor\/nocobase3 is nocobase\/nocobase's `agent\/PM-1`/u);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('also builds on a same-name branch that has no pull request yet', () => {
  const context = fixture();
  try {
    const result = choose(context, 'agent/PM-1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.source, 'branch');
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('keeps the committed pointer without a same-name branch, for a push, a long-lived name, or a merged or closed change', () => {
  const context = fixture();
  try {
    for (const [headRef, merged, reason] of [
      ['agent/PM-9', '', /has no branch `agent\/PM-9`/u],
      ['', '', /No pull request head branch/u],
      ['v3-develop', '', /long-lived branch name/u],
      ['main', '', /long-lived branch name/u],
      ['agent/PM-1', `42 closed merged ${context.squash}`, /nocobase\/nocobase#42 \(`agent\/PM-1`\) has merged/u],
      ['agent/PM-1', '41 closed unmerged -', /closed without merging/u],
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

test('the gate passes a push, a long-lived name, an unpaired branch and a change closed without merging', () => {
  const context = fixture();
  try {
    for (const [headRef, pulls, message] of [
      ['', '', /a push/u],
      ['main', '', /long-lived branch name/u],
      ['agent/PM-9', '', /has no branch or pull request `agent\/PM-9`/u],
      ['agent/PM-1', '41 closed unmerged -', /closed without merging/u],
    ]) {
      const result = check(context, headRef, pulls);
      assert.equal(result.status, 0, `${headRef}: ${result.stderr}`);
      assert.match(result.summary, /### Framework half\n\n(?!Failed)/u, headRef);
      assert.match(result.summary, message, headRef);
    }
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('the gate fails while the framework half is open, or its branch has no pull request', () => {
  const context = fixture();
  try {
    for (const [pulls, message] of [
      ['6 open unmerged -\n5 closed unmerged -', /nocobase\/nocobase#6 \(`agent\/PM-1`\), the framework half of this change, has not merged yet/u],
      ['', /has a branch `agent\/PM-1`, named like this pull request's head, with no pull request/u],
    ]) {
      const result = check(context, 'agent/PM-1', pulls);
      assert.notEqual(result.status, 0);
      assert.match(result.summary, /Failed: /u);
      assert.match(result.summary, message);
    }
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('the gate fails on a merged framework half until the pointer contains its merge commit', () => {
  const context = fixture();
  try {
    // The squash merge lands on v3-develop and the branch is deleted.
    context.git(context.pub, 'checkout', '-q', 'v3-develop');
    context.git(context.pub, 'merge', '-q', '--ff-only', 'squash');
    context.git(context.pub, 'branch', '-q', '-D', 'agent/PM-1');
    const pulls = `5 closed merged ${context.squash}`;
    const stale = check(context, 'agent/PM-1', pulls);
    assert.notEqual(stale.status, 0);
    assert.match(stale.summary, /Failed: nocobase\/nocobase#5 \(`agent\/PM-1`\), the framework half of this change, has merged as/u);
    assert.match(stale.summary, /does not contain it/u);

    // The Studio pull request moves the pointer to the v3-develop commit that contains it.
    const vendor = path.join(context.studio, 'vendor/nocobase3');
    context.git(vendor, 'fetch', '-q', 'origin');
    context.git(vendor, 'checkout', '-q', context.squash);
    context.git(context.studio, 'commit', '-q', '-am', 'bump');
    const bumped = check(context, 'agent/PM-1', pulls);
    assert.equal(bumped.status, 0, bumped.stderr);
    assert.match(bumped.summary, /contains nocobase\/nocobase#5/u);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("the gate runs no pull request code and fetches nocobase/nocobase without a credential", () => {
  assert.match(gate, /PUBLIC_URL: https:\/\/github\.com\/nocobase\/nocobase\.git\n/u);
  assert.doesNotMatch(gate, /x-access-token|extraheader|token@|node |pnpm |scripts\//u);
});
