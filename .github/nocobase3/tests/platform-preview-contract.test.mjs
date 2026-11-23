import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checkout = readFileSync(new URL('../checkout/action.yml', import.meta.url), 'utf8');
const workflow = readFileSync(
  new URL('../../workflows/multi-tenant-platform-preview.yml', import.meta.url),
  'utf8',
);

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test('keeps the Bot dispatch protocol, platform identity and PR-only boundary', () => {
  assert.match(workflow, /^run-name: multi-tenant-platform-preview:\$\{\{ inputs.request_id \}\}$/mu);
  assert.match(workflow, /name: Preview\n    if:.*event_name == 'pull_request'.*skip_label != 'true'/u);
  assert.match(workflow, /SOURCE_REPOSITORY: nocobase\/multi-tenant-platform-app/u);
  assert.match(workflow, /APP_ID: multi-tenant-platform-app-pr-\$\{\{ inputs.pr_number \}\}/u);
  assert.match(workflow, /merge-pull-request: 'false'/u);
  for (const command of ['build status', 'deploy']) {
    const lines = workflow.split('\n').filter((line) => line.includes(`run: nb-studio ${command}`));
    assert.ok(lines.length);
    assert.ok(lines.every((line) => line.includes('--repository "$SOURCE_REPOSITORY" --sha "$HEAD_SHA"')));
  }
});

test('waits for source checks before rebuilding, and does not publish private artifacts', () => {
  const steps = [
    'Wait for the platform quality checks',
    'Revoke the gate token',
    'Check out the verified platform head',
    'Inspect the platform framework layout',
    'Create a Pro-only read token',
    'Check out the pinned framework',
    'Revoke the Pro source token',
    'Set up pnpm',
    'Install dependencies',
    'Build the deployment archive',
    'Remove private package configuration',
    'Stage the archive',
    'Deploy the verified head',
  ];
  const positions = steps.map((name) => workflow.indexOf(`- name: ${name}`));
  assert.ok(positions.every((pos) => pos >= 0));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  assert.match(
    workflow,
    /permission-pull-requests: read\n          permission-checks: read\n          skip-token-revoke: true/u,
  );
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact|actions\/cache/u);
  assert.doesNotMatch(workflow, /secrets\.NB_STUDIO_API_KEY\b/u);
  assert.match(workflow, /secrets\.MULTI_TENANT_PLATFORM_NB_STUDIO_API_KEY/u);
});

test('disables recursive checkout and revokes the application and Pro tokens before application code runs', () => {
  assert.match(step('Check out the verified platform head'), /submodules: 'false'/u);
  assert.match(checkout, /submodules:\n    description: .+\n    default: 'true'/u);
  assert.match(checkout, /submodules: \$\{\{ inputs\.submodules == 'true' && 'recursive' \|\| 'false' \}\}/u);
  assert.equal((checkout.match(/SUBMODULES: \$\{\{ inputs\.submodules \}\}/gu) ?? []).length, 2);
  assert.match(checkout, /persist-credentials: false/u);
  assert.match(checkout, /- name: Revoke the source token\n      if: \$\{\{ always\(\) && steps\.app-token\.outputs\.token != '' \}\}/u);
  assert.match(checkout, /--request DELETE[\s\S]*https:\/\/api\.github\.com\/installation\/token\s*$/u);
  assert.doesNotMatch(checkout, /continue-on-error/u);

  const framework = step('Check out the pinned framework');
  assert.match(framework, /if: \$\{\{ steps\.gate\.outputs\.skip == 'false' \}\}/u);
  assert.match(framework, /working-directory: platform/u);
  assert.match(framework, /PLATFORM_PRO_SOURCE_TOKEN: \$\{\{ steps\.pro-token\.outputs\.token \}\}/u);
  assert.match(framework, /run: node \.\.\/\.github\/nocobase3\/platform-framework\.mjs$/u);
  assert.doesNotMatch(framework, /secrets\.|always\(\)|continue-on-error/u);
  const inspect = step('Inspect the platform framework layout');
  assert.match(inspect, /--inspect$/u);
  assert.doesNotMatch(inspect, /secrets\.|TOKEN/u);
  const token = step('Create a Pro-only read token');
  assert.match(token, /framework-layout\.outputs\.pro_required == 'true'/u);
  assert.match(token, /owner: nocobase\n          repositories: nocobase3-pro\n          permission-contents: read/u);
  assert.doesNotMatch(token, /permission-[^:]+: write|repositories: \$|skip-token-revoke: false/u);
  const revoke = step('Revoke the Pro source token');
  assert.match(revoke, /always\(\) && steps\.pro-token\.outputs\.token != ''/u);
  assert.match(revoke, /--request DELETE[\s\S]*https:\/\/api\.github\.com\/installation\/token/u);
  assert.doesNotMatch(revoke, /continue-on-error/u);
});

test('installs and builds directly on the runner with the source package manager', () => {
  assert.match(workflow, /runs-on: ubuntu-latest/u);
  assert.match(workflow, /uses: actions\/setup-node@v4\n        with:\n          node-version: 24/u);
  const setup = step('Set up pnpm');
  assert.match(setup, /uses: pnpm\/action-setup@v4/u);
  assert.match(setup, /package_json_file: platform\/package.json/u);
  assert.match(setup, /run_install: false/u);
  assert.ok(workflow.indexOf('uses: actions/setup-node@v4') < workflow.indexOf('Set up pnpm'));
  const install = step('Install dependencies');
  const build = step('Build the deployment archive');
  assert.match(install, /run: pnpm install --frozen-lockfile/u);
  assert.match(build, /run: pnpm build --target linux-x64 --node-version 24 --tar/u);
  assert.match(build, /timeout-minutes: 20/u);
  assert.match(workflow, /NODE_OPTIONS: --max-old-space-size=6144/u);
  const jobEnvironment = workflow.slice(workflow.indexOf('\n    env:\n'), workflow.indexOf('\n    steps:\n'));
  assert.doesNotMatch(jobEnvironment, /secrets\.|NB_STUDIO_API_KEY|SOURCE_READ_TOKEN|PRIVATE_KEY/u);
  for (const operation of [install, build]) {
    assert.match(operation, /if: \$\{\{ steps.gate.outputs.skip == 'false' \}\}/u);
    assert.match(operation, /working-directory: platform/u);
    assert.match(operation, /NPM_CONFIG_USERCONFIG: \$\{\{ runner.temp \}\}\/platform-npmrc/u);
    assert.doesNotMatch(operation, /NB_STUDIO|SOURCE_READ_TOKEN|PRIVATE_KEY|secrets\./u);
  }
  assert.doesNotMatch(
    workflow,
    /\bdocker\s+(?:run|build|rm)|^\s*container:|BUILD_CONTAINER|BUILD_IMAGE|--mount|platform-home|platform-tools/mu,
  );
});

test('keeps cleanup and the fresh post-build deployment gate on the runner path', () => {
  const packageCleanup = step('Remove private package configuration');
  assert.match(packageCleanup, /if: \$\{\{ always\(\) \}\}/u);
  assert.ok(packageCleanup.includes('rm -f "$RUNNER_TEMP/platform-npmrc"'));
  const finalCleanup = step('Remove temporary platform CI files');
  assert.match(finalCleanup, /if: \$\{\{ always\(\) \}\}/u);
  assert.ok(finalCleanup.includes('rm -f "$RUNNER_TEMP/platform-npmrc"'));
  assert.ok(finalCleanup.includes('rm -rf "$NB_STUDIO_HOME" "$RUNNER_TEMP/platform-deploy"'));
  assert.ok(
    workflow.indexOf('Build the deployment archive') <
      workflow.indexOf('Create a fresh pre-deployment read token'),
  );
  assert.ok(workflow.indexOf('--before-deploy') < workflow.indexOf('Ensure the PR application'));
  assert.match(workflow, /steps\.deployment-token\.outputs\.token/u);
  assert.match(workflow, /Revoke the pre-deployment token/u);
});

test('matches the existing application Preview workflows runner-native build pattern', () => {
  for (const file of ['studio-ci.yml', 'nocobase3-preview.yml', 'customerportal-ci.yml']) {
    const reference = readFileSync(new URL(`../../workflows/${file}`, import.meta.url), 'utf8');
    assert.match(reference, /runs-on: ubuntu-latest/u);
    assert.match(reference, /run: pnpm install/u);
    assert.match(reference, /run: pnpm build --target linux-x64 --tar/u);
    assert.doesNotMatch(reference, /\bdocker run|^\s*container:/mu);
  }
});

test('all multiline shell scripts parse without executing any build or deployment', () => {
  const lines = workflow.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('run: |')) continue;
    const indent = lines[i].search(/\S/u),
      body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/u) > indent); j++)
      body.push(lines[j].slice(indent + 2));
    const result = spawnSync('bash', ['-n'], { input: body.join('\n'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
