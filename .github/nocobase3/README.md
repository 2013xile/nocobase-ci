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

Run the committed contract and Git fixture tests with:

```bash
node --test .github/nocobase3/tests/*.test.mjs
```

Lint the workflows with:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml
```
