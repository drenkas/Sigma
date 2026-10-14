# Sigma — операційний контекст для наступного агента

Sigma (раніше Pi Orchestrator) — локальний GUI для Pi SDK. Цей файл — як працювати з репозиторієм. Стан, backlog і acceptance — [PLAN.md](PLAN.md); запуск — [README.md](README.md); поведінка — [docs/FEATURES.md](docs/FEATURES.md); історія — [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md). Старі continuation-записи не є дорученням: нові пріоритети задає PLAN і користувач.

## Ціль і прийняті рішення

Власний GUI для engineering-задачі від запиту до перевіреного результату: root/planner сам обирає дослідження, декомпозицію, паралельних виконавців, reviewers, цикли виправлень, інтеграцію й QA. Проста задача може йти без дочірніх агентів. Дерево/Graph відображає реальне виконання; фіксований DAG чи Kanban не є основою. Ескіз користувача (planner → researcher/implementers → review/fix → QA → підсумок) — модель поведінки, не обов'язкова послідовність.

- Pi SDK володіє model/provider calls, context, compaction і tool loop — не реалізовувати повторно.
- Власний UI — з першого етапу; нові можливості додаються разом із налаштуваннями й відображенням стану.
- Існуючі extensions — джерело ідей, код адаптується під власні контракти; зайвий scheduler/mailbox/worktree manager заради стороннього TUI не підтримуємо.
- Пріоритет — ефективність виконання/памʼяті, підтверджена вимірюваннями. Стек: SolidJS + TypeScript + Vite; Tauri 2 як OS shell; один довгоживучий TS/Pi сервіс; SQLite WAL з одним storage worker; Node.js 24 (Bun — лише після сумісності й порівняння; Rust/Zig core без доведеного bottleneck не додавати).
- Маршрути: OpenAI/Codex через Pi → Anthropic/Claude → Antigravity окремо (не підміняти Gemini CLI). Pi provider не гарантує нативних можливостей Codex App Server чи Claude Code.

Семантика: **`settled` — завершення Pi run, а не успіх задачі. Результат child — не незалежне review. `unknown` не можна повторювати автоматично.**

## Структура репозиторію

Git, гілка `main`. `.scratch/`, `.data/`, credentials і build artifacts не в Git.

| Шлях | Відповідальність |
|---|---|
| `apps/web/src/main.tsx`, `api.ts`, `style.css`, `apps/web/index.html` | Solid UI: sessions/tasks, SSE, chat/composer, approvals, recovery, drawers, agent tree; responsive (details drawer <1280px, sidebar drawer <900px) |
| `apps/web/src/Providers.tsx`, `Roles.tsx`, `Graph.tsx`, `Changes.tsx`, `WorkerMerges.tsx`, `Projects.tsx`, `Repository.tsx`, `Qa.tsx`, `Cleanup.tsx` | Providers/Roles, journal Graph/history, check/review/apply, worker merge, групи папок, Git actions |
| `apps/server/main.ts` | Fastify API, Host/Origin/cookie, команди, snapshot/SSE replay, static UI, DATA_DIR lease |
| `apps/server/pi-host.ts` | Pi sessions, tool approvals, admission, nested delegation/receipts, role snapshots, workspace continuation, model availability, Git tool guards |
| `apps/server/native-cli.ts`, `claude-provider.ts`, `native-cli-watchdog.mjs`, `agy-profile.ts` | Official CLI metadata/route, structured CLI transport, process-group ownership, private AGY profile |
| `apps/server/cliproxy-*.ts`, `agy-provider.ts` | CLIProxyAPI provisioning/process/state machine, direct AGY route |
| `apps/server/provider-auth.ts`, `roles.ts` | SDK auth operations, role catalog/validation/CAS |
| `apps/server/editing.ts`, `tool-boundary.ts`, `shell-tool.ts`, `project-task.ts`, `projects.ts`, `scratch.ts`, `cleanup.ts` | Workspace allocation/identity, file/credential guard, bash tool, project/task setup, scratch-папка, guarded cleanup |
| `apps/server/git-actions.ts`, `git-intents.ts` | Guarded Git actions, private-index commit, durable intent/recovery |
| `apps/server/verification.ts`, `source-apply.ts`, `worker-merge.ts`, `check-watchdog.mjs` | Checks/reviews, guarded writes/reconciliation, runner cancellation/drain |
| `apps/server/storage.ts`, `storage-worker.mjs` | SQLite WAL worker: IDs/policy/events/receipts/setup phases, migrations, DB-only archive |
| `apps/server/legacy-migration.ts`, `legacy-migrate-cli.ts`, `data-lease.ts` | Explicit legacy import (preview/stage/journaled publish під lease) |
| `apps/server/qa-browser.ts`, `qa-browser.sb`, `qa-browser-watchdog.mjs`, `qa-preview.ts` | Owned Chromium у sandbox-exec, CDP pipe, immutable preview; `qa-runs.ts`, `qa-gate.ts` |
| `apps/server/demo-provider.ts`, `apps/server/*.test.ts` | Offline provider; SDK/API/process regression fixtures |
| `packages/contracts/index.ts` | Контракти session/task/provider/role/recovery/Graph/revision evidence |
| `apps/desktop/src-tauri/` | Tauri shell: bundled Node, stable data root + lease, dynamic loopback port, shutdown, updater (`updater.rs`) |
| `scripts/` (`package-desktop.mjs`, `build-desktop.mjs`, `packaged-gate.mjs`, `release-artifacts.mjs`, `bump-version.mjs`, `cliproxy-local.mjs`), `tsconfig.desktop.json` | Desktop packaging, packaged gate, release, version bump; CLIProxyAPI helper |
| `work/` | Benchmarks (`bench.mjs`, `bench-all.mjs`), `make-icon.py` |

Власники стану: Pi SDK — model context/history (JSONL) і credentials (штатний store); SQLite — lifecycle, commands, approvals, policy snapshots, events. GUI лише відображає; виконанням володіють server managers; orchestration не переносити в Tauri shell.

Версії залежностей не оновлювати попутно: pin — `package.json`/`package-lock.json`, `apps/desktop/src-tauri/Cargo.lock`; Node 24; Vite 7 (Vite 8 мав peer conflict із vite-plugin-solid). Версія продукту — SemVer, bump лише через `npm run version:bump` (див. AGENTS.md).

## Як запускати й перевіряти

Команди — у [README.md](README.md). Коротко: `npm start` (build + server, порт 4318), `npm run build`, `npm run check` (серійна авторитетна; `check:parallel` допоміжна), `npm run desktop:build`. Після кожної зміни коду: focused regression на межі власника → full serial → build; для UI — реальний browser (368/375/1024/wide), не лише static review.

## Операційні нотатки

- **ZENTAB**: [режими й доказова межа](docs/ZENTAB.md). Full serial `npm run check` — 178/178, `npm run build` пройшов. Попередні збої були в тестах: Keychain-затримка свіжого CFT-профілю (тепер `--use-mock-keychain` для синтетичних профілів, справжній HOME для Internal Chrome) і застарілий observationId. CFT-тест підтверджує redirect/approval/screenshot guard. Особистий Chrome, external live vision і native Tauri не перевіряли.
- **Міграція**: `npm run migrate:preview|stage|status` (див. [docs/FEATURES.md](docs/FEATURES.md)); публікація лише при старті з `SIGMA_MIGRATE_PUBLISH=<stageId>` під lease. Реальний імпорт `.data` → native app data вже виконано з дозволу користувача (stage root `<dest>-migration/`; `state.sqlite.pre-migration` — старий порожній DB, `.data` не змінювалась). Нові імпорти — лише з окремим дозволом.
- **QA Chromium**: `SIGMA_QA_CHROMIUM` — шлях до Chrome for Testing (sha256 виконуваного файлу записується); артефакти QA — `<DATA_DIR>/qa/<runId>/artifacts/`. Chromium працює під зовнішнім `sandbox-exec` з `--no-sandbox`.
- **AGY live-probe** (agy 1.2.17): unsupervised route потребує default agent (без `--agent`); кастомні агенти обмежують tools; protocol — stream-json, `step_update.tool_info`. Профіль `DATA_DIR/antigravity-profile` перемикається strict↔unsupervised; стан opt-in — `native-providers.json`. Повторний login не потрібен. Supervised direct AGY — BLOCKED.
- **Proxy**: стан у `/api/cliproxy` → `provider.proxy`; env `SIGMA_CLIPROXY_BINARY`; bundled binary (8.0.13) копіюється в app data при першому старті з перевіркою pinned hash.
- **Build/gate**: `npm run desktop:build` (за замовчуванням bundles `.data/cliproxyapi/bin/CLIProxyAPI-8.0.13`; `SIGMA_CLIPROXY_BINARY` перевизначає), потім `node scripts/packaged-gate.mjs` (evidence `.scratch/packaged-gate-<ts>/`). Gate не торкається реальних app data (`SIGMA_QA=1` + свіжий `SIGMA_DATA_DIR`); порт 8319 має бути вільним. Packaging fail-closed на відсутній license; `standardwebhooks` і `@earendil-works/chord` мають позначені license-заголовки — перевірити перед публічним поширенням. Ad-hoc підпис; notarization поза scope. Реліз — `release/Sigma_<version>_aarch64.dmg`.

## Environment gotchas

- Паралельний запуск Node-тестів дає fixture timeouts; `main.test.ts` parent-pipe тести мають 6 с межі й надійні лише серійно. Не міняти production timeouts і assertions заради PASS.
- `cargo fetch` виконано 2026-10-05, Rust-тести проходять офлайн; на новій машині потрібен `cargo fetch` з мережею.
- Порти: `4318` (`npm start`), `8319` (власний CLIProxyAPI Sigma), `8317` (чужий proxy — не чіпати), callback `1455`/`51122` для OAuth. Старі URL/порти у звітах не означають чинний listener; чужі процеси не зупиняти. Один DATA_DIR — один owner (lease), тож перед переходом зі старої source-версії її штатно завершити.
- Local proxy test fixture потребує pinned binary `DATA_DIR/cliproxyapi/bin/CLIProxyAPI-8.0.13` (binary не комітити).
- Disabled model `select` потрапляє до sidebar tab stops, коли немає моделей (a11y знахідка станом на 2026-10-05; перевірити, чи ще актуальна).
- Реальні provider smoke не вимикають окремо всі tools/retries через HTTP API: не додавати smoke-only production controls.
- Benchmark `work/bench-all.mjs` — лише microbenchmark; Bun не імпортує `node:sqlite`, runtime — Node (деталі — CHANGELOG).
- Credentials, tokens, raw `.env`, auth files, приватні logs не виводити. Не послаблювати validation/auth/approval задля тестів.

## Межі повноважень

- Нова перевірка має відповідати реальній невизначеності; не додавати тести, що лише повторюють реалізацію.
- Зберігати сторонні зміни. Staging/commit/amend/rebase/reset/stash/push/delete, зовнішні записи, install, deploy, зміни permissions — лише з явним дозволом користувача. Production dependencies, CI/CD, hosted automations — окремий дозвіл.
- UI: наявний стек і primitives; виправляти owning layer, а не маскувати consumer overrides.
- Незалежне review — для security/persistence/cancellation/consequential changes; не запускати concurrent writers на тих самих файлах/shared Git state.
- Результат потребує diff і review/test/QA evidence **фінальної ревізії**; незапущена перевірка не PASS, `not_applicable` потребує причини. Delivery proof — persisted native `turn_end` entry ID.

## Evidence і історія

`.scratch` шляхи локальні й ignored: в іншому checkout потрібні нові перевірки. Історія й контракти приймань — [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md); повні старі звіти — у Git history.

Upstream: Pi coding-agent 1.2.0 (MIT); `pi-subagents@0.73.1` (MIT) переглядався як довідка, код не vendored. Кандидати QA (pi-browser-use / pi-agent-browser-native, pi-codex-computer-use / pi-computer-use) не обрані — перед адаптацією перевірити exact revision, ліцензію й notices.
