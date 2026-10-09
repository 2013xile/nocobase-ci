import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFrameworkPointer, frameworkBranch } from '../check-framework-pointer.mjs';

test('maps Pro branch names according to the actual framework repository', () => {
  for (const [remote, expected] of [
    ['https://github.com/nocobase/nocobase3.git', ['main', 'develop']],
    ['https://github.com/nocobase/nocobase.git', ['v3-main', 'v3-develop']],
    ['git@github.com:nocobase/nocobase.git', ['v3-main', 'v3-develop']],
  ]) {
    assert.equal(frameworkBranch(remote, 'main'), expected[0]);
    assert.equal(frameworkBranch(remote, 'develop'), expected[1]);
  }
  assert.equal(frameworkBranch('https://github.com/nocobase/nocobase.git', 'feature/foo'), 'v3-develop');
  assert.equal(frameworkBranch('https://github.com/nocobase/nocobase3.git', 'release/test'), 'develop');
  assert.equal(frameworkBranch('https://example.com/fork.git', 'main'), 'main');
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'framework-pointer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = path.join(directory, 'upstream');
  const pro = path.join(directory, 'pro');
  mkdirSync(upstream);
  mkdirSync(pro);
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  for (const cwd of [upstream, pro]) {
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'CI fixture');
    git(cwd, 'config', 'user.email', 'ci@example.com');
    git(cwd, 'config', 'commit.gpgsign', 'false');
  }
  const commit = (content) => {
    writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: content }));
    git(upstream, 'add', 'package.json');
    git(upstream, 'commit', '-m', content);
    return git(upstream, 'rev-parse', 'HEAD');
  };
  const v2 = commit('legacy');
  git(upstream, 'checkout', '--orphan', 'v3-develop');
  const base = commit('framework');
  git(upstream, 'branch', 'v3-main', base);
  const head = commit('framework-next');
  git(upstream, 'branch', 'develop', head);
  mkdirSync(path.join(pro, 'vendor'));
  git(pro, 'clone', upstream, 'vendor/nocobase3');
  const vendor = path.join(pro, 'vendor/nocobase3');
  const setRemote = (name) => {
    const remote = `https://github.com/nocobase/${name}.git`;
    git(vendor, 'config', 'remote.origin.url', remote);
    git(vendor, 'config', `url.${upstream}.insteadOf`, remote);
  };
  const pin = (sha) => {
    git(vendor, 'checkout', '--detach', sha);
    git(pro, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/nocobase3`);
    git(pro, 'commit', '--allow-empty', '-m', 'pin framework');
  };
  setRemote('nocobase');
  return { pro, vendor, upstream, base, head, v2, git, pin, setRemote };
}

test('accepts older framework commits on the new v3 branches, never v2 main', (t) => {
  const f = fixture(t);
  f.pin(f.base);
  assert.deepEqual(checkFrameworkPointer(f.pro, 'main'), { branch: 'v3-main', pinned: f.base });
  assert.deepEqual(checkFrameworkPointer(f.pro, 'develop'), { branch: 'v3-develop', pinned: f.base });
  f.pin(f.v2);
  assert.throws(() => checkFrameworkPointer(f.pro, 'main'), /not on v3-main/u);
});

test('checks the recorded pointer against the migrated stable branch', (t) => {
  const f = fixture(t);
  f.pin(f.head);
  assert.throws(() => checkFrameworkPointer(f.pro, 'main'), /not on v3-main/u);
  f.git(f.vendor, 'checkout', '--detach', f.base);
  assert.equal(checkFrameworkPointer(f.pro, 'develop').pinned, f.head);
});

test('rejects an empty migrated target branch as the original pointer check does', (t) => {
  const f = fixture(t);
  f.pin(f.base);
  const emptyTree = f.git(f.upstream, 'mktree');
  const emptyCommit = f.git(f.upstream, 'commit-tree', emptyTree, '-m', 'empty stable');
  f.git(f.upstream, 'update-ref', 'refs/heads/v3-main', emptyCommit);
  assert.throws(() => checkFrameworkPointer(f.pro, 'main'), /empty/u);
});

test('delegates unchanged legacy targets to the original source-owned checker', (t) => {
  const f = fixture(t);
  f.setRemote('nocobase3');
  mkdirSync(path.join(f.pro, 'scripts'));
  writeFileSync(path.join(f.pro, 'scripts/pin-submodule.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync('checker-args.json', JSON.stringify(process.argv.slice(2)));`);
  for (const [target, branch] of [['main', 'main'], ['develop', 'develop'], ['release/test', 'develop']]) {
    assert.deepEqual(checkFrameworkPointer(f.pro, target), { branch, delegated: true });
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.pro, 'checker-args.json'), 'utf8')), ['--check', '--branch', branch]);
  }
});
