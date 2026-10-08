import assert from 'node:assert/strict';
import test from 'node:test';

import { mirrorWorkspace } from '../mirror-workspace.mjs';

const application = `# Studio is the workspace root.
packages:
  - .
  - vendor/nocobase3/packages/*/*

verifyDepsBeforeRun: false

catalog:
  react: ^18.0.0
`;

const framework = `packages:
  - packages/*/*
  - docs

verifyDepsBeforeRun: false

catalog:
  react: ^19.0.0
  zod: ^4.0.0

allowBuilds:
  esbuild: true
`;

test('keeps the application packages and takes everything after them from the framework', () => {
  assert.equal(
    mirrorWorkspace(application, framework),
    `# Studio is the workspace root.
packages:
  - .
  - vendor/nocobase3/packages/*/*

verifyDepsBeforeRun: false

catalog:
  react: ^19.0.0
  zod: ^4.0.0

allowBuilds:
  esbuild: true
`,
  );
});

test('changes nothing when the two already agree', () => {
  const mirrored = mirrorWorkspace(application, framework);
  assert.equal(mirrorWorkspace(mirrored, framework), mirrored);
});

test('refuses a workspace without a packages list', () => {
  assert.throws(() => mirrorWorkspace('catalog: {}\n', framework), /application workspace has no top-level packages/u);
  assert.throws(() => mirrorWorkspace(application, 'catalog: {}\n'), /framework workspace has no top-level packages/u);
});
