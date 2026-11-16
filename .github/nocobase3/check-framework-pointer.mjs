import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const migratedRemotes = new Set([
  'https://github.com/nocobase/nocobase.git',
  'https://github.com/nocobase/nocobase',
  'git@github.com:nocobase/nocobase.git',
  'ssh://git@github.com/nocobase/nocobase.git',
]);

// The framework branches a Pro target may track, preferred first. nocobase/nocobase is renaming v3-develop to v3, so
// until the rename settles either name may be the one that exists.
export function frameworkBranches(remote, targetBranch) {
  if (!migratedRemotes.has(remote)) return [targetBranch === 'main' ? 'main' : 'develop'];
  return targetBranch === 'main' ? ['v3-main'] : ['v3', 'v3-develop'];
}

export function checkFrameworkPointer(directory, targetBranch) {
  const vendor = path.join(directory, 'vendor/nocobase3');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let remote = '';
  try {
    remote = git(vendor, ['config', '--get', 'remote.origin.url']);
  } catch {
    // The original source-owned script handles an uninitialized submodule.
  }
  const branches = frameworkBranches(remote, targetBranch);
  if (!migratedRemotes.has(remote)) {
    const [branch] = branches;
    execFileSync(process.execPath, ['./scripts/pin-submodule.mjs', '--check', '--branch', branch], {
      cwd: directory,
      stdio: 'inherit',
    });
    return { branch, delegated: true };
  }

  const entry = git(directory, ['ls-tree', 'HEAD', '--', 'vendor/nocobase3']);
  const match = /^160000 commit ([0-9a-f]{40})\tvendor\/nocobase3$/u.exec(entry);
  if (!match) throw new Error('HEAD must record vendor/nocobase3 as a Git submodule.');
  const pinned = match[1];
  const existing = git(vendor, ['ls-remote', '--heads', 'origin', ...branches.map((name) => `refs/heads/${name}`)]);
  const branch = branches.find((name) => existing.split('\n').some((line) => line.endsWith(`\trefs/heads/${name}`)));
  if (!branch) throw new Error(`None of the framework branches ${branches.join(', ')} exists.`);
  const ref = `refs/remotes/origin/${branch}`;
  git(vendor, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`]);
  if (!git(vendor, ['ls-tree', '-r', '--name-only', ref])) {
    throw new Error(`The framework branch ${branch} is empty and cannot be used.`);
  }
  try {
    git(vendor, ['merge-base', '--is-ancestor', pinned, ref]);
  } catch {
    throw new Error(`The pinned framework commit is not on ${branch}.`);
  }
  return { branch, pinned };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkFrameworkPointer(process.cwd(), process.env.TARGET_BRANCH);
    if (!result.delegated) console.log(`Framework ${result.pinned} is on ${result.branch}.`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
