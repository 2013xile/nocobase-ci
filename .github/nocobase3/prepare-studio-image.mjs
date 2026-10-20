import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testing = '@nocobase/app-plugin-testing';
const importer = '  packages/app-plugin-testing:';
const rootEntry = `      '${testing}':\n        specifier: workspace:*\n        version: link:packages/app-plugin-testing\n`;

// Compare the entire lockfile after removing only the two QA workspace additions.
// Existing catalogs, importers, package snapshots and resolutions must remain byte-identical.
function lockSections(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('importers:');
  assert(start >= 0, 'Missing lockfile importers.');
  let end = start + 1;
  while (end < lines.length && !/^\S/u.test(lines[end])) end++;
  return { lines, start, end, body: lines.slice(start + 1, end) };
}

function importerEnd(body, start) {
  let end = start + 1;
  while (end < body.length && !/^  \S/u.test(body[end])) end++;
  return end;
}

export function verifyLockAddition(before, after) {
  assert(!before.includes(rootEntry) && !before.includes(`\n${importer}\n`), 'The source lockfile already includes QA.');
  const { lines, start, end, body } = lockSections(after);
  const qa = body.indexOf(importer);
  assert(qa >= 0 && body.lastIndexOf(importer) === qa, 'Missing or duplicate QA workspace importer.');
  body.splice(qa, importerEnd(body, qa) - qa);
  const root = body.indexOf('  .:');
  assert(root >= 0, 'Missing root workspace importer.');
  const rootText = body.slice(root, importerEnd(body, root)).join('\n') + '\n';
  assert(rootText.includes(rootEntry), 'The root must link the QA workspace dependency.');
  assert.equal(rootText.split(rootEntry).length, 2, 'Duplicate QA root dependency.');
  const remaining = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
  assert(remaining.replace(rootEntry, '') === before, 'QA lock synchronization changed existing Studio dependencies.');
}

export function addWorkspaceLock(before, resolved) {
  const candidate = lockSections(resolved).body;
  const qa = candidate.indexOf(importer);
  assert(qa >= 0 && candidate.lastIndexOf(importer) === qa, 'Missing or duplicate resolved QA importer.');
  const rootCandidate = candidate.indexOf('  .:');
  const rootText = candidate.slice(rootCandidate, importerEnd(candidate, rootCandidate)).join('\n') + '\n';
  assert(rootCandidate >= 0 && rootText.includes(rootEntry), 'Missing resolved QA root dependency.');
  const { lines, start, end, body } = lockSections(before);
  const root = body.indexOf('  .:');
  assert(root >= 0, 'Missing base root importer.');
  const rootEnd = importerEnd(body, root);
  const dependencies = body.indexOf('    dependencies:', root + 1);
  assert(dependencies > root && dependencies < rootEnd, 'Missing base root dependencies.');
  body.splice(rootEnd, 0, ...candidate.slice(qa, importerEnd(candidate, qa)));
  body.splice(dependencies + 1, 0, ...rootEntry.trimEnd().split('\n'));
  const result = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
  verifyLockAddition(before, result);
  return result;
}

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

export function prepare(studio, source, baseFile) {
  assert.equal(git(studio, 'status', '--porcelain'), '', 'Start from a clean Studio checkout.');
  const base = readFileSync(path.join(studio, 'pnpm-lock.yaml'), 'utf8');
  assert(!base.includes(`\n${importer}\n`), 'The source already includes a QA importer.');
  const installer = path.join(source, 'scripts/apply-studio.mjs');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [installer, studio, ...args, '--require-clean'], { encoding: 'utf8' }));
  const check = run('--check');
  const profile = JSON.parse(readFileSync(path.join(source, 'release/studio-preview.json'), 'utf8'));
  assert.equal(check.source.contentHash, profile.sourceContentHash, 'Unexpected private source content.');
  // The installer refuses overwriting unmanaged host changes and immutable migration history.
  // Unlike a one-off preview, a normal image builds the current Studio commit, never a saved profile's old commit.
  writeFileSync(baseFile, base, { mode: 0o600 });
  run();
  run('--verify');
  assert(readFileSync(path.join(studio, 'pnpm-lock.yaml'), 'utf8') === base, 'Source assembly must not rewrite the lockfile.');
  console.log(`Assembled QA ${check.source.head} into Studio ${git(studio, 'rev-parse', 'HEAD')}.`);
}

export function synchronize(studio, baseFile) {
  const before = readFileSync(baseFile, 'utf8');
  assert(readFileSync(path.join(studio, 'pnpm-lock.yaml'), 'utf8') === before, 'The base lockfile changed before synchronization.');
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: studio,
    stdio: 'inherit',
  });
  const file = path.join(studio, 'pnpm-lock.yaml');
  // pnpm can normalize unrelated transitive peers during lock-only resolution. Copy only
  // the newly resolved QA importer and root link back onto the untouched Studio lock.
  // The subsequent frozen install rejects any missing snapshot or incompatible catalog.
  writeFileSync(file, addWorkspaceLock(before, readFileSync(file, 'utf8')));
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--frozen-lockfile', '--offline'], {
    cwd: studio,
    stdio: 'inherit',
  });
  verifyLockAddition(before, readFileSync(file, 'utf8'));
  console.log('QA workspace lock entries added; existing Studio dependency resolutions are unchanged.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, studioPath, sourcePath, basePath, ...extra] = process.argv.slice(2);
  assert(['prepare', 'lock'].includes(mode) && studioPath && sourcePath && basePath && !extra.length,
    'Usage: prepare-studio-image.mjs <prepare|lock> <studio> <private-source> <base-lock>');
  const studio = path.resolve(studioPath), source = path.resolve(sourcePath), base = path.resolve(basePath);
  if (mode === 'prepare') prepare(studio, source, base);
  else synchronize(studio, base);
}
