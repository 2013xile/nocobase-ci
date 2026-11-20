import { spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FRAMEWORK_PATH = 'vendor/nocobase3';
const FRAMEWORK_URL = 'https://github.com/nocobase/nocobase.git';
const FRAMEWORK_BRANCH = 'v3';
const FRAMEWORK_REF = `refs/heads/${FRAMEWORK_BRANCH}`;
const SUBMODULE = `submodule.${FRAMEWORK_PATH}`;
const SHA = /^[0-9a-f]{40}$/u;

function splitRecords(output) {
  return output.split('\0').slice(0, -1);
}

function readFrameworkPin(git, head) {
  const entries = splitRecords(git(['ls-tree', '-rzt', head], 'Cannot read the platform tree.'));
  const gitlinks = entries.filter((entry) => entry.startsWith('160000 '));
  const modules = entries.find((entry) => entry.slice(entry.indexOf('\t') + 1) === '.gitmodules');
  if (!gitlinks.length && !modules) return null;

  const pin = gitlinks.length === 1 && /^160000 commit ([0-9a-f]{40})\tvendor\/nocobase3$/u.exec(gitlinks[0]);
  if (!pin || !modules?.startsWith('100644 blob ')) {
    throw new Error('Expected one vendor/nocobase3 gitlink and a regular .gitmodules file.');
  }

  const expected = [
    `${SUBMODULE}.path\n${FRAMEWORK_PATH}`,
    `${SUBMODULE}.url\n${FRAMEWORK_URL}`,
    `${SUBMODULE}.branch\n${FRAMEWORK_BRANCH}`,
  ];
  const config = splitRecords(git(
    ['config', '--no-includes', '--null', '--blob', `${head}:.gitmodules`, '--list'],
    'Invalid committed .gitmodules.',
  ));
  if (config.length !== expected.length || expected.some((entry) => !config.includes(entry))) {
    throw new Error('Unexpected submodule configuration in the platform head.');
  }
  return pin[1];
}

export function checkoutPlatformFramework({ cwd, headSha, tempDirectory = tmpdir(), summaryPath }, remote = FRAMEWORK_URL) {
  // Start Git without inherited credentials, URL rewrites, or transport overrides.
  const env = {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: remote === FRAMEWORK_URL ? 'https' : 'file',
  };
  const runGit = (directory, args) => spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'http.followRedirects=false',
    ...args,
  ], { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const git = (args, failure, directory = cwd) => {
    const result = runGit(directory, args);
    if (result.status !== 0) throw new Error(failure);
    return result.stdout;
  };

  const head = (headSha ?? '').toLowerCase();
  if (!SHA.test(head) || git(['rev-parse', 'HEAD'], 'Cannot read the source head.').trim() !== head) {
    throw new Error('The checked-out source does not match head_sha.');
  }
  const keys = splitRecords(git(
    ['config', '--local', '--no-includes', '--null', '--name-only', '--list'],
    'Cannot check the platform Git configuration.',
  ));
  if (keys.some((key) => /^http\.(?:.*\.)?extraheader$/iu.test(key))) {
    throw new Error('Checkout authentication headers are still configured.');
  }

  const framework = readFrameworkPin(git, head);
  if (framework) {
    const modules = lstatSync(join(cwd, '.gitmodules'), { throwIfNoEntry: false });
    if (!modules?.isFile() ||
        git(['hash-object', '--no-filters', '--', '.gitmodules'], 'Cannot read the checked-out .gitmodules.').trim() !==
          git(['rev-parse', `${head}:.gitmodules`], 'Cannot read the committed .gitmodules.').trim()) {
      throw new Error('The checked-out .gitmodules differs from the platform head.');
    }

    const target = join(cwd, FRAMEWORK_PATH);
    const vendor = lstatSync(dirname(target), { throwIfNoEntry: false });
    if (vendor && !vendor.isDirectory()) throw new Error('The platform vendor path must be a directory.');
    const destination = lstatSync(target, { throwIfNoEntry: false });
    if (destination && (!destination.isDirectory() || readdirSync(target).length)) {
      throw new Error('The framework checkout path must be empty and inside the platform checkout.');
    }

    // A SHA fetch alone can accept objects from outside v3. Prove ancestry using only commit history first.
    const history = mkdtempSync(join(tempDirectory, 'platform-v3-history-'));
    try {
      git(['init', '--bare', '--template='], 'Cannot initialize v3 history storage.', history);
      git(
        ['fetch', '--filter=tree:0', '--no-tags', '--no-recurse-submodules', remote, `${FRAMEWORK_REF}:${FRAMEWORK_REF}`],
        'Cannot fetch public v3 history.',
        history,
      );
      git(['merge-base', '--is-ancestor', framework, FRAMEWORK_REF], 'The framework gitlink is not reachable from public v3.', history);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }

    // A direct depth-one fetch gets the pin's files without also cloning the current branch tip.
    const gitDir = git(['rev-parse', '--absolute-git-dir'], 'Cannot locate the platform Git directory.').trim();
    const moduleDir = join(gitDir, 'modules', FRAMEWORK_PATH);
    mkdirSync(dirname(moduleDir), { recursive: true });
    mkdirSync(target, { recursive: true });
    git(['init', '--template=', '--separate-git-dir', moduleDir], 'Cannot initialize the framework checkout.', target);
    git(['remote', 'add', 'origin', remote], 'Cannot register the framework remote.', target);
    git(
      ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', remote, framework],
      'Cannot fetch the pinned framework commit.',
      target,
    );
    git(['checkout', '--detach', '--no-recurse-submodules', framework], 'Cannot check out the pinned framework.', target);
    git(['config', '--local', `${SUBMODULE}.url`, remote], 'Cannot register the framework submodule.');
    const status = git(['submodule', 'status', '--', FRAMEWORK_PATH], 'Cannot verify the framework gitlink.');
    if (git(['rev-parse', 'HEAD'], 'Cannot read the framework head.', target).trim() !== framework ||
        !status.startsWith(` ${framework} ${FRAMEWORK_PATH}`)) {
      throw new Error('The framework checkout does not match the platform gitlink.');
    }
  }

  const summary = `source=${head} framework=${framework ?? 'none'}${framework ? ` (${FRAMEWORK_BRANCH})` : ''}`;
  console.log(`::notice::${summary}`);
  if (summaryPath) appendFileSync(summaryPath, `Platform checkout: \`${summary}\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkoutPlatformFramework({
      cwd: process.cwd(),
      headSha: process.env.HEAD_SHA,
      tempDirectory: process.env.RUNNER_TEMP,
      summaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
