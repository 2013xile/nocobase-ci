# Internal Studio EE images

`studio-image.yml` requires a Studio source revision containing the edition build entry (nocobase/studio#476). It builds only `studio-ee` for amd64/arm64 and publishes `nocobase/studio-ee` in the existing `ALI_DOCKER_REGISTRY`. The `dev`, `main` and `dev-<SHA>` tag rules are unchanged. `--dev-stamp` is passed to Studio's isolated build so Studio, nb-studio and the runner share the same timestamp without mutating the outer checkout.

Coordinate activation with the Studio source merge. The registry must allow the new `nocobase/studio-ee` repository. After a verified image is available, update the internal deployment's image reference separately; this workflow does not edit compose files or deploy a running service. Formal ordinary/EE releases remain in `nocobase/nocobase`'s `v3-studio-release.yml`.

Local check: `node --test .github/nocobase3/tests/studio-image-contract.test.mjs` and `actionlint .github/workflows/studio-image.yml`. Real two-platform builds and registry publication still need verification after the branches are reviewed.
