import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const workflow = readFileSync(new URL('../../workflows/studio-ci.yml', import.meta.url), 'utf8');
const action = readFileSync(new URL('../studio-qa-checkout/action.yml', import.meta.url), 'utf8');

test('manual QA profile is opt-in and uses a separate preview App', () => {
  assert.match(workflow, /qa_plugin_sha:\n[^]*?required: false\n        default: ''/u);
  assert.match(workflow, /APP_ID: \$\{\{ inputs\.qa_plugin_sha != '' && format\('studio-qa-preview-\{0\}', github\.run_id\) \|\| format\('studio-pr-\{0\}', inputs\.pr_number\) \}\}/u);
  assert.match(workflow, /ENVIRONMENT: preview/u);
  assert.match(workflow, /- name: Check out fixed pull request head\n        if: \$\{\{ inputs\.qa_plugin_sha == '' \}\}/u);
  assert.match(workflow, /- name: Check out and assemble the QA preview profile\n        if: \$\{\{ inputs\.qa_plugin_sha != '' \}\}/u);
  assert.doesNotMatch(action + workflow, /--admin|environment: production|docker login|docker push/u);
});

test('only the two source repositories get temporary read-only access', () => {
  assert.match(action, /repositories: \|\n          studio\n          studio-plugin-testing\n        permission-contents: read/u);
  assert.match(action, /\^\[0-9a-f\]\{40\}\$/u);
  assert.equal([...action.matchAll(/persist-credentials: false/gu)].length, 2);
  assert.match(action, /repository: nocobase\/studio\n[^]*?ref: \$\{\{ inputs\.studio-sha \}\}/u);
  assert.match(action, /repository: nocobase\/studio-plugin-testing\n[^]*?ref: \$\{\{ inputs\.plugin-sha \}\}/u);
  assert.match(action, /if: \$\{\{ always\(\) && steps\.source-token\.outputs\.token != '' \}\}/u);
  assert.ok(action.indexOf('- name: Revoke the profile token') < action.indexOf('- name: Assemble the verified private profile'));
  assert.doesNotMatch(action, /actions\/cache|upload-artifact|cat .*\.(ts|json)|set -x/u);
});

test('profile validation and registration run before dependencies, preserving the pinned framework and lockfile', () => {
  assert.match(action, /prepare-studio-preview\.mjs studio --check\n        node qa-source\/scripts\/prepare-studio-preview\.mjs studio --apply/u);
  assert.ok(workflow.indexOf('- name: Check out and assemble the QA preview profile') < workflow.indexOf('- name: Install dependencies'));
  assert.match(workflow, /id: framework\n        if: \$\{\{ inputs\.qa_plugin_sha == '' && steps\.gate\.outputs\.skip != 'true' \}\}/u);
  assert.match(workflow, /pnpm install "\$\{INSTALL_FLAG:---frozen-lockfile\}"/u);
  assert.doesNotMatch(action, /pnpm install|pnpm build|nb-studio deploy|studio-framework/u);
});
