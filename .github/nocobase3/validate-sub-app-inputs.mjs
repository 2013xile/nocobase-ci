import { validateInputs, InputValidationError } from './validate-inputs.mjs';
import { pathToFileURL } from 'node:url';

export function validateSubAppInputs(input) {
  if (input.repository !== 'multi-tenant-sub-app' || input.checkoutPath !== 'sub-app' || input.targetBranch !== 'main')
    throw new InputValidationError('Only multi-tenant-sub-app in sub-app targeting main is permitted.');
  if (input.submodules !== undefined && input.submodules !== 'false')
    throw new InputValidationError('Child workflows do not fetch submodules.');
  validateInputs({ ...input, repository: undefined });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateSubAppInputs({
      repository: process.env.REPOSITORY, checkoutPath: process.env.CHECKOUT_PATH,
      requestId: process.env.REQUEST_ID, eventName: process.env.EVENT_NAME,
      headSha: process.env.HEAD_SHA, baseSha: process.env.BASE_SHA,
      targetBranch: process.env.TARGET_BRANCH, prNumber: process.env.PR_NUMBER,
      skipLabel: process.env.SKIP_LABEL, submodules: process.env.SUBMODULES,
    });
  } catch (error) {
    console.error(`::error::Invalid child dispatch: ${error.message}`);
    process.exitCode = 1;
  }
}
