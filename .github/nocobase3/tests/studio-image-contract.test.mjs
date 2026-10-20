import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/studio-image.yml'), 'utf8');

// The text of one job, from its key to the next job's.
function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

// A step of the job `in` (the whole workflow by default), up to the next step or job.
function step(name, { in: source = workflow } = {}) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `step ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n      - name: |\n  [a-z-]+:\n/u);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

// The shell of a `run: |` block, unindented.
function script(name) {
  const lines = step(name).split('\n');
  const begin = lines.findIndex((line) => line === '        run: |');
  assert.notEqual(begin, -1, `run block of ${name}`);
  return lines
    .slice(begin + 1)
    .filter((line) => line.startsWith('          ') || line === '')
    .map((line) => line.slice(10))
    .join('\n');
}

const commit = '0123abcdef0123abcdef0123abcdef0123abcdef';
const sha = commit.slice(0, 7);

// Runs the tag step for the resolved commit and returns the tag names and stamp it wrote.
function nameTags({ ref = 'dev' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-image-'));
  try {
    const output = path.join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', script('Name the tags')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, COMMIT: commit, REF: ref, GITHUB_OUTPUT: output },
    });
    const text = readFileSync(output, 'utf8');
    const tags = text.includes('tags<<EOF\n') ? text.split('tags<<EOF\n')[1].split('\nEOF')[0].split('\n') : [];
    const value = (key) => new RegExp(`^${key}=(.*)$`, 'mu').exec(text)?.[1];
    return { status: result.status, sha: value('sha'), stamp: value('stamp'), tags };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs the stamp step against manifests at `versions` and returns what it wrote and reported.
function stampVersions(versions, { stamp = '20261019081500' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-stamp-'));
  const manifests = {
    '@nocobase/studio': '.',
    '@nocobase/studio-cli': 'packages/studio-cli',
    '@nocobase/agent-runner': 'vendor/nocobase3/packages/app/agent-runner',
  };
  try {
    for (const [name, directory] of Object.entries(manifests)) {
      mkdirSync(path.join(dir, directory), { recursive: true });
      writeFileSync(
        path.join(dir, directory, 'package.json'),
        JSON.stringify({ name, version: versions[name], private: false }, null, 2),
      );
    }
    const output = path.join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', script('Stamp dev versions')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, STAMP: stamp, GITHUB_OUTPUT: output },
    });
    const written = Object.fromEntries(
      Object.entries(manifests).map(([name, directory]) => [
        name,
        JSON.parse(readFileSync(path.join(dir, directory, 'package.json'), 'utf8')),
      ]),
    );
    const text = readFileSync(output, 'utf8');
    const reported = text.includes('versions<<EOF\n') ? text.split('versions<<EOF\n')[1].split('EOF')[0].trim().split('\n') : [];
    return { status: result.status, written, reported };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('takes the ref to build, and no release mode', () => {
  const inputs = workflow.slice(workflow.indexOf('  workflow_dispatch:\n'), workflow.indexOf('\npermissions:\n'));
  assert.match(inputs, /      ref:\n(?:        .+\n)*?        required: true\n(?:        .+\n)*?        type: string\n/u);
  assert.doesNotMatch(workflow, /inputs\.release|      release:/u);
  assert.match(workflow, /^run-name: studio-image:\$\{\{ inputs\.ref \}\}$/mu);
  assert.match(workflow, /group: studio-image-\$\{\{ inputs\.ref \}\}\n/u);
});

test('tags a build of dev dev-<short sha> and dev', () => {
  const result = nameTags();
  assert.equal(result.status, 0);
  assert.equal(result.sha, sha);
  assert.deepEqual(result.tags, [`dev-${sha}`, 'dev']);
  assert.match(result.stamp, /^\d{14}$/u);
});

test('gives main its own moving tag, so it never replaces dev', () => {
  const { status, tags } = nameTags({ ref: 'main' });
  assert.equal(status, 0);
  assert.deepEqual(tags, [`dev-${sha}`, 'main']);
});

test('tags a build of any other ref dev-<short sha> alone, so it moves neither dev nor main', () => {
  for (const ref of ['feat/anything', 'agent/PM-42', 'v3-develop', 'main-backup', 'dev-1', '0123abc']) {
    const { status, tags } = nameTags({ ref });
    assert.equal(status, 0);
    assert.deepEqual(tags, [`dev-${sha}`], ref);
  }
});

test('names tags without the registry, which as a secret would drop the output on its way to other jobs', () => {
  assert.doesNotMatch(step('Name the tags'), /REGISTRY/u);
  assert.doesNotMatch(job('prepare'), /secrets\.ALI_DOCKER_REGISTRY/u);
  assert.match(job('prepare'), /      tags: \$\{\{ steps\.tags\.outputs\.tags \}\}\n/u);
});

test('checks out the private nocobase/studio at the ref, with its submodule, through a read-only token it revokes', () => {
  const inputs = workflow.slice(workflow.indexOf('  workflow_dispatch:\n'), workflow.indexOf('\npermissions:\n'));
  assert.match(inputs, /description: Branch, tag or commit of nocobase\/studio to build\.\n/u);
  assert.match(inputs, /default: dev\n/u);
  for (const id of ['prepare', 'image']) {
    const source = job(id);
    const token = step('Create a read-only source token', { in: source });
    assert.match(token, /app-id: \$\{\{ vars\.NOCOBASE_APP_ID \}\}\n/u, id);
    assert.match(token, /private-key: \$\{\{ secrets\.NOCOBASE_APP_PRIVATE_KEY \}\}\n/u, id);
    assert.match(token, /owner: nocobase\n          repositories: studio\n          permission-contents: read\n/u, id);
    const revoke = step('Revoke the source token', { in: source });
    assert.match(revoke, /if: \$\{\{ always\(\) && steps\.app-token\.outputs\.token != '' \}\}\n/u, id);
    assert.match(revoke, /--request DELETE/u, id);
  }
  // `prepare` resolves the ref once, and every platform checks that commit out, so a branch that moves during the run
  // cannot give the platforms different sources.
  assert.match(step('Resolve the ref'), /REF: \$\{\{ inputs\.ref \}\}\n/u);
  assert.match(step('Resolve the ref'), /gh api "repos\/nocobase\/studio\/commits\/\$\{REF\}" --jq \.sha/u);
  const image = job('image');
  assert.match(image, /    needs: prepare\n/u);
  const checkout = step('Check out Studio', { in: image });
  assert.match(checkout, /repository: nocobase\/studio\n          ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}\n/u);
  assert.match(checkout, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}\n/u);
  assert.match(checkout, /persist-credentials: false\n/u);
  assert.match(checkout, /submodules: true\n/u);
  // Revoked before any of Studio's own code runs.
  assert.ok(
    image.indexOf(step('Revoke the source token', { in: image })) < image.indexOf(step('Install dependencies', { in: image })),
  );
  const code = workflow.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
  assert.doesNotMatch(code, /nocobase\/nocobase\b(?!-ci)|packages\/apps\/studio|packages\/tools\/studio-cli/u);
});

test('builds at the repository root with the pnpm of its packageManager', () => {
  assert.match(step('Set up pnpm'), /package_json_file: package\.json\n/u);
  assert.doesNotMatch(workflow, /working-directory:|--filter|NOCOBASE_SKIP_WORKSPACE_DEPENDENCY_BUILD/u);
  assert.match(step('Install dependencies'), /run: pnpm install --frozen-lockfile\n/u);
  assert.match(step('Build and push'), /context: \.\n          file: Dockerfile\n/u);
});

test("lets Studio's own build pack the universal packages into the prebuilt dist", () => {
  // `pnpm build` packs nb-studio and the runner into dist/runners; nothing builds or copies them separately.
  assert.doesNotMatch(workflow, /cli build|runners-dist/u);
  assert.match(step('Build dist'), /run: pnpm build --target \$\{\{ matrix\.target \}\}\n/u);
  assert.match(step('Build and push'), /build-args: DIST=prebuilt\n/u);
});

test('builds linux/amd64 and linux/arm64 in parallel, each from a dist/ built for its own platform', () => {
  const image = job('image');
  assert.match(
    image,
    /        include:\n          - arch: amd64\n            target: linux-x64\n          - arch: arm64\n            target: linux-arm64\n/u,
  );
  assert.match(step('Build and push'), /platforms: linux\/\$\{\{ matrix\.arch \}\}\n/u);
  // The arm64 image's RUN lines need emulation on the x64 runner; amd64 does not.
  assert.match(step('Set up QEMU'), /if: \$\{\{ matrix\.arch != 'amd64' \}\}\n/u);
  assert.ok(image.indexOf(step('Set up QEMU')) < image.indexOf(step('Build and push')));
});

test('pushes each platform by digest and tags them under one multi-platform manifest', () => {
  const push = step('Build and push');
  assert.doesNotMatch(push, /if:|tags:|push: true/u);
  assert.match(push, /outputs: type=image,name=\$\{\{ secrets\.ALI_DOCKER_REGISTRY \}\}\/nocobase\/studio,push-by-digest=true,name-canonical=true,push=true\n/u);
  assert.match(step('Upload the digest'), /name: digest-\$\{\{ matrix\.arch \}\}\n/u);
  const manifest = job('manifest');
  assert.match(manifest, /    needs: \[prepare, image\]\n/u);
  assert.match(step('Download the digests', { in: manifest }), /pattern: digest-\*\n          merge-multiple: true\n/u);
  const tag = step('Tag and push the manifest', { in: manifest });
  assert.match(tag, /TAGS: \$\{\{ needs\.prepare\.outputs\.tags \}\}\n/u);
  assert.match(tag, /docker buildx imagetools create "\$\{args\[@\]\}"/u);
});

test('lists the tags in the summary', () => {
  const summary = step('Summary', { in: job('manifest') });
  assert.match(summary, /TAGS: \$\{\{ needs\.prepare\.outputs\.tags \}\}/u);
  assert.match(summary, /GITHUB_STEP_SUMMARY/u);
});

test('stamps dev versions on Studio, nb-studio and the runner before anything is built', () => {
  const stamp = step('Stamp dev versions');
  assert.doesNotMatch(stamp, /        if:/u);
  const at = workflow.indexOf(stamp);
  assert.ok(at > workflow.indexOf(step('Install dependencies')));
  assert.ok(at < workflow.indexOf(step('Build dist')));
  // One timestamp from `prepare`, so both platforms carry the same versions.
  assert.match(stamp, /STAMP: \$\{\{ needs\.prepare\.outputs\.stamp \}\}\n/u);
  assert.doesNotMatch(stamp, /date /u);
});

test('appends .dev.<UTC timestamp> to a prerelease and -dev.<timestamp> to a plain version', () => {
  const { status, written, reported } = stampVersions({
    '@nocobase/studio': '1.0.0-beta.51',
    '@nocobase/studio-cli': '0.1.0-beta.2',
    '@nocobase/agent-runner': '0.1.0',
  });
  assert.equal(status, 0);
  const studio = written['@nocobase/studio'].version;
  const cli = written['@nocobase/studio-cli'].version;
  const runner = written['@nocobase/agent-runner'].version;
  assert.equal(studio, '1.0.0-beta.51.dev.20261019081500');
  assert.equal(cli, '0.1.0-beta.2.dev.20261019081500');
  assert.equal(runner, '0.1.0-dev.20261019081500');
  assert.deepEqual(reported, [`@nocobase/studio@${studio}`, `@nocobase/studio-cli@${cli}`, `@nocobase/agent-runner@${runner}`]);
  assert.equal(written['@nocobase/studio'].private, false, 'other manifest fields are kept');
});

test('fails the stamp when a manifest has no version', () => {
  const { status } = stampVersions({
    '@nocobase/studio': '1.0.0-beta.51',
    '@nocobase/studio-cli': undefined,
    '@nocobase/agent-runner': '0.1.0-beta.3',
  });
  assert.notEqual(status, 0);
});

test('fails the stamp without a timestamp from prepare', () => {
  const { status } = stampVersions(
    { '@nocobase/studio': '1.0.0-beta.51', '@nocobase/studio-cli': '0.1.0', '@nocobase/agent-runner': '0.1.0' },
    { stamp: '' },
  );
  assert.notEqual(status, 0);
});

test('prints the stamped versions in the summary', () => {
  assert.match(job('image'), /      versions: \$\{\{ steps\.stamp\.outputs\.versions \}\}\n/u);
  const summary = step('Summary');
  assert.match(summary, /VERSIONS: \$\{\{ needs\.image\.outputs\.versions \}\}/u);
  assert.match(summary, /Stamped versions:/u);
});


test('requires QA from the Studio checkout, with no separate source pin or build-time installer', () => {
  const guard = step('Require the in-repository testing package');
  assert.doesNotMatch(guard, /if:|continue-on-error/u);
  assert.match(guard, /packages\/app-plugin-testing\/package\.json/u);
  assert.match(guard, /testing\.private !== true/u);
  assert.ok(workflow.indexOf(guard) > workflow.indexOf(step('Revoke the source token', { in: job('image') })));
  assert.ok(workflow.indexOf(guard) < workflow.indexOf(step('Install dependencies')));
  assert.doesNotMatch(workflow, /qa_plugin_sha|studio-qa-checkout|qa-source|assembly: image|--no-frozen-lockfile/u);
});
