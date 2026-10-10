# NocoBase 3 CI relays

## Pro CI relay

`nocobase3-pro-ci.yml` is dispatched by `nocobase-bot` with seven string inputs: `request_id`, `event_name`, `head_sha`, `base_sha`, `target_branch`, `pr_number`, and `skip_label`. Its run name is `pro-ci:<request_id>`, which lets the bot associate the public workflow run with check runs on `nocobase/nocobase3-pro`.

The job names form a bot-facing protocol and must remain exact: `Submodule and catalog`, `Changed files`, `Typecheck`, `Test`, `Build`, `Pro plugins on OSS Default installation smoke test`, `quality`, `Validate and advise`, and `Reject prerelease state`. `Validate and advise` applies only to pull requests targeting `main` or `develop`; `Reject prerelease state` applies only to pull requests targeting `main`.

`check-framework-pointer.mjs` adds support for the framework's new upstream without replacing existing Pro checks. Until the submodule remote changes to `nocobase/nocobase`, it delegates to the source-owned `scripts/pin-submodule.mjs --check`, preserving the original mapping of `main` to `main` and every other target to `develop`. With the new upstream, those map to `v3-main` and `v3-develop`; the check retains the existing gitlink ancestry and non-empty-branch requirements. Pro itself keeps its existing branch names and job conditions. This does not move the pointer, rewrite `.gitmodules`, add a custom-target restriction, or change commercial registry configuration.

The workflow checks out only the supplied immutable commits. Quality and main-guard jobs locally merge the fixed base and head and fail on conflicts, while the changeset job checks the fixed pull request head against the fixed base. It never fetches a movable Pro branch for execution.

The existing GitHub App credentials create an installation token restricted to `nocobase/nocobase3-pro` with read-only contents permission. Checkout does not persist credentials, and the token is always revoked before dependency installation or any Pro script runs. The public repository token has read-only contents permission. No package publishing, deployment, or notification secrets are provided to this workflow.

Logs are public by design, but the workflow does not upload source, packages, logs, diagnostic artifacts, or caches. The create-app smoke test publishes only to an ephemeral registry on its isolated runner.

## NocoBase Studio CI relay

`studio-ci.yml` runs the CI of the private `nocobase/studio` repository the same way: `nocobase-bot` dispatches it with the same seven inputs, its run name is `studio-ci:<request_id>`, and it checks out the immutable commits through the shared `checkout` action with `repository: studio`, which limits the read-only token to that repository. Its job names are the check names on `nocobase/studio`: `Submodule pointer`, `Lint`, `Typecheck`, `Test`, `API document` and `CLI reference` for every request, `Studio e2e` and `Preview` for pull requests, and `Dist` for pushes to `main`.

- `Preview` builds the pull request's head (not a merge) and deploys it to the App `studio-pr-<n>` in Studio's `preview` environment, as Studio's standard preview workflow does, naming `--repository nocobase/studio` and `--sha <head_sha>` in every call. It needs the secret `NB_STUDIO_API_KEY` and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the build.
- `Dist` builds the `nb-studio` and `nocobase-runner` tarballs as a check and keeps them as artifacts for three days; both are public. They are not delivered anywhere: `studio-image.yml` builds them into `runners-dist/` before `docker build`, and Studio's `Dockerfile` bakes them into `/app/runners/dist`, which the image serves.
- Nothing is cached, and no source or application build is uploaded. Besides the tarballs, `Studio e2e` uploads its screenshots and Playwright traces only when it fails, kept for three days.

## NocoBase 3 preview relay

`nocobase3-preview.yml` gives NocoBase 3 pull requests in `nocobase/nocobase` a preview in NocoBase Studio. `nocobase-bot` dispatches it with the seven forwarded inputs plus `source_repository: nocobase`, its only accepted value, and its run name is `nocobase3-preview:<request_id>`. A pull request belongs to v3 when its direct `target_branch` is `v3-develop`, `v3-main`, or a single-level stacked branch named `<type>/v3-<name>`, where both segments are non-empty; the exact recognition pattern is `^[^/]+/v3-[^/]+$`. Classification uses only that target, never the head branch, its ancestry, or a separately resolved branch, and the bot forwards the original `head_sha` and `base_sha`. Preview eligibility remains limited to head branches named `agent/PM-<number>` in the repository itself, never forks, pushes or human branches. The bot mirrors only `Preview` and `Studio preview` onto `nocobase/nocobase`; the repository's own GitHub Actions CI is untouched. `skip_label` carries the `no-preview` label here rather than `release:skip`.

- It checks out the pull request's head (not a merge) through the shared `checkout` action with `repository: nocobase` and `partial-history: 'true'`: the head alone at depth one, then the commits and trees behind the head and base SHAs without blobs (about 30 MB), never the repository's other branches, tags or v2 history. It ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, changesets, Skills, `studio/` or CI files.
- Otherwise it installs with the pnpm version of the repository's `packageManager` on Node.js 24, runs `pnpm build --target linux-x64 --tar` in `packages/templates/app-template-examples`, and deploys `storage/exports/dist.tar.gz` to the App `nocobase-v3-pr-<n>` in Studio's `preview` environment, naming `--repository nocobase/nocobase` and `--sha <head_sha>` in every call.
- `Studio preview` fixes private `nocobase/studio`'s `main` to one commit with a read-only token revoked at once, checks it out, replaces its `vendor/nocobase3` submodule with the pull request's head, and mirrors the pull request's `pnpm-workspace.yaml` below `packages:` into Studio's (`mirror-workspace.mjs`). It installs with `pnpm install --no-frozen-lockfile`, builds with `pnpm build --target linux-x64 --tar`, and deploys to the App `nocobase-v3-studio-pr-<n>`. Neither repository is changed. A pull request that breaks Studio, or is based on a `v3-develop` Studio has not caught up with, fails this check without failing `Preview`.
- Studio removes both Apps once the pull request is merged or closed: it records each App `app ensure` made as a preview of the pull request whose head was first deployed to it, and removes every preview of that pull request.
- It needs the secret `NB_STUDIO_API_KEY_NOCOBASE_V3`, the manual CI key of `nocobase/nocobase` in Studio (`nb-studio build ci setup nocobase/nocobase --reveal`), and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the install or the build. Nothing is cached or uploaded.

The archived `nocobase/nocobase3` is no longer previewed; its Apps and its `NB_STUDIO_API_KEY_NOCOBASE3` secret were removed. `validate-inputs.mjs` still accepts `nocobase3` as a checkout source because older Pro commits' `vendor/nocobase3` submodule points there.

## Existing workflow behavior

The v1/v2 image, plugin publishing and auto-merge workflows are unchanged. No new preflight job or branch allowlist is added to them, and custom image-build targets retain their existing behavior.

### Release tags are not branch targets

Keep v3 aggregate tags in `release-beta/*` and `release/*`, and package tags in `@nocobase/<package>@<version>`. They do not match the existing legacy `v*` triggers. None of the workflows here subscribes to tag pushes. The bot must keep tag events separate from branch dispatches; no additional tag or branch guards are introduced into the existing v1/v2 workflows here.

The main repository's `release.yml` and `changelog-and-release.yml` tag triggers live outside this repository. Tag-push workflows are read from the tagged commit, not indiscriminately from the default branch. When migrating the main repository, keep those workflows out of the independent v3 code tree, retain disjoint tag names, and add a v2-lineage guard to both automatic and manual legacy release entry points before any publishing token or job: the selected tag must resolve to a commit reachable from an approved legacy release branch. A version number alone cannot identify the code line, because the legacy history already has `v3.0.0-alpha.*` tags. These shared-CI changes do not implement or replace that source-repository guard.

## Moving Pro's framework submodule

Pro's `vendor/nocobase3` now points at `nocobase/nocobase` and its gitlink is on `v3-develop`. `check-framework-pointer.mjs` maps `main` to `v3-main` and every other target to `v3-develop`, and Pro's own `scripts/pin-submodule.mjs` uses the same branch names. The archived `nocobase/nocobase3` URL is still handled by delegating to that script, for older Pro commits. The shared `checkout` action still initializes the submodule from the whole of `nocobase/nocobase`, v2 history included (about 390 MB); giving it a shallow or partial fetch is a separate follow-up, because `check-framework-pointer.mjs` needs the tracked branch's ancestry.

Run the committed contract and Git fixture tests with:

```bash
node --test .github/nocobase3/tests/*.test.mjs
```

Lint the workflows with:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml .github/workflows/nocobase3-preview.yml
```
