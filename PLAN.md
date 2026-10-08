# Sigma — поточний план і критерії приймання

Тут лише поточний стан, впорядкований відкритий backlog і acceptance criteria. Історія, checkpoints, evidence і reproductions — [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md); операційний контекст — [HANDOFF.md](HANDOFF.md). Старі continuation-записи не відновлюють implementation scope.

## Стан

- Етапи 0–6 закомічені (Етап 6 — локальна ad-hoc збірка). Актуальні ревізія й версія — `git log` / `package.json`; DMG — `release/Sigma_<version>_aarch64.dmg`. Лічильники тестів не пінимо: авторитетний результат — свіжий `npm run check`.
- Загальний вердикт продукту — **REVISE** для повного обсягу: Етап 6 виконано для локальної ad-hoc збірки (без notarization за рішенням користувача), але лишаються відкриті пункти (див. «Що лишається відкритим» нижче).
- Кожне приймання належить своїй ревізії й артефакту. `.scratch` докази локальні й ignored: в іншому checkout потрібні нові перевірки.

### Прийняті обмежені зрізи

| Зріз | Що прийнято | Межа / відкритий залишок |
|---|---|---|
| Graph, nested, Roles | Journal-backed Graph, history/navigation; policy v2 (depth 2, 4 descendants, concurrency 2/service); immutable role/model snapshots | Локальні SDK/API/browser gates і bounded live Codex smoke. Nested writer integration, full multi-repo, accessibility — відкриті |
| Source Apply / WorkerMerge / workspace recovery | Bounded admission/Stop/drain, crash → unknown → fresh observations, same-ID continuation, DB-only archive/restore | Не доводять безпеку read/Git commit; загальний lifecycle audit відкритий |
| Pi SDK OAuth | Synthetic Providers gates; packaged OpenAI sign-in/Cancel/Quit/reopen, 8 моделей, reopen без нового login (isolated profile, 0 model prompts) | Успішний callback/manual fallback не трасувалися; інші SDK flows, expiry/quota/errors відкриті |
| Claude CLI → Pi | Live Allow/Deny → tool result → відповідь, streaming Stop, owned process drain | Повний V2 і packaged startup з фінальними owners відкриті |
| Local CLIProxyAPI → Pi | Окремий `sigma-cliproxy`, live Gemini Allow/Deny/Stop; compiled cold/restart autostart; provisioning app data + state machine `not_installed…borrowed` (`c8341ae`) | Packaged cold/restart/degraded/Quit gates пройдено (Етап 6); binary 8.0.13 входить у app |
| Direct native AGY (supervised) | Private profile/sign-in, zero-model metadata probes | **BLOCKED**: agy native tools вимкнути неможливо, pre-execution guard не доведено; supervised route не реєструвати. CLIProxyAPI цей gate не закриває |
| AGY unsupervised (opt-in) | Явний вибір користувача (`757d661`…`a14f27a`); worktree-only; live-перевірка agy 1.2.17 | Tools виконує сам AGY без Pi approvals — це не закриває supervised blocker; packaged startup gate пройдено (Етап 6) |
| Native foundation | Apple Silicon app/DMG, bundled Node, LaunchServices, bounded shutdown/lease, OpenAI native auth | Ad-hoc signing (sealed, `--deep --strict`); notarization не в scope за рішенням користувача. Етап 6: app/DMG зібрано на поточному source, licenses зібрано, Rust cache отримано (`cargo fetch`) |
| Legacy migration | Виконано 2026-10-05 з дозволу користувача (`76fd55a`): `.data` → `~/Library/Application Support/dev.sigma.app` | Лише одне джерело; `work/tauri-data` не мігровано; packaged gates ішли на свіжих QA data-каталогах, не на мігрованих даних |
| Browser QA | Chrome for Testing у `sandbox-exec`, QA tools з approvals, QA evidence gate (`601a097`, `f8d4c80`, `11897ec`) | Desktop QA відкладено; image-block review path лише unit-тест; повний live R1→R2 gate і packaged — не прийняті |

## Виконано

Етапи 0–6 і D1–D4 закомічені; підсумки й контракти — [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md). Таблиця не є дозволом на implementation, login/import, Git mutations чи публікацію.

| ID | Що | Коміти |
|---|---|---|
| 0 | Material findings F1–F6 (credential roots, read identity, DATA_DIR lease, Git scope/approval/receipt) | `30e2ef7`, `3b4a297` |
| 1 (D1–D4) | Розділення docs, серійний `npm run check`, tabs/Graph labels, `GraphFact.kind:"prompt"` | `032afa5`, `b4ace08` |
| 2 | Legacy migration `.data` → app data (виконано 2026-10-05); SDK OAuth — залишки відкриті | `76fd55a` |
| 3 | Lifecycle/recovery audit, guarded cleanup архівних сесій (preview+digest, `git worktree remove` без `--force`) | `a7a3059`, `878f55b` |
| 4 | V2 providers: unsupervised AGY (opt-in), CLIProxyAPI provisioning/state machine; supervised AGY BLOCKED | `757d661`, `c8341ae`, `88f7af8`, `544588e`, `a14f27a` |
| 5 | Browser QA (Chrome for Testing у `sandbox-exec`), `qa_*` tools, QA evidence gate | `601a097`, `f8d4c80`, `11897ec` |
| 6 | Native/license/distribution gate для локальної ad-hoc збірки (`scripts/packaged-gate.mjs`) | `3abd8eb`, `2abf1f1` |

CLIProxyAPI state machine: `not_installed|needs_login|starting|ready|degraded|stopped|borrowed`, pinned binary за SHA-256, ≤3 рестарти/5 хв; чужий 8317 не чіпати. Bundled binary — 8.0.13 (рішення користувача).

Авторитетні перевірки для code changes:

```sh
npm run check   # node --import tsx --test --test-concurrency=1 apps/server/*.test.ts
npm run build
```

Rust-тести: `cargo test` у `apps/desktop/src-tauri` (після `cargo fetch`). Docs-only зміни: достатньо diff, перевірки локальних посилань і узгодженості статусів. Для виправлень коду: focused regression на межі власника, full serial/build і незалежне review; native/browser/live перевірки — за зміненим контрактом, не підміняти static PASS.

## Що лишається відкритим

- **Desktop QA** (TCC preflight, UID lock, native helper) — відкладено.
- **Pi SDK auth:** успішний callback/manual fallback, інші SDK flows, expiry/quota/errors.
- **Performance:** Pi → SSE → paint, CPU/RAM всього дерева, slow-client recovery; повний accessibility/VoiceOver gate.
- **Окремий backlog:** nested writer integration, configurable budgets/container profiles, повний live multi-repo lifecycle.
- **Supervised direct AGY — BLOCKED** (unsupervised opt-in існує і цього не закриває).
- **QA image-block review path** (`qa_view_artifact`) — лише unit-тест; повний live R1 → R2 і packaged Chromium denials не підтверджені.
- **Не в scope за рішенням користувача:** notarization / Developer ID / public distribution.
- Packaged gates не покривають мігровані дані, QA browser і CLI/AGY owners як активні під час Quit.
- **Pi SDK OAuth:** Cancel і Quit чекають прийнятого SDK save/model-sync finalizer; невідомий результат спершу оглянути, login не повторювати автоматично.
- **Lifecycle:** actual SIGKILL/restart/slow-client на packaged app не перевірено; cleanup не видаляє гілки/DB/history (за дизайном).
- **Межі F1–F6:** packaged native runtime цих змін, Push durable recovery, live-provider automatic SDK replay, hostile same-user directory ABA isolation.
- **Licenses перед публічним поширенням:** `standardwebhooks@1.1.1` (незаповнений Apache-2.0 шаблон) і `@earendil-works/chord` (автор ≠ holder) поставлені з позначеними заголовками.
