import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/website-v3-docs.yml'), 'utf8');
const proWorkflow = readFileSync(path.join(root, '.github/workflows/nocobase3-pro-ci.yml'), 'utf8');
const deployScript = readFileSync(path.join(root, '.github/nocobase3/docs-publish/deploy-cdn.mjs'), 'utf8');

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

const inputNames = (source) => [
  ...source
    .slice(source.indexOf('  workflow_dispatch:\n'), source.indexOf('\npermissions:\n'))
    .matchAll(/^      ([a-z_]+):$/gmu),
].map((match) => match[1]);

test('takes exactly the seven forwarded fields and is named after the request', () => {
  assert.match(workflow, /^run-name: website-v3-docs:\$\{\{ inputs\.request_id \}\}$/mu);
  assert.deepEqual(inputNames(workflow), inputNames(proWorkflow));
});

test('names the job nocobase-bot mirrors, and a publish job that is not yet reported', () => {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: (.+)$/gmu)].map((match) => match.slice(1));
  assert.deepEqual(jobs, [
    ['build', 'Docs build'],
    ['publish', 'Docs publish'],
  ]);
  // Every request builds, for a pull request and for a push, whatever it changes.
  assert.doesNotMatch(job('build'), /\n    if:/u);
  assert.doesNotMatch(workflow, /paths:|git -C website diff|--name-only/u);
});

test('checks out only nocobase/website-v3 through the shared action, and never a merge', () => {
  const checkouts = [
    ...workflow.matchAll(/uses: \.\/\.github\/nocobase3\/checkout\n        with:\n          repository: (.+)\n          path: (.+)\n/gu),
  ].map((match) => match.slice(1));
  assert.deepEqual(checkouts, [
    ['website-v3', 'website'],
  ]);
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 1);
  assert.match(workflow, /repositories: website-v3\n          permission-contents: read\n/u);
});

test('builds with Node.js 24, a locked install without scripts, and doc/build.mjs at the repository root', () => {
  const source = job('build');
  assert.match(step(source, 'Set up Node.js'), /node-version: 24\n/u);
  assert.doesNotMatch(workflow, /actions\/cache|cache: /u);
  assert.match(step(source, 'Install dependencies'), /working-directory: website\n        run: npm ci --prefix doc --ignore-scripts\n/u);
  assert.match(step(source, 'Build the site'), /working-directory: website\n        run: node doc\/build\.mjs\n/u);
  const check = step(source, 'Check the build');
  for (const file of ['doc/dist/index.html', 'doc/dist/zh-CN/index.html', 'doc/dist/404.html', 'doc/dist/sitemap.xml']) {
    assert.ok(check.includes(file), `checks ${file}`);
  }
  assert.doesNotMatch(workflow.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n'), /DOCS_SITE_ORIGIN/u);
});

test('uploads doc/dist as the artifact the publish job downloads', () => {
  const upload = step(job('build'), 'Upload the site');
  assert.match(upload, /uses: actions\/upload-artifact@v4\n/u);
  assert.match(upload, /name: website-v3-docs\n          path: website\/doc\/dist\n/u);
  assert.match(upload, /retention-days: 7\n/u);
  assert.match(step(job('publish'), 'Download the site'), /uses: actions\/download-artifact@v4\n        with:\n          name: website-v3-docs\n          path: dist\n/u);
});

test('gives the build job no secret but the App key, and the publish job the OSS keys only in the Publish step', () => {
  const code = (source) => source.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
  const build = code(job('build'));
  assert.doesNotMatch(build, /DOCS_ALI|V3_DOCS|OSS_ACCESS/u);
  assert.doesNotMatch(build, /secrets\.(?!NOCOBASE_APP_PRIVATE_KEY\b)/u);
  assert.equal([...build.matchAll(/secrets\./gu)].length, 1);
  const publish = job('publish');
  const withKeys = publish.split(/\n(?=      - name: )/u).filter((part) => /secrets\.DOCS_ALI|secrets\.V3_DOCS/u.test(part));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /^      - name: Publish\n/u);
  // The publish job runs none of the site's code: it checks out only this repository's helpers.
  assert.doesNotMatch(publish, /doc\/build\.mjs|npm ci --prefix doc|nocobase3\/checkout/u);
});

test('runs only this repository\'s own publishing script', () => {
  const publish = step(job('publish'), 'Publish');
  assert.match(publish, /node \.github\/nocobase3\/docs-publish\/deploy-cdn\.mjs --timestamp "\$TIMESTAMP"/u);
  assert.doesNotMatch(publish, /website\//u);
  assert.match(step(job('publish'), 'Install the publishing tools'), /npm ci --ignore-scripts --prefix \.github\/nocobase3\/docs-publish\n/u);
});

test('is switched off by one repository variable, and publishes only a push to main that is still the latest', () => {
  const publish = job('publish');
  assert.match(
    publish,
    /\n    needs: build\n    if: \$\{\{ vars\.WEBSITE_V3_DOCS_PUBLISH == 'true' && inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}\n/u,
  );
  assert.match(publish, /concurrency:\n      group: website-v3-docs-publish\n      cancel-in-progress: false\n/u);
  assert.match(publish, /repositories: website-v3\n          permission-contents: read\n/u);
  // The latest-push check comes first, and every step after the token's revocation waits for it.
  const names = [...publish.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(names.slice(0, 3), ['Create a read-only source token', 'Compare with the head of the branch', 'Revoke the source token']);
  for (const name of names.slice(3)) {
    assert.match(step(publish, name), /\n        if: \$\{\{ steps\.head\.outputs\.current == 'true' \}\}\n/u, name);
  }
});

test('uploads the way the v3 documentation always has', () => {
  const publish = step(job('publish'), 'Publish');
  assert.match(step(job('publish'), 'Install the publishing tools'), /ossutil\/v2\/2\.2\.2\/ossutil-2\.2\.2-linux-amd64\.zip/u);
  assert.match(publish, /TZ=Asia\/Shanghai date \+%Y%m%d%H%M%S/u);
  assert.match(publish, /REGION="\$\{DOCS_ALI_OSS_REGION#oss-\}"/u);
  assert.match(publish, /ossutil cp -r dist\/ "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/\$TIMESTAMP\/"/u);
  assert.match(publish, /ossutil cp dist\/404\.html "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/404\.html"/u);
  assert.match(publish, /DOCS_ALI_OSS_BUCKET: \$\{\{ secrets\.V3_DOCS_ALI_OSS_BUCKET \}\}/u);
  assert.match(publish, /DOCS_ALI_OSS_REGION: \$\{\{ secrets\.V3_DOCS_ALI_OSS_REGION \}\}/u);
  assert.match(publish, /V3_DOCS_ALI_CDN_DOMAINS: \$\{\{ vars\.V3_DOCS_ALI_CDN_DOMAINS \}\}/u);
});

test('keeps the five back-to-origin rules, and cleans up once after every domain is switched', () => {
  const rules = [...deployScript.matchAll(/\{ sourceUrl: '([^']+)'/gu)].map((match) => match[1]);
  const multiline = [...deployScript.matchAll(/^  \{\n    sourceUrl: '([^']+)'/gmu)].map((match) => match[1]);
  assert.deepEqual([...rules, ...multiline].sort(), ['^/(.*)', '^/([^.]*[^/.])$', '^/api/ai/(.*)$', '^/en/(.*)', '^/en/([^.]*[^/.])$'].sort());
  assert.match(deployScript, /for \(const domain of domains\) \{/u);
  assert.equal([...deployScript.matchAll(/await cleanUpOldVersions\(ossClient\)/gu)].length, 1);
  assert.ok(deployScript.indexOf('for (const domain of domains)') < deployScript.indexOf('await cleanUpOldVersions(ossClient)'));
  assert.match(deployScript, /split\(\/\[\\s,\]\+\/u\)/u);
  assert.match(deployScript, /const KEEP_VERSIONS = 1;/u);
});
