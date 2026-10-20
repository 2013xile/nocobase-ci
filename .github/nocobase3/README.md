# NocoBase 3 CI relays

## Pro CI relay

`nocobase3-pro-ci.yml` is dispatched by `nocobase-bot` with seven string inputs: `request_id`, `event_name`, `head_sha`, `base_sha`, `target_branch`, `pr_number`, and `skip_label`. Its run name is `pro-ci:<request_id>`, which lets the bot associate the public workflow run with check runs on `nocobase/nocobase3-pro`.

The job names form a bot-facing protocol and must remain exact: `Submodule and catalog`, `Changed files`, `Typecheck`, `Test`, `Build`, `Pro plugins on OSS Default installation smoke test`, `Pro DB integration`, `quality`, `Validate and advise`, and `Reject prerelease state`. `Validate and advise` applies only to pull requests targeting `main` or `develop`; `Reject prerelease state` applies only to pull requests targeting `main`.

`Pro DB integration` summarizes the commercial database drivers' integration suites, which run in the parallel matrix jobs `Pro DB integration (kingbase)`, `Pro DB integration (dameng)` and `Pro DB integration (oceanbase)`; the bot treats every job whose name starts with `Pro DB integration (` as part of that check, including a skipped matrix whose name keeps the unexpanded expression. `Select Pro DB integration` runs them for every push, and for a pull request only when it changes a path under `packages/libs/db-`, the `vendor/nocobase3` pointer, or a root dependency manifest (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`), or when the base commit or the changed-file list is unavailable. When nothing selects them, the matrix is skipped and `Pro DB integration` passes. `quality` requires `Pro DB integration` to pass.

`check-framework-pointer.mjs` adds support for the framework's new upstream without replacing existing Pro checks. Until the submodule remote changes to `nocobase/nocobase`, it delegates to the source-owned `scripts/pin-submodule.mjs --check`, preserving the original mapping of `main` to `main` and every other target to `develop`. With the new upstream, those map to `v3-main` and `v3-develop`; the check retains the existing gitlink ancestry and non-empty-branch requirements. Pro itself keeps its existing branch names and job conditions. This does not move the pointer, rewrite `.gitmodules`, add a custom-target restriction, or change commercial registry configuration.

The workflow checks out only the supplied immutable commits. Quality and main-guard jobs locally merge the fixed base and head and fail on conflicts, while the changeset job checks the fixed pull request head against the fixed base. It never fetches a movable Pro branch for execution.

The existing GitHub App credentials create an installation token restricted to `nocobase/nocobase3-pro` with read-only contents permission. Checkout does not persist credentials, and the token is always revoked before dependency installation or any Pro script runs. The public repository token has read-only contents permission. No package publishing, deployment, or notification secrets are provided to this workflow.

Logs are public by design, but the workflow does not upload source, packages, logs, diagnostic artifacts, or caches. The create-app smoke test publishes only to an ephemeral registry on its isolated runner.

## NocoBase Studio CI relay

`studio-ci.yml` runs the checks of the private `nocobase/studio` repository that need this repository's secrets: `nocobase-bot` dispatches it with the same seven inputs plus `head_ref`, the pull request's head branch (empty for a push), its run name is `studio-ci:<request_id>`, and it checks out the immutable commits, with the `vendor/nocobase3` submodule, through the shared `checkout` action with `repository: studio`, which limits the read-only token to that repository. Studio is the repository's workspace root, the framework is the submodule (`nocobase/nocobase` on `v3-develop`), and nb-studio's brand package is `packages/studio-cli`. Studio's long-lived branches mirror the public repository's: `dev` tracks `v3-develop` and `main` tracks `v3-main`; pull requests normally target `dev`. Every job installs the whole workspace with the pnpm of Studio's `packageManager` and runs Studio's own scripts. Its job names are the check names on `nocobase/studio`:

- Pull requests: `Preview` builds the pull request's head (not a merge) and deploys it to the App `studio-pr-<n>` in Studio's `preview` environment, as Studio's standard preview workflow does, naming `--repository nocobase/studio` and `--sha <head_sha>` in every call. It needs the secret `NB_STUDIO_API_KEY` and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the build. A change that spans the framework and Studio is two pull requests with the same head branch name, such as `agent/PM-42` in both repositories; the preview runs the `studio-framework` action after the checkout: while `nocobase/nocobase` has a branch named like the head branch with an open pull request, or none at all, it checks that branch out in `vendor/nocobase3` (fetched from the public repository without a credential), mirrors its `pnpm-workspace.yaml` below `packages:` into Studio's (`mirror-workspace.mjs`) and installs with `--no-frozen-lockfile`; otherwise, including once the framework pull request has merged or was closed without merging, it keeps the committed pointer and the frozen lockfile. The job summary says which. Long-lived names (`main`, `dev`, `develop`, `next`, `v3-develop`, `v3-main`) are never paired.
- Pushes to `dev` and `main`: `Dist` builds the per-platform `nb-studio` and `nocobase-runner` tarballs as a check and keeps them as artifacts for three days; both are public. They are not delivered anywhere.
- Nothing is cached, and no source or application build is uploaded.

Studio's other checks, `Submodule pointer`, `Lint`, `Typecheck`, `Test`, `API document`, `CLI reference` and `Studio e2e`, need no secret and run in `studio-quality.yml` of the CI repository pool (`chenos/nocobase-ci` and its copies), which checks Studio out with a read-only token `nocobase-bot` hands each job for its OIDC token. That repository carries copies of `validate-inputs.mjs`, `prepare-snapshot.mjs`, `mirror-workspace.mjs`, `studio-framework` and `studio-framework-gate`; change both together.

## NocoBase Studio image

`studio-image.yml` builds Studio's internal image from the private `nocobase/studio` at a `ref` (any branch, tag or commit). Every normal image includes the QA plugin pinned in `.github/nocobase3/studio-qa-image.json`; bot dispatches need no additional parameter. A plugin update changes that reviewed immutable revision, rather than following a moving private branch. The optional `qa_plugin_sha` input overrides that pin explicitly; leaving it empty does not omit QA.

The workflow resolves the current Studio ref and the plugin revision once for both architectures. Through `studio-qa-checkout` with `assembly: image`, it checks out both sources without persisted credentials using a temporary contents-read GitHub App token, revokes the token, verifies the private source content hash and applies the plugin's normal installer. It never substitutes the old Studio commit in the isolated preview profile. The installer refuses overwriting unmanaged host changes or migration history.

After pnpm and Node are configured, `prepare-studio-image.mjs` resolves the QA workspace importer with scripts disabled and copies only that importer and its root dependency link onto the original lockfile. pnpm may normalize unrelated transitive peers while resolving; those unrelated changes are discarded. A byte comparison proves every existing Studio dependency resolution remains unchanged. Frozen offline lock validation and the normal frozen dependency install must pass before compilation. An unavailable or incompatible plugin fails the build: there is no fallback that silently publishes an image without QA. Helpers and private source remain outside the Studio Docker context.

Studio's, CLI's and Runner's versions are stamped as before; Studio's own build packs its CLI/Runner and the image carries them. Both linux/amd64 and linux/arm64 are built and published through the existing internal registry. Existing `dev-<short Studio SHA>`, `dev` and `main` tags keep their original meaning, and all contain QA. An additional `qa-<full Studio SHA>-p<full plugin SHA>` tag identifies the exact two-source combination. Branch dispatch concurrency and ordinary deployment entry points are unchanged.

`nocobase-bot` dispatches a build for every push to Studio's dev/main branches. Manual builds use the same default plugin path:

```bash
gh workflow run studio-image.yml -R 2013xile/nocobase-ci -f ref=dev
```

Publishing the image does not update a running server. The deployment owner continues selecting the normal branch tag/digest through the existing deployment procedure, preserving configuration, database and storage. Plugin migrations ship in the image; local business records, test scripts, accounts and credentials are not copied. Database backups and migration verification follow the normal deployment policy. Removing the plugin from Studio remains a deliberate installer unregister/dependency-removal operation; an ordinary rebuild no longer removes it by accident.

## NocoBase 3 preview

`nocobase3-preview.yml` gives NocoBase 3 pull requests in `nocobase/nocobase` a preview of the examples template. `nocobase-bot` dispatches it with the seven forwarded inputs plus `source_repository: nocobase`, its only accepted value, and its run name is `nocobase3-preview:<request_id>`. A pull request belongs to v3 when its direct `target_branch` is `v3-develop`, `v3-main`, or a single-level stacked branch named `<type>/v3-<name>`, where both segments are non-empty; the exact recognition pattern is `^[^/]+/v3-[^/]+$`. Classification uses only that target, never the head branch, its ancestry, or a separately resolved branch, and the bot forwards the original `head_sha` and `base_sha`. The bot forwards every pull request to a v3 target from a branch of the repository itself, never forks or pushes. The workflow limits deployed previews to head branches named `agent/PM-<number>`. The bot mirrors its one job, `Preview`, onto `nocobase/nocobase`; the repository's own GitHub Actions CI is untouched. `skip_label` carries the `no-preview` label here rather than `release:skip`.

- It checks out the pull request's head (not a merge) through the shared `checkout` action with `repository: nocobase` and `partial-history: 'true'`: the head alone at depth one, then the commits and trees behind the head and base SHAs without blobs (about 30 MB), never the repository's other branches, tags or v2 history. It ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, changesets, Skills, `packages/apps/` or CI files.
- Otherwise it installs with the pnpm version of the repository's `packageManager` on Node.js 24, runs `pnpm build --target linux-x64 --tar` in `packages/templates/app-template-examples`, and deploys `storage/exports/dist.tar.gz` to the App `nocobase-v3-pr-<n>` in Studio's `preview` environment, naming `--repository nocobase/nocobase` and `--sha <head_sha>` in every call.
- Studio removes the App once the pull request is merged or closed: it records each App `app ensure` made as a preview of the pull request whose head was first deployed to it, and removes every preview of that pull request.
- It needs the secret `NB_STUDIO_API_KEY_NOCOBASE_V3`, the manual CI key of `nocobase/nocobase` in Studio (`nb-studio build ci setup nocobase/nocobase --reveal`), and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the install or the build. Nothing is cached or uploaded.

NocoBase Studio itself is no longer in `nocobase/nocobase`, so this workflow has no Studio jobs; they are `studio-ci.yml`'s, on `nocobase/studio`.

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
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml .github/workflows/nocobase3-preview.yml .github/workflows/studio-image.yml
```


### Opt-in private QA preview

The existing `studio-ci.yml` has one optional string input, `qa_plugin_sha`, empty by default. Forwarded Studio jobs keep the existing Preview/Dist names, dispatch fields and ordinary behavior. Only an explicit manual Preview dispatch with a full private plugin commit selects the QA path; `head_sha` must be the exact Studio revision recorded by that commit's `release/studio-preview.json`. There is no moving plugin branch, matching framework branch, production image build or default QA registration.

That path uses `studio-qa-checkout`: validate both full lowercase SHAs, mint a contents-read installation token restricted to `nocobase/studio` and `nocobase/studio-plugin-testing`, check out both without persisted credentials, revoke the token even on failure, then run the private profile's check/apply before the normal frozen dependency install and archive build. The existing GitHub App must be installed on both repositories; shared organization membership alone does not grant access. The profile fails closed if the Studio commit, source hash, base lock or resulting lock differs. It changes only the ephemeral build checkout.

The built archive goes through the existing `nb-studio` CLI and CI key to a new App `studio-qa-preview-<run-id>` in `preview`; retries reuse that run's App. It neither changes an ordinary `studio-pr-<n>` App nor updates production. A protected environment still requires its native deployment approval. No private source, application archive or cache is uploaded as a public Actions artifact. Clean up the preview App through Studio after testing.

Example (use the current full SHAs from the private plugin's profile and merged commit):

```bash
gh workflow run studio-ci.yml -R 2013xile/nocobase-ci --ref <reviewed-ci-branch> \
  -f request_id=<new-uuid> -f event_name=pull_request \
  -f head_sha=<profile-studio-sha> -f base_sha=<profile-studio-sha> \
  -f target_branch=dev -f pr_number=0 -f skip_label=false \
  -f qa_plugin_sha=<fixed-private-plugin-sha>
```

`pr_number=0` here is just the legacy required dispatch field: the opt-in path performs no PR label lookup or shared forwarded-checkout validation. Ordinary forwarded pull requests continue to require their actual PR number. An empty `qa_plugin_sha` never enters this path. Workflow dispatch runs the reviewed branch before merge; it does not require changing the default branch or merging a CI PR first. A successful preview is evidence for that fixed two-repository profile, not a production release or a completed historical-data migration.


### Default private QA image delivery

Production image delivery is described above under NocoBase Studio image. It uses the current Studio revision and the reviewed QA revision by default. The manual isolated preview profile below/above remains an exact two-repository snapshot for reproducible preview validation, and is not used to pin future production builds to an old Studio commit.
