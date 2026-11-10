import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/pro-registry-image.yml'), 'utf8');

test('takes the ref to build, runs by dispatch only, and is named after it', () => {
  assert.match(workflow, /^run-name: pro-registry-image:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n(?:        .+\n)*?        default: main\n/u);
  assert.match(workflow, /group: pro-registry-image-\$\{\{ inputs\.ref \}\}\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
});

test('checks out the private nocobase/v3-pro-registry at the resolved commit through a read-only token it revokes', () => {
  assert.match(workflow, /owner: nocobase\n          repositories: v3-pro-registry\n          permission-contents: read\n/u);
  assert.match(workflow, /gh api "repos\/nocobase\/v3-pro-registry\/commits\/\$\{REF\}" --jq \.sha/u);
  assert.match(workflow, /repository: nocobase\/v3-pro-registry\n          ref: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n/u);
  assert.match(workflow, /--request DELETE/u);
  assert.ok(workflow.indexOf('- name: Revoke the source token') < workflow.indexOf('- name: Build and push'));
});

test('pushes linux/amd64 without attestations, tagging sha-<short sha> and, for main alone, main', () => {
  assert.match(workflow, /build-args: NPM_REGISTRY=https:\/\/registry\.npmjs\.org\/\n          platforms: linux\/amd64\n          provenance: false\n          sbom: false\n/u);
  assert.match(workflow, /\$\{\{ secrets\.ALI_DOCKER_REGISTRY \}\}\/nocobase\/pro-registry:sha-\$\{\{ steps\.resolve\.outputs\.sha \}\}\n/u);
  assert.match(workflow, /inputs\.ref == 'main' && format\('\{0\}\/nocobase\/pro-registry:main', secrets\.ALI_DOCKER_REGISTRY\) \|\| ''/u);
});

test('typechecks and tests the source before it builds anything', () => {
  assert.match(workflow, /run: pnpm install --frozen-lockfile\n/u);
  assert.ok(workflow.indexOf('run: pnpm typecheck') < workflow.indexOf('- name: Build and push'));
  assert.ok(workflow.indexOf('run: pnpm test') < workflow.indexOf('- name: Build and push'));
});
