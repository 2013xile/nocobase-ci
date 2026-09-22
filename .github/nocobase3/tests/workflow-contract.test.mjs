import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflowPath = path.join(root, '.github/workflows/nocobase3-pro-ci.yml');
const checkoutPath = path.join(root, '.github/nocobase3/checkout/action.yml');
const smokePath = path.join(root, '.github/nocobase3/verify-create-app/action.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const checkout = readFileSync(checkoutPath, 'utf8');
const smoke = readFileSync(smokePath, 'utf8');

const expectedInputs = [
  'request_id',
  'event_name',
  'head_sha',
  'base_sha',
  'target_branch',
  'pr_number',
  'skip_label',
];

const expectedJobs = [
  'Submodule and catalog',
  'Changed files',
  'Typecheck',
  'Test',
  'Build',
  'Pro plugins on OSS Default installation smoke test',
  'quality',
  'Validate and advise',
  'Reject prerelease state',
];

test('keeps the workflow dispatch and run-name contract', () => {
  assert.match(workflow, /^run-name: pro-ci:\$\{\{ inputs\.request_id \}\}$/mu);

  const dispatchStart = workflow.indexOf('  workflow_dispatch:\n');
  const permissionsStart = workflow.indexOf('\npermissions:\n');
  assert.notEqual(dispatchStart, -1);
  assert.notEqual(permissionsStart, -1);
  const dispatch = workflow.slice(dispatchStart, permissionsStart);
  const inputs = [...dispatch.matchAll(/^      ([a-z_]+):$/gmu)].map((match) => match[1]);
  assert.deepEqual(inputs, expectedInputs);

  for (const input of expectedInputs) {
    assert.match(
      dispatch,
      new RegExp(`^      ${input}:\\n(?:        .+\\n)+?        required: true\\n        type: string$`, 'mu'),
    );
  }
});

test('keeps the nine check job names and branch conditions', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)];
  const matrixNames = [...workflow.matchAll(/^          - name: (Typecheck|Test|Build)$/gmu)].map(
    (match) => match[1],
  );
  const names = jobs.flatMap(([, , name]) => (name === '${{ matrix.name }}' ? matrixNames : name));
  assert.deepEqual(names, expectedJobs);
  assert.match(
    workflow,
    /name: Validate and advise\n    if: \$\{\{ inputs\.event_name == 'pull_request' && \(inputs\.target_branch == 'main' \|\| inputs\.target_branch == 'develop'\) \}\}/u,
  );
  assert.match(
    workflow,
    /name: Reject prerelease state\n    if: \$\{\{ inputs\.event_name == 'pull_request' && inputs\.target_branch == 'main' \}\}/u,
  );
});

test('keeps source access read-only and revokes the token before source code runs', () => {
  assert.match(checkout, /repository: nocobase\/nocobase3-pro/u);
  assert.match(checkout, /permission-contents: read/u);
  assert.match(checkout, /persist-credentials: false/u);
  assert.match(checkout, /skip-token-revoke: true/u);

  const prepare = checkout.indexOf('    - name: Prepare the immutable source snapshot');
  const revoke = checkout.indexOf('    - name: Revoke the source token');
  assert.ok(prepare >= 0 && revoke > prepare);
  assert.match(
    checkout.slice(revoke),
    /if: \$\{\{ always\(\) && steps\.app-token\.outputs\.token != '' \}\}/u,
  );

  const firstSourceCommand = workflow.indexOf('      - name: Set up Node.js');
  assert.ok(firstSourceCommand > workflow.indexOf('uses: ./.github/nocobase3/checkout'));
  assert.doesNotMatch(workflow, /NPM_TOKEN|FEISHU|deploy/u);
});

test('does not cache or upload source, packages, logs, or diagnostics', () => {
  const ciSource = `${workflow}\n${checkout}\n${smoke}`;
  assert.doesNotMatch(ciSource, /actions\/(?:upload|download)-artifact/u);
  assert.doesNotMatch(ciSource, /actions\/cache|^\s+cache:/mu);
});
