import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/nocobase3-preview.yml'), 'utf8');
const proWorkflow = readFileSync(path.join(root, '.github/workflows/nocobase3-pro-ci.yml'), 'utf8');

const inputNames = (source) => [
  ...source
    .slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'))
    .matchAll(/^      ([a-z_]+):$/gmu),
].map((match) => match[1]);

test('takes the same dispatch inputs as Pro and names its runs nocobase3-preview', () => {
  assert.match(workflow, /^run-name: nocobase3-preview:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), inputNames(proWorkflow));
});

test('has the one job nocobase-bot mirrors, for pull requests only', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match[2]);
  assert.deepEqual(jobs, ['Preview']);
  assert.match(workflow, /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u);
});

test('checks out only the pull request head of nocobase/nocobase3 through the shared checkout action', () => {
  const checkouts = [...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu)];
  assert.equal(checkouts.length, 1);
  assert.deepEqual(checkouts[0].slice(1), ['nocobase3', 'nocobase3']);
  assert.match(workflow, /merge-pull-request: 'false'/u);
  assert.match(workflow, /REPOSITORY: nocobase\/nocobase3\n/u);
});

test('skips on the no-preview label and on changes the application does not run', () => {
  assert.match(workflow, /\[ "\$SKIP_LABEL" = 'true' \]/u);
  assert.match(workflow, /grep -qx 'no-preview'/u);
  assert.match(workflow, /git -C nocobase3 merge-base "\$BASE_SHA" "\$HEAD_SHA"/u);
  const gated = [...workflow.matchAll(/      - name: (.+)\n        if: (.+)\n/gu)];
  const afterGate = workflow.slice(workflow.indexOf('id: gate'));
  const steps = [...afterGate.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
  for (const step of steps) {
    const condition = gated.find(([, name]) => name === step)?.[2];
    assert.ok(condition?.includes('steps.gate.outputs.skip'), step);
  }
});

test('builds the examples template with the repository pnpm', () => {
  assert.match(workflow, /TEMPLATE: packages\/templates\/app-template-examples\n/u);
  assert.match(workflow, /package_json_file: nocobase3\/package\.json/u);
  assert.doesNotMatch(workflow, /^\s+version: /mu);
  assert.match(workflow, /working-directory: nocobase3\/\$\{\{ env\.TEMPLATE \}\}\n        run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(workflow, /--file "nocobase3\/\$TEMPLATE\/storage\/exports\/dist\.tar\.gz"/u);
});

test('gives its own Studio key only to the steps that call Studio', () => {
  assert.doesNotMatch(workflow, /secrets\.NB_STUDIO_API_KEY\b(?!_NOCOBASE3)/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
  const steps = workflow.split(/\n(?=      - name: )/u).slice(1);
  for (const step of steps) {
    const name = step.match(/- name: (.+)/u)[1];
    const usesKey = step.includes('secrets.NB_STUDIO_API_KEY_NOCOBASE3');
    const callsStudio = /nb-studio|NB_STUDIO_SERVER/u.test(step.slice(step.indexOf('run:') === -1 ? step.length : step.indexOf('run:')));
    assert.equal(usesKey, callsStudio, name);
  }
  assert.doesNotMatch(workflow, /actions\/cache|upload-artifact|^\s+cache:/mu);
});

test('names the repository and the commit in every call to Studio', () => {
  const calls = [...workflow.matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.match(workflow, /APP_ID: nocobase3-pr-\$\{\{ inputs\.pr_number \}\}/u);
  assert.match(workflow, /ENVIRONMENT: preview/u);
});
