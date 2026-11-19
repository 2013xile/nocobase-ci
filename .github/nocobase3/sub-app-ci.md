# Multi-tenant child CI (pending rollout)

This is a child-only integration for private `nocobase/multi-tenant-sub-app`.
It does not change Studio, Pro, platform or other repository workflows, shared pool
health, deployment infrastructure, timeout policy or organization budget.

## Contract and readiness

- Quality: `multi-tenant-sub-quality.yml`, run prefix `multi-tenant-sub-quality`,
  source/annotation directory `sub-app`, main PRs and pushes.
- Quality targets: only `chenos/nocobase-ci` and `cgyrock/nocobase-ci`;
  initial placement, rerequests and refused-dispatch reroutes fail closed outside them.
  Existing requests remain bound to their saved target/client for polling/cancel.
- Preview: `multi-tenant-sub-preview.yml` in `2013xile/nocobase-ci` only.
  Independent lane, `multi-tenant-sub-app-pr-<number>`, environment `preview`.
- Five quality Checks: Lint, Typecheck, Node tests, Client tests, Build; Preview
  is a separate sixth Check. Check App is `nocobase` (`979192`).
- Node 24, manifest-selected pnpm, frozen install, enabled postinstall and existing
  app-cli patch. Internal package checks are not optional; root tests reject no tests.
- Child source endpoint: `/api/ci/multi-tenant-sub-source-token`, audience
  `nocobase-bot`, contents-read only for the child repository. It requires the exact
  child quality workflow on main, a real active request and actual run/job/attempt.
  Platform/Studio grants cannot mint child source, or vice versa.
- Source tokens are revoked before source code executes; cleanup handles failures
  and cancellation. No arbitrary repository/path/workflow is accepted.
- Fixed CI alone references `MULTI_TENANT_SUB_APP_NB_STUDIO_API_KEY`; never reuse,
  overwrite or distribute Studio/platform Keys. Package credentials are temporary
  and mode-restricted. Do not put Studio credentials into either quality copy.

## Preview and artifact safety

The initial gate evaluates one newest Bot quality request of the exact head.
It refuses failed/skipped/incomplete checks and another Check App. PR/head/main/
same-repository/no-preview state is live-read, including after building; a different
quality request after the first gate cannot authorize deployment of the staged build.

Ubuntu installs/builds directly, as the existing platform runner-native workflow.
Trusted helpers come from this CI repository, never from the application checkout.
Do not copy Studio's runtime-change skip logic: pure CI/docs acceptance PRs also
need Preview. Explicit source repository and head SHA reach every Studio report/deploy.

The archive verifier reads complete tar/gzip without extraction, validates source
name/version, tenant protocol, Linux x64/glibc/Node 24 metadata and all three vendored
Portal packages/compiled entries. Links, escapes, special files, duplicate entries
and runtime state are rejected. Quality discards the archive; Preview rebuilds and
stages outside source, then uploads directly. No public Artifact or application cache.

Public CI logs still have exposure risk. Step env is not a filesystem sandbox:
build code and Studio CLI state share runner storage. The user accepted this existing
runner-native boundary; do not claim isolation or add another container architecture.
Cleanup cannot promise execution after a VM is forcibly killed.

## Rollout: do not merge/deploy a half-configured Bot

These PRs are preparatory, not proof of live acceptance. As audited, child workflows
were absent from main, Bot child App permissions were unverified, and each executor's
private-package reads were untested. Child Studio settings still used `agent`, with
no CI Key/reported App or dedicated fixed-CI Secret. Secret metadata or an operator's
clone/push privilege is not installation/package access evidence.

1. Review external workflow/helper PRs, merge by a person, and normally fast-forward
   synchronize only the two approved quality copies. No force push or other pools.
2. Verify source Bot App contents/PR read and Checks write, fixed-CI App contents/PR/
   Checks read, and package reads independently for all three executors.
3. Verify Studio's own Git connection and source commit, then change only child
   resource `398595238920199` Checks source to `host`. Generate its repository-scoped
   CI Key via supported `nb-studio build ci setup`, consuming the one-time secret
   directly in a checked memory pipe to fixed CI's child-only Secret. No plaintext
   files/logs/chat, no rotation of another consumer, no shared connection change.
4. Obtain separate human approval for Bot main merge/deployment (may auto-deploy).
5. Dispatch via a fresh source PR event/Bot request. New workflow definitions are not
   proven by native rerun of an old run. Keep acceptance PR open; no auto-merge.
6. Record source SHA, request UUIDs, workflow commit/target, Check App, actual test
   file/test counts and skips, archive metadata/hash, Studio build/upload request,
   Release, deployment/runtime URL and real authorized browser/API verification.
7. Update/supersede/cancel need real evidence. Close cleanup deletes data and needs
   a separately approved disposable PR. Never close the acceptance PR as a shortcut.

Main's legacy finder-smartlab compatibility, SSO, license/admission, wildcard roles,
business/schema/migrations and shared Preview/timeout/proxy configuration are out of
scope. The historical platform upload 408 has no established child implication or
diagnosed cause. Keep child failures' own build/request/head/time/stage; no repeated
upload guesses or changes to the independent platform debugging work.

## Scoped checks

Bot: affected forwarding, source token, pool and request tests plus TypeScript.
Quality/Preview: child workflow/input/gate/archive fixtures, affected existing platform
contracts and shared helper consumers. Use actionlint for the two new workflows;
shell scripts are syntax checked without executing source or deployment.

Real application quality, Linux archive build, independent package access, source App
capabilities, upload, Release, runtime and destructive cleanup remain unverified until
the approved rollout. Do not represent local fixture tests as those results.
