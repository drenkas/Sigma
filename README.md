# Sigma

**English** · [Українська](README.uk.md)

A local GUI for the Pi SDK: chat with persistent history, Code in a chosen Git folder or worktree, managed approvals/checks/review, multi-repo tasks, and a Graph of the actual orchestration. Sessions always run in editing mode (the root agent can edit files and delegate to child agents; a lone worker edits the working copy directly, parallel workers are merged automatically under Full access and otherwise after your approval), directly in the chosen folder by default or in a separate worktree; the model and reasoning are chosen in the chat itself. Tool permissions are determined by the session profile.

Product state, open backlog and acceptance criteria: [PLAN.md](PLAN.md). Operational context for the next agent: [HANDOFF.md](HANDOFF.md). Detailed behavior (Git, Code, recovery, permission boundaries): [docs/FEATURES.md](docs/FEATURES.md). History: [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md).

## Table of contents

1. [Two ways to launch](#1-two-ways-to-launch)
2. [Requirements](#2-requirements)
3. [Option A: macOS app from DMG](#3-option-a-macos-app-from-dmg)
4. [Option B: run from source](#4-option-b-run-from-source)
5. [First walkthrough](#5-first-walkthrough)
6. [Connecting providers](#6-connecting-providers)
7. [Building the macOS app from source](#7-building-the-macos-app-from-source)
8. [Checks](#8-checks)
9. [Troubleshooting](#9-troubleshooting)
10. [Browser QA, cleanup, migration](#10-browser-qa-cleanup-migration)
11. [Data and security](#11-data-and-security)

## 1. Two ways to launch

- **Option A: macOS app from DMG.** The simplest path: install `Sigma.app` and double-click it. No terminal needed. The DMG is built locally (there is no public download), see [section 7](#7-building-the-macos-app-from-source).
- **Option B: run from source.** Requires Node.js and npm. The service runs in a terminal, and the UI opens in a browser at `http://127.0.0.1:4318`.

Both options give the same UI. They differ in the data directory and the port (see [section 11](#11-data-and-security)).

## 2. Requirements

| For | What you need | How to check |
|---|---|---|
| Option A | macOS on Apple Silicon (`aarch64` app bundle), macOS 13.5 or newer | Apple menu → About This Mac |
| Option B | Node.js 24.16+ and npm; macOS is needed for the system folder picker | `node -v` |
| Building the app from source | Rust toolchain (`rustc`, `cargo`) and Cargo cache | `cargo --version` |

To build the app, download the Rust dependencies once (network required):

```sh
cargo fetch --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 3. Option A: macOS app from DMG

1. **Find the DMG.** It appears after `npm run desktop:build`:

   ```
   release/Sigma_<version>_aarch64.dmg
   ```

   `<version>` is the version in `package.json`.

   If the file is missing, run the [build](#7-building-the-macos-app-from-source) first.

2. **Open the DMG** by double-clicking it in Finder. A window with `Sigma.app` is expected.

3. **Drag `Sigma.app` to Applications**, then eject the mounted disk.

4. **First launch.** Open Sigma from Applications. If the DMG was built on this same Mac, the app usually opens without warnings.

   The signature is ad-hoc only: there is no Apple Developer ID and no notarization (out of scope by the owner's decision). If the DMG came from another machine (browser, AirDrop, messenger), macOS adds quarantine and may block the launch with a message such as "cannot be opened", "is damaged" or "Apple could not verify". This is expected. You can unblock it in one of these ways (only for a build you trust, i.e. your own):

   - Finder → right-click `Sigma.app` → **Open** → **Open**.
   - After the first blocked attempt: System Settings → Privacy & Security → **Open Anyway**.
   - In Terminal:

     ```sh
     xattr -dr com.apple.quarantine /Applications/Sigma.app
     ```

5. **What happens at startup.** The app starts the bundled Node service itself on a free loopback port and opens a window. You do not need to keep a terminal open. A Sigma window with a sidebar is expected.

6. **Where the data is.** `~/Library/Application Support/dev.sigma.app` (permissions `0700`).

7. **Quit.** Cmd+Q or Sigma → Quit. Graceful shutdown waits for pending saves to finish, so do not kill the process forcibly.

8. **CLIProxyAPI inside the app.** The bundled CLIProxyAPI is present only if it was available when the app was built (see [section 7](#7-building-the-macos-app-from-source)). When present, it is copied into app data on first start, with a check against the pinned sha256, but the app does not run it on its own: the proxy starts only after you click **Connect local proxy** (**Providers → Local model gateways**). Sigma then remembers that choice and starts the proxy on every launch; **Disconnect** stops it and turns autostart off. Installs that already have an Antigravity sign-in keep autostart. State is visible in **Providers**; if the binary is missing, **Providers** shows `not_installed`. Manual steps: Connect and the one-time Antigravity sign-in ([6c](#6c-local-cliproxyapi-antigravity-login)).

Next: [First walkthrough](#5-first-walkthrough).

## 4. Option B: run from source

1. **Go to the project directory.**

   ```sh
   cd Sigma
   ```

2. **Check Node.** Version 24.16 or newer is required.

   ```sh
   node -v
   ```

3. **Install dependencies** (in a fresh copy; install scripts are disabled).

   ```sh
   npm ci --ignore-scripts
   ```

4. **Start.**

   ```sh
   npm start
   ```

   `npm start` first builds the UI (`prestart`: `tsc --noEmit` and `vite build`), then starts the service. This can take up to a minute.

5. **Wait for this line** in the terminal:

   ```
   Sigma API listening on http://127.0.0.1:4318
   ```

6. **Open** [http://127.0.0.1:4318](http://127.0.0.1:4318) in a browser.

7. **Stopping.** Keep the terminal open while you work; Ctrl+C stops the service.

Source-run data lives in `.data/` or in the directory given by `SIGMA_DATA_DIR`.

### If port 4318 is in use

Pick another port and a separate data directory. Do not stop the other process.

```sh
SIGMA_PORT=4330 SIGMA_DATA_DIR="$PWD/.scratch/source-4330/data" npm start
```

A second server with the same canonical `DATA_DIR` is rejected regardless of the port (the lease is taken before recovery). So each concurrent server needs its own data directory. The `SIGMA_*` variables replaced `PI_ORCH_*`; the old names are still read as fallbacks.

### Offline demo without a provider

Useful for checking the UI and protocol without any account.

```sh
PI_OFFLINE=1 \
PI_CODING_AGENT_DIR="$PWD/.scratch/readme-demo/agent" \
SIGMA_DEMO=1 \
SIGMA_PORT=4319 \
SIGMA_DATA_DIR="$PWD/.scratch/readme-demo/data" \
npm start
```

Open `http://127.0.0.1:4319` and pick the model `sigma-demo/offline` in the chat's bottom bar. This is a deterministic local provider; it does not confirm that OpenAI or Claude work. Prompts: `hello`, `read:package.json`, `delegate2: inspect A | inspect B`, `slow task`, `fail-provider`. For Code, additionally: `edit:{"path":"file.txt","edits":[{"oldText":"old","newText":"new"}]}` and `write:{"path":"new.txt","content":"hello"}`. For a new fixture, use new data/agent directories; do not carry these variables over to a live run.

### Development mode

Two separate terminals:

```sh
npm run dev:server
```

```sh
npm run dev:web
```

`dev:web` is Vite on `127.0.0.1:4317`. After changes to server source, restart your own Node process; the production UI needs a reload after a new build.

## 5. First walkthrough

The same for both options.

1. Open **Providers** in the sidebar (the menu is available even without models) and connect a provider ([section 6](#6-connecting-providers)). For a quick check without an account, use the [offline demo](#offline-demo-without-a-provider).
2. Click **New session**.
3. Choose a directory (folder) and, if needed, **Separate Git worktree**.
4. Describe the goal in the box at the bottom, optionally choosing the model and reasoning in its bar, and press Enter (or the send button): the session is created in editing mode (the agent can edit files and delegate to child agents) and the first prompt is sent.
5. Keep chatting. With Full access (the default) tools run without asking and each action is recorded. With Agent access set to ask, every tool operation opens a permission panel above the message box, in the same style as the agent's questions: numbered choices **Allow once** (**Apply this change** for file edits, **Commit** for `git_commit`), **Allow … for this chat** (every agent in the chat then runs that tool without asking; not offered for `git_commit`; undo it with **Ask again** under Changes → Approvals, and a restart asks again) and **Deny**, plus a field to deny and tell the agent what to do instead. Keys 1–3 pick a choice; several waiting requests are shown one at a time.
6. **Stop** interrupts the response.
7. Sessions remain in **Sessions** after a restart.

**Images.** Attach up to 4 images (PNG, JPEG, GIF, WebP) to a message with the paperclip button, by pasting from the clipboard, or by dragging them onto the composer. Large images are downscaled in the browser first (longest side 2000 px, about 3.5 MB). Only models that accept images allow attachments (OpenAI models, the Claude Code CLI models and the unsupervised Antigravity route do; the composer says so when the selected model cannot read images). Images are sent with the prompt and are not stored by Sigma outside the Pi history. Sent images appear as small thumbnails in your message (click one to open it full size); they are read back from the Pi history on demand. The unsupervised Antigravity route receives them as temporary files outside the workspace (AGY opens them with `view_file`), deleted when the turn ends.

**Chats without a project.** Click **+** next to **Chats** in the sidebar (or send from an empty composer with no folder chosen) to start a chat without a project. Sigma creates a fresh scratch folder `~/Documents/Sigma/<YYYY-MM-DD>/<short slug>` (a Git repository with one empty commit, so editing mode works) and runs the session there; the chat is listed under **Chats**. The root can be changed with `SIGMA_SCRATCH_ROOT`.

**Questions with suggested answers.** When the root agent needs your decision before it can go on, it asks through the `ask_user` tool: a panel above the message box shows the question, its suggested answers (with a short description each) and a field for your own answer. Click an option or type your own and press **Answer**; it is sent as your next message and the agent continues. The × hides the panel; you can still reply in the message box. While the question is open, the chat shows as **Waiting** in the sidebar. The question and its options stay in the chat history. Delegated agents do not ask; they report to their parent.

**@-mentions.** Type `@` in the composer to pick project files and folders, skills and tools, grouped under Files, Skills and Tools and filtered as you type (arrow keys to move, Enter or Tab to insert, Esc to close). The reference stays visible in your message as plain text: `@src/app.ts`, `@"my dir/notes.md"` (paths with spaces), `@skill:name` or `@tool:name`. On send, Sigma resolves the references and gives the agent the context: file contents up to 32 KB (larger or binary files are only named so the agent can read them), folder listings, the full text of a skill with its base directory, and a request to use the chosen tool. Paths are resolved inside the session's working folder only, and anything that does not resolve stays plain text. Skills are read from `.claude/skills`, `.agents/skills` and `.pi/skills` in the project, from `~/.claude/skills` and `~/.agents/skills`, and from the Pi agent folder; the chat shows only what you typed.

## 6. Connecting providers

| Provider | How to connect | Notes |
|---|---|---|
| OpenAI via Pi SDK (OpenAI/Codex) | **Sign in**, follow the current prompt/browser link; **Cancel sign-in**, **Reload status**, **Refresh provider** (on `sync_pending`, without logging in again) | Credentials stay in the standard Pi SDK store; Sigma does not write tokens to SQLite. OpenAI verified; other SDK flows, expiry and quota not verified |
| Claude Code CLI | **Official CLI accounts → Claude Code → Refresh status → Connect local route**, models Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5 · official CLI | Uses the already authorized `claude`; credentials are not copied. **Disconnect** disables only the route |
| Local CLIProxyAPI (Antigravity) | Starts only after **Connect local proxy** (then autostarts on every launch; **Disconnect** turns it off); **Local model gateways**; sign-in only explicitly: `node scripts/cliproxy-local.mjs login` | A separate private deployment in `DATA_DIR/cliproxyapi`, `127.0.0.1:8319`, models `sigma-cliproxy`; states `not_installed/needs_login/starting/ready/degraded/stopped/borrowed` are visible in Providers; a foreign 8317 is not touched; the binary is included in the app only if it was available at build time (see section 7; otherwise `not_installed`) |
| Antigravity (unsupervised) | **Providers → Antigravity (unsupervised)**: checkbox + confirmation, disabled by default | **Warning:** AGY runs its own file/shell/browser tools **without Pi Allow/Deny**. Details: [6d](#6d-antigravity-unsupervised) |
| Direct native AGY (supervised) | not supported | **BLOCKED**: agy native tools cannot be disabled; no supervised route is registered |

Sigma supports only three provider families: OpenAI (ChatGPT/Codex sign-in or API key via the Pi SDK), Claude Code (official CLI) and Antigravity (official CLI, unsupervised mode, local CLIProxyAPI). All other built-in Pi SDK providers (Gemini/Google, Anthropic, OpenRouter, GitHub Copilot, etc.) are intentionally unavailable: they are not listed in Providers, cannot be signed in, and none of their models appear anywhere in Sigma.

For all routes except unsupervised AGY, `read`/`ls`/`edit`/`write`, `bash`, `git_commit` and QA actions go through Pi. **Full access is the default:** agents run these tools without asking, and each action is still recorded as approved. To get an Allow/Deny prompt for every action again, uncheck **Providers → Agent access → Full access** (the choice is saved in `DATA_DIR/agent-access.json`). Workspace and credential path guards apply in both modes. **Agents** is a plain role → model + reasoning map (Planner, Researcher, Implementation, Reviewer, QA; defaults "Same as chat model" and "Model default"; an explicit model must support the chosen level, and a level the chat model lacks falls back to the model default). The model chosen in the chat is the orchestrator and decides which agents to call by task size: small task, none; medium, e.g. implementer then reviewer; complex, planner/researcher, implementer, reviewer and QA. A project can change any of these for its own chats: **Edit project → Agents in this project** offers the same model and reasoning choices plus **Global**, which keeps the Agents value. Only the fields a project sets replace the global ones, and chats outside projects (or started in a folder that is not part of the selected project) use the Agents page as before. New sessions/tasks keep a snapshot of the mapping, workspace and mode; the root session always uses the chat model and reasoning, and delegated agents use their role's reasoning.

**Reasoning.** The chat's bottom bar shows a Reasoning choice only for models that support it, and lists only the levels that provider accepts ("Default reasoning" = the model's default): OpenAI (Codex) `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` (the exact list depends on the model), Claude Code CLI `low`/`medium`/`high`/`xhigh`/`max` for Fable 5.1, Opus 5.5 and Sonnet 5.5 (Haiku 4.5 has no reasoning control; the legacy Sonnet 4.6, kept only for existing sessions, offers `low`/`medium`/`high`/`max`), Antigravity via CLIProxyAPI `low`/`medium`/`high`; the offline demo and unsupervised AGY have no reasoning control. The choice applies to the root session (or to the coordinator and repository sessions of a project task); delegated agents use their role's reasoning. In an open session you can change the model and reasoning from the same bar; the change applies to the next prompts and is kept after a restart. It is unavailable while a run is in progress, for delegated agents, for multi-repository task sessions and for unsupervised AGY. An unsupported level is rejected, not adjusted.

### 6a. Pi SDK OAuth

1. **Providers** → **Pi SDK accounts** → click the provider row to expand it → **Sign in**.
2. Follow the prompt shown or open the browser link and complete the sign-in.
3. The provider is expected to become connected, and its models appear in the chat's model picker.
4. To cancel the sign-in, click **Cancel sign-in**. If the status is stale, **Reload status**. If the state is `sync_pending`, click **Refresh provider** (no new login needed).

### 6b. Claude Code CLI

1. Make sure the official `claude` is already installed and authorized (sign-in happens in the CLI itself, not in Sigma).
2. **Providers** → **Official CLI accounts** → **Claude Code** → **Refresh status**.
3. Click **Connect local route**.
4. In the chat's bottom bar, choose one of the Claude models (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) · official CLI.
5. If the status says a login is required, complete the sign-in in the official CLI and click **Refresh status** again. Also click **Refresh status** after restarting Sigma.

### 6c. Local CLIProxyAPI (Antigravity login)

The proxy process runs only after you opt in with **Connect local proxy**; until then its state is `stopped` ("Local proxy is off"). Prerequisites: the pinned CLIProxyAPI binary is part of the app (bundled at build time) or is in `DATA_DIR/cliproxyapi` (otherwise the state is `not_installed`, see [section 7](#7-building-the-macos-app-from-source)). Port `127.0.0.1:8319` must be free. Sigma never touches a foreign proxy on 8317.

The script `scripts/cliproxy-local.mjs login` takes the data directory from `SIGMA_DATA_DIR` (by default `.data` in the project root), so for an installed app you must specify the app data directory and run the script from a clone of the repository.

1. In Sigma: **Providers → Local model gateways → Antigravity · local CLIProxyAPI**, click **Connect local proxy**. This starts the proxy (state `needs_login` while there is no sign-in) and makes Sigma start it on every launch.

2. For an installed app (from the repository directory):

   ```sh
   SIGMA_DATA_DIR="$HOME/Library/Application Support/dev.sigma.app" node scripts/cliproxy-local.mjs login
   ```

   For a source run with the default data, this is enough:

   ```sh
   node scripts/cliproxy-local.mjs login
   ```

   (with a non-default `SIGMA_DATA_DIR`, pass the same variable.)

3. The script prints «Complete Antigravity sign-in in the browser opened by CLIProxyAPI.» and opens a browser. Complete the Antigravity sign-in. The OAuth callback uses port 51122.
4. When the command finishes, it prints «Sign-in command ended. Connect or refresh the local proxy in Sigma to verify availability.» and sets permissions `0600` on the auth files.
5. In Sigma, click **Connect local proxy** again in the same place (once connected, the button becomes **Refresh models**). The state `ready` and the models `sigma-cliproxy` are expected.

If the script prints «Local proxy could not run», check that the binary is actually installed in `DATA_DIR/cliproxyapi` and that `SIGMA_DATA_DIR` points to the right directory.

### 6d. Antigravity (unsupervised)

Disabled by default. **Warning:** AGY runs its own file/shell/browser tools **without Pi Allow/Deny**; Sigma only shows what AGY reports, read-only.

1. **Providers → Antigravity (unsupervised)**.
2. Enable the checkbox and confirm.
3. Works only for new code sessions in a worktree; a «Executed by AGY (unsupervised)» marker appears in Activity.
4. Disabling Stops active AGY runs.

## 7. Building the macOS app from source

The Rust toolchain and Cargo cache are required (see [section 2](#2-requirements)).

1. Build a relocatable Apple Silicon app/DMG with bundled Node and the compiled runtime (minimum macOS 13.5):

   ```sh
   npm run desktop:build
   ```

   The build bundles CLIProxyAPI automatically when `.data/cliproxyapi/bin/CLIProxyAPI-8.0.13` exists (its sha256 is verified). That file appears after Sigma has been started once from source (`npm start`) with the binary available. The build prints `CLIProxyAPI CLIProxyAPI-8.0.13 staged ... (sha256 ...)` when it is bundled, or `No SIGMA_CLIPROXY_BINARY and no provisioned ...: CLIProxyAPI not staged` otherwise. `npm run desktop:build` then stops before building the app, because a build without the proxy would show `not_installed`; `npm run desktop:dev` still runs without it.

   `SIGMA_CLIPROXY_BINARY` is only an override for a binary stored elsewhere, for example:

   ```sh
   SIGMA_CLIPROXY_BINARY="$PWD/.data/cliproxyapi/bin/CLIProxyAPI-8.0.13" npm run desktop:build
   ```

   If the variable points to a missing file, the build stops with a clear error; unset it to use the default.

2. Artifacts:
   - app: `.scratch/native-cargo-target/release/bundle/macos/Sigma.app`
   - DMG: `release/Sigma_<version>_aarch64.dmg` (repo root; the build also keeps a copy at `.scratch/native-cargo-target/release/bundle/dmg/Sigma_<version>_aarch64.dmg`, which packaged-gate checks)

3. Individual steps: `npm run desktop:emit` (compile the desktop runtime), `npm run desktop:package` (build + emit + runtime packaging), `npm run desktop:dev` (packaging and `tauri dev`).

4. Verify the built artifacts:

   ```sh
   node scripts/packaged-gate.mjs
   ```

   Options: `--app <Sigma.app>`, `--dmg <Sigma.dmg>`, `--skip-launch`.

   The gate checks the app/DMG (manifest, hash, codesign on a read-only mount) and runs the cold/restart/degraded/Quit gates. Each run uses `SIGMA_QA=1` and a fresh isolated `SIGMA_DATA_DIR`, so real app data is not touched. Port 8319 must be free. Evidence: `.scratch/packaged-gate-<ts>/`.

Third-party licenses and Go notices are included in the bundle. The signature is ad-hoc (a sealed signature, `codesign --verify --deep --strict` before the DMG); notarization and public distribution are out of scope. The old `.data` and `work/tauri-data` are not migrated automatically, only by explicit migration ([section 10](#10-browser-qa-cleanup-migration)).

### Versioning

SemVer. While below 1.0, every new feature bumps minor and every visible fix or UI tweak bumps patch; docs-only, tests-only and internal refactors need no bump. Bump once per merged change:

```sh
npm run version:bump -- minor   # or patch, major, X.Y.Z
node scripts/bump-version.mjs   # check: all files agree on one version
```

The script keeps `package.json`, `package-lock.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` in sync; the DMG name follows the version.

### Updates

Sigma updates itself from GitHub Releases (`drenkas/Sigma`) with the Tauri updater. About 10 seconds after launch, and then every ~6 hours, the app checks `https://github.com/drenkas/Sigma/releases/latest/download/latest.json`. If a newer version exists, a small round download button (tooltip: **Update to vX.Y.Z and restart**) appears at the bottom of the sidebar; clicking it downloads the signed archive, verifies it against the public key in `tauri.conf.json`, replaces the app, stops the local service in order and relaunches. **Sigma → Check for Updates…** runs the check on demand and shows the same button (or an "up to date" dialog). The check is skipped in debug builds and when `SIGMA_DISABLE_UPDATER=1`.

Cutting a release:

```sh
npm run version:bump -- minor        # or patch
npm run desktop:build                # signed Sigma.app + DMG
npm run release:prepare              # release/Sigma_<v>_aarch64.app.tar.gz (+ .sig) and release/latest.json
```

Then create a GitHub release tagged `v<version>` and upload `release/Sigma_<version>_aarch64.dmg`, `release/Sigma_<version>_aarch64.app.tar.gz` and `release/latest.json`. `release:prepare` uploads nothing; set `SIGMA_RELEASE_NOTES` to put release notes into the update dialog.

- The updater private key lives at `~/.tauri/sigma-updater.key` (override with `TAURI_SIGNING_PRIVATE_KEY_PATH`). Never commit it; if it is lost, existing installs cannot be updated and a new DMG must be installed manually.
- The first install from the DMG needs right-click → **Open** once (ad-hoc signature, no notarization). Updates installed by the updater do not get the quarantine flag, so there is no repeated Gatekeeper prompt.
- `Sigma.app` must live in `/Applications` (or another folder writable by you) so the updater can replace it.

## 8. Checks

```sh
npm run build
```

`tsc --noEmit` and `vite build`.

```sh
npm run check
```

The authoritative sequential command (`--test-concurrency=1`): ~10 min.

```sh
npm run check:parallel
```

Auxiliary; it may produce fixture timeouts, so do not treat its result as authoritative.

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Rust tests.

```sh
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

```sh
node work/bench-all.mjs
```

JS dispatch of Node/Bun only, not a Pi/SSE/paint benchmark.

Node tests run with `SIGMA_APPROVAL_MODE=ask` (used only when no access choice is saved), use offline providers and a synthetic CLI in isolated HOME/agent/data under `.scratch/` (`SIGMA_TEST_DIR` is the parent directory). The CLIProxyAPI lifecycle test needs a local pinned binary. Do not weaken assertions or production timeouts just to get a PASS.

## 9. Troubleshooting

| Symptom | What to do |
|---|---|
| Port 4318 is in use | See [If port 4318 is in use](#if-port-4318-is-in-use) |
| The server refuses to start because `DATA_DIR` belongs to another server (lease) | Another running Sigma (source or app) already uses the same data directory. Shut it down normally (Ctrl+C or Cmd+Q) or use a different `SIGMA_DATA_DIR` |
| macOS blocks Sigma.app («cannot be opened», «damaged», «Apple could not verify») | Quarantine on an ad-hoc build. See [section 3, step 4](#3-option-a-macos-app-from-dmg): right-click → Open, Open Anyway, or `xattr -dr com.apple.quarantine /Applications/Sigma.app` |
| `npm ci` fails or the app does not start on an old Node | Check `node -v`; 24.16+ is required |
| Providers shows `not_installed` for the proxy | The build did not find the binary. Start Sigma once from source so `.data/cliproxyapi/bin/CLIProxyAPI-8.0.13` exists, then rebuild with plain `npm run desktop:build` ([section 7](#7-building-the-macos-app-from-source)), or put the pinned binary at `DATA_DIR/cliproxyapi/bin/CLIProxyAPI-8.0.13` |
| Proxy is in the `needs_login` state | Run the Antigravity login ([6c](#6c-local-cliproxyapi-antigravity-login)), then **Connect local proxy** again (**Refresh models** once connected) |
| Port 8319 is in use | Free it (shut down your own old Sigma/proxy normally); Sigma does not touch a foreign proxy on 8317. `packaged-gate.mjs` also requires a free 8319 |
| Claude Code CLI asks for a login | Complete the sign-in in the official `claude` and click **Refresh status** |

## 10. Browser QA, cleanup, migration

- **Browser QA** (Changes → Browser QA): an owned Chrome for Testing (`SIGMA_QA_CHROMIUM`) inside `sandbox-exec` on an immutable preview; `qa_*` tools only for qa-role agents, with per-action approvals when Full access is off; a QA gate before the final receipt. Desktop QA is not implemented.
- **Cleanup**: sidebar → Archived → «Clean up archived sessions…»: preview and explicit approval; removes only clean worktrees/scratch of archived sessions.
- **Apply to source.** In a session with a separate worktree, **Changes → Prepare source Apply** copies the changes into your original folder after you approve the exact diff. A passed check and a review first are recommended, not required; the panel warns when the current revision has neither.
- **Legacy data migration** only explicitly, one source: `npm run migrate:preview -- --source <dir>`, `npm run migrate:stage -- --source <dir> --authorize <sha256>`, `npm run migrate:status`; publication at startup (`SIGMA_MIGRATE_PUBLISH`). Details: [docs/FEATURES.md](docs/FEATURES.md).

## 11. Data and security

- Data: `.data/` or `SIGMA_DATA_DIR` (source), `~/Library/Application Support/dev.sigma.app` (native app); directory permissions `0700`. SQLite WAL stores lifecycle/commands/approvals/events; Pi SDK stores the JSONL history and credentials.
- The server listens on loopback only and checks Host, Origin and an HttpOnly cookie (with the port in its name).
- Allowed tools (except unsupervised AGY): `read` of a specific file, `ls` of a directory, and in Code `edit`/`write`. The app's credential roots (AGY/proxy/SDK) are inaccessible to file tools even after Allow; symlinks/hardlinks fail closed.
- **`bash` tool ("Run command")**: root Code/Parallel sessions and every delegated agent (planner, researcher, worker, reviewer, QA) can run shell commands such as `npm test`, `npm install`, `git`, linters, build tools and `curl`. Not available to read-only root sessions, multi-repository coordinators, the independent revision reviewer or unsupervised AGY. The command runs on the host through `/bin/zsh -lc` in the agent's own folder (the selected folder, or its isolated worktree), with network access and your environment minus Sigma-internal variables and provider keys (`SIGMA_*`, `PI_*`, `*_API_KEY`, `*_TOKEN`, ...). It runs under macOS `sandbox-exec` that blocks reading and writing only credential files: `auth.json`-style files (`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, `~/.claude/.credentials.json`, `credentials.json` and similar inside hidden home folders), `~/.cli-proxy-api/`, Sigma's `agent-access.json`, `native-providers.json`, `state.sqlite`, the CLIProxyAPI and Antigravity sign-in folders and the Pi SDK key files; everything else, including the rest of those folders, stays readable; without `sandbox-exec` it refuses to run. In Ask mode each command needs Allow/Deny and the full command is shown before it runs; in Full access it runs immediately and is still recorded in Approvals and Activity (command and exit code). Default timeout 300 s (up to 1800 s); output is capped to the last 30 KB; the command's whole process group is killed on timeout, on Stop and when Sigma quits. **Warning:** a command can change or delete anything else your user account can reach (your home folder, other projects, installed tools) and use the network; the sandbox protects only credential files. Use Ask mode if you do not trust the task.
- After a crash, undetermined actions become `unknown` and are not retried automatically.
- These are host-level checks, not OS isolation from another process of the same user.
