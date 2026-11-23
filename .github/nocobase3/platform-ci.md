# Multi-tenant platform Preview

The workflow is `.github/workflows/multi-tenant-platform-preview.yml`. The Bot dispatches only same-repository PRs targeting main. Keep `MULTI_TENANT_PLATFORM_NB_STUDIO_API_KEY` separate from Studio's existing `NB_STUDIO_API_KEY`; `NB_STUDIO_URL`, `NOCOBASE_APP_ID`, `NOCOBASE_APP_PRIVATE_KEY` and read-only `PRO_NPM_TOKEN` are the existing integration inputs. Authorize the App on the new platform source before enabling forwarding.

The trusted gate requires all five pooled checks of the head from the nocobase App (ID 979192), rejects mixed request groups and skipped/failed checks, and times out after 30 minutes. Like Studio, NocoBase 3 and Customer Portal Preview, application installation/build runs directly on the GitHub-hosted Ubuntu runner: Node.js 24, the pnpm declared in the source package manifest, a frozen dependency install and a Linux x64 Node.js 24 archive build. The archive is staged outside the application directory, with escape links rejected, then deployed directly to Studio. No GitHub artifact/cache contains private application code.

Deployment API keys are supplied only to the steps calling Studio, not to the install/build step environment. Package configuration is removed after the build, and final cleanup removes the temporary CLI state and staged archive. As in the existing runner-native workflows, application scripts and CLI state share the runner filesystem; step-scoped environment values are not a filesystem sandbox.

The successful quality Build is deliberately rebuilt here rather than transferred publicly. The job has a 55-minute overall timeout and a 20-minute archive-build step limit. Queueing or checks exceeding the gate deadline fail closed; resolve the cause and rerun. No shared Studio environment, nested Host/SSO configuration or child application is modified.

After the runner build, a fresh one-minute gate rechecks that the PR still permits Preview at the same head and that current quality checks pass. Its source-read token is revoked before ensuring or deploying the App.

## Rollout and credentials

The quality maintenance source is `chenos/nocobase-ci/main`; only its eligible platform copy `cgyrock/nocobase-ci` needs the authorized fast-forward, with SHA/tree equality verified. Preview remains fixed to `2013xile/nocobase-ci/main`. Merge/synchronize the reviewed workflow/helper changes with approval, confirm package access, and confirm the existing nocobase GitHub App can read both the platform and `nocobase3-pro`. Quality additionally needs the Bot's new fixed two-repository contents-read grant; Preview uses its separate Pro-only App token. Missing installation access requires a maintainer to add Pro, not a PAT, broader permissions or another pool. Keep the already-configured platform Studio CI key unchanged; this migration requires no new or rotated Secret.

Merge/deploy the Bot grant with separate approval: a Bot main push can automatically deploy the shared Bot. Studio Checks source stays host; source Checks, dispatch protocol and the quality-request identity used by the fresh pre-deploy gate stay unchanged. Do not recreate the removed source-local CI workflow. After rollout, run the normal source Check flow against the latest reviewed application head. A green local regression suite is not evidence that the actual App token can read Pro, that application tests passed, or that Preview deployed.

Platform checkout disables recursive submodule handling. It accepts exactly one of: no submodule (older published-package applications), the legacy `vendor/nocobase3` OSS gitlink, or `vendor/nocobase3-pro` with exactly one inner `vendor/nocobase3` OSS gitlink. Each committed `.gitmodules` must be a regular 100644 blob containing only the exact path, URL and branch entries. URLs are fixed to `https://github.com/nocobase/nocobase3-pro.git` (`develop`) and `https://github.com/nocobase/nocobase.git` (`v3`); branches prove history reachability, never select checkout revisions. Each recorded SHA is fetched at depth one and checked out detached. The Pro inner layout is validated before materializing its files. Additional gitlinks/config entries, mismatched heads, redirects, alternate URLs, symlinks and unsafe destination paths fail closed. No `--remote`, version synchronization or recursive update is used; leaf OSS submodules are not initialized. Logs/summary record only application SHA, Pro SHA, OSS SHA and layout.

After the application token is revoked, `--inspect` validates the root committed layout without a network request. Only a Pro layout creates a separate token, explicitly limited to `nocobase3-pro` and `contents: read`, using the existing App configuration. The trusted helper sends its process-local header only to the fixed Pro URL; it never persists credentials, follows redirects or gives them to the public OSS fetch. An always-run step revokes the Pro token before pnpm/setup/install, including checkout failures. Legacy heads do not mint a Pro token. Other users of shared `checkout/action.yml` keep their existing behavior.

## Verification

```bash
node --test .github/nocobase3/tests/platform-framework.test.mjs .github/nocobase3/tests/platform-pro-framework.test.mjs .github/nocobase3/tests/platform-preview*.test.mjs .github/nocobase3/tests/stage-platform-archive.test.mjs .github/nocobase3/tests/validate-inputs.test.mjs .github/nocobase3/tests/prepare-snapshot.test.mjs
actionlint .github/workflows/multi-tenant-platform-preview.yml
```

After deploying the Bot, verify actual PR checks, failure reporting, cancellation, Preview usability and close cleanup. Static tests alone do not establish those results. The source repository's docs/ci.md records full child Host/SSO acceptance as separate work.

CI runner logs are public and may contain file paths, test data or source excerpts in error diagnostics. Artifact/cache isolation is not confidentiality of logs. Use synthetic data, never production configuration, and review this exposure before rollout.
