import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/verdaccio-image.yml'), 'utf8');

test('takes the ref to build, runs by dispatch only, and is named after it', () => {
  assert.match(workflow, /^run-name: verdaccio-image:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n(?:        .+\n)*?        default: next\n/u);
  assert.match(workflow, /group: verdaccio-image-\$\{\{ inputs\.ref \}\}\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
});

test('checks out the private nocobase/verdaccio at the resolved commit through a read-only token it revokes', () => {
  assert.match(workflow, /owner: nocobase\n          repositories: verdaccio\n          permission-contents: read\n/u);
  assert.match(workflow, /gh api "repos\/nocobase\/verdaccio\/commits\/\$\{REF\}" --jq \.sha/u);
    assert.match(workflow, /--request DELETE/u);
  assert.ok(workflow.indexOf('- name: Revoke the source token') < workflow.indexOf('- name: Build and push the image'));
});

test('builds through the shared image-push action, tagging alpha only for a build of next', () => {
  assert.match(workflow, /uses: \.\/\.github\/nocobase3\/image-push\n        with:\n          path: verdaccio\n          image: nocobase\/verdaccio\n          sha: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n          moving-tag: \$\{\{ inputs\.ref == 'next' && 'alpha' \|\| '' \}\}\n/u);
  assert.match(workflow, /repository: nocobase\/verdaccio\n          ref: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n(?:          .+\n)*?          path: verdaccio\n/u);
});

test('tests the plugin before it builds anything', () => {
  assert.match(workflow, /run: npx --yes yarn@1\.22\.22 install --frozen-lockfile\n/u);
  assert.ok(workflow.indexOf('run: node --test "test/*.test.js"') < workflow.indexOf('- name: Build and push'));
});
