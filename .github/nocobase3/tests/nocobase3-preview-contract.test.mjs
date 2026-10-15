import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/nocobase3-preview.yml'), 'utf8');
const proWorkflow = readFileSync(path.join(root, '.github/workflows/nocobase3-pro-ci.yml'), 'utf8');

function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const inputNames = (source) => [
  ...source
    .slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'))
    .matchAll(/^      ([a-z_]+):$/gmu),
].map((match) => match[1]);

const checkouts = (id) =>
  [...job(id).matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu)].map(
    (match) => match.slice(1),
  );

test('takes the forwarded fields and a source selector that names only nocobase', () => {
  assert.match(workflow, /^run-name: nocobase3-preview:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), ['source_repository', ...inputNames(proWorkflow)]);
  assert.ok(workflow.includes('        options:\n          - nocobase\n        default: nocobase'));
});

test('has only the job nocobase-bot mirrors, for pull requests only', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [['preview', 'Preview']]);
  assert.match(job('preview'), /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u);
  assert.doesNotMatch(job('preview'), /\n    needs:/u);
  // NocoBase Studio left this repository for the private nocobase/studio, checked by studio-ci.yml.
  assert.doesNotMatch(workflow, /packages\/apps\/studio|studio-cli|Studio (preview|e2e|dist)|cli-reference|STUDIO_PATHS|needs\.scope/u);
});

test('checks out only the pull request head, never a merge, through the shared checkout action', () => {
  assert.deepEqual(checkouts('preview'), [['nocobase', 'nocobase3']]);
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 1);
  assert.match(job('preview'), /repository: nocobase\n          path: nocobase3\n          partial-history: 'true'\n/u);
  assert.doesNotMatch(workflow, /repository: studio\b|(?<!@)nocobase\/studio\b|vendor\/nocobase3/u);
});

test('previews the examples template only for agent branches, and skips on the no-preview label', () => {
  const source = job('preview');
  assert.match(source, /\[ "\$SKIP_LABEL" = 'true' \]/u);
  assert.match(source, /grep -qx 'no-preview'/u);
  assert.match(source, /--jq \.head\.ref\)/u);
  assert.match(source, /grep -qE '\^agent\/PM-\[0-9\]\+\$'/u);
  assert.match(source, /git -C nocobase3 merge-base "\$BASE_SHA" "\$HEAD_SHA"/u);
  const gated = [...source.matchAll(/      - name: (.+)\n        (?:id: .+\n        )?if: (.+)\n/gu)];
  const afterGate = source.slice(source.indexOf('id: gate'));
  for (const step of [...afterGate.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1])) {
    const condition = gated.find(([, name]) => name === step)?.[2];
    assert.ok(condition?.includes('steps.gate.outputs.skip'), step);
  }
});

test('builds the examples template with the repository pnpm', () => {
  assert.match(workflow, /TEMPLATE: packages\/templates\/app-template-examples\n/u);
  assert.doesNotMatch(workflow, /^\s+version: /mu);
  assert.match(workflow, /working-directory: nocobase3\/\$\{\{ env\.TEMPLATE \}\}\n        run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(workflow, /--file "nocobase3\/\$TEMPLATE\/storage\/exports\/dist\.tar\.gz"/u);
});

test('gives its own Studio key only to the steps that call Studio', () => {
  assert.doesNotMatch(workflow, /NB_STUDIO_API_KEY_NOCOBASE3/u);
  assert.doesNotMatch(workflow, /secrets\.NB_STUDIO_API_KEY\b(?!_NOCOBASE_V3)/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
  // A job's last step ends where the next job begins.
  const steps = workflow
    .split(/\n(?=      - name: )/u)
    .slice(1)
    .map((step) => step.split(/\n\n {2}(?=[#a-z])/u)[0]);
  for (const step of steps) {
    const name = step.match(/- name: (.+)/u)[1];
    const usesKey = step.includes('secrets.NB_STUDIO_API_KEY_NOCOBASE_V3');
    const callsStudio = /nb-studio [a-z]|NB_STUDIO_SERVER/u.test(step.slice(step.indexOf('run:') === -1 ? step.length : step.indexOf('run:')));
    assert.equal(usesKey, callsStudio, name);
  }
  assert.doesNotMatch(workflow, /actions\/cache|^\s+cache:/mu);
});

test('uploads nothing', () => {
  assert.doesNotMatch(workflow, /actions\/upload-artifact/u);
});

test('names the repository and the commit in every call to Studio', () => {
  const calls = [...workflow.matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.ok(workflow.includes('APP_ID: nocobase-v3-pr-${{ inputs.pr_number }}\n'));
  assert.match(workflow, /ENVIRONMENT: preview/u);
});

test('sets up Node.js before installing the nb-studio CLI, which carries no Node.js of its own', () => {
  const source = job('preview');
  const node = source.indexOf('      - name: Set up Node.js\n');
  const cli = source.indexOf('      - name: Install the nb-studio CLI\n');
  assert.ok(node !== -1 && cli !== -1 && node < cli);
});
