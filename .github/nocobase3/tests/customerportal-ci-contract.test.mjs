import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/customerportal-ci.yml'), 'utf8');
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

test('takes exactly the seven forwarded fields and is named after the request', () => {
  assert.match(workflow, /^run-name: customerportal-ci:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), inputNames(proWorkflow));
});

test('has only the jobs nocobase-bot mirrors, each for its own event', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [['preview', 'Preview'], ['test', 'Test'], ['deploy', 'Deploy']]);
  assert.match(job('preview'), /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u);
  assert.match(job('test'), /\n    if: \$\{\{ inputs\.event_name == 'pull_request' \}\}\n/u);
  assert.match(job('deploy'), /\n    if: \$\{\{ inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}\n/u);
});

test('checks out only CustomerPortal, the pull request head for the preview, its merge for the tests and the pushed head for the deployment', () => {
  const checkouts = [
    ...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu),
  ].map((match) => match.slice(1));
  assert.deepEqual(checkouts, [['CustomerPortal', 'customerportal'], ['CustomerPortal', 'customerportal'], ['CustomerPortal', 'customerportal']]);
  assert.match(job('preview'), /merge-pull-request: 'false'/u);
  assert.match(job('deploy'), /merge-pull-request: 'false'/u);
  // The checkout action merges the pull request into its base by default.
  assert.doesNotMatch(job('test'), /merge-pull-request:/u);
  assert.match(workflow, /repositories: CustomerPortal\n          permission-pull-requests: read\n/u);
});

test('deploys the commit the check is on, with one job whose conclusion is the check, and never cancels a deployment', () => {
  const source = job('deploy');
  assert.match(source, /head-sha: \$\{\{ inputs\.head_sha \}\}\n/u);
  assert.match(source, /uses: \.\/\.github\/nocobase3\/customerportal-deploy\n        with:\n          sha: \$\{\{ inputs\.head_sha \}\}\n/u);
  // Nothing resolves a branch name, which could name a commit newer than the check's.
  assert.doesNotMatch(source, /gh api|commits\//u);
  assert.match(source, /\n    concurrency:\n      group: customerportal-deploy\n      cancel-in-progress: false\n/u);
  assert.doesNotMatch(job('preview'), /group: customerportal-deploy/u);
  assert.match(source, /ssh-key: \$\{\{ secrets\.CUSTOMERPORTAL_DEPLOY_SSH_KEY \}\}/u);
  assert.match(source, /deploy-host: \$\{\{ vars\.CUSTOMERPORTAL_DEPLOY_HOST \}\}/u);
  assert.match(source, /known-hosts: \$\{\{ vars\.CUSTOMERPORTAL_DEPLOY_KNOWN_HOSTS \}\}/u);
  assert.doesNotMatch(source, /^\s+environment:/mu);
  assert.doesNotMatch(source, /needs:/u);
});

test('skips on the no-preview label and for changes the application does not run', () => {
  const source = job('preview');
  assert.match(source, /\[ "\$SKIP_LABEL" = 'true' \]/u);
  assert.match(source, /grep -qx 'no-preview'/u);
  assert.match(source, /git -C customerportal merge-base "\$BASE_SHA" "\$HEAD_SHA"/u);
  const gated = [...source.matchAll(/      - name: (.+)\n        (?:id: .+\n        )?if: (.+)\n/gu)];
  const afterGate = source.slice(source.indexOf('id: gate'));
  for (const step of [...afterGate.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1])) {
    const condition = gated.find(([, name]) => name === step)?.[2];
    assert.ok(condition?.includes('steps.gate.outputs.skip'), step);
  }
});

test('builds the application at the repository root with its own pnpm', () => {
  assert.match(workflow, /package_json_file: customerportal\/package\.json/u);
  assert.doesNotMatch(workflow, /^\s+version: /mu);
  assert.match(workflow, /working-directory: customerportal\n        run: pnpm install --frozen-lockfile\n/u);
  assert.match(workflow, /working-directory: customerportal\n        run: pnpm build --target linux-x64 --tar\n/u);
  assert.match(workflow, /--file customerportal\/storage\/exports\/dist\.tar\.gz/u);
});

test('gives the repository\'s own Studio key only to the steps that call Studio', () => {
  assert.doesNotMatch(workflow, /secrets\.NB_STUDIO_API_KEY/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
  const steps = workflow
    .split(/\n(?=      - name: )/u)
    .slice(1)
    .map((step) => step.split(/\n\n {2}(?=[#a-z])/u)[0]);
  for (const step of steps) {
    const name = step.match(/- name: (.+)/u)[1];
    const usesKey = step.includes('secrets.CUSTOMERPORTAL_NB_STUDIO_API_KEY');
    const callsStudio = /nb-studio [a-z]|NB_STUDIO_SERVER/u.test(step.slice(step.indexOf('run:') === -1 ? step.length : step.indexOf('run:')));
    assert.equal(usesKey, callsStudio, name);
  }
});

test('caches and uploads nothing', () => {
  assert.doesNotMatch(workflow, /actions\/cache|^\s+cache:/mu);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/u);
});

test('names the repository and the commit in every call to Studio, and deploys the pull request\'s own App', () => {
  const calls = [...workflow.matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.ok(workflow.includes('      REPOSITORY: nocobase/CustomerPortal\n'));
  assert.ok(workflow.includes('APP_ID: customerportal-pr-${{ inputs.pr_number }}\n'));
  assert.match(workflow, /ENVIRONMENT: preview/u);
});

test('sets up Node.js before installing the nb-studio CLI, which carries no Node.js of its own', () => {
  const source = job('preview');
  const node = source.indexOf('      - name: Set up Node.js\n');
  const cli = source.indexOf('      - name: Install the nb-studio CLI\n');
  assert.ok(node !== -1 && cli !== -1 && node < cli);
});

test('runs the application\'s test suite on every pull request, with no secret beyond the checkout\'s', () => {
  const source = job('test');
  assert.match(source, /working-directory: customerportal\n        run: pnpm install --frozen-lockfile\n/u);
  assert.match(source, /working-directory: customerportal\n        run: pnpm test\n/u);
  // The no-preview label skips only the preview.
  assert.doesNotMatch(source, /no-preview|SKIP_LABEL|steps\.gate/u);
  assert.deepEqual([...source.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]), ['NOCOBASE_APP_PRIVATE_KEY']);
  assert.doesNotMatch(source, /group: customerportal-deploy/u);
});
