import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/website-v3-site.yml'), 'utf8');
const docsWorkflow = readFileSync(path.join(root, '.github/workflows/website-v3-docs.yml'), 'utf8');

function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

// The text of one step of a job, up to the next step.
function step(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `step ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n      - name: /u);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const code = (source) => source.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');

const inputs = (source) => source.slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'));
const inputNames = (source) => [...inputs(source).matchAll(/^      ([a-z_]+):$/gmu)].map((match) => match[1]);

test('takes exactly the inputs of the documentation workflow and is named after the request', () => {
  assert.match(workflow, /^name: Website v3 site$/mu);
  assert.match(workflow, /^run-name: website-v3-site:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), ['request_id', 'event_name', 'head_sha', 'base_sha', 'target_branch', 'pr_number', 'skip_label']);
  assert.deepEqual(inputNames(workflow), inputNames(docsWorkflow));
  assert.equal([...inputs(workflow).matchAll(/required: true\n        type: string\n/gu)].length, 7);
  assert.match(workflow, /concurrency:\n  group: website-v3-site-\$\{\{ inputs\.request_id \}\}\n  cancel-in-progress: false\n/u);
});

test('names the two jobs nocobase-bot mirrors', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [
    ['build', 'Site build'],
    ['publish', 'Site publish'],
  ]);
  // Every request the bot forwards builds; selecting by path is the bot's.
  assert.doesNotMatch(job('build'), /\n    if:/u);
  assert.doesNotMatch(workflow, /paths:|git -C website diff|--name-only/u);
});

test('checks out only nocobase/website-v3 through the shared action, and never a merge', () => {
  const checkouts = [
    ...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu),
  ].map((match) => match.slice(1));
  assert.deepEqual(checkouts, [['website-v3', 'website']]);
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 1);
  assert.match(step(job('build'), 'Check out trusted CI helpers'), /persist-credentials: false\n          sparse-checkout: \.github\/nocobase3\n/u);
});

test('assembles html/ without _src/ or .DS_Store, and serves homepage.html as index.html too', () => {
  const build = job('build');
  const assemble = step(build, 'Assemble the site');
  assert.match(assemble, /working-directory: website\n/u);
  assert.match(assemble, /rsync -a --exclude '\/_src\/' --exclude '\.DS_Store' html\/ dist\/\n/u);
  assert.match(assemble, /cp dist\/homepage\.html dist\/index\.html\n/u);
  assert.doesNotMatch(assemble, /mv dist\/homepage\.html|rm /u);
  // Transitional: none of the site's code runs, so there is no Node.js, install or build script in the build job.
  assert.doesNotMatch(code(build), /setup-node|npm |node |build\.mjs/u);
  assert.doesNotMatch(workflow, /actions\/cache|cache: /u);
  const check = step(build, 'Check the build');
  assert.match(check, /if \[ ! -s dist\/index\.html \]; then/u);
  assert.match(check, /if \[ ! -d dist\/assets \]; then/u);
});

test('uploads dist as the artifact the publish job downloads', () => {
  const upload = step(job('build'), 'Upload the site');
  assert.match(upload, /uses: actions\/upload-artifact@v4\n/u);
  assert.match(upload, /name: website-v3-site\n          path: website\/dist\n          if-no-files-found: error\n          retention-days: 7\n/u);
  assert.match(step(job('publish'), 'Download the site'), /uses: actions\/download-artifact@v4\n        with:\n          name: website-v3-site\n          path: dist\n/u);
});

test('gives the build job no secret but the App key, and the publish job the OSS keys only in the Publish step', () => {
  const build = code(job('build'));
  assert.doesNotMatch(build, /DOCS_ALI|V3_DOCS|WEBSITE_V3_ALI|OSS_ACCESS/u);
  assert.doesNotMatch(build, /secrets\.(?!NOCOBASE_APP_PRIVATE_KEY\b)/u);
  assert.equal([...build.matchAll(/secrets\./gu)].length, 1);
  const publish = job('publish');
  const withKeys = publish.split(/\n(?=      - name: )/u).filter((part) => /secrets\.DOCS_ALI|secrets\.V3_DOCS|vars\.WEBSITE_V3_ALI/u.test(part));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /^      - name: Publish\n/u);
  // The publish job runs none of the site's code: it checks out only this repository's helpers.
  assert.doesNotMatch(publish, /website\/|nocobase3\/checkout/u);
});

test('publishes a push to main unless a newer commit changes html/, and never a pull request', () => {
  const publish = job('publish');
  assert.match(publish, /\n    needs: build\n    if: \$\{\{ inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}\n/u);
  assert.match(publish, /concurrency:\n      group: website-v3-site-publish\n      cancel-in-progress: false\n/u);
  assert.match(publish, /repositories: website-v3\n          permission-contents: read\n/u);
  const names = [...publish.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(names.slice(0, 3), ['Create a read-only source token', 'Compare with the head of the branch', 'Revoke the source token']);
  for (const name of names.slice(3)) {
    assert.match(step(publish, name), /\n        if: \$\{\{ steps\.head\.outputs\.current == 'true' \}\}\n/u, name);
  }
  const head = step(publish, 'Compare with the head of the branch');
  assert.match(head, /gh api "repos\/nocobase\/website-v3\/compare\/\$\{HEAD_SHA\}\.\.\.\$\{head\}"/u);
  assert.match(head, /startswith\("html\/"\)\) or \(\(\.previous_filename \/\/ ""\) \| startswith\("html\/"\)\)/u);
  assert.doesNotMatch(head, /"doc\//u);
  assert.match(head, /if \[ "\$status" = "ahead" \] && \[ "\$files" -lt 300 \] && \[ "\$site" -eq 0 \]; then\n            echo "current=true"/u);
});

test('uploads to the website bucket with the shared keys and region, and requires them', () => {
  const publish = step(job('publish'), 'Publish');
  assert.match(step(job('publish'), 'Install the publishing tools'), /ossutil\/v2\/2\.2\.2\/ossutil-2\.2\.2-linux-amd64\.zip/u);
  assert.match(publish, /DOCS_ALI_OSS_ACCESS_KEY_ID: \$\{\{ secrets\.DOCS_ALI_OSS_ACCESS_KEY_ID \}\}/u);
  assert.match(publish, /DOCS_ALI_OSS_ACCESS_KEY_SECRET: \$\{\{ secrets\.DOCS_ALI_OSS_ACCESS_KEY_SECRET \}\}/u);
  assert.match(publish, /DOCS_ALI_OSS_BUCKET: \$\{\{ vars\.WEBSITE_V3_ALI_OSS_BUCKET \}\}/u);
  assert.match(publish, /DOCS_ALI_OSS_REGION: \$\{\{ secrets\.V3_DOCS_ALI_OSS_REGION \}\}/u);
  assert.match(publish, /WEBSITE_V3_ALI_CDN_DOMAINS: \$\{\{ vars\.WEBSITE_V3_ALI_CDN_DOMAINS \}\}/u);
  // Never the documentation's bucket or domains.
  assert.doesNotMatch(publish, /V3_DOCS_ALI_OSS_BUCKET|vars\.V3_DOCS_ALI_CDN_DOMAINS/u);
  const required = publish.match(/for name in ([^;]+); do/u);
  assert.ok(required, 'checks the required settings');
  assert.deepEqual(required[1].split(/[\s\\]+/u).filter(Boolean), [
    'DOCS_ALI_OSS_ACCESS_KEY_ID',
    'DOCS_ALI_OSS_ACCESS_KEY_SECRET',
    'DOCS_ALI_OSS_BUCKET',
    'DOCS_ALI_OSS_REGION',
  ]);
  assert.match(publish, /TZ=Asia\/Shanghai date \+%Y%m%d%H%M%S/u);
  assert.match(publish, /REGION="\$\{DOCS_ALI_OSS_REGION#oss-\}"/u);
  assert.match(publish, /ossutil cp -r dist\/ "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/\$TIMESTAMP\/"/u);
  assert.match(publish, /if \[ -f dist\/404\.html \]; then\n            ossutil cp dist\/404\.html "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/404\.html"/u);
});

test('only uploads when no CDN domain is configured, and otherwise switches with the site\'s domains', () => {
  const publish = step(job('publish'), 'Publish');
  const upload = publish.indexOf('ossutil cp -r dist/');
  const empty = publish.indexOf('if [ -z "${WEBSITE_V3_ALI_CDN_DOMAINS//[[:space:],]/}" ]; then');
  const deploy = publish.indexOf('node .github/nocobase3/docs-publish/deploy-cdn.mjs');
  assert.ok(upload !== -1 && empty !== -1 && deploy !== -1);
  assert.ok(upload < empty && empty < deploy, 'uploads, then stops before deploy-cdn.mjs when no domain is set');
  const emptyBranch = publish.slice(empty, publish.indexOf('\n          fi\n', empty));
  assert.match(emptyBranch, /echo "::notice::/u);
  assert.match(emptyBranch, /\$GITHUB_STEP_SUMMARY/u);
  assert.match(emptyBranch, /oss:\/\/\$DOCS_ALI_OSS_BUCKET\/\$TIMESTAMP\//u);
  assert.match(emptyBranch, /\n            exit 0$/u);
  assert.doesNotMatch(emptyBranch, /deploy-cdn/u);
  assert.equal([...code(publish).matchAll(/deploy-cdn\.mjs/gu)].length, 1);
  assert.match(publish, /V3_DOCS_ALI_CDN_DOMAINS="\$WEBSITE_V3_ALI_CDN_DOMAINS" \\\n            node \.github\/nocobase3\/docs-publish\/deploy-cdn\.mjs --timestamp "\$TIMESTAMP"\n/u);
  assert.match(step(job('publish'), 'Install the publishing tools'), /npm ci --ignore-scripts --prefix \.github\/nocobase3\/docs-publish\n/u);
});
