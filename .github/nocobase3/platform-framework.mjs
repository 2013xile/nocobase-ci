import { spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OSS = { kind: 'oss', path: 'vendor/nocobase3', url: 'https://github.com/nocobase/nocobase.git', branch: 'v3' };
const PRO = { kind: 'pro', path: 'vendor/nocobase3-pro', url: 'https://github.com/nocobase/nocobase3-pro.git', branch: 'develop' };
const SHA = /^[0-9a-f]{40}$/u;

function splitRecords(output) {
  return output.split('\0').slice(0, -1);
}

// A minimal environment prevents inherited headers, helpers, URL rewrites, tracing and transport overrides.
// Authentication is process-local, scoped to the fixed Pro URL, and never stored in Git config or argv.
export function frameworkGitEnvironment(remote, token) {
  const env = {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: remote?.startsWith('file:') ? 'file' : 'https',
  };
  if (token) {
    if (remote !== PRO.url) throw new Error('Credentials may only be sent to the fixed Pro repository.');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${PRO.url}.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function git(directory, args, failure, env = frameworkGitEnvironment()) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false',
    '-c', 'submodule.recurse=false',
    ...args,
  ], { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Never surface Git stderr: it can contain private source or authentication details.
  if (result.status !== 0) throw new Error(failure);
  return result.stdout;
}

function assertCleanConfig(cwd) {
  const keys = splitRecords(git(cwd,
    ['config', '--local', '--no-includes', '--null', '--name-only', '--list'],
    'Cannot check the platform Git configuration.',
  ));
  if (keys.some((key) => /^http\.(?:.*\.)?extraheader$/iu.test(key))) {
    throw new Error('Checkout authentication headers are still configured.');
  }
  if (keys.some((key) => /^(?:include\.|includeif\.|url\.|credential\.|core\.(?:sshcommand|fsmonitor)$)/iu.test(key))) {
    throw new Error('Unexpected local Git configuration.');
  }
}

function readPin(cwd, head, allowed, required = false, verifyWorking = true) {
  const entries = splitRecords(git(cwd, ['ls-tree', '-rzt', head], 'Cannot read the committed tree.'));
  const gitlinks = entries.filter((entry) => entry.startsWith('160000 '));
  const modules = entries.find((entry) => entry.slice(entry.indexOf('\t') + 1) === '.gitmodules');
  if (!gitlinks.length && !modules && !required) return null;
  const match = gitlinks.length === 1 && /^160000 commit ([0-9a-f]{40})\t(.+)$/u.exec(gitlinks[0]);
  const definition = match && allowed.find((candidate) => candidate.path === match[2]);
  if (!definition || !modules?.startsWith('100644 blob ')) {
    throw new Error(`Expected one ${allowed.map((candidate) => `${candidate.path} gitlink`).join(' or one ')} and a regular .gitmodules file.`);
  }
  const section = `submodule.${definition.path}`;
  const expected = [
    `${section}.path\n${definition.path}`,
    `${section}.url\n${definition.url}`,
    `${section}.branch\n${definition.branch}`,
  ];
  const config = splitRecords(git(cwd,
    ['config', '--no-includes', '--null', '--blob', `${head}:.gitmodules`, '--list'],
    'Invalid committed .gitmodules.',
  ));
  if (config.length !== expected.length || expected.some((entry) => !config.includes(entry))) {
    throw new Error('Unexpected submodule configuration in the committed head.');
  }
  const workingModules = lstatSync(join(cwd, '.gitmodules'), { throwIfNoEntry: false });
  if (verifyWorking && (!workingModules?.isFile() ||
      git(cwd, ['hash-object', '--no-filters', '--', '.gitmodules'], 'Cannot read the checked-out .gitmodules.').trim() !==
        git(cwd, ['rev-parse', `${head}:.gitmodules`], 'Cannot read the committed .gitmodules.').trim())) {
    throw new Error('The checked-out .gitmodules differs from the committed head.');
  }
  return { ...definition, sha: match[1] };
}

function checkoutPin(cwd, pin, tempDirectory, remote, token) {
  const target = join(cwd, pin.path);
  const vendor = lstatSync(dirname(target), { throwIfNoEntry: false });
  if (vendor && !vendor.isDirectory()) throw new Error('The platform vendor path must be a directory.');
  const destination = lstatSync(target, { throwIfNoEntry: false });
  if (destination && (!destination.isDirectory() || readdirSync(target).length)) {
    throw new Error('The framework checkout path must be empty and inside the platform checkout.');
  }
  if (pin.kind === 'pro' && remote === PRO.url && !token) {
    throw new Error('A read-only Pro source token is required for the pinned Pro workspace.');
  }
  const networkEnv = frameworkGitEnvironment(remote, remote === PRO.url ? token : undefined);
  const ref = `refs/heads/${pin.branch}`;
  // Branch history proves provenance only. It never chooses the commit that is checked out.
  const history = mkdtempSync(join(tempDirectory, `platform-${pin.branch}-history-`));
  try {
    git(history, ['init', '--bare', '--template='], 'Cannot initialize framework history storage.');
    git(history,
      ['fetch', '--filter=tree:0', '--no-tags', '--no-recurse-submodules', remote, `${ref}:${ref}`],
      `Cannot fetch ${pin.kind} history; check repository read access.`, networkEnv,
    );
    git(history, ['merge-base', '--is-ancestor', pin.sha, ref],
      `The framework gitlink is not reachable from ${pin.kind === 'oss' ? 'public v3' : 'Pro develop'}.`);
  } finally {
    rmSync(history, { recursive: true, force: true });
  }

  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir'], 'Cannot locate the parent Git directory.').trim();
  const moduleDir = join(gitDir, 'modules', pin.path);
  if (lstatSync(moduleDir, { throwIfNoEntry: false })) throw new Error('The framework Git directory must not already exist.');
  mkdirSync(dirname(moduleDir), { recursive: true });
  mkdirSync(target, { recursive: true });
  git(target, ['init', '--template=', '--separate-git-dir', moduleDir], 'Cannot initialize the framework checkout.');
  git(target, ['remote', 'add', 'origin', remote], 'Cannot register the framework remote.');
  git(target,
    ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', remote, pin.sha],
    `Cannot fetch the pinned ${pin.kind} commit; check repository read access.`, networkEnv,
  );
  // Validate the Pro commit's inner layout before materializing any of its files.
  if (pin.kind === 'pro') readPin(target, pin.sha, [OSS], true, false);
  git(target, ['checkout', '--detach', '--no-recurse-submodules', pin.sha], 'Cannot check out the pinned framework.');
  git(cwd, ['config', '--local', `submodule.${pin.path}.url`, remote], 'Cannot register the framework submodule.');
  const status = git(cwd, ['submodule', 'status', '--', pin.path], 'Cannot verify the framework gitlink.');
  if (git(target, ['rev-parse', 'HEAD'], 'Cannot read the framework head.').trim() !== pin.sha ||
      !status.startsWith(` ${pin.sha} ${pin.path}`)) {
    throw new Error('The framework checkout does not match the committed gitlink.');
  }
  assertCleanConfig(target);
  return target;
}

export function inspectPlatformFramework({ cwd, headSha }) {
  const head = (headSha ?? '').toLowerCase();
  if (!SHA.test(head) || git(cwd, ['rev-parse', 'HEAD'], 'Cannot read the source head.').trim() !== head) {
    throw new Error('The checked-out source does not match head_sha.');
  }
  assertCleanConfig(cwd);
  return readPin(cwd, head, [OSS, PRO]);
}

// Test-only remote injection is never exposed as a CLI flag or environment variable.
// Fixtures must use local repositories; production always uses the two fixed HTTPS URLs.
export function checkoutPlatformFramework({ cwd, headSha, tempDirectory = tmpdir(), summaryPath, proToken }, remotes = {}) {
  if (typeof remotes === 'string') remotes = { oss: remotes };
  for (const [kind, remote] of Object.entries(remotes)) {
    if (!['oss', 'pro'].includes(kind) || !remote.startsWith('file:')) throw new Error('Only local fixture remotes may be overridden.');
  }
  const head = (headSha ?? '').toLowerCase();
  const outer = inspectPlatformFramework({ cwd, headSha: head });
  let pro, oss, frameworkPath;
  if (outer) {
    const target = checkoutPin(cwd, outer, tempDirectory, remotes[outer.kind] ?? outer.url, proToken);
    if (outer.kind === 'pro') {
      pro = outer.sha;
      const inner = readPin(target, pro, [OSS], true);
      checkoutPin(target, inner, tempDirectory, remotes.oss ?? OSS.url);
      oss = inner.sha;
      frameworkPath = `${PRO.path}/${OSS.path}`;
    } else {
      oss = outer.sha;
      frameworkPath = OSS.path;
    }
  }
  const summary = `source=${head} framework=${oss ?? 'none'}${oss ? ' (v3)' : ''} pro=${pro ?? 'none'} frameworkPath=${frameworkPath ?? 'none'}`;
  console.log(`::notice::${summary}`);
  if (summaryPath) appendFileSync(summaryPath, `Platform checkout: \`${summary}\`\n`);
  return { source: head, pro, oss, frameworkPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {
      cwd: process.cwd(),
      headSha: process.env.HEAD_SHA,
      tempDirectory: process.env.RUNNER_TEMP,
      summaryPath: process.env.GITHUB_STEP_SUMMARY,
      proToken: process.env.PLATFORM_PRO_SOURCE_TOKEN,
    };
    if (process.argv[2] === '--inspect') {
      const pin = inspectPlatformFramework(options);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pro_required=${pin?.kind === 'pro'}\n`);
    } else {
      if (process.argv[2]) throw new Error('Unexpected platform checkout option.');
      checkoutPlatformFramework(options);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
