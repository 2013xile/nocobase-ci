import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHECK_APP_ID,
  QUALITY_CHECK_NAMES,
  evaluateChecks,
  validatePullRequest,
  waitForSubAppChecks,
  verifySubAppDeployment,
} from '../sub-app-preview-gate.mjs';

const SHA = 'b'.repeat(40);
const ID = '00000000-0000-4000-8000-000000000001';
const NEW = '00000000-0000-4000-8000-000000000002';
const pull = () => ({
  state: 'open',
  head: { sha: SHA, repo: { full_name: 'nocobase/multi-tenant-sub-app' } },
  base: { ref: 'main' },
  labels: [],
});
const checks = (offset = 0, requestId = ID) =>
  QUALITY_CHECK_NAMES.map((name, i) => ({
    id: offset + i + 1,
    name,
    head_sha: SHA,
    app: { id: CHECK_APP_ID },
    external_id: `${requestId}:${name}`,
    status: 'completed',
    conclusion: 'success',
  }));

test('requires five successful checks with the right App, SHA and Bot request identity', () => {
  assert.equal(evaluateChecks(checks(), SHA).state, 'success');
  for (const change of [{ head_sha: 'a'.repeat(40) }, { app: { id: 1 } }, { external_id: 'other:Lint' }]) {
    const source = checks();
    Object.assign(source[0], change);
    assert.equal(evaluateChecks(source, SHA).state, 'pending');
  }
  assert.equal(evaluateChecks([], SHA).state, 'pending');
  assert.equal(
    evaluateChecks([...checks(), checks(10, NEW)[0]], SHA).state,
    'pending',
    'do not combine old success with a new request',
  );
  assert.equal(evaluateChecks([...checks(), ...checks(10, NEW)], SHA).state, 'success');
});

test('failed, skipped, cancelled, timed-out and incomplete checks cannot authorize deployment', () => {
  for (const conclusion of ['failure', 'skipped', 'cancelled', 'timed_out', 'neutral', 'action_required', null]) {
    const source = checks();
    source[2].conclusion = conclusion;
    assert.equal(evaluateChecks(source, SHA).state, 'failed', String(conclusion));
  }
  const source = checks();
  source[0].status = 'in_progress';
  assert.equal(evaluateChecks(source, SHA).state, 'pending');
});

test('validates an open same-repository PR head and respects no-preview', () => {
  assert.equal(validatePullRequest(pull(), SHA), false);
  assert.equal(validatePullRequest({ ...pull(), labels: [{ name: 'no-preview' }] }, SHA), true);
  for (const value of [
    { ...pull(), state: 'closed' },
    { ...pull(), head: { sha: 'a'.repeat(40) } },
    { ...pull(), head: { sha: SHA, repo: { full_name: 'fork/sub-app' } } },
    { ...pull(), base: { ref: 'dev' } },
  ])
    assert.throws(() => validatePullRequest(value, SHA), /PR is closed/);
});

test('polls pending checks and succeeds without exposing its source-read credential', async () => {
  let time = 0,
    reads = 0;
  const logs = [];
  const result = await waitForSubAppChecks({
    token: 'fake-secret',
    headSha: SHA,
    prNumber: '17',
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    log: (value) => logs.push(value),
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer fake-secret');
      assert.ok(url.startsWith('https://api.github.com/repos/nocobase/multi-tenant-sub-app/'));
      const value = url.includes('/pulls/')
        ? pull()
        : { check_runs: ++reads === 1 ? [] : checks(), total_count: reads === 1 ? 0 : 5 };
      return { ok: true, json: async () => value };
    },
  });
  assert.equal(result.skip, false);
  assert.equal(reads, 2);
  assert.ok(logs.every((line) => !line.includes('fake-secret')));
});

test('skips a labelled PR, refuses API errors and fails closed at the deadline', async () => {
  const options = { token: 'fake', headSha: SHA, prNumber: '17', log() {} };
  const skipped = await waitForSubAppChecks({
    ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...pull(), labels: [{ name: 'no-preview' }] }) }),
  });
  assert.equal(skipped.skip, true);
  await assert.rejects(
    waitForSubAppChecks({ ...options, fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/,
  );
  let time = 0;
  await assert.rejects(
    waitForSubAppChecks({
      ...options,
      timeoutMs: 10,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => (url.includes('/pulls/') ? pull() : { check_runs: [], total_count: 0 }),
      }),
    }),
    /did not pass/,
  );
});

test('reads all check pages rather than silently accepting a partial response', async () => {
  const pages = [];
  const result = await waitForSubAppChecks({
    token: 'fake',
    headSha: SHA,
    prNumber: 17,
    log() {},
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => {
        if (url.includes('/pulls/')) return pull();
        const page = Number(new URL(url).searchParams.get('page'));
        pages.push(page);
        return { total_count: 105, check_runs: page === 1 ? Array(100).fill({ name: 'unrelated' }) : checks() };
      },
    }),
  });
  assert.equal(result.skip, false);
  assert.deepEqual(pages, [1, 2]);
});

test('rechecks closed, changed and newly skipped PRs after building', async () => {
  for (const current of [
    pull(),
    { ...pull(), state: 'closed' },
    { ...pull(), head: { sha: 'a'.repeat(40) } },
    { ...pull(), labels: [{ name: 'no-preview' }] },
  ]) {
    const options = {
      token: 'fake',
      headSha: SHA,
      prNumber: 17,
      log() {},
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => (url.includes('/pulls/') ? current : { check_runs: checks(), total_count: 5 }),
      }),
    };
    if (current.state === 'open' && current.head.sha === SHA && current.labels.length === 0) {
      assert.equal((await verifySubAppDeployment(options)).skip, false);
    } else {
      await assert.rejects(verifySubAppDeployment(options), /PR is closed|no longer permits/);
    }
  }
});

test('a native Actions retry cannot borrow earlier successful checks of the same Bot request', () => {
  for (const status of ['queued', 'in_progress']) {
    const retry = checks(10);
    retry[0].status = status;
    retry[0].conclusion = null;
    assert.equal(evaluateChecks([...checks(), ...retry], SHA).state, 'pending');
  }
  const failed = checks(10);
  failed[0].conclusion = 'failure';
  assert.equal(evaluateChecks([...checks(), ...failed], SHA).state, 'failed');
  const oldFailed = checks();
  oldFailed[0].conclusion = 'failure';
  assert.equal(evaluateChecks([...oldFailed, ...checks(10)], SHA).state, 'success');
});

test('a fresh gate refuses a different quality request even if the same head is still green', async () => {
  assert.equal(evaluateChecks(checks(10, NEW), SHA, ID).state, 'failed');
  assert.equal(evaluateChecks(checks(), SHA, ID).requestId, ID);
  await assert.rejects(verifySubAppDeployment({
    token: 'fake', headSha: SHA, prNumber: 17, expectedRequestId: ID, log() {},
    fetchImpl: async (url) => ({ok:true, json:async()=>url.includes('/pulls/') ? pull() :
      {check_runs:checks(10, NEW),total_count:5}}),
  }), /superseded/);
});

test('re-reads labels on every gate iteration and never waits through no-preview', async () => {
  let pulls = 0, time = 0;
  const result = await waitForSubAppChecks({
    token:'fake',headSha:SHA,prNumber:17,now:()=>time,wait:async(ms)=>{time+=ms;},log(){},
    fetchImpl:async(url)=>({ok:true,json:async()=>url.includes('/pulls/') ?
      {...pull(),labels:++pulls > 1 ? [{name:'no-preview'}] : []} : {check_runs:[],total_count:0}}),
  });
  assert.equal(result.skip,true);
  assert.equal(pulls,2);
});
