import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSubAppInputs } from '../validate-sub-app-inputs.mjs';
const input = {repository:'multi-tenant-sub-app', checkoutPath:'sub-app', targetBranch:'main',
  requestId:'00000000-0000-4000-8000-000000000001', eventName:'pull_request',
  headSha:'b'.repeat(40), baseSha:'a'.repeat(40), prNumber:'17', skipLabel:'false', submodules:'false'};
test('accepts only the fixed child identity and safe dispatch arguments', () => {
  assert.doesNotThrow(() => validateSubAppInputs(input));
  assert.doesNotThrow(() => validateSubAppInputs({...input, eventName:'push', prNumber:'0'}));
  for(const bad of [{repository:'multi-tenant-platform-app'}, {repository:'studio'}, {checkoutPath:'../escape'},
    {checkoutPath:'platform'}, {targetBranch:'dev'}, {headSha:'$(echo injected)'}, {prNumber:'17; exit 0'},
    {requestId:'not-a-uuid'}, {skipLabel:'yes'}, {baseSha:'0'.repeat(40)}, {submodules:'$(pwd)'}])
    assert.throws(() => validateSubAppInputs({...input,...bad}), undefined, JSON.stringify(bad));
});
