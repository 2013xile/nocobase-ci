import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { checkoutPlatformFramework } from '../platform-framework.mjs';

const frameworkPath = 'vendor/nocobase3';
const publicUrl = 'https://github.com/nocobase/nocobase.git';
const gitmodules = `[submodule "${frameworkPath}"]
  path = ${frameworkPath}
  url = ${publicUrl}
  branch = v3
`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo(root, name, branch = 'main') {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, 'init', '--template=', '-b', branch);
  git(cwd, 'config', 'user.name', 'CI test');
  git(cwd, 'config', 'user.email', 'ci-test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}

function commit(cwd) {
  git(cwd, 'commit', '--allow-empty', '-m', 'Test snapshot');
  return git(cwd, 'rev-parse', 'HEAD');
}

function useRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'platform-framework-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function stageModules(cwd, content) {
  writeFileSync(join(cwd, '.gitmodules'), content);
  git(cwd, 'add', '.gitmodules');
}

function stageGitlink(cwd, sha, path = frameworkPath) {
  git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`);
}

function fixture(root) {
  const cwd = repo(root, 'platform');
  return { cwd, tempDirectory: root, summaryPath: join(root, 'summary') };
}

test('logs the exact source head and skips checkout for a legacy platform commit', (t) => {
  const root = useRoot(t);
  const platform = fixture(root);
  const headSha = commit(platform.cwd);
  checkoutPlatformFramework({ ...platform, headSha: headSha.toUpperCase() }, pathToFileURL(join(root, 'missing')).href);
  assert.match(readFileSync(platform.summaryPath, 'utf8'), new RegExp(`source=${headSha} framework=none`, 'u'));
  assert.deepEqual(readdirSync(platform.cwd), ['.git']);
});

test('checks out a historical v3 pin without fetching the tip files or its nested submodule', (t) => {
  const root = useRoot(t);
  const framework = repo(root, 'framework', 'v3');
  git(framework, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(framework, 'framework.txt'), 'pinned version');
  git(framework, 'add', 'framework.txt');
  stageModules(framework, '[submodule "nested"]\n  path = nested\n  url = ./missing-nested\n');
  stageGitlink(framework, '1'.repeat(40), 'nested');
  const pin = commit(framework);
  writeFileSync(join(framework, 'framework.txt'), 'newer version');
  git(framework, 'add', 'framework.txt');
  const tip = commit(framework);

  const platform = fixture(root);
  stageModules(platform.cwd, gitmodules);
  stageGitlink(platform.cwd, pin);
  const headSha = commit(platform.cwd);
  checkoutPlatformFramework({ ...platform, headSha }, pathToFileURL(framework).href);

  const target = join(platform.cwd, frameworkPath);
  assert.equal(git(platform.cwd, 'rev-parse', 'HEAD'), headSha);
  assert.equal(git(target, 'rev-parse', 'HEAD'), pin);
  assert.equal(git(target, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.throws(() => git(target, 'cat-file', '-e', tip));
  assert.match(git(target, 'submodule', 'status'), /^-/u);
  assert.deepEqual(readdirSync(join(target, 'nested')), []);
  assert.equal(readFileSync(join(target, 'framework.txt'), 'utf8'), 'pinned version');
  assert.match(readFileSync(platform.summaryPath, 'utf8'), new RegExp(`source=${headSha} framework=${pin} \\(v3\\)`, 'u'));
  assert.ok(!readdirSync(root).some((name) => name.startsWith('platform-v3-history-')));
});

for (const [name, configuration, paths] of [
  ['fork URL', gitmodules.replace(publicUrl, 'https://github.com/example/nocobase.git'), [frameworkPath]],
  ['SSH URL', gitmodules.replace(publicUrl, 'git@github.com:nocobase/nocobase.git'), [frameworkPath]],
  ['HTTP URL', gitmodules.replace('https:', 'http:'), [frameworkPath]],
  ['file URL', gitmodules.replace(publicUrl, 'file:///tmp/framework'), [frameworkPath]],
  ['URL with credentials', gitmodules.replace('github.com', 'example@github.com'), [frameworkPath]],
  ['wrong branch', gitmodules.replace('branch = v3', 'branch = main'), [frameworkPath]],
  ['duplicate key', `${gitmodules}  path = ${frameworkPath}\n`, [frameworkPath]],
  ['update key', `${gitmodules}  update = merge\n`, [frameworkPath]],
  ['include directive', `${gitmodules}[include]\n  path = example\n`, [frameworkPath]],
  ['wrong target', gitmodules.replace('path = vendor/nocobase3', 'path = vendor/other'), [frameworkPath]],
  ['other section', gitmodules.replace('[submodule "vendor/nocobase3"]', '[submodule "framework"]'), [frameworkPath]],
  ['wrong gitlink path', gitmodules, ['vendor/other']],
  ['additional gitlink', gitmodules, [frameworkPath, 'other']],
  ['only .gitmodules', gitmodules, []],
  ['only gitlink', null, [frameworkPath]],
]) {
  test(`rejects ${name} before fetching history`, (t) => {
    const root = useRoot(t);
    const platform = fixture(root);
    if (configuration !== null) stageModules(platform.cwd, configuration);
    for (const path of paths) stageGitlink(platform.cwd, '1'.repeat(40), path);
    const headSha = commit(platform.cwd);
    assert.throws(
      () => checkoutPlatformFramework({ ...platform, headSha }, pathToFileURL(join(root, 'missing')).href),
      /Expected one vendor\/nocobase3 gitlink|Unexpected submodule configuration/u,
    );
    assert.deepEqual(readdirSync(root), ['platform']);
  });
}

test('rejects a symlink or tree in place of the committed .gitmodules', (t) => {
  const root = useRoot(t);
  const platform = fixture(root);
  symlinkSync('another-file', join(platform.cwd, '.gitmodules'));
  // Create the tree directly because Git rejects .gitmodules symlinks in a normal index update.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: platform.cwd, input: 'another-file', encoding: 'utf8',
  }).trim();
  const tree = spawnTree(platform.cwd, `100644 blob ${blob}\tfile\n`);
  for (const entry of [`120000 blob ${blob}`, `040000 tree ${tree}`]) {
    const rootTree = spawnTree(platform.cwd, `${entry}\t.gitmodules\n`);
    const headSha = git(platform.cwd, 'commit-tree', rootTree, '-m', 'Non-regular configuration');
    git(platform.cwd, 'update-ref', 'HEAD', headSha);
    assert.throws(() => checkoutPlatformFramework({ ...platform, headSha }), /regular .gitmodules/u);
  }
});

function spawnTree(cwd, content) {
  return execFileSync('git', ['mktree', '--missing'], { cwd, input: content, encoding: 'utf8' }).trim();
}

test('rejects a source head mismatch, a retained checkout header and a changed .gitmodules before fetching', (t) => {
  const root = useRoot(t);
  const platform = fixture(root);
  stageModules(platform.cwd, gitmodules);
  stageGitlink(platform.cwd, '1'.repeat(40));
  const headSha = commit(platform.cwd);
  const checkout = (sha = headSha) => checkoutPlatformFramework({ ...platform, headSha: sha });
  assert.throws(() => checkout('f'.repeat(40)), /does not match head_sha/u);
  stageModules(platform.cwd, gitmodules.replace(publicUrl, 'https://example.com/framework.git'));
  assert.throws(checkout, /checked-out .gitmodules differs/u);
  appendFileSync(join(platform.cwd, '.git', 'config'), '[http "https://github.com/"]\n  extraheader =\n');
  assert.throws(checkout, /authentication headers are still configured/u);
  assert.deepEqual(readdirSync(root), ['platform']);
});

test('rejects a checkout path redirected through a vendor symlink', (t) => {
  const root = useRoot(t);
  const platform = fixture(root);
  stageModules(platform.cwd, gitmodules);
  stageGitlink(platform.cwd, '1'.repeat(40));
  const headSha = commit(platform.cwd);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(platform.cwd, 'vendor'));
  assert.throws(() => checkoutPlatformFramework({ ...platform, headSha }), /vendor path must be a directory/u);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('fails closed and cleans up history for a SHA from another branch or a missing SHA', (t) => {
  const root = useRoot(t);
  const framework = repo(root, 'framework', 'v3');
  git(framework, 'config', 'uploadpack.allowFilter', 'true');
  commit(framework);
  git(framework, 'switch', '-c', 'another-branch');
  const outside = commit(framework);
  assert.equal(git(framework, 'cat-file', '-t', outside), 'commit');

  const platform = fixture(root);
  stageModules(platform.cwd, gitmodules);
  for (const sha of [outside, 'a'.repeat(40)]) {
    stageGitlink(platform.cwd, sha);
    const headSha = commit(platform.cwd);
    assert.throws(
      () => checkoutPlatformFramework({ ...platform, headSha }, pathToFileURL(framework).href),
      /not reachable from public v3/u,
    );
    assert.deepEqual(readdirSync(root), ['framework', 'platform']);
  }
});
