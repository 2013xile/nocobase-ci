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

const jobIds = ['preview', 'studio-preview'];

const inputNames = (source) => [
  ...source
    .slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'))
    .matchAll(/^      ([a-z_]+):$/gmu),
].map((match) => match[1]);

test('takes the forwarded fields and a source selector that names only nocobase', () => {
  assert.match(workflow, /^run-name: nocobase3-preview:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), ['source_repository', ...inputNames(proWorkflow)]);
  assert.ok(workflow.includes('        options:\n          - nocobase\n        default: nocobase'));
});

test('has the two jobs nocobase-bot mirrors, for pull requests only', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [
    ['preview', 'Preview'],
    ['studio-preview', 'Studio preview'],
  ]);
  for (const id of jobIds) {
    assert.match(job(id), /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u, id);
    assert.doesNotMatch(job(id), /\n    needs:/u, id);
    assert.ok(job(id).includes('REPOSITORY: nocobase/nocobase\n'), id);
  }
});

test('checks out the pull request head, and Studio only at a fixed main, through the shared checkout action', () => {
  const checkouts = (id) =>
    [...job(id).matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu)].map(
      (match) => match.slice(1),
    );
  const repository = 'nocobase';
  assert.deepEqual(checkouts('preview'), [[repository, 'nocobase3']]);
  assert.deepEqual(checkouts('studio-preview'), [
    [repository, 'nocobase3'],
    ['studio', 'studio'],
  ]);
  for (const id of jobIds) {
    assert.equal([...job(id).matchAll(/merge-pull-request: 'false'/gu)].length, checkouts(id).length, id);
    assert.match(job(id), /repository: nocobase\n          path: nocobase3\n          partial-history: 'true'\n/u, id);
  }
  const studio = job('studio-preview');
  assert.match(studio, /head-sha: \$\{\{ steps\.studio-main\.outputs\.sha \}\}\n/u);
  assert.match(studio, /event-name: push\n/u);
  assert.match(studio, /gh api repos\/nocobase\/studio\/commits\/main --jq \.sha/u);
  assert.match(studio, /repositories: studio\n          permission-contents: read\n          skip-token-revoke: true\n/u);
  assert.match(studio, /--request DELETE[\s\S]+installation\/token/u);
  assert.match(studio, /rm -rf studio\/vendor\/nocobase3\n          mv nocobase3 studio\/vendor\/nocobase3\n/u);
  assert.match(studio, /mirror-workspace\.mjs" studio\/pnpm-workspace\.yaml studio\/vendor\/nocobase3\/pnpm-workspace\.yaml/u);
});

test('skips on the no-preview label and on changes the application does not run', () => {
  for (const id of jobIds) {
    const source = job(id);
    assert.match(source, /\[ "\$SKIP_LABEL" = 'true' \]/u, id);
    assert.match(source, /grep -qx 'no-preview'/u, id);
    assert.match(source, /git -C nocobase3 merge-base "\$BASE_SHA" "\$HEAD_SHA"/u, id);
    const gated = [...source.matchAll(/      - name: (.+)\n        (?:id: .+\n        )?if: (.+)\n/gu)];
    const afterGate = source.slice(source.indexOf('id: gate'));
    const steps = [...afterGate.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
    for (const step of steps) {
      const condition = gated.find(([, name]) => name === step)?.[2];
      assert.ok(condition?.includes('steps.gate.outputs.skip'), `${id}: ${step}`);
    }
  }
});

test('builds Studio as studio-ci builds it, on the pull request framework', () => {
  const studio = job('studio-preview');
  assert.match(studio, /package_json_file: studio\/package\.json/u);
  assert.match(studio, /working-directory: studio\n        run: pnpm install --no-frozen-lockfile\n/u);
  assert.match(studio, /working-directory: studio\n        run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(studio, /--file studio\/storage\/exports\/dist\.tar\.gz/u);
  assert.ok(studio.includes('APP_ID: nocobase-v3-studio-pr-${{ inputs.pr_number }}\n'));
});

test('builds the examples template with the repository pnpm', () => {
  assert.match(workflow, /TEMPLATE: packages\/templates\/app-template-examples\n/u);
  assert.match(workflow, /package_json_file: nocobase3\/package\.json/u);
  assert.doesNotMatch(workflow, /^\s+version: /mu);
  assert.match(workflow, /working-directory: nocobase3\/\$\{\{ env\.TEMPLATE \}\}\n        run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(workflow, /--file "nocobase3\/\$TEMPLATE\/storage\/exports\/dist\.tar\.gz"/u);
});

test('gives its own Studio key only to the steps that call Studio', () => {
  assert.doesNotMatch(workflow, /NB_STUDIO_API_KEY_NOCOBASE3/u);
  assert.doesNotMatch(workflow, /secrets\.NB_STUDIO_API_KEY\b(?!_NOCOBASE_V3)/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
  const steps = workflow.split(/\n(?=      - name: )/u).slice(1);
  for (const step of steps) {
    const name = step.match(/- name: (.+)/u)[1];
    const usesKey = step.includes('secrets.NB_STUDIO_API_KEY_NOCOBASE_V3');
    const callsStudio = /nb-studio|NB_STUDIO_SERVER/u.test(step.slice(step.indexOf('run:') === -1 ? step.length : step.indexOf('run:')));
    assert.equal(usesKey, callsStudio, name);
  }
  assert.doesNotMatch(workflow, /actions\/cache|upload-artifact|^\s+cache:/mu);
});

test('names the repository and the commit in every call to Studio', () => {
  const calls = [...workflow.matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 8);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.ok(workflow.includes('APP_ID: nocobase-v3-pr-${{ inputs.pr_number }}\n'));
  assert.match(workflow, /ENVIRONMENT: preview/u);
});
