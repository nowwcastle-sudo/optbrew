# Reviewed distribution replacements

`scripts/vendor.config.json` lists reviewed full-file replacements in `reviewed_patches`. These are not unified diffs. Each entry has `id`, `module_id`, `upstream_path`, `expected_base_sha256`, `replacement_path`, `replacement_sha256`, and `reason`.

The base hash is SHA-256 after the vendorer's built-in transforms and before the replacement. The replacement path is relative to `scripts/vendor.config.json` and must stay under `scripts/patches/`. The vendorer first verifies the pinned upstream Git blob, then verifies the base and replacement hashes. It records the patch identity and reason alongside the unchanged original source hash and the final distribution hash.

CLI regeneration reads this config automatically. The API also accepts `patchSet: { patches: [same entry] }` for focused tests. When an output already exists, regeneration replaces it only if its bytes match the previous source-lock distribution hash. Back up existing files before intentional changes. Do not edit generated module copies independently of a reviewed replacement.

`first_party_files` declares the optbrew-owned `robots.mjs` helper. Its canonical source is `patches/naver-robots.mjs`; the vendorer verifies its SHA-256 and MIT license before copying it to the contained package path. The source-lock marks it `source_kind: first_party` with a null upstream Git blob. Regeneration protects its previous distributed hash against local edits, as for upstream files.

Task 5 updates both reviewed replacements. The Naver replacement disables direct remote requests and exports `auditCollected` for bounded response evidence. The Magnus replacement rejects direct remote URLs and accepts collector HTML on stdin. Regenerate both module copies and source-lock with `node scripts/vendor.mjs` after updating replacement hashes in `scripts/vendor.config.json`.
