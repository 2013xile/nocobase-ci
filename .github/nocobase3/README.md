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

`studio-image.yml` builds Studio's internal image from the private `nocobase/studio` at a `ref` and pushes it to the internal registry for linux/amd64 and linux/arm64. Studio includes the private testing package at `packages/app-plugin-testing` in the same source checkout, dependency manifest and lockfile. The workflow requires that private workspace package before installing dependencies and fails if it is absent; it does not silently publish an image without QA. There is no second source checkout, plugin revision input, generic SDK package, private overlay or build-time lockfile generation. Each Studio commit records its matching QA implementation.

The existing read-only GitHub App token reads only Studio and is revoked before any source script or dependency installation. The framework remains the public submodule. Frozen installation, Studio/CLI/Runner version stamping, platform builds and registry publication retain their normal flow. Tags remain `dev-<short sha>`, plus `dev` for a dev ref and `main` for main. The bot dispatches ordinary dev/main pushes; manual builds use the same `ref` input. The normal `studio-ci.yml` preview also builds QA from its Studio head checkout without extra repository permissions or inputs.

Image publication does not update the running server. Its deployment owner selects the usual tag/digest through the existing procedure, retaining database, storage and configuration and verifying migrations. Local QA business records and credentials are not copied into an image. The Studio source PR and this CI cleanup must be coordinated: merge the CI cleanup immediately before the Studio source change so a source push uses the new workflow. The package guard prevents an intervening old-source build from replacing the normal image without QA. Neither change deploys production by itself.

## Bot image

`bot-image.yml` builds `nocobase-bot`'s own image from the private `nocobase/nocobase-bot` at a `ref` and pushes it to the internal registry for linux/amd64 only, as `nocobase/nocobase-bot:sha-<short sha>` and, when `ref` is `main`, the moving tag `nocobase/nocobase-bot:main`. A build of any other ref never moves `main`. `nocobase-bot` dispatches it with `ref: main` for every push to `nocobase/nocobase-bot`'s `main`, and a newer push cancels the build in progress; run it by hand for any other ref with `gh workflow run bot-image.yml -R 2013xile/nocobase-ci -f ref=<ref>`. It is not a forwarded CI row: it creates no check and has no `request_id`.

- The existing read-only GitHub App token reads only `nocobase/nocobase-bot` and is revoked before the build. The GitHub App must be installed on `nocobase/nocobase-bot`.
- `provenance: false` and `sbom: false` must stay: buildx attaches attestations by default and the registry rejects them (`unknown manifest class for application/vnd.oci.empty.v1+json`).
- It uses the existing registry secrets `ALI_DOCKER_REGISTRY`, `ALI_DOCKER_USERNAME` and `ALI_DOCKER_PASSWORD`. Nothing deploys the image: on the server, `docker compose pull && docker compose up -d`.

## Website v3 documentation

`website-v3-docs.yml` builds the documentation site of the private `nocobase/website-v3` (`doc/`), and can publish it to the documentation CDN. `nocobase-bot` dispatches it with the seven forwarded inputs for every pull request from a branch of the repository and every push to `main`, never for a fork's pull request; its run name is `website-v3-docs:<request_id>`, it is not in the CI repository pool, and the job named `Docs build` is the check name on `nocobase/website-v3`. Every request builds, whatever it changes, and `skip_label` is ignored.

- `Docs build` checks out the commit (not a merge) through the shared `checkout` action with `repository: website-v3` into `website`, with a token that reads that repository only and is revoked inside the action, then runs, on Node.js 24, `npm ci --prefix doc --ignore-scripts` and `node doc/build.mjs` at the repository root, and checks that `doc/dist/index.html`, `doc/dist/zh-CN/index.html`, `doc/dist/404.html` and `doc/dist/sitemap.xml` exist. It has no secret besides the App key, which is revoked before the site's code runs, and uploads `doc/dist` as the artifact `website-v3-docs` (kept 7 days; public, like the rest of this repository's artifacts). Nothing is cached. The site's origin is `DOCS_SITE_ORIGIN`, which CI leaves at its default.
- Publishing is off. `Docs publish` is skipped unless the repository variable `WEBSITE_V3_DOCS_PUBLISH` is `true`, and then only for a push to `main`. To turn it on: set the variable, fill the secrets and the variable below, and add `Docs publish` to the push checks of the `website-v3` row in `nocobase-bot` (`WEBSITE_V3_DOCS_CHECK_NAMES` and its `expectedChecks`, plus `docs/ci-forwarding.md` there) so that it is reported on `nocobase/website-v3` too; until then it shows only on the run's Actions page. Setting the variable alone publishes without a check.
- `Docs publish` needs `Docs build`, checks first that the push is still the head of `main` (with a read-only App token, revoked right after; an older push skips the rest so it cannot switch the CDN back over a newer one), then downloads the artifact, builds nothing and checks out no site code, uploads it to a timestamp directory of the bucket (ossutil 2.2.2; the timestamp is Asia/Shanghai time), puts `404.html` at the bucket root, and runs `docs-publish/deploy-cdn.mjs`, which points the five back-to-origin rules of every domain in `V3_DOCS_ALI_CDN_DOMAINS` (whitespace or commas) at that directory, refreshes each domain's cache, and only then removes the versions older than the previous one, once. A bucket serving several domains therefore never loses a directory one of them still points at. The script is a copy of `docs/scripts/deploy-cdn.mjs` of `nocobase/nocobase` on `v3-develop`, with `npm ci` pinning `@alicloud/cdn20180510`, `@alicloud/openapi-client` and `ali-oss` to the versions of that repository's lockfile. Only the `Publish` step has the keys, and it runs this repository's script.
- Secrets and variables: `V3_DOCS_ALI_OSS_BUCKET`, `V3_DOCS_ALI_OSS_REGION` (the console's value; each tool normalizes the `oss-` prefix), the variable `V3_DOCS_ALI_CDN_DOMAINS`, the existing `DOCS_ALI_OSS_ACCESS_KEY_ID` and `DOCS_ALI_OSS_ACCESS_KEY_SECRET`, the variable `WEBSITE_V3_DOCS_PUBLISH`, and the App's `NOCOBASE_APP_ID` and `NOCOBASE_APP_PRIVATE_KEY`, which must be installed on `nocobase/website-v3`.

## NocoBase 3 preview

`nocobase3-preview.yml` gives NocoBase 3 pull requests in `nocobase/nocobase` a preview of the examples template. `nocobase-bot` dispatches it with the seven forwarded inputs plus `source_repository: nocobase`, its only accepted value, and its run name is `nocobase3-preview:<request_id>`. A pull request belongs to v3 when its direct `target_branch` is `v3-develop`, `v3-main`, or a single-level stacked branch named `<type>/v3-<name>`, where both segments are non-empty; the exact recognition pattern is `^[^/]+/v3-[^/]+$`. Classification uses only that target, never the head branch, its ancestry, or a separately resolved branch, and the bot forwards the original `head_sha` and `base_sha`. The bot forwards every pull request to a v3 target from a branch of the repository itself, never forks or pushes. The workflow limits deployed previews to head branches named `agent/PM-<number>`. The bot mirrors its one job, `Preview`, onto `nocobase/nocobase`; the repository's own GitHub Actions CI is untouched. `skip_label` carries the `no-preview` label here rather than `release:skip`.

- It checks out the pull request's head (not a merge) through the shared `checkout` action with `repository: nocobase` and `partial-history: 'true'`: the head alone at depth one, then the commits and trees behind the head and base SHAs without blobs (about 30 MB), never the repository's other branches, tags or v2 history. It ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, changesets, Skills, `packages/apps/` or CI files.
- Otherwise it installs with the pnpm version of the repository's `packageManager` on Node.js 24, runs `pnpm build --target linux-x64 --tar` in `packages/templates/app-template-examples`, and deploys `storage/exports/dist.tar.gz` to the App `nocobase-v3-pr-<n>` in Studio's `preview` environment, naming `--repository nocobase/nocobase` and `--sha <head_sha>` in every call.
- Studio removes the App once the pull request is merged or closed: it records each App `app ensure` made as a preview of the pull request whose head was first deployed to it, and removes every preview of that pull request.
- It needs the secret `NB_STUDIO_API_KEY_NOCOBASE_V3`, the manual CI key of `nocobase/nocobase` in Studio (`nb-studio build ci setup nocobase/nocobase --reveal`), and the variable `NB_STUDIO_URL`; the key is given only to the steps that call Studio, never to the install or the build. Nothing is cached or uploaded.

NocoBase Studio itself is no longer in `nocobase/nocobase`, so this workflow has no Studio jobs; they are `studio-ci.yml`'s, on `nocobase/studio`.

The archived `nocobase/nocobase3` is no longer previewed; its Apps and its `NB_STUDIO_API_KEY_NOCOBASE3` secret were removed. `validate-inputs.mjs` still accepts `nocobase3` as a checkout source because older Pro commits' `vendor/nocobase3` submodule points there.

## CustomerPortal preview

`customerportal-ci.yml` gives pull requests of the private `nocobase/CustomerPortal` a preview, replacing the workflow Studio generated in that repository (`nb-studio-customerportal-preview.yml`). `nocobase-bot` dispatches it with the seven forwarded inputs, `skip_label` carrying the `no-preview` label, for every pull request from a branch of the repository whatever its target, never a fork's or a push; its run name is `customerportal-ci:<request_id>` and its one job, `Preview`, is the check name on `nocobase/CustomerPortal`.

- It checks out the pull request's head (not a merge) through the shared `checkout` action with `repository: CustomerPortal` into `customerportal`, with a read-only token limited to that repository. It ends without telling Studio anything when the pull request has the `no-preview` label (from `skip_label` or read again from the pull request) or changes only documentation, tests, e2e or CI files.
- Otherwise it installs with the pnpm of the repository's `packageManager` on Node.js 24, runs `pnpm build --target linux-x64 --tar` at the repository root, and deploys `storage/exports/dist.tar.gz` to the App `customerportal-pr-<n>` in Studio's `preview` environment, naming `--repository nocobase/CustomerPortal` and `--sha <head_sha>` in every call. Studio removes the App once the pull request is merged or closed.
- It needs the secret `CUSTOMERPORTAL_NB_STUDIO_API_KEY` and the variable `NB_STUDIO_URL`. The key is the CI key Studio keeps for `nocobase/CustomerPortal`, which may name only that repository (`REPOSITORY_MISMATCH` otherwise), revealed once with `nb-studio build ci setup nocobase/CustomerPortal --reveal --json | jq -er .result.data.secret | gh secret set CUSTOMERPORTAL_NB_STUDIO_API_KEY -R 2013xile/nocobase-ci`; Studio then no longer rotates it, so rotate it the same way before it expires. The key is given only to the steps that call Studio, never to the install or the build. Nothing is cached or uploaded.

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
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false .github/workflows/nocobase3-pro-ci.yml .github/workflows/studio-ci.yml .github/workflows/nocobase3-preview.yml .github/workflows/customerportal-ci.yml .github/workflows/studio-image.yml .github/workflows/bot-image.yml .github/workflows/website-v3-docs.yml
```


### Testing source ownership

The testing capability is now maintained inside the private Studio repository. Use normal Studio pull request previews and image builds. Historical isolated QA preview Apps and their fixed two-repository builds remain historical evidence; they are not the ongoing delivery path. The standalone private plugin repository is not a build dependency.
