# Sigma agent rules

## Versioning
- SemVer. While below 1.0: every new feature bumps minor; every visible fix or UI tweak bumps patch. Docs-only, tests-only and internal refactors need no bump.
- Bump once per merged change: `npm run version:bump -- minor|patch`. This keeps `package.json`, `package-lock.json`, `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock` in sync.
- Check agreement with `node scripts/bump-version.mjs` (exit 1 if files differ).
- The DMG name follows the version: `release/Sigma_<version>_aarch64.dmg`. Never hardcode the version elsewhere.

## Docs
- Keep `README.md` (English) and `README.uk.md` (Ukrainian) in sync.
