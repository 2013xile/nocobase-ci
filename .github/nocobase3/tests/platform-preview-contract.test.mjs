import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/multi-tenant-platform-preview.yml', import.meta.url), 'utf8');

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
    'Build inside an isolated container',
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

test('application code runs only in a container with narrowly enumerated mounts and environment', () => {
  const build = workflow.slice(
    workflow.indexOf('      - name: Build inside an isolated container'),
    workflow.indexOf('      - name: Stage the archive'),
  );
  assert.match(build, /docker run --rm --init/u);
  assert.match(build, /--cap-drop ALL --security-opt no-new-privileges --pids-limit 512/u);
  assert.match(build, /node:24-bookworm/u);
  assert.match(build, /pnpm install --frozen-lockfile/u);
  assert.ok(build.includes('--user "$(id -u):$(id -g)"'));
  assert.ok(build.includes('--env HOME=/tmp/platform-home'));
  assert.ok(build.includes('npm install --global --prefix /tmp/platform-tools pnpm@11.11.0'));
  assert.ok(build.includes('export PATH="/tmp/platform-tools/bin:$PATH"'));
  assert.match(build, /pnpm build --target linux-x64 --node-version 24 --tar/u);
  assert.equal((build.match(/--mount /gu) ?? []).length, 3);
  assert.match(build, /dst=\/workspace\/\.git,readonly/u);
  assert.match(build, /dst=\/run\/secrets\/npmrc,readonly/u);
  assert.doesNotMatch(
    build,
    /--privileged|--pid(?:=|\s)|--network.?host|docker.sock|NB_STUDIO|GITHUB_ENV|GITHUB_OUTPUT|PRIVATE_KEY/u,
  );
  assert.equal((build.match(/--env /gu) ?? []).length, 4);
  assert.ok(
    workflow.indexOf('Build inside an isolated container') <
      workflow.indexOf('Create a fresh pre-deployment read token'),
  );
  assert.ok(workflow.indexOf('--before-deploy') < workflow.indexOf('Ensure the PR application'));
  assert.match(workflow, /steps\.deployment-token\.outputs\.token/u);
  assert.match(workflow, /Revoke the pre-deployment token/u);
  assert.match(workflow, /always\(\).*\n        run: \|\n          docker rm -f/u);
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
