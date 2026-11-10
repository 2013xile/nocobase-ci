import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const action = read('.github/nocobase3/image-push/action.yml');
const INPUTS = ['request_id', 'event_name', 'head_sha', 'base_sha', 'target_branch', 'pr_number', 'skip_label'];
const rows = [
  { file: 'bot-ci.yml', prefix: 'bot-ci', repository: 'nocobase-bot', image: 'nocobase-bot', build: 'bot-build', deploy: 'bot-deploy', secrets: 'BOT_DEPLOY', jobs: ['Build', 'Deploy'] },
  { file: 'pro-registry-ci.yml', prefix: 'pro-registry-ci', repository: 'v3-pro-registry', image: 'pro-registry', build: 'pro-registry-build', deploy: 'pro-registry-deploy', secrets: 'PRO_REGISTRY_DEPLOY', jobs: ['Test', 'Build', 'Deploy'] },
].map((row) => ({ ...row, workflow: read(`.github/workflows/${row.file}`) }));

test('image-push builds linux/amd64 without attestations, tagging sha-<short sha> and main only when asked', () => {
  assert.match(action, /platforms: linux\/amd64\n        provenance: false\n        sbom: false\n/u);
  assert.match(action, /\$\{\{ inputs\.registry \}\}\/\$\{\{ inputs\.image \}\}:sha-\$\{\{ steps\.tag\.outputs\.short \}\}\n/u);
  assert.match(action, /inputs\.push-main == 'true' && format\('\{0\}\/\{1\}:main', inputs\.registry, inputs\.image\) \|\| ''/u);
  assert.match(action, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(action, /short=\$\{SHA:0:7\}/u);
  assert.match(action, /value: sha-\$\{\{ steps\.tag\.outputs\.short \}\}/u);
});

for (const { file, prefix, repository, image, build, deploy, secrets, jobs, workflow } of rows) {
  test(`${file} takes the seven forwarded inputs, runs by dispatch only, and is named after the request`, () => {
    assert.match(workflow, new RegExp(`^run-name: ${prefix}:\\$\\{\\{ inputs\\.request_id \\}\\}$`, 'mu'));
    for (const input of INPUTS) assert.match(workflow, new RegExp(`\\n      ${input}:\\n(?:        .+\\n)*?        required: true\\n`, 'u'));
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
    assert.match(workflow, new RegExp(`\\nconcurrency:\\n  group: ${prefix}-\\$\\{\\{ inputs\\.request_id \\}\\}\\n  cancel-in-progress: false\\n`, 'u'));
  });

  test(`${file} names its jobs after the checks the bot expects`, () => {
    const names = [...workflow.matchAll(/^    name: (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(names, jobs);
  });

  test(`${file} checks out the fixed commit of nocobase/${repository} through the shared checkout`, () => {
    const checkouts = workflow.match(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu);
    assert.ok(checkouts.length >= 1);
    for (const checkout of checkouts) assert.match(checkout, new RegExp(`repository: ${repository}\\n          path: ${repository}\\n`, 'u'));
    assert.match(workflow, /head-sha: \$\{\{ inputs\.head_sha \}\}\n/u);
  });

  test(`${file} builds a push only, replacing an older build but never a deployment`, () => {
    assert.match(workflow, new RegExp(`  build:\\n    name: Build\\n(?:    .+\\n)*?    if: \\$\\{\\{ inputs\\.event_name == 'push' \\}\\}\\n(?:    .+\\n)*?    concurrency:\\n      group: ${build}\\n      cancel-in-progress: true\\n`, 'u'));
    assert.match(workflow, new RegExp(`uses: \\./\\.github/nocobase3/image-push\\n        with:\\n          path: ${repository}\\n          image: nocobase/${image}\\n          sha: \\$\\{\\{ inputs\\.head_sha \\}\\}\\n          push-main: \\$\\{\\{ inputs\\.target_branch == 'main' \\}\\}\\n`, 'u'));
  });

  test(`${file} deploys the pushed sha tag of main alone, sharing its group with the manual build`, () => {
    assert.match(workflow, /  deploy:\n    name: Deploy\n    needs: build\n    if: \$\{\{ inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}\n/u);
    assert.match(workflow, new RegExp(`concurrency:\\n      group: ${deploy}\\n      cancel-in-progress: false\\n`, 'u'));
    assert.match(workflow, /uses: \.\/\.github\/nocobase3\/ssh-deploy\n/u);
    assert.match(workflow, /tag: \$\{\{ needs\.build\.outputs\.tag \}\}\n/u);
    assert.match(workflow, new RegExp(`ssh-key: \\$\\{\\{ secrets\\.${secrets}_SSH_KEY \\}\\}\\n`, 'u'));
    assert.match(read(`.github/workflows/${file.replace('-ci.yml', '-image.yml')}`), new RegExp(`group: ${deploy}\\n`, 'u'));
  });
}

test('pro-registry-ci.yml tests every event, and builds only once the tests pass', () => {
  const workflow = rows[1].workflow;
  assert.match(workflow, /  test:\n    name: Test\n    runs-on: ubuntu-latest\n/u);
  assert.match(workflow, /  build:\n    name: Build\n    needs: test\n/u);
  assert.ok(workflow.indexOf('run: pnpm typecheck') < workflow.indexOf('  build:\n'));
  assert.ok(workflow.indexOf('run: pnpm test') < workflow.indexOf('  build:\n'));
});
