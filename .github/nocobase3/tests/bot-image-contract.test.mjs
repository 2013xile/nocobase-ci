import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/bot-image.yml'), 'utf8');

test('takes the ref to build, runs by dispatch only, and is named after it', () => {
  assert.match(workflow, /^run-name: bot-image:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n(?:        .+\n)*?        default: main\n/u);
  assert.match(workflow, /group: bot-image-\$\{\{ inputs\.ref \}\}\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
});

test('checks out the private nocobase/nocobase-bot at the resolved commit through a read-only token it revokes', () => {
  assert.match(workflow, /owner: nocobase\n          repositories: nocobase-bot\n          permission-contents: read\n/u);
  assert.match(workflow, /gh api "repos\/nocobase\/nocobase-bot\/commits\/\$\{REF\}" --jq \.sha/u);
    assert.match(workflow, /--request DELETE/u);
  assert.ok(workflow.indexOf('- name: Revoke the source token') < workflow.indexOf('- name: Build and push the image'));
});

test('builds through the shared image-push action, tagging main only for a build of main', () => {
  assert.match(workflow, /uses: \.\/\.github\/nocobase3\/image-push\n        with:\n          path: nocobase-bot\n          image: nocobase\/nocobase-bot\n          sha: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n          moving-tag: \$\{\{ inputs\.ref == 'main' && 'main' \|\| '' \}\}\n/u);
  assert.match(workflow, /repository: nocobase\/nocobase-bot\n          ref: \$\{\{ steps\.resolve\.outputs\.commit \}\}\n(?:          .+\n)*?          path: nocobase-bot\n/u);
});
