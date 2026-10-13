# Sigma agent rules

These rules apply to every agent and person working on Sigma.

## Git
- Every commit uses the author `Dmytro Renkas <25162167+drenkas@users.noreply.github.com>`. Never commit with a work or personal email. If the local git config does not set it, set it before committing.
- `main` was squashed into a single "Sigma 0.8.0" commit and force-pushed on 2026-10-08. Always branch from the current `origin/main`; never push a branch or worktree based on the history from before that.

## Versioning
- Every feature or user-visible change bumps the app version in that same change. SemVer; while below 1.0, a new feature bumps minor and a visible fix or UI tweak bumps patch. Docs-only, tests-only and internal refactors need no bump.
- Bump once per merged change: `npm run version:bump -- minor|patch`. This keeps `package.json`, `package-lock.json`, `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock` in sync, so the DMG name and the version shown in the app match. If anything else ever carries the version, keep it in sync too.
- Check agreement with `node scripts/bump-version.mjs` (exit 1 if files differ).
- The DMG name follows the version: `release/Sigma_<version>_aarch64.dmg`. Never hardcode the version elsewhere.

## Releases
Every merge into `main` that brings a new version is followed right away, as part of the same task, by a GitHub Release of that version on `drenkas/Sigma`, so the in-app update button sees it. A merge that does not change the version has nothing to release.

1. Build from the current `origin/main` in a clean worktree (not from a local checkout with uncommitted or unpushed changes):
   ```sh
   git fetch origin && git worktree add ../sigma-release origin/main && cd ../sigma-release
   npm ci
   npm run desktop:build      # signed Sigma.app + release/Sigma_<v>_aarch64.dmg
   SIGMA_RELEASE_NOTES="..." npm run release:prepare   # release/Sigma_<v>_aarch64.app.tar.gz (+ .sig) and release/latest.json
   ```
   `release:prepare` signs the update archive with the updater key at `~/.tauri/sigma-updater.key` (override with `TAURI_SIGNING_PRIVATE_KEY_PATH`; never commit it) and uploads nothing.
2. Publish the release, tag `v<version>`, title `Sigma <version>`, marked Latest, with exactly these three assets:
   ```sh
   gh release create v<version> --repo drenkas/Sigma --target <origin/main sha> --title "Sigma <version>" --notes "..." --latest \
     release/Sigma_<version>_aarch64.dmg release/Sigma_<version>_aarch64.app.tar.gz release/latest.json
   ```
3. Check that the updater endpoint serves the new version and the archive downloads:
   ```sh
   curl -sL https://github.com/drenkas/Sigma/releases/latest/download/latest.json | jq -r .version
   curl -sIL "$(curl -sL https://github.com/drenkas/Sigma/releases/latest/download/latest.json | jq -r '.platforms["darwin-aarch64"].url')" | grep -i '^HTTP'
   ```

## Docs
- Keep `README.md` (English) and `README.uk.md` (Ukrainian) in sync.
