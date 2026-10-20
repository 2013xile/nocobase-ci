import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/studio-ci.yml'), 'utf8');
const proWorkflow = readFileSync(path.join(root, '.github/workflows/nocobase3-pro-ci.yml'), 'utf8');

// The check names nocobase-bot mirrors onto nocobase/studio from this workflow (STUDIO_CI_CHECK_NAMES there). The others
// run in studio-quality.yml of the CI repository pool.
const expectedJobs = ['Preview', 'Dist'];

function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const dispatchInputs = (source) =>
  source.slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'));

test("takes Pro's dispatch inputs plus the optional head branch, and names its runs studio-ci", () => {
  assert.match(workflow, /^run-name: studio-ci:\$\{\{ inputs\.request_id \}\}$/mu);
  const headRef = `      head_ref:
        description: The source pull request's head branch, or empty for a push.
        required: false
        default: ''
        type: string
`;
  const qaInput = `      qa_plugin_sha:
        description: Optional full private QA plugin SHA for an isolated manual preview; empty preserves normal CI.
        required: false
        default: ''
        type: string
`;
  assert.ok(dispatchInputs(workflow).endsWith(headRef + qaInput));
  assert.equal(dispatchInputs(workflow).slice(0, -(headRef.length + qaInput.length)), dispatchInputs(proWorkflow));
});

test('keeps only the check jobs that need its secrets, and their events', () => {
  const names = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map(([, , name]) => name);
  assert.deepEqual(names, expectedJobs);
  assert.match(job('preview'), /if: \$\{\{ inputs\.event_name == 'pull_request' \}\}/u);
  assert.match(
    job('dist'),
    /if: \$\{\{ inputs\.qa_plugin_sha == '' && inputs\.event_name == 'push' && \(inputs\.target_branch == 'dev' \|\| inputs\.target_branch == 'main'\) \}\}/u,
  );
});

test('checks out only nocobase/studio through the shared checkout action', () => {
  const checkouts = [...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu)];
  assert.equal(checkouts.length, 2);
  assert.ok(checkouts.every(([, repository, directory]) => repository === 'studio' && directory === 'studio'));
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 1);
  assert.match(job('preview'), /merge-pull-request: 'false'/u);
});

test('gives the deployment secret only to the preview', () => {
  assert.doesNotMatch(job('dist'), /secrets\.(?!NOCOBASE_APP_PRIVATE_KEY)/u);
  assert.doesNotMatch(workflow, /\bssh\b/u);
  assert.doesNotMatch(workflow, /^ {6}NB_STUDIO_API_KEY:/mu);
});

test('names the repository and the commit in every preview call to Studio', () => {
  const calls = [...job('preview').matchAll(/run: (nb-studio .+)$/gmu)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /--repository "\$REPOSITORY"/u, call);
  for (const call of calls.filter((call) => !call.startsWith('nb-studio app ensure'))) {
    assert.match(call, /--sha "\$HEAD_SHA"/u, call);
  }
  assert.match(job('preview'), /APP_ID: \$\{\{ inputs\.qa_plugin_sha != '' && format\('studio-qa-preview-\{0\}', github\.run_id\) \|\| format\('studio-pr-\{0\}', inputs\.pr_number\) \}\}/u);
  assert.match(job('preview'), /ENVIRONMENT: preview/u);
  assert.match(job('preview'), /LOGS: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/u);
});

test('uploads only the public tarballs, briefly, and caches nothing', () => {
  assert.doesNotMatch(workflow, /actions\/cache|^\s+cache:/mu);
  const uploads = [...workflow.matchAll(/- name: .+\n(?:        if: (.+)\n)?        uses: actions\/upload-artifact@v4\n        with:\n(?:          .+\n)*?          retention-days: (\d+)/gu)];
  assert.equal([...workflow.matchAll(/actions\/upload-artifact/gu)].length, uploads.length);
  assert.ok(uploads.every(([, , days]) => days === '3'));
  const dist = uploads.filter(([upload]) => job('dist').includes(upload));
  assert.equal(dist.length, 2);
  assert.ok(dist.every(([upload]) => /path: studio\/output\/dist\/stable\/(nb-studio|nocobase-runner)\n/u.test(upload)));
  assert.equal(dist.length, uploads.length);
});

test("runs Studio's own scripts with the repository's pnpm, after a full install", () => {
  assert.doesNotMatch(workflow, /^\s+version: /mu);
  assert.equal(
    [...workflow.matchAll(/uses: pnpm\/action-setup@v4\n        with:\n          package_json_file: studio\/package\.json\n/gu)].length,
    [...workflow.matchAll(/uses: pnpm\/action-setup@v4/gu)].length,
  );
  // The committed pointer installs from the lockfile; a same-name framework branch may need it resolved again.
  assert.match(
    job('preview'),
    /working-directory: studio\n        env:\n          INSTALL_FLAG: \$\{\{ steps\.framework\.outputs\.install-flag \}\}\n        run: pnpm install "\$\{INSTALL_FLAG:---frozen-lockfile\}"\n/u,
  );
  assert.match(job('dist'), /working-directory: studio\n        run: pnpm install --frozen-lockfile\n/u);
});

test('builds the per-platform tarballs of both products', () => {
  assert.match(job('dist'), /run: pnpm nocobase cli build --out output\/dist\n/u);
  assert.match(job('dist'), /run: pnpm nocobase cli build --runner --out output\/dist\n/u);
});

test('builds the preview on the same-name framework branch when there is one, right after the checkout', () => {
  for (const id of ['preview']) {
    const source = job(id);
    const step = source.indexOf('      - name: Choose the framework\n');
    assert.notEqual(step, -1, id);
    assert.match(
      source.slice(step),
      /uses: \.\/\.github\/nocobase3\/studio-framework\n        with:\n          head-ref: \$\{\{ inputs\.head_ref \}\}\n          github-token: \$\{\{ github\.token \}\}\n/u,
      id,
    );
    assert.ok(source.indexOf('uses: ./.github/nocobase3/checkout') < step, id);
    assert.ok(step < source.indexOf('      - name: Install dependencies\n'), id);
  }
  assert.match(job('preview'), /- name: Choose the framework\n        id: framework\n        if: \$\{\{ inputs\.qa_plugin_sha == '' && steps\.gate\.outputs\.skip != 'true' \}\}\n/u);
  assert.doesNotMatch(job('dist'), /studio-framework\n/u);
});

test("never runs the pull request's code with a token beside it", () => {
  assert.doesNotMatch(workflow, /GITHUB_TOKEN:|--head-branch|studio-framework-gate/u);
  // The only token in a step's environment is Preview's own label lookup, which runs no pull request code.
  assert.deepEqual([...workflow.matchAll(/GH_TOKEN: (.+)/gu)].map((match) => match[1]), ['${{ steps.pr-token.outputs.token }}']);
});

test('sets up Node.js before installing the nb-studio CLI, which carries no Node.js of its own', () => {
  const source = job('preview');
  const node = source.indexOf('      - name: Set up Node.js\n');
  const cli = source.indexOf('      - name: Install the nb-studio CLI\n');
  assert.ok(node !== -1 && cli !== -1 && node < cli);
});
