import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/customerportal-release.yml'), 'utf8');

function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test('runs by dispatch only, one release at a time, with read-only contents by default', () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n    inputs:\n      dry_run:\n/u);
  // CustomerPortal's Release workflow finds the run it dispatched by its request id in the run name.
  assert.match(workflow, /^run-name: customerportal-release:\$\{\{ inputs\.request_id \|\| 'manual' \}\}/mu);
  assert.match(workflow, /\n      request_id:\n/u);
  assert.match(workflow, /\n      requested_by:\n/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
  assert.match(workflow, /\nconcurrency:\n  group: customerportal-release\n  cancel-in-progress: false\n/u);
  assert.match(workflow, /\npermissions:\n  contents: read\n/u);
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: .+$/gmu)].map((match) => match[1]);
  assert.deepEqual(jobs, ['prepare', 'deploy', 'release', 'notify']);
});

test('releases the version of package.json at the commit main was resolved to, once', () => {
  const source = job('prepare');
  assert.match(source, /gh api repos\/nocobase\/CustomerPortal\/commits\/main --jq \.sha/u);
  assert.match(source, /contents\/package\.json\?ref=\$\{commit\}/u);
  assert.match(source, /permission-contents: read\n/u);
  assert.match(source, /matching-refs\/tags\/v\$\{VERSION\}/u);
  assert.match(source, /bump_branch=release\/customerportal-\$\{next\}/u);
  assert.ok(source.indexOf('- name: Revoke the source token') > source.indexOf('- name: Check the tag and the bump branch are free'));
});

test('builds and deploys the resolved commit with the shared action, never pushing or deploying on a dry run', () => {
  const source = job('deploy');
  assert.match(source, /needs: prepare\n/u);
  assert.match(source, /\n    concurrency:\n      group: customerportal-deploy\n      cancel-in-progress: false\n/u);
  assert.match(source, /ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}\n/u);
  assert.match(source, /uses: \.\/\.github\/nocobase3\/customerportal-deploy\n        with:\n          sha: \$\{\{ needs\.prepare\.outputs\.commit \}\}\n/u);
  assert.match(source, /deploy: \$\{\{ inputs\.dry_run && 'false' \|\| 'true' \}\}\n/u);
  assert.ok(source.indexOf('- name: Revoke the source token') < source.indexOf('- name: Build and deploy'));
});

test('tags, bumps and releases only after the deployment, and never on a dry run', () => {
  const source = job('release');
  assert.match(source, /needs: \[prepare, deploy\]\n    if: \$\{\{ !inputs\.dry_run \}\}\n/u);
  assert.match(source, /permission-contents: write\n          permission-pull-requests: write\n/u);
  assert.match(source, /git tag "\$tag" "\$COMMIT"/u);
  assert.match(source, /persist-credentials: false/u);
  // The squash merge follows CustomerPortal's convention: the title with its number, an empty body.
  assert.match(source, /--squash --delete-branch --subject "\$\{title\} \(#\$\{number\}\)" --body ''/u);
  assert.match(source, /--base main \\\n/u);
  assert.match(source, /--verify-tag/u);
  // Notes and the GitHub release never fail a release that is already deployed and tagged.
  for (const step of ['Write the release notes', 'Create the GitHub release']) {
    const start = source.indexOf(`- name: ${step}`);
    assert.match(source.slice(start, source.indexOf('\n      - name:', start + 1)), /continue-on-error: true/u);
  }
});

test('notifies Feishu of every real release, never of a dry run', () => {
  const source = job('notify');
  assert.match(source, /needs: \[prepare, deploy, release\]\n    if: \$\{\{ !cancelled\(\) && !inputs\.dry_run \}\}\n/u);
  assert.match(source, /WEBHOOK_URL: \$\{\{ secrets\.RELEASE_RESULT_FEISHU_WEBHOOK_URL \}\}/u);
  assert.match(source, /repository: nocobase\/nocobase\n/u);
  assert.match(source, /persist-credentials: false/u);
  assert.doesNotMatch(source, /NOCOBASE_APP_PRIVATE_KEY|CUSTOMERPORTAL_DEPLOY/u);
});
