# Multi-tenant platform Preview

The workflow is `.github/workflows/multi-tenant-platform-preview.yml`. The Bot dispatches only same-repository PRs targeting main. Keep `MULTI_TENANT_PLATFORM_NB_STUDIO_API_KEY` separate from Studio's existing `NB_STUDIO_API_KEY`; `NB_STUDIO_URL`, `NOCOBASE_APP_ID`, `NOCOBASE_APP_PRIVATE_KEY` and read-only `PRO_NPM_TOKEN` are the existing integration inputs. Authorize the App on the new platform source before enabling forwarding.

The trusted gate requires all five pooled checks of the head from the nocobase App (ID 979192), rejects mixed request groups and skipped/failed checks, and times out after 30 minutes. Like Studio, NocoBase 3 and Customer Portal Preview, application installation/build runs directly on the GitHub-hosted Ubuntu runner: Node.js 24, the pnpm declared in the source package manifest, a frozen dependency install and a Linux x64 Node.js 24 archive build. The archive is staged outside the application directory, with escape links rejected, then deployed directly to Studio. No GitHub artifact/cache contains private application code.

Deployment API keys are supplied only to the steps calling Studio, not to the install/build step environment. Package configuration is removed after the build, and final cleanup removes the temporary CLI state and staged archive. As in the existing runner-native workflows, application scripts and CLI state share the runner filesystem; step-scoped environment values are not a filesystem sandbox.

The successful quality Build is deliberately rebuilt here rather than transferred publicly. The job has a 55-minute overall timeout and a 20-minute archive-build step limit. Queueing or checks exceeding the gate deadline fail closed; resolve the cause and rerun. No shared Studio environment, nested Host/SSO configuration or child application is modified.

After the runner build, a fresh one-minute gate rechecks that the PR still permits Preview at the same head and that current quality checks pass. Its source-read token is revoked before ensuring or deploying the App.

## Rollout and credentials

Merge both external workflow PRs and synchronize the quality workflow/helpers to every active pool copy first. Confirm package credentials in those copies and the nocobase GitHub App installation on the new source. Obtain or rotate the platform's repository CI key through the supported Studio CLI; pipe the one-time secret directly to GitHub without logs or files. Rotation invalidates the previous value, so coordinate consumers and expiry. Never overwrite Studio's existing key.

The platform PR must remove its superseded local workflow to prevent double deployment. Merge/deploy the Bot registration last, with separate approval: a Bot main push can automatically deploy the shared Bot. Studio Checks source stays host. Only after real external acceptance should obsolete source-repository Secrets be removed.

## Verification

```bash
node --test .github/nocobase3/tests/platform-preview*.test.mjs .github/nocobase3/tests/stage-platform-archive.test.mjs .github/nocobase3/tests/validate-inputs.test.mjs .github/nocobase3/tests/prepare-snapshot.test.mjs
actionlint .github/workflows/multi-tenant-platform-preview.yml
```

After deploying the Bot, verify actual PR checks, failure reporting, cancellation, Preview usability and close cleanup. Static tests alone do not establish those results. The source repository's docs/ci.md records full child Host/SSO acceptance as separate work.

CI runner logs are public and may contain file paths, test data or source excerpts in error diagnostics. Artifact/cache isolation is not confidentiality of logs. Use synthetic data, never production configuration, and review this exposure before rollout.
