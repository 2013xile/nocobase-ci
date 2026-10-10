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

const studioJobs = ['studio-preview', 'studio-e2e', 'cli-reference', 'studio-dist'];

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

test('has the jobs nocobase-bot mirrors, plus the scope they depend on, for pull requests only', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [
    ['preview', 'Preview'],
    ['scope', 'Scope'],
    ['studio-preview', 'Studio preview'],
    ['studio-e2e', 'Studio e2e'],
    ['cli-reference', 'CLI reference'],
    ['studio-dist', 'Studio dist'],
  ]);
  for (const id of ['preview', 'scope']) {
    assert.match(job(id), /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u, id);
    assert.doesNotMatch(job(id), /\n    needs:/u, id);
  }
  assert.match(job('studio-preview'), /\n    needs: scope\n    if: \$\{\{ needs\.scope\.outputs\.preview == 'true' \}\}\n/u);
  for (const id of studioJobs.slice(1)) {
    assert.match(job(id), /\n    needs: scope\n    if: \$\{\{ needs\.scope\.outputs\.studio == 'true' \}\}\n/u, id);
  }
});

test('checks out only the pull request head, never a merge, through the shared checkout action', () => {
  for (const id of ['preview', 'scope', ...studioJobs]) {
    assert.deepEqual(checkouts(id), [['nocobase', 'nocobase3']], id);
    assert.equal([...job(id).matchAll(/merge-pull-request: 'false'/gu)].length, 1, id);
  }
  for (const id of ['preview', 'scope']) {
    assert.match(job(id), /repository: nocobase\n          path: nocobase3\n          partial-history: 'true'\n/u, id);
  }
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

test('runs the Studio jobs only when the pull request changes Studio or what it is built from', () => {
  const scope = job('scope');
  for (const path of [
    'packages/apps/studio/',
    'app-server',
    'app-client',
    'app-cli',
    'app-cli-client',
    'agent-runner',
    'packages/libs/agent-protocol/',
    'app-plugin-(projects|agents|knowledge|releases)',
    'pnpm-lock',
  ]) {
    assert.ok(scope.includes(path), path);
  }
  assert.match(scope, /git -C nocobase3 diff --name-only "\$base" "\$HEAD_SHA" \| grep -qE "\$STUDIO_PATHS"/u);
  assert.match(scope, /\[ "\$SKIP_LABEL" = 'true' \]/u);
  // Only agent runs get a Studio preview; the checks run for every pull request that changes Studio.
  assert.match(scope, /--jq \.head\.ref\)/u);
  assert.match(scope, /grep -qE '\^agent\/PM-\[0-9\]\+\$'/u);
  // Only agent runs get a Studio preview; the checks run for every pull request that changes Studio.
  assert.match(scope, /--jq \.head\.ref\)/u);
  assert.match(scope, /grep -qE '\^agent\/PM-\[0-9\]\+\$'/u);
  assert.match(scope, /grep -qx 'no-preview'/u);
  assert.match(scope, /studio: \$\{\{ steps\.scope\.outputs\.studio \}\}\n      preview: \$\{\{ steps\.scope\.outputs\.preview \}\}\n/u);
});

test('builds Studio from the pull request with the repository pnpm and lockfile', () => {
  for (const id of studioJobs) {
    const source = job(id);
    assert.match(source, /package_json_file: nocobase3\/package\.json/u, id);
    assert.match(source, /working-directory: nocobase3\n        run: pnpm install --frozen-lockfile --filter "@nocobase\/studio\.\.\."\n/u, id);
    assert.match(source, /working-directory: nocobase3\n        run: pnpm --filter "@nocobase\/studio\^\.\.\." build\n/u, id);
  }
  const preview = job('studio-preview');
  assert.match(preview, /working-directory: nocobase3\/packages\/apps\/studio\n[\s\S]*?run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(preview, /--file nocobase3\/packages\/apps\/studio\/storage\/exports\/dist\.tar\.gz/u);
  assert.ok(preview.includes('APP_ID: nocobase-v3-studio-pr-${{ inputs.pr_number }}\n'));
  assert.match(job('studio-e2e'), /run: pnpm test:e2e\n/u);
  assert.match(job('cli-reference'), /run: pnpm cli-reference:check\n/u);
  assert.match(job('studio-dist'), /run: pnpm nocobase cli build --runner --out output\/dist\n/u);
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
  for (const id of ['studio-e2e', 'cli-reference', 'studio-dist']) {
    assert.doesNotMatch(job(id), /NB_STUDIO/u, id);
  }
  assert.doesNotMatch(workflow, /actions\/cache|^\s+cache:/mu);
});

test('uploads only Studio e2e evidence on failure and the CLI tarballs, kept for three days', () => {
  const uploads = [...workflow.matchAll(/uses: actions\/upload-artifact@v4\n        with:\n          name: (.+)\n/gu)].map((m) => m[1]);
  assert.deepEqual(uploads, ['studio-screenshots', 'studio-e2e-results', 'studio-dist-nb-studio', 'studio-dist-nocobase-runner']);
  assert.equal([...workflow.matchAll(/retention-days: 3\n/gu)].length, 4);
  for (const name of ['Upload screenshots', 'Upload failed test traces']) {
    assert.ok(job('studio-e2e').includes(`- name: ${name}\n        if: \${{ failure() }}\n`), name);
  }
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
