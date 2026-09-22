import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertCommit(cwd, sha) {
  git(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
}

export function prepareSnapshot({ cwd, eventName, headSha, baseSha, mergePullRequest }) {
  const head = headSha.toLowerCase();
  const base = baseSha.toLowerCase();

  assertCommit(cwd, head);
  if (eventName === 'pull_request') assertCommit(cwd, base);

  if (eventName === 'pull_request' && mergePullRequest === 'true') {
    git(cwd, ['checkout', '--detach', base]);
    try {
      git(cwd, [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'merge',
        '--no-ff',
        '--no-edit',
        head,
      ]);
    } catch {
      spawnSync('git', ['merge', '--abort'], { cwd, stdio: 'ignore' });
      throw new Error('The fixed pull request head does not merge cleanly into its fixed base.');
    }

    if (git(cwd, ['rev-parse', 'HEAD^1']) !== base || git(cwd, ['rev-parse', 'HEAD^2']) !== head) {
      throw new Error('The prepared merge does not have the requested base and head parents.');
    }
  } else if (git(cwd, ['rev-parse', 'HEAD']) !== head) {
    throw new Error('The checked-out commit does not match head_sha.');
  }

  git(cwd, ['submodule', 'sync', '--recursive']);
  git(cwd, ['submodule', 'update', '--init', '--recursive']);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    prepareSnapshot({
      cwd: process.cwd(),
      eventName: process.env.EVENT_NAME ?? '',
      headSha: process.env.HEAD_SHA ?? '',
      baseSha: process.env.BASE_SHA ?? '',
      mergePullRequest: process.env.MERGE_PULL_REQUEST ?? '',
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
