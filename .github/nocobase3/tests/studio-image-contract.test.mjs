import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/studio-image.yml'), 'utf8');

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `step ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, next);
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

// Runs the tag step in a throwaway repository whose Studio manifest has `version`.
function nameTags({ version }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-image-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(path.join(dir, 'packages/apps/studio'), { recursive: true });
    if (version !== undefined) {
      writeFileSync(path.join(dir, 'packages/apps/studio/package.json'), JSON.stringify({ name: '@nocobase/studio', version }));
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'fixture');
    const sha = git('rev-parse', '--short=7', 'HEAD').toString().trim();
    const output = path.join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', script('Name the tags')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        REGISTRY: 'registry.example.com',
        REF: 'v3-develop',
        GITHUB_OUTPUT: output,
      },
    });
    const text = readFileSync(output, 'utf8');
    const tags = text.includes('tags<<EOF\n') ? text.split('tags<<EOF\n')[1].split('\nEOF')[0].split('\n') : [];
    return { status: result.status, stdout: result.stdout, sha, tags };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const image = 'registry.example.com/nocobase/studio';

// Runs the stamp step against manifests at `versions` and returns what it wrote and reported.
function stampVersions(versions) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-stamp-'));
  const manifests = {
    '@nocobase/studio': 'packages/apps/studio',
    '@nocobase/studio-cli': 'packages/tools/studio-cli',
    '@nocobase/agent-runner': 'packages/app/agent-runner',
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
      env: { ...process.env, GITHUB_OUTPUT: output },
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

test('tags an internal image dev-<short sha> and dev', () => {
  const { status, sha, tags } = nameTags({ version: '1.0.0-beta.52' });
  assert.equal(status, 0);
  assert.deepEqual(tags, [`${image}:dev-${sha}`, `${image}:dev`]);
});

test("lets Studio's own build pack the universal packages into the prebuilt dist", () => {
  // `pnpm build` packs nb-studio and the runner into dist/runners; nothing builds or copies them separately.
  assert.doesNotMatch(workflow, /cli build|runners-dist/u);
  assert.match(step('Build dist for linux-x64'), /run: pnpm build --target linux-x64\n/u);
  assert.match(step('Build and push'), /build-args: DIST=prebuilt\n/u);
});

test('pushes the image and lists the tags in the summary', () => {
  const push = step('Build and push');
  assert.doesNotMatch(push, /if:/u);
  assert.match(push, /build-args: DIST=prebuilt\n/u);
  assert.match(push, /tags: \$\{\{ steps\.tags\.outputs\.tags \}\}\n/u);
  assert.match(step('Summary'), /TAGS: \$\{\{ steps\.tags\.outputs\.tags \}\}/u);
  assert.match(step('Summary'), /GITHUB_STEP_SUMMARY/u);
});

test('stamps dev versions on Studio, nb-studio and the runner before anything is built', () => {
  const stamp = step('Stamp dev versions');
  assert.doesNotMatch(stamp, /        if:/u);
  const at = workflow.indexOf(stamp);
  assert.ok(at > workflow.indexOf(step('Install dependencies')));
  for (const name of ['Build the workspace packages Studio depends on', 'Build dist for linux-x64']) {
    assert.ok(at < workflow.indexOf(step(name)), name);
  }
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
  const match = /^1\.0\.0-beta\.51\.dev\.(\d{14})$/u.exec(studio);
  assert.ok(match, studio);
  assert.equal(cli, `0.1.0-beta.2.dev.${match[1]}`);
  assert.equal(runner, `0.1.0-dev.${match[1]}`);
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

test('prints the stamped versions in the summary', () => {
  const summary = step('Summary');
  assert.match(summary, /VERSIONS: \$\{\{ steps\.stamp\.outputs\.versions \}\}/u);
  assert.match(summary, /Stamped versions:/u);
});
