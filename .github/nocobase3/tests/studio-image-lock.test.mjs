import assert from 'node:assert/strict';
import test from 'node:test';
import { addWorkspaceLock, verifyLockAddition } from '../prepare-studio-image.mjs';

const before = `lockfileVersion: '9.0'

catalogs:
  default:
    react:
      version: 19.2.8

importers:
  .:
    dependencies:
      hono:
        specifier: 'catalog:'
        version: 4.13.2

  packages/studio-cli:
    dependencies:
      yaml:
        specifier: 'catalog:'
        version: 2.9.0

packages:
  react@19.2.8:
    resolution: {integrity: existing}

snapshots:
  react@19.2.8: {}
`;
const rootEntry = `      '@nocobase/app-plugin-testing':
        specifier: workspace:*
        version: link:packages/app-plugin-testing
`;
const pluginImporter = `  packages/app-plugin-testing:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.2.8

`;
const after = before.replace('      hono:', rootEntry + '      hono:').replace('  packages/studio-cli:', pluginImporter + '  packages/studio-cli:');

test('allows only QA root registration and its workspace importer against the current base', () => {
  verifyLockAddition(before, after);
  // An independently advanced Studio lockfile is allowed; no old profile checksum pins it.
  verifyLockAddition(before.replaceAll('19.2.8', '19.3.0'), after.replaceAll('19.2.8', '19.3.0'));
});

test('refuses changes to existing Studio resolutions, catalogs, imports or snapshots', () => {
  for (const [from, to] of [
    ['version: 4.13.2', 'version: 4.14.0'],
    ['version: 2.9.0', 'version: 3.0.0'],
    ['resolution: {integrity: existing}', 'resolution: {integrity: changed}'],
    ['react@19.2.8: {}', 'react@19.2.8: {newPeer: true}'],
  ]) {
    assert.throws(() => verifyLockAddition(before, after.replace(from, to)), /existing Studio dependencies/u);
  }
});

test('refuses omitted, malformed or duplicate QA registrations instead of silently shipping without QA', () => {
  assert.throws(() => verifyLockAddition(before, before), /Missing or duplicate QA/u);
  assert.throws(() => verifyLockAddition(before, after.replace(rootEntry, '')), /root must link/u);
  assert.throws(() => verifyLockAddition(before, after.replace('link:packages/app-plugin-testing', 'link:other')), /root must link/u);
  assert.throws(() => verifyLockAddition(before, after.replace(rootEntry, rootEntry + rootEntry)), /Duplicate QA/u);
  assert.throws(() => verifyLockAddition(before, after.replace(pluginImporter, pluginImporter + pluginImporter)), /Missing or duplicate QA/u);
});


test('copies only new QA entries and discards unrelated resolver normalization', () => {
  const normalized = after.replace('resolution: {integrity: existing}', 'resolution: {integrity: normalized}').replace('version: 2.9.0', 'version: 3.0.0');
  const result = addWorkspaceLock(before, normalized);
  verifyLockAddition(before, result);
  assert.match(result, /integrity: existing/u);
  assert.match(result, /version: 2\.9\.0/u);
  assert.doesNotMatch(result, /integrity: normalized|version: 3\.0\.0/u);
  assert.throws(() => addWorkspaceLock(before, before), /Missing or duplicate resolved QA/u);
});
