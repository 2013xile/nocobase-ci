# NocoBase 3 Pro CI relay

`nocobase3-pro-ci.yml` is dispatched by `nocobase-bot` with seven string inputs: `request_id`, `event_name`, `head_sha`, `base_sha`, `target_branch`, `pr_number`, and `skip_label`. Its run name is `pro-ci:<request_id>`, which lets the bot associate the public workflow run with check runs on `nocobase/nocobase3-pro`.

The job names form a bot-facing protocol and must remain exact: `Submodule and catalog`, `Changed files`, `Typecheck`, `Test`, `Build`, `Pro plugins on OSS Default installation smoke test`, `quality`, `Validate and advise`, and `Reject prerelease state`. `Validate and advise` applies only to pull requests targeting `main` or `develop`; `Reject prerelease state` applies only to pull requests targeting `main`.

The workflow checks out only the supplied immutable commits. Quality and main-guard jobs locally merge the fixed base and head and fail on conflicts, while the changeset job checks the fixed pull request head against the fixed base. It never fetches a movable Pro branch for execution.

The existing GitHub App credentials create an installation token restricted to `nocobase/nocobase3-pro` with read-only contents permission. Checkout does not persist credentials, and the token is always revoked before dependency installation or any Pro script runs. The public repository token has read-only contents permission. No package publishing, deployment, or notification secrets are provided to this workflow.

Logs are public by design, but the workflow does not upload source, packages, logs, diagnostic artifacts, or caches. The create-app smoke test publishes only to an ephemeral registry on its isolated runner.

## NocoBase Studio CI relay

`studio-ci.yml` runs the CI of the private `nocobase/studio` repository the same way: `nocobase-bot` dispatches it with the same seven inputs, its run name is `studio-ci:<request_id>`, and it checks out the immutable commits through the shared `checkout` action with `repository: studio`, which limits the read-only token to that repository. Its job names are the check names on `nocobase/studio`: `Submodule pointer`, `Lint`, `Typecheck`, `Test`, `API document` and `CLI reference` for every request, `Studio e2e` and `Preview` for pull requests, and `Dist` for pushes to `main`.

- `Preview` builds the pull request's head (not a merge) and deploys it to the App `studio-pr-<n>` in Studio's `preview` environment, as Studio's standard preview workflow does, naming `--repository nocobase/studio` and `--sha <head_sha>` in every call. It needs the secret `NB_STUDIO_API_KEY` and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the build.
- `Dist` builds the `nb-studio` and `nocobase-runner` tarballs as a check and keeps them as artifacts for three days; both are public. They are not delivered anywhere: `studio-image.yml` builds them into `runners-dist/` before `docker build`, and Studio's `Dockerfile` bakes them into `/app/runners/dist`, which the image serves.
- Nothing is cached, and no source or application build is uploaded. Besides the tarballs, `Studio e2e` uploads its screenshots and Playwright traces only when it fails, kept for three days.

## NocoBase 3 preview relay

`nocobase3-preview.yml` gives pull requests of the public `nocobase/nocobase3` a preview in NocoBase Studio. `nocobase-bot` dispatches it with the same seven inputs for pull requests to `develop` or `main` from branches of the repository itself, never for forks or pushes, and its run name is `nocobase3-preview:<request_id>`. Its two jobs, `Preview` and `Studio preview`, run in parallel and are the only checks it mirrors onto `nocobase/nocobase3`; the repository's own GitHub Actions CI is untouched. `skip_label` carries the `no-preview` label here rather than `release:skip`.

- It checks out the pull request's head (not a merge) through the shared `checkout` action with `repository: nocobase3`, then ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, changesets, Skills, `studio/` or CI files.
- Otherwise it installs with the pnpm version of the repository's `packageManager` on Node.js 24, runs `pnpm build --target linux-x64 --tar` in `packages/templates/app-template-examples`, which builds the workspace packages the template depends on and vendors them into `dist/`, and deploys `storage/exports/dist.tar.gz` to the App `nocobase3-pr-<n>` in Studio's `preview` environment, naming `--repository nocobase/nocobase3` and `--sha <head_sha>` in every call. Studio makes the App on first deployment and removes it once the pull request is merged or closed.
- `Studio preview` previews NocoBase Studio on the pull request's framework, under the same gate. It fixes the private `nocobase/studio`'s `main` to one commit with a read-only token limited to that repository and revoked at once, checks that commit out through the shared `checkout` action (as a push to `main`), replaces its `vendor/nocobase3` submodule with the pull request's head, and mirrors the pull request's `pnpm-workspace.yaml` below `packages:` into Studio's (`mirror-workspace.mjs`), as Studio does by hand when its submodule moves. It then installs with `pnpm install --no-frozen-lockfile`, because Studio's lockfile describes the framework it pins, builds Studio with `pnpm build --target linux-x64 --tar` as `studio-ci.yml`'s `Preview` does, and deploys it to the App `nocobase3-studio-pr-<n>`, again naming `--repository nocobase/nocobase3` and the pull request's `--sha`. Neither repository is changed. Studio's `main` follows a pinned framework commit, so a pull request that breaks Studio, or one based on a `develop` Studio has not caught up with, fails this check without failing `Preview`.
- Studio removes both Apps once the pull request is merged or closed: it records each App `app ensure` made as a preview of the pull request whose head was first deployed to it, and removes every preview of that pull request.
- It needs the secret `NB_STUDIO_API_KEY_NOCOBASE3`, the manual CI key of `nocobase/nocobase3` (`nb-studio build ci setup nocobase/nocobase3 --reveal`), and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the install or the build. Nothing is cached or uploaded.

Run the committed contract and Git fixture tests with:

```bash
node --test .github/nocobase3/tests/*.test.mjs
```

Lint the workflows with:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml .github/workflows/nocobase3-preview.yml
```
