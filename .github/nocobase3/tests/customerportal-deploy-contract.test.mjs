import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/customerportal-deploy.yml'), 'utf8');

test('takes the ref to deploy, runs by dispatch only, and is named after it', () => {
  assert.match(workflow, /^run-name: customerportal-deploy:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n(?:        .+\n)*?        default: main\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
  assert.match(workflow, /\npermissions:\n  contents: read\n/u);
  assert.doesNotMatch(workflow, /^concurrency:/mu);
});

test('cancels a build of the same ref in progress but never a deployment', () => {
  assert.match(workflow, /group: customerportal-internal-build-\$\{\{ inputs\.ref \}\}\n      cancel-in-progress: true\n/u);
  assert.match(workflow, /group: customerportal-internal-deploy\n      cancel-in-progress: false\n/u);
});

test('checks out the private nocobase/CustomerPortal at the resolved commit through a read-only token it revokes', () => {
  assert.match(workflow, /owner: nocobase\n          repositories: CustomerPortal\n          permission-contents: read\n/u);
  assert.match(workflow, /gh api "repos\/nocobase\/CustomerPortal\/commits\/\$\{REF\}" --jq \.sha/u);
  assert.match(workflow, /repository: nocobase\/CustomerPortal\n          ref: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n/u);
  assert.match(workflow, /--request DELETE/u);
  assert.ok(workflow.indexOf('- name: Revoke the source token') < workflow.indexOf('- name: Install dependencies'));
});

test('builds dist with a larger heap, then packages it as a linux/amd64 image without attestations', () => {
  assert.match(workflow, /NODE_OPTIONS: --max-old-space-size=6144\n        run: pnpm build --target linux-x64\n/u);
  assert.match(workflow, /node-version: 24\n/u);
  assert.ok(workflow.indexOf('pnpm build --target linux-x64') < workflow.indexOf('- name: Build and push'));
  assert.match(workflow, /build-args: DIST=prebuilt\n          platforms: linux\/amd64\n          provenance: false\n          sbom: false\n/u);
  assert.match(workflow, /tags: \$\{\{ secrets\.ALI_DOCKER_REGISTRY \}\}\/nocobase\/customer-portal:internal-\$\{\{ steps\.resolve\.outputs\.sha \}\}\n/u);
  assert.match(workflow, /sha=\$\{commit:0:7\}/u);
});

test('deploys the tag alone over a restricted SSH key with repository-level secrets', () => {
  assert.match(workflow, /needs: build\n/u);
  assert.doesNotMatch(workflow, /^\s+environment:/mu);
  assert.match(workflow, /secrets\.CUSTOMERPORTAL_DEPLOY_SSH_KEY/u);
  assert.match(workflow, /vars\.CUSTOMERPORTAL_DEPLOY_HOST/u);
  assert.match(workflow, /vars\.CUSTOMERPORTAL_DEPLOY_KNOWN_HOSTS/u);
  assert.match(workflow, /TAG: internal-\$\{\{ needs\.build\.outputs\.sha \}\}\n/u);
  assert.match(workflow, /-o StrictHostKeyChecking=yes/u);
  assert.match(workflow, /"root@\$\{DEPLOY_HOST\}" "\$TAG"/u);
  assert.match(workflow, /\^internal-\[0-9a-f\]\{7,40\}\$/u);
  assert.match(workflow, /trap 'rm -rf "\$dir"' EXIT/u);
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?SSH_KEY/u);
  assert.match(workflow, /"\$status" -eq 75/u);
});
