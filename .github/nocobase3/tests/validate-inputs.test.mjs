import assert from 'node:assert/strict';
import test from 'node:test';

import { InputValidationError, validateInputs } from '../validate-inputs.mjs';

const validPullRequest = {
  requestId: '123e4567-e89b-12d3-a456-426614174000',
  eventName: 'pull_request',
  headSha: 'A'.repeat(40),
  baseSha: 'b'.repeat(40),
  targetBranch: 'release/v3.0',
  prNumber: '42',
  skipLabel: 'true',
};

function rejects(overrides, message) {
  assert.throws(
    () => validateInputs({ ...validPullRequest, ...overrides }),
    (error) => error instanceof InputValidationError && error.message === message,
  );
}

test('accepts fixed pull request and first-push payloads', () => {
  assert.doesNotThrow(() => validateInputs(validPullRequest));
  assert.doesNotThrow(() =>
    validateInputs({
      ...validPullRequest,
      eventName: 'push',
      baseSha: '0'.repeat(40),
      targetBranch: 'main',
      prNumber: '0',
      skipLabel: 'false',
    }),
  );
});

test('rejects malformed identity and commit fields', () => {
  rejects({ requestId: 'not-a-uuid' }, 'request_id must be a UUID.');
  rejects({ eventName: 'workflow_dispatch' }, 'event_name must be pull_request or push.');
  rejects({ headSha: '0'.repeat(40) }, 'head_sha must be a non-zero, 40-character commit SHA.');
  rejects({ headSha: 'abc' }, 'head_sha must be a non-zero, 40-character commit SHA.');
  rejects({ baseSha: 'xyz' }, 'base_sha must be a 40-character commit SHA.');
});

test('rejects unsafe target branches', () => {
  for (const targetBranch of ['develop;echo-injected', 'release/../main', '/main', 'main/', 'main.lock']) {
    rejects({ targetBranch }, 'target_branch must be a safe Git branch name.');
  }
});

test('enforces event-specific base, pull request number, and label fields', () => {
  rejects({ baseSha: '0'.repeat(40) }, 'a pull request cannot use a zero base_sha.');
  rejects({ prNumber: '0' }, 'pr_number must be a positive integer for a pull request.');
  rejects({ skipLabel: 'yes' }, 'skip_label must be true or false.');
  rejects(
    { eventName: 'push', prNumber: '9', skipLabel: 'false' },
    'pr_number must be 0 for a push.',
  );
  rejects(
    { eventName: 'push', prNumber: '0', skipLabel: 'true' },
    'skip_label must be false for a push.',
  );
});

test('accepts only the forwarded source repositories and a plain checkout path', () => {
  assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository: 'studio', checkoutPath: 'studio' }));
  assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository: 'nocobase3-pro', checkoutPath: 'pro' }));
  assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository: 'nocobase3', targetBranch: 'develop', checkoutPath: 'nocobase3' }));
  assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository: 'nocobase', targetBranch: 'v3-develop', checkoutPath: 'nocobase3' }));
  rejects({ repository: 'studio,nocobase3-pro' }, 'repository must be one of nocobase3-pro, studio, nocobase3, nocobase.');
  rejects({ repository: 'other/nocobase' }, 'repository must be one of nocobase3-pro, studio, nocobase3, nocobase.');
  rejects({ checkoutPath: '../outside' }, 'path must be a single lowercase directory name.');
  rejects({ checkoutPath: '' }, 'path must be a single lowercase directory name.');
});

test('recognizes main and single-level stacked v3 targets in the main repository', () => {
  for (const targetBranch of ['v3-develop', 'v3-main', 'feat/v3-projects', 'fix/v3-stacked-pr-routing']) {
    assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository: 'nocobase', targetBranch }));
  }

  for (const targetBranch of [
    'main',
    'next',
    'develop',
    'feature/example',
    'v3/fix-example',
    'feature/v3-',
    'feature/v3-example/child',
  ]) {
    rejects(
      { repository: 'nocobase', targetBranch },
      'target_branch for nocobase must be one of v3-develop, v3-main or match <type>/v3-<name>.',
    );
  }

  rejects(
    {
      repository: 'nocobase',
      eventName: 'push',
      baseSha: '0'.repeat(40),
      targetBranch: 'feat/v3-projects',
      prNumber: '0',
      skipLabel: 'false',
    },
    'target_branch for nocobase must be one of v3-develop, v3-main or match <type>/v3-<name>.',
  );
});

test('preserves custom target branches for all existing sources', () => {
  for (const repository of ['nocobase3', 'nocobase3-pro', 'studio']) {
    for (const targetBranch of ['main', 'develop', 'release/test', 'feature/example']) {
      assert.doesNotThrow(() => validateInputs({ ...validPullRequest, repository, targetBranch }));
    }
  }
});
