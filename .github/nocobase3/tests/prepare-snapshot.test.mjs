import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareSnapshot } from '../prepare-snapshot.mjs';

let fixture;
let common;
let cleanBase;
let cleanHead;
let conflictBase;
let conflictHead;

function git(args) {
  return execFileSync('git', args, {
    cwd: fixture,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(message) {
  git(['add', '.']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

before(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'nocobase3-pro-ci-'));
  git(['init']);
  git(['config', 'user.name', 'Pro CI test']);
  git(['config', 'user.email', 'pro-ci-test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(fixture, 'shared.txt'), 'common\n');
  common = commit('common base');

  git(['checkout', '-b', 'clean-base']);
  writeFileSync(path.join(fixture, 'base.txt'), 'base\n');
  cleanBase = commit('clean base');

  git(['checkout', '-b', 'clean-head', common]);
  writeFileSync(path.join(fixture, 'head.txt'), 'head\n');
  cleanHead = commit('clean head');

  git(['checkout', '-b', 'conflict-base', common]);
  writeFileSync(path.join(fixture, 'shared.txt'), 'base side\n');
  conflictBase = commit('conflict base');

  git(['checkout', '-b', 'conflict-head', common]);
  writeFileSync(path.join(fixture, 'shared.txt'), 'head side\n');
  conflictHead = commit('conflict head');
});

after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test('creates a merge whose parents are the fixed base and head', () => {
  git(['checkout', '--detach', cleanHead]);
  prepareSnapshot({
    cwd: fixture,
    eventName: 'pull_request',
    headSha: cleanHead.toUpperCase(),
    baseSha: cleanBase,
    mergePullRequest: 'true',
  });

  assert.equal(git(['rev-parse', 'HEAD^1']), cleanBase);
  assert.equal(git(['rev-parse', 'HEAD^2']), cleanHead);
  assert.equal(readFileSync(path.join(fixture, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(path.join(fixture, 'head.txt'), 'utf8'), 'head\n');
});

test('keeps the exact head for checks that must not use a merge result', () => {
  git(['checkout', '--detach', cleanHead]);
  prepareSnapshot({
    cwd: fixture,
    eventName: 'pull_request',
    headSha: cleanHead,
    baseSha: cleanBase,
    mergePullRequest: 'false',
  });

  assert.equal(git(['rev-parse', 'HEAD']), cleanHead);
});

test('fails a conflicting fixed snapshot and aborts the merge', () => {
  git(['checkout', '--detach', conflictHead]);
  assert.throws(
    () =>
      prepareSnapshot({
        cwd: fixture,
        eventName: 'pull_request',
        headSha: conflictHead,
        baseSha: conflictBase,
        mergePullRequest: 'true',
      }),
    /does not merge cleanly/u,
  );

  assert.equal(git(['rev-parse', 'HEAD']), conflictBase);
  assert.equal(git(['status', '--porcelain']), '');
});

test('skips all recursive operations when disabled and keeps nested submodules by default', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'snapshot-submodules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const localGit = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const createRepo = (name) => {
    const cwd = path.join(directory, name);
    localGit(directory, 'init', '--template=', cwd);
    localGit(cwd, 'config', 'user.name', 'CI test');
    localGit(cwd, 'config', 'user.email', 'ci-test@example.com');
    localGit(cwd, 'config', 'commit.gpgsign', 'false');
    return cwd;
  };

  const nested = createRepo('nested');
  writeFileSync(path.join(nested, 'checked-out.txt'), 'nested source\n');
  localGit(nested, 'add', 'checked-out.txt');
  localGit(nested, 'commit', '-m', 'Nested source');

  const framework = createRepo('framework');
  localGit(framework, 'submodule', 'add', nested, 'nested');
  localGit(framework, 'commit', '-m', 'Framework source');

  const source = createRepo('source');
  localGit(source, 'submodule', 'add', framework, 'framework');
  localGit(source, 'commit', '-m', 'Source with framework');
  localGit(source, 'submodule', 'deinit', '--all');
  const head = localGit(source, 'rev-parse', 'HEAD');
  const script = fileURLToPath(new URL('../prepare-snapshot.mjs', import.meta.url));
  const snapshotEnv = {
    ...env,
    EVENT_NAME: 'push',
    HEAD_SHA: head,
    BASE_SHA: '0'.repeat(40),
    MERGE_PULL_REQUEST: 'false',
  };
  delete snapshotEnv.SUBMODULES;

  execFileSync(process.execPath, [script], { cwd: source, env: { ...snapshotEnv, SUBMODULES: 'false' } });
  assert.equal(existsSync(path.join(source, 'framework/.git')), false);
  assert.equal(localGit(source, 'rev-parse', 'HEAD'), head);

  execFileSync(process.execPath, [script], { cwd: source, env: snapshotEnv });
  assert.equal(readFileSync(path.join(source, 'framework/nested/checked-out.txt'), 'utf8'), 'nested source\n');
  assert.equal(localGit(source, 'rev-parse', 'HEAD'), head);
});
