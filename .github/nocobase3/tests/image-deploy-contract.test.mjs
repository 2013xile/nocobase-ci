import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const action = read('.github/nocobase3/ssh-deploy/action.yml');
const callers = [
  { file: 'bot-image.yml', image: 'bot-image', deploy: 'bot-deploy', prefix: 'BOT_DEPLOY' },
  { file: 'pro-registry-image.yml', image: 'pro-registry-image', deploy: 'pro-registry-deploy', prefix: 'PRO_REGISTRY_DEPLOY' },
  { file: 'verdaccio-image.yml', image: 'verdaccio-image', deploy: 'verdaccio-deploy', prefix: 'VERDACCIO_DEPLOY', branch: 'next' },
].map((caller) => ({ branch: 'main', ...caller, workflow: read(`.github/workflows/${caller.file}`) }));

test('the action sends the sha tag alone over a restricted SSH key, checking the host key', () => {
  assert.doesNotMatch(action, /^\s+environment:/mu);
  assert.match(action, /\^sha-\[0-9a-f\]\{7,40\}\$/u);
  assert.match(action, /-o StrictHostKeyChecking=yes/u);
  assert.match(action, /-o BatchMode=yes/u);
  assert.match(action, /"root@\$\{DEPLOY_HOST\}" "\$TAG"/u);
  assert.match(action, /trap 'rm -rf "\$dir"' EXIT/u);
  assert.doesNotMatch(action, /echo[^\n]*\$\{?SSH_KEY/u);
  assert.match(action, /"\$status" -eq 75/u);
});

for (const { file, image, deploy, prefix, branch, workflow } of callers) {
  test(`${file} cancels an older build of the same ref, never a deployment`, () => {
    assert.doesNotMatch(workflow, /^concurrency:/mu);
    assert.match(workflow, new RegExp(`concurrency:\\n      group: ${image}-\\$\\{\\{ inputs\\.ref \\}\\}\\n      cancel-in-progress: true\\n`, 'u'));
    assert.match(workflow, new RegExp(`concurrency:\\n      group: ${deploy}\\n      cancel-in-progress: false\\n`, 'u'));
  });

  test(`${file} deploys the sha tag of a build of ${branch} alone, with repository-level secrets`, () => {
    assert.match(workflow, new RegExp(`\\n  deploy:\\n(?:    .+\\n)*?    needs: image\\n    if: \\$\\{\\{ inputs\\.ref == '${branch}' && inputs\\.deploy \\}\\}\\n`, 'u'));
    assert.match(workflow, /      deploy:\n(?:        .+\n)*?        default: true\n        type: boolean\n/u);
    assert.match(workflow, /sha: \$\{\{ steps\.resolve\.outputs\.sha \}\}\n/u);
    assert.match(workflow, /uses: \.\/\.github\/nocobase3\/ssh-deploy\n/u);
    assert.match(workflow, /tag: sha-\$\{\{ needs\.image\.outputs\.sha \}\}\n/u);
    assert.match(workflow, new RegExp(`ssh-key: \\$\\{\\{ secrets\\.${prefix}_SSH_KEY \\}\\}\\n`, 'u'));
    assert.match(workflow, new RegExp(`deploy-host: \\$\\{\\{ vars\\.${prefix}_HOST \\}\\}\\n`, 'u'));
    assert.match(workflow, new RegExp(`known-hosts: \\$\\{\\{ vars\\.${prefix}_KNOWN_HOSTS \\}\\}\\n`, 'u'));
    assert.match(workflow, /sparse-checkout: \.github\/nocobase3\n/u);
  });
}
