import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const workflow = read('.github/workflows/customerportal-deploy.yml');
const action = read('.github/nocobase3/customerportal-deploy/action.yml');
const forwarded = read('.github/workflows/customerportal-ci.yml');

test('the manual redeploy takes the ref to deploy, runs by dispatch only, and is named after it', () => {
  assert.match(workflow, /^run-name: customerportal-deploy:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n(?:        .+\n)*?        default: main\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
  assert.match(workflow, /\npermissions:\n  contents: read\n/u);
  assert.doesNotMatch(workflow, /^concurrency:/mu);
});

test('the manual redeploy and the forwarded Deploy share one group that never cancels a deployment', () => {
  const group = /concurrency:\n      group: customerportal-deploy\n      cancel-in-progress: false\n/u;
  assert.match(workflow, group);
  assert.match(forwarded, group);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/u);
});

test('the manual redeploy checks out the private nocobase/CustomerPortal at the resolved commit through a read-only token it revokes', () => {
  assert.match(workflow, /owner: nocobase\n          repositories: CustomerPortal\n          permission-contents: read\n/u);
  assert.match(workflow, /gh api "repos\/nocobase\/CustomerPortal\/commits\/\$\{REF\}" --jq \.sha/u);
  assert.match(workflow, /repository: nocobase\/CustomerPortal\n          ref: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n/u);
  assert.match(workflow, /--request DELETE/u);
  assert.ok(workflow.indexOf('- name: Revoke the source token') < workflow.indexOf('- name: Build and deploy'));
  assert.match(workflow, /uses: \.\/\.github\/nocobase3\/customerportal-deploy\n        with:\n          sha: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n/u);
});

test('builds dist with a larger heap, then packages it as a linux/amd64 image without attestations', () => {
  assert.match(action, /NODE_OPTIONS: --max-old-space-size=6144\n      run: pnpm build --target linux-x64\n/u);
  assert.match(action, /node-version: 24\n/u);
  assert.ok(action.indexOf('pnpm build --target linux-x64') < action.indexOf('- name: Build and push the image'));
  assert.match(action, /build-args: DIST=prebuilt\n        platforms: linux\/amd64\n        provenance: false\n        sbom: false\n/u);
  assert.match(action, /tags: \$\{\{ inputs\.registry \}\}\/nocobase\/customer-portal:prod-\$\{\{ steps\.tag\.outputs\.short \}\}\n/u);
  assert.match(action, /short=\$\{SHA:0:7\}/u);
  assert.match(action, /\^\[0-9a-f\]\{40\}\$/u);
});

test('deploys the tag alone over a restricted SSH key with repository-level secrets', () => {
  assert.doesNotMatch(action, /^\s+environment:/mu);
  assert.match(action, /TAG: prod-\$\{\{ steps\.tag\.outputs\.short \}\}\n/u);
  assert.match(action, /-o StrictHostKeyChecking=yes/u);
  assert.match(action, /"root@\$\{DEPLOY_HOST\}" "\$TAG"/u);
  assert.match(action, /\^prod-\[0-9a-f\]\{7,40\}\$/u);
  assert.match(action, /trap 'rm -rf "\$dir"' EXIT/u);
  assert.doesNotMatch(action, /echo[^\n]*\$\{?SSH_KEY/u);
  assert.match(action, /"\$status" -eq 75/u);
});

test('both callers hand the action the secrets and variables, and nothing is cached or uploaded', () => {
  for (const caller of [workflow, forwarded]) {
    assert.match(caller, /ssh-key: \$\{\{ secrets\.CUSTOMERPORTAL_DEPLOY_SSH_KEY \}\}/u);
    assert.match(caller, /deploy-host: \$\{\{ vars\.CUSTOMERPORTAL_DEPLOY_HOST \}\}/u);
    assert.match(caller, /known-hosts: \$\{\{ vars\.CUSTOMERPORTAL_DEPLOY_KNOWN_HOSTS \}\}/u);
    assert.match(caller, /registry: \$\{\{ secrets\.ALI_DOCKER_REGISTRY \}\}/u);
  }
  for (const source of [workflow, action]) {
    assert.doesNotMatch(source, /actions\/cache|^\s+cache:|actions\/upload-artifact/mu);
  }
});
