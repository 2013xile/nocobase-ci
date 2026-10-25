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
    ['latest', 'Check the push is the latest'],
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
    ['website-v3', 'website'],
  ]);
  assert.equal([...workflow.matchAll(/merge-pull-request: 'false'/gu)].length, 2);
  assert.match(workflow, /repositories: website-v3\n          permission-contents: read\n/u);
});

test('builds with Node.js 24, a locked install without scripts, and doc/build.mjs at the repository root', () => {
  for (const id of ['build', 'publish']) {
    const source = job(id);
    assert.match(step(source, 'Set up Node.js'), /node-version: 24\n/u, id);
    assert.doesNotMatch(source, /cache: |actions\/cache/u, id);
    assert.match(step(source, 'Install dependencies'), /working-directory: website\n        run: npm ci --prefix doc --ignore-scripts\n/u, id);
    assert.match(step(source, 'Build the site'), /working-directory: website\n        run: node doc\/build\.mjs\n/u, id);
    const check = step(source, 'Check the build');
    for (const file of ['doc/dist/index.html', 'doc/dist/zh-CN/index.html', 'doc/dist/404.html', 'doc/dist/sitemap.xml']) {
      assert.ok(check.includes(file), `${id} checks ${file}`);
    }
  }
  assert.doesNotMatch(workflow.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n'), /DOCS_SITE_ORIGIN/u);
});

test('is public-safe: uploads and caches nothing', () => {
  assert.doesNotMatch(workflow, /actions\/upload-artifact|actions\/cache/u);
});

test('gives no secret to the build job, and keys only to the Publish step', () => {
  const code = job('build').split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
  assert.doesNotMatch(code, /DOCS_ALI|V3_DOCS|OSS_ACCESS|secrets\.(?!NOCOBASE_APP_PRIVATE_KEY)/u);
  const publish = job('publish');
  const withKeys = publish.split(/\n(?=      - name: )/u).filter((part) => /secrets\.DOCS_ALI/u.test(part));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /^      - name: Publish\n/u);
  // The steps that run the site's code come after the tools are installed and before the keys, and carry no `env`.
  const order = ['Install the publishing tools', 'Install dependencies', 'Build the site', 'Check the build', 'Publish'];
  const positions = order.map((name) => publish.indexOf(`      - name: ${name}\n`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((position) => position !== -1));
  for (const name of ['Install dependencies', 'Build the site']) assert.doesNotMatch(step(publish, name), /\n        env:/u, name);
});

test('runs only this repository\'s own publishing script, never one from the source repository', () => {
  const publish = step(job('publish'), 'Publish');
  assert.match(publish, /node \.github\/nocobase3\/docs-publish\/deploy-cdn\.mjs --timestamp "\$TIMESTAMP"/u);
  assert.doesNotMatch(publish, /website\/(?:doc\/)?(?:scripts|[a-z-]+\.mjs)|node website\//u);
  assert.match(step(job('publish'), 'Install the publishing tools'), /npm ci --ignore-scripts --prefix \.github\/nocobase3\/docs-publish\n/u);
});

test('is switched off by one repository variable, and publishes only a push to main that is still the latest', () => {
  assert.match(
    job('latest'),
    /\n    if: \$\{\{ vars\.WEBSITE_V3_DOCS_PUBLISH == 'true' && inputs\.event_name == 'push' && inputs\.target_branch == 'main' \}\}\n/u,
  );
  const publish = job('publish');
  assert.match(publish, /\n    needs: latest\n    if: \$\{\{ needs\.latest\.outputs\.current == 'true' \}\}\n/u);
  assert.match(publish, /concurrency:\n      group: website-v3-docs-publish\n      cancel-in-progress: false\n/u);
});

test('uploads the way the v3 documentation always has', () => {
  const publish = step(job('publish'), 'Publish');
  assert.match(step(job('publish'), 'Install the publishing tools'), /ossutil\/v2\/2\.2\.2\/ossutil-2\.2\.2-linux-amd64\.zip/u);
  assert.match(publish, /TZ=Asia\/Shanghai date \+%Y%m%d%H%M%S/u);
  assert.match(publish, /REGION="\$\{DOCS_ALI_OSS_REGION#oss-\}"/u);
  assert.match(publish, /ossutil cp -r website\/doc\/dist\/ "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/\$TIMESTAMP\/"/u);
  assert.match(publish, /ossutil cp website\/doc\/dist\/404\.html "oss:\/\/\$DOCS_ALI_OSS_BUCKET\/404\.html"/u);
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
