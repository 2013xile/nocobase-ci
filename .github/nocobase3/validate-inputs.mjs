import process from 'node:process';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ZERO_SHA = '0'.repeat(40);

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputValidationError';
  }
}

function reject(message) {
  throw new InputValidationError(message);
}

export function validateInputs(input) {
  if (!UUID_PATTERN.test(input.requestId)) reject('request_id must be a UUID.');
  if (!['pull_request', 'push'].includes(input.eventName)) {
    reject('event_name must be pull_request or push.');
  }
  if (!SHA_PATTERN.test(input.headSha) || input.headSha === ZERO_SHA) {
    reject('head_sha must be a non-zero, 40-character commit SHA.');
  }
  if (!SHA_PATTERN.test(input.baseSha)) {
    reject('base_sha must be a 40-character commit SHA.');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(input.targetBranch) ||
    input.targetBranch.includes('..') ||
    input.targetBranch.includes('//') ||
    input.targetBranch.includes('@{') ||
    input.targetBranch.endsWith('/') ||
    input.targetBranch.endsWith('.') ||
    input.targetBranch.endsWith('.lock')
  ) {
    reject('target_branch must be a safe Git branch name.');
  }
  if (!['true', 'false'].includes(input.skipLabel)) {
    reject('skip_label must be true or false.');
  }

  if (input.eventName === 'pull_request') {
    if (input.baseSha === ZERO_SHA) reject('a pull request cannot use a zero base_sha.');
    if (!/^[1-9][0-9]*$/u.test(input.prNumber)) {
      reject('pr_number must be a positive integer for a pull request.');
    }
  } else {
    if (input.prNumber !== '0') reject('pr_number must be 0 for a push.');
    if (input.skipLabel !== 'false') reject('skip_label must be false for a push.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    validateInputs({
      requestId: process.env.REQUEST_ID ?? '',
      eventName: process.env.EVENT_NAME ?? '',
      headSha: process.env.HEAD_SHA ?? '',
      baseSha: process.env.BASE_SHA ?? '',
      targetBranch: process.env.TARGET_BRANCH ?? '',
      prNumber: process.env.PR_NUMBER ?? '',
      skipLabel: process.env.SKIP_LABEL ?? '',
    });
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    console.error(`::error::Invalid Pro CI dispatch: ${error.message}`);
    process.exitCode = 1;
  }
}
