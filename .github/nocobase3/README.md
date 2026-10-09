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

`nocobase3-preview.yml` accepts the same seven fields plus optional `source_repository`, a repository name under `nocobase` that defaults to `nocobase3`. Existing callers continue to work without adding the field. The new value `nocobase` selects v3 pull requests in the main repository. Its run name stays `nocobase3-preview:<request_id>` and its two check names stay `Preview` and `Studio preview`; the bot must mirror them onto the selected source repository. `skip_label` carries `no-preview` here rather than `release:skip`.

| `source_repository` | PR targets | Preview App | Studio preview App | Studio key secret |
| --- | --- | --- | --- | --- |
| `nocobase3` (default) | Existing bot targets; custom targets remain accepted | `nocobase3-pr-<n>` | `nocobase3-studio-pr-<n>` | `NB_STUDIO_API_KEY_NOCOBASE3` |
| `nocobase` | `v3-develop`, `v3-main` | `nocobase-v3-pr-<n>` | `nocobase-v3-studio-pr-<n>` | `NB_STUDIO_API_KEY_NOCOBASE3` (reused at cutover) |

Only the newly added `nocobase` source restricts targets to `v3-develop/v3-main`. Existing sources retain their input validation and custom-target behavior. The relay continues to build the supplied immutable commits without adding a live-PR state or SHA comparison. The bot retains responsibility for its same-repository PR forwarding policy and version-line routing; this change does not alter that policy. Push events do not create previews.

- It checks out the selected repository's pull request head (not a merge) through the shared `checkout` action into the directory `nocobase3`, then ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, changesets, Skills, `studio/` or CI files.
- Otherwise it installs with the pnpm version of the repository's `packageManager` on Node.js 24, builds the Examples deployment archive, and deploys it to the source-specific App above. Every Studio call names the selected full repository and dispatched head SHA. Source-specific App prefixes prevent collisions between equal PR numbers in the old and new repositories.
- `Studio preview` fixes private `nocobase/studio`'s `main` to one commit, checks it out with a read-only token, replaces `vendor/nocobase3` with the selected OSS PR head, and mirrors the framework workspace configuration. It builds Studio with `pnpm install --no-frozen-lockfile` and `pnpm build --target linux-x64 --tar`, then deploys to the source-specific Studio App. Neither source repository is modified. Framework incompatibilities with Studio fail this check independently of `Preview`.
- Studio removes both Apps once the pull request is merged or closed: it records each App `app ensure` made as a preview of the pull request whose head was first deployed to it, and removes every preview of that pull request.
- Both sources read the existing `NB_STUDIO_API_KEY_NOCOBASE3` secret. Until migration, it remains bound to the old Studio repository record. At cutover, edit that existing working directory through Studio's repository picker to select `nocobase/nocobase`, retaining the record and key binding; do not create a separate record or regenerate the key. Retire old-repository previews before switching this binding: a repository CI key is not a credential for two separate repository records at once. The key is given only to Studio-calling steps, never directly to dependency installation or compilation. Nothing is cached or uploaded; checkout tokens are revoked before source commands run.

## Existing workflow behavior

The v1/v2 image, plugin publishing and auto-merge workflows are unchanged. No new preflight job or branch allowlist is added to them, and custom image-build targets retain their existing behavior. The new OSS source is opt-in; existing preview callers continue using the old repository, App IDs and Studio key.

The bot must route new main-repository v3 PRs to the v3 relay using their actual base branch and repository. These compatibility changes do not modify the bot or stop it from dispatching a wrong legacy workflow. No branch-prefix restriction is imposed on contributors' source branches.

### Release tags are not branch targets

Keep v3 aggregate tags in `release-beta/*` and `release/*`, and package tags in `@nocobase/<package>@<version>`. They do not match the existing legacy `v*` triggers. None of the workflows here subscribes to tag pushes. The bot must keep tag events separate from branch dispatches; no additional tag or branch guards are introduced into the existing v1/v2 workflows here.

The main repository's `release.yml` and `changelog-and-release.yml` tag triggers live outside this repository. Tag-push workflows are read from the tagged commit, not indiscriminately from the default branch. When migrating the main repository, keep those workflows out of the independent v3 code tree, retain disjoint tag names, and add a v2-lineage guard to both automatic and manual legacy release entry points before any publishing token or job: the selected tag must resolve to a commit reachable from an approved legacy release branch. A version number alone cannot identify the code line, because the legacy history already has `v3.0.0-alpha.*` tags. These shared-CI changes do not implement or replace that source-repository guard.

## Cutover dependencies outside this repository

1. Deploy this CI branch to the shared repository's default branch before sending the new input. Update callers that pin an older action or workflow revision.
2. In `nocobase-bot`, route `nocobase/nocobase` PRs targeting `v3-develop/v3-main` to `nocobase3-preview.yml` with `source_repository: nocobase`, and mirror its checks onto that repository. Preserve v2 routing and legacy `nocobase3` requests. Do not forward forks.
3. Authorize the GitHub App on the main repository for contents and PR reads. No Studio key or secret change is required before migration. At cutover, retire the old previews and edit the existing Studio working directory to select the main repository and `v3-develop`, preserving its key binding and the `NB_STUDIO_API_KEY_NOCOBASE3` secret. Repository registration and PR-close cleanup must support the new App prefixes. Verify a new-repository preview after the switch.
4. Move the framework git history first, then update Pro/Studio `.gitmodules` and gitlinks in their own repositories. Shared checkout follows committed submodule metadata; it does not silently redirect URLs or move pointers. Pro's local sync scripts must learn the new upstream branch names separately. Studio's source-owned pointer check currently describes `main/develop`; adapt its messages and branch recognition there when moving its upstream. Studio itself keeps `main`, including its Dist trigger.
5. Keep commercial registry configuration and the runner-local installation smoke registry in place. OSS public npm publication and private package distribution remain separate changes, and Hub publishing is not introduced here.

No bot code, source-repository settings, Studio authorization, source submodule metadata or public registry settings are changed by these CI files alone.

Run the committed contract and Git fixture tests with:

```bash
node --test .github/nocobase3/tests/*.test.mjs
```

Lint the workflows with:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml .github/workflows/nocobase3-preview.yml
```
