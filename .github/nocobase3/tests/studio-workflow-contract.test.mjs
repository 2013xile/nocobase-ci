import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/studio-ci.yml'), 'utf8');
const proWorkflow = readFileSync(path.join(root, '.github/workflows/nocobase3-pro-ci.yml'), 'utf8');

// The check names nocobase-bot mirrors onto nocobase/studio (STUDIO_CI_CHECK_NAMES there).
const expectedJobs = [
  'Submodule pointer',
  'Lint',
  'Typecheck',
  'Test',
  'API document',
  'CLI reference',
  'Studio e2e',
  'Preview',
  'Dist',
];

function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const dispatchInputs = (source) =>
  source.slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'));

test('takes the same dispatch inputs as Pro and names its runs studio-ci', () => {
  assert.match(workflow, /^run-name: studio-ci:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.equal(dispatchInputs(workflow), dispatchInputs(proWorkflow));
});

test('keeps the check job names and their events', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)];
  const matrixNames = [...job('check').matchAll(/^          - name: (.+)$/gmu)].map((match) => match[1]);
  const names = jobs.flatMap(([, , name]) => (name === '${{ matrix.name }}' ? matrixNames : name));
  assert.deepEqual(names, expectedJobs);
  assert.match(job('e2e'), /if: \$\{\{ inputs\.event_name == 'pull_request' \}\}/u);
  assert.match(job('preview'), /if: \$\{\{ inputs\.event_name == 'pull_request' \}\}/u);
  assert.match(job('dist'), /if: \$\{\{ inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}/u);
});

test('checks out only nocobase/studio through the shared checkout action', () => {
  const checkouts = [...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu)];
  assert.equal(checkouts.length, 5);
  assert.ok(checkouts.every(([, repository, directory]) => repository === 'studio' && directory === 'studio'));
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 1);
  assert.match(job('preview'), /merge-pull-request: 'false'/u);
});

test('gives the deployment secret only to the preview', () => {
  for (const id of ['submodule', 'check', 'e2e', 'dist']) {
    assert.doesNotMatch(job(id), /secrets\.(?!NOCOBASE_APP_PRIVATE_KEY)/u, id);
  }
  assert.doesNotMatch(workflow, /\bssh\b/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
});

test('names the repository and the commit in every preview call to Studio', () => {
  const calls = [...job('preview').matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.match(job('preview'), /APP_ID: studio-pr-\$\{\{ inputs\.pr_number \}\}/u);
  assert.match(job('preview'), /ENVIRONMENT: preview/u);
  assert.match(job('preview'), /LOGS: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/u);
});

test('uploads only failed e2e results and the public tarballs, briefly, and caches nothing', () => {
  assert.doesNotMatch(workflow, /actions\/cache|^\s+cache:/mu);
  const uploads = [...workflow.matchAll(/- name: .+\n(?:        if: (.+)\n)?        uses: actions\/upload-artifact@v4\n        with:\n(?:          .+\n)*?          retention-days: (\d+)/gu)];
  assert.equal([...workflow.matchAll(/actions\/upload-artifact/gu)].length, uploads.length);
  assert.ok(uploads.every(([, , days]) => days === '3'));
  const e2e = uploads.filter(([upload]) => job('e2e').includes(upload));
  const dist = uploads.filter(([upload]) => job('dist').includes(upload));
  assert.equal(e2e.length, 2);
  assert.ok(e2e.every(([, condition]) => condition === '${{ failure() }}'));
  assert.equal(dist.length, 2);
  assert.ok(dist.every(([upload]) => /path: studio\/output\/dist\/stable\/(nb-studio|nocobase-runner)\n/u.test(upload)));
  assert.equal(e2e.length + dist.length, uploads.length);
});
