import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkoutPlatformFramework, frameworkGitEnvironment, inspectPlatformFramework } from '../platform-framework.mjs';

const PRO = 'vendor/nocobase3-pro';
const OSS = 'vendor/nocobase3';
const PRO_URL = 'https://github.com/nocobase/nocobase3-pro.git';
const OSS_URL = 'https://github.com/nocobase/nocobase.git';
const modules = (path, url, branch) => `[submodule "${path}"]\n  path = ${path}\n  url = ${url}\n  branch = ${branch}\n`;
const proModules = modules(PRO, PRO_URL, 'develop');
const ossModules = modules(OSS, OSS_URL, 'v3');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repo(root, name, branch) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, 'init', '--template=', '-b', branch);
  git(cwd, 'config', 'user.name', 'CI test');
  git(cwd, 'config', 'user.email', 'ci-test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'uploadpack.allowFilter', 'true');
  return cwd;
}
function commit(cwd) {
  git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic snapshot');
  return git(cwd, 'rev-parse', 'HEAD');
}
function pin(cwd, path, sha, config) {
  writeFileSync(join(cwd, '.gitmodules'), config);
  git(cwd, 'add', '.gitmodules');
  git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`);
  return commit(cwd);
}
function fixture(t, innerConfig = ossModules, innerPath = OSS) {
  const root = mkdtempSync(join(tmpdir(), 'platform-pro-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oss = repo(root, 'oss', 'v3');
  writeFileSync(join(oss, 'fixture.txt'), 'historical OSS\n');
  git(oss, 'add', 'fixture.txt');
  const ossPin = commit(oss);
  writeFileSync(join(oss, 'fixture.txt'), 'newer OSS\n');
  git(oss, 'add', 'fixture.txt');
  const ossTip = commit(oss);
  const pro = repo(root, 'pro', 'develop');
  const proPin = pin(pro, innerPath, ossPin, innerConfig);
  const proTip = pin(pro, innerPath, ossTip, innerConfig);
  const cwd = repo(root, 'app', 'main');
  const headSha = pin(cwd, PRO, proPin, proModules);
  return { root, pro, oss, proPin, proTip, ossPin, ossTip, cwd, headSha,
    options: { cwd, headSha, tempDirectory: root, summaryPath: join(root, 'summary') },
    remotes: { pro: pathToFileURL(pro).href, oss: pathToFileURL(oss).href },
  };
}

test('checks out both recorded pins, never either newer branch tip, without nested recursive updates', (t) => {
  const f = fixture(t);
  assert.equal(inspectPlatformFramework(f.options).kind, 'pro');
  const result = checkoutPlatformFramework(f.options, f.remotes);
  assert.deepEqual(result, { source: f.headSha, pro: f.proPin, oss: f.ossPin, frameworkPath: `${PRO}/${OSS}` });
  const pro = join(f.cwd, PRO), oss = join(pro, OSS);
  for (const [directory, expected, tip] of [[pro, f.proPin, f.proTip], [oss, f.ossPin, f.ossTip]]) {
    assert.equal(git(directory, 'rev-parse', 'HEAD'), expected);
    assert.equal(git(directory, 'rev-parse', '--is-shallow-repository'), 'true');
    assert.throws(() => git(directory, 'cat-file', '-e', tip));
    assert.doesNotMatch(git(directory, 'config', '--local', '--list'), /extraheader|credential|AUTHORIZATION/iu);
  }
  assert.equal(readFileSync(join(oss, 'fixture.txt'), 'utf8'), 'historical OSS\n');
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  assert.match(readFileSync(f.options.summaryPath, 'utf8'), new RegExp(`pro=${f.proPin}`));
  assert.match(readFileSync(f.options.summaryPath, 'utf8'), new RegExp(`framework=${f.ossPin}`));
  assert.ok(!readdirSync(f.root).some((name) => /^platform-(?:develop|v3)-history-/u.test(name)));
});

const invalidConfigs = [
  ['fork', (s) => s.replace('github.com/nocobase/', 'github.com/untrusted/')],
  ['HTTP', (s) => s.replace('https:', 'http:')],
  ['SSH', (s) => s.replace('https://github.com/', 'git@github.com:')],
  ['file transport', (s) => s.replace(/url = .+/u, 'url = file:///tmp/untrusted')],
  ['external transport', (s) => s.replace(/url = .+/u, 'url = ext::echo unexpected')],
  ['traversal path', (s) => s.replace(/path = .+/u, 'path = ../outside')],
  ['credentials in URL', (s) => s.replace('github.com', 'user@github.com')],
  ['include', (s) => `${s}[include]\n  path = stolen\n`],
  ['duplicate URL', (s) => `${s}  url = https://example.com/other.git\n`],
  ['update command', (s) => `${s}  update = !echo unexpected\n`],
  ['wrong branch', (s) => s.replace(/branch = .+/u, 'branch = main')],
];
for (const [name, mutate] of invalidConfigs) {
  test(`rejects outer Pro ${name} before any fetch`, (t) => {
    const f = fixture(t);
    const headSha = pin(f.cwd, PRO, f.proPin, mutate(proModules));
    assert.throws(() => checkoutPlatformFramework({ ...f.options, headSha }, f.remotes), /Unexpected submodule configuration/u);
    assert.equal(existsSync(join(f.cwd, PRO)), false);
  });
  test(`rejects inner OSS ${name} before fetching OSS`, (t) => {
    const f = fixture(t, mutate(ossModules));
    assert.throws(() => checkoutPlatformFramework(f.options, f.remotes), /Unexpected submodule configuration/u);
    assert.equal(existsSync(join(f.cwd, PRO, OSS, '.git')), false);
  });
}

test('rejects an additional outer gitlink and an unexpected inner path', (t) => {
  const f = fixture(t, ossModules, 'vendor/wrong');
  assert.throws(() => checkoutPlatformFramework(f.options, f.remotes), /Expected one vendor\/nocobase3 gitlink/u);
  git(f.cwd, 'update-index', '--add', '--cacheinfo', `160000,${f.ossPin},extra`);
  assert.throws(() => inspectPlatformFramework({ ...f.options, headSha: commit(f.cwd) }), /Expected one/u);
});

test('rejects a Pro tree with no inner gitlink and one with additional inner gitlinks', (t) => {
  const f = fixture(t);
  git(f.pro, 'rm', '--cached', '.gitmodules', OSS);
  const emptyPro = commit(f.pro);
  const headSha = pin(f.cwd, PRO, emptyPro, proModules);
  assert.throws(() => checkoutPlatformFramework({ ...f.options, headSha }, f.remotes), /Expected one/u);
  // Inspect another synthetic application so the previous partial checkout cannot hide the structural rejection.
  pin(f.pro, OSS, f.ossPin, ossModules);
  git(f.pro, 'update-index', '--add', '--cacheinfo', `160000,${f.ossPin},extra`);
  const extraPro = commit(f.pro);
  const cwd = repo(f.root, 'another-app', 'main');
  const extraHead = pin(cwd, PRO, extraPro, proModules);
  assert.throws(() => checkoutPlatformFramework({ ...f.options, cwd, headSha: extraHead }, f.remotes), /Expected one/u);
});

test('rejects a Pro pin outside develop and does not fall back to the branch tip', (t) => {
  const f = fixture(t);
  git(f.pro, 'switch', '-c', 'unrelated');
  const outside = commit(f.pro);
  const headSha = pin(f.cwd, PRO, outside, proModules);
  assert.throws(() => checkoutPlatformFramework({ ...f.options, headSha }, f.remotes), /not reachable from Pro develop/u);
  assert.equal(existsSync(join(f.cwd, PRO)), false);
  assert.ok(!readdirSync(f.root).some((name) => name.startsWith('platform-develop-history-')));
});

test('rejects an inner OSS pin outside v3 without substituting a current branch', (t) => {
  const f = fixture(t);
  git(f.oss, 'switch', '-c', 'unrelated');
  const outside = commit(f.oss);
  const proSha = pin(f.pro, OSS, outside, ossModules);
  const headSha = pin(f.cwd, PRO, proSha, proModules);
  assert.throws(() => checkoutPlatformFramework({ ...f.options, headSha }, f.remotes), /not reachable from public v3/u);
  assert.equal(existsSync(join(f.cwd, PRO, OSS, '.git')), false);
});

test('missing Pro permission fails distinctly, and configuration inspection needs no token or network', (t) => {
  const f = fixture(t);
  assert.throws(() => checkoutPlatformFramework(f.options), /read-only Pro source token is required/u);
  const output = join(f.root, 'outputs');
  execFileSync(process.execPath, [fileURLToPath(new URL('../platform-framework.mjs', import.meta.url)), '--inspect'], {
    cwd: f.cwd, env: { PATH: process.env.PATH, HEAD_SHA: f.headSha, GITHUB_OUTPUT: output },
  });
  assert.equal(readFileSync(output, 'utf8'), 'pro_required=true\n');
  assert.equal(existsSync(join(f.cwd, PRO)), false);
});

test('authentication is scoped to Pro only and is not inherited by local/OSS Git or tracing', () => {
  const token = 'synthetic-ci-token';
  const env = frameworkGitEnvironment(PRO_URL, token);
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, `http.${PRO_URL}.extraheader`);
  assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_0.slice('AUTHORIZATION: basic '.length), 'base64').toString(), `x-access-token:${token}`);
  for (const remote of [OSS_URL, 'https://github.com/untrusted/repo.git', 'file:///tmp/fixture']) {
    assert.throws(() => frameworkGitEnvironment(remote, token), /only be sent to the fixed Pro repository/u);
  }
  for (const name of ['HOME', 'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'PLATFORM_PRO_SOURCE_TOKEN']) {
    assert.equal(env[name], undefined);
  }
  assert.equal(frameworkGitEnvironment(OSS_URL).GIT_CONFIG_VALUE_0, undefined);
  assert.equal(frameworkGitEnvironment().GIT_CONFIG_VALUE_0, undefined);
  const options = { cwd: tmpdir(), env, encoding: 'utf8', stdio: 'pipe' };
  assert.match(execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', `${PRO_URL}/info/refs`], options), /AUTHORIZATION/u);
  assert.throws(() => execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', `${OSS_URL}/info/refs`], options));
});

// Git's normal index refuses .gitmodules symlinks; build hostile committed trees directly.
function withModulesMode(cwd, mode) {
  const entries = git(cwd, 'ls-tree', 'HEAD').split('\n').map((entry) =>
    entry.endsWith('\t.gitmodules') ? entry.replace('100644', mode) : entry);
  const tree = execFileSync('git', ['mktree'], { cwd, input: `${entries.join('\n')}\n`, encoding: 'utf8' }).trim();
  const sha = git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', 'Hostile configuration type');
  git(cwd, 'update-ref', 'HEAD', sha);
  return sha;
}

for (const mode of ['100755', '120000']) {
  test(`rejects non-regular outer and inner .gitmodules mode ${mode}`, (t) => {
    const f = fixture(t);
    const proSha = withModulesMode(f.pro, mode);
    const headSha = pin(f.cwd, PRO, proSha, proModules);
    assert.throws(() => checkoutPlatformFramework({ ...f.options, headSha }, f.remotes), /regular .gitmodules file/u);
    assert.equal(existsSync(join(f.cwd, PRO, OSS, '.git')), false);
    const outerSha = withModulesMode(f.cwd, mode);
    assert.throws(() => inspectPlatformFramework({ ...f.options, headSha: outerSha }), /regular .gitmodules file/u);
  });
}

test('remote overrides cannot redirect a production credential to an arbitrary network endpoint', () => {
  assert.throws(() => checkoutPlatformFramework({}, { pro: 'https://example.com/repo.git' }), /Only local fixture/u);
});
