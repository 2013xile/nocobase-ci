import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const PLATFORM_REPOSITORY = 'nocobase/multi-tenant-platform-app';
// The public GitHub App /apps/nocobase, also the NOCOBASE_APP_ID client ID used by this CI repository.
export const CHECK_APP_ID = 979192;
export const QUALITY_CHECK_NAMES = ['Lint', 'Typecheck', 'Node tests', 'Client tests', 'Build'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Never mix check groups from separate Bot requests, accept another App, or treat skipped checks as passing. */
export function evaluateChecks(checks, headSha) {
  const relevant = checks
    .flatMap((check) => {
      if (check.app?.id !== CHECK_APP_ID || check.head_sha !== headSha || !QUALITY_CHECK_NAMES.includes(check.name))
        return [];
      const match = new RegExp(`^(${UUID}):${check.name}$`, 'u').exec(check.external_id ?? '');
      return match && Number.isSafeInteger(check.id) ? [{ ...check, requestId: match[1] }] : [];
    })
    .sort((a, b) => b.id - a.id);
  if (!relevant.length) return { state: 'pending', reason: 'Waiting for the platform Bot checks.' };
  const requestId = relevant[0].requestId;
  const group = relevant.filter((check) => check.requestId === requestId);
  const latest = QUALITY_CHECK_NAMES.map((name) => group.find((check) => check.name === name));
  for (const check of latest) {
    if (check?.status === 'completed' && check.conclusion !== 'success') {
      return { state: 'failed', reason: `${check.name} concluded ${check.conclusion ?? 'without a conclusion'}.` };
    }
  }
  return latest.every((check) => check?.status === 'completed' && check.conclusion === 'success')
    ? { state: 'success', reason: 'All five platform quality checks passed.' }
    : { state: 'pending', reason: 'Waiting for all five checks of the newest platform request.' };
}

export function validatePullRequest(pull, headSha) {
  if (
    pull.state !== 'open' ||
    pull.head?.sha !== headSha ||
    pull.head?.repo?.full_name !== PLATFORM_REPOSITORY ||
    pull.base?.ref !== 'main'
  ) {
    throw new Error('The PR is closed, has another head or target, or is not a same-repository platform PR.');
  }
  return (pull.labels ?? []).some((label) => label.name === 'no-preview');
}

export async function waitForPlatformChecks({
  token,
  headSha,
  prNumber,
  fetchImpl = fetch,
  now = Date.now,
  wait = sleep,
  timeoutMs = 30 * 60_000,
  log = console.log,
}) {
  if (!token || !/^[0-9a-f]{40}$/u.test(headSha) || !/^[1-9][0-9]*$/u.test(String(prNumber))) {
    throw new Error('A source-read token, head SHA and PR number are required.');
  }
  const request = async (suffix) => {
    const response = await fetchImpl(`https://api.github.com/repos/${PLATFORM_REPOSITORY}/${suffix}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Reading platform CI state failed (HTTP ${response.status}).`);
    return response.json();
  };
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const pull = await request(`pulls/${prNumber}`);
    if (validatePullRequest(pull, headSha)) return { skip: true, reason: 'The PR has the no-preview label.' };
    const checks = [];
    // filter=all exposes superseded requests too; evaluateChecks chooses one complete request, never an old mix.
    for (let page = 1; page <= 100; page++) {
      const data = await request(
        `commits/${headSha}/check-runs?app_id=${CHECK_APP_ID}&filter=all&per_page=100&page=${page}`,
      );
      checks.push(...data.check_runs);
      if (checks.length >= data.total_count || data.check_runs.length < 100) break;
      if (page === 100) throw new Error('Too many check runs to safely evaluate the platform gate.');
    }
    const result = evaluateChecks(checks, headSha);
    log(result.reason);
    if (result.state === 'failed') throw new Error(result.reason);
    if (result.state === 'success') return { skip: false, reason: result.reason };
    await wait(Math.min(15_000, Math.max(0, deadline - now())));
  }
  throw new Error('Platform quality checks did not pass before the gate deadline; nothing will be deployed.');
}

/** Recheck current source state after the archive build, not only before its potentially long execution. */
export async function verifyPlatformDeployment(options) {
  const result = await waitForPlatformChecks({ ...options, timeoutMs: 60_000 });
  if (result.skip) throw new Error('The PR no longer permits a Preview deployment.');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const gate = process.argv.includes('--before-deploy') ? verifyPlatformDeployment : waitForPlatformChecks;
    const result = await gate({
      token: process.env.SOURCE_READ_TOKEN,
      headSha: process.env.HEAD_SHA ?? '',
      prNumber: process.env.PR_NUMBER ?? '',
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip}\n`);
    console.log(result.reason);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
