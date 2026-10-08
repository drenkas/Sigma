# Sigma — стиснута хронологія

Короткі підсумки завершених етапів (нові записи зверху). Це не чинний стан і не доручення — актуальне див. [PLAN.md](../../PLAN.md). Повні тексти (звіти F1–F6, review 2026-10-04, старий PLAN зі специфікацією Graph, evidence-таблиці, хеші артефактів, лічильники тестів) — у Git history до коміту, що вводить цей файл. Каталог `.scratch` локальний і ignored.

## 2026-10-05 — Етапи 1–6 (`032afa5`…`2abf1f1`)

- **D1–D4**: docs розділено (README — запуск, PLAN — стан/backlog, HANDOFF — операційний контекст, FEATURES — поведінка); `npm run check` серійний (`--test-concurrency=1`), паралельний — лише `check:parallel`; tabs переносяться, edge labels мають `title`; перший user input — `GraphFact.kind:"prompt"` (`b4ace08`).
- **Legacy migration** (`76fd55a`): preview → stage → journaled publish при старті. Виконано з дозволу користувача: `.data` → `~/Library/Application Support/dev.sigma.app` (5 sessions, 1 project); сесія `8623a25c` без history за рішенням користувача, alias `a041abb4` прийнято, `state.sqlite.pre-migration` збережено. `work/tauri-data` не мігровано.
- **Lifecycle** (`a7a3059`, `878f55b`): supervised push і worktree allocation, sweep crash-temp, SSE, merge publish, guarded cleanup архівних сесій.
- **Providers** (`757d661`, `88f7af8`, `544588e`, `a14f27a`, `c8341ae`): opt-in unsupervised AGY (worktree-only; agy 1.2.17 потребує default agent, кастомні агенти обмежують tools); CLIProxyAPI provisioning + state machine. Supervised AGY лишається BLOCKED.
- **Browser QA** (`601a097`, `f8d4c80`, `11897ec`): Chrome for Testing у `sandbox-exec` + `--no-sandbox` (власний sandbox Chromium у nested режимі не працює), `qa_*` tools з approvals, QA evidence gate. Desktop QA відкладено.
- **Етап 6** (`3abd8eb`, `2abf1f1`): fail-closed license packaging; sealed ad-hoc підпис (`codesign --verify --deep --strict` до DMG); `scripts/packaged-gate.mjs` (read-only DMG, cold start/provisioning, restart, degraded → `not_installed`, Quit drain) — PASS. Застереження ліцензій: `standardwebhooks@1.1.1` (MIT у package.json, у repo незаповнений Apache-2.0 шаблон) і `@earendil-works/chord` (автор ≠ holder) — поставлені з позначеними заголовками; перевірити перед публічним поширенням. Notarization не планується.

## 2026-10-04 — F1–F6 (Stage 0, `30e2ef7`, `3b4a297`); review → REVISE

Вихідне review знайшло 6 material findings (P1: F1–F4, P2: F5–F6) і документаційні розбіжності (застарілі лічильники тестів, нестабільний паралельний `check`, надмірні README/PLAN/HANDOFF). Усі виправлено; контракти, що лишаються чинними:

- **F1/F2 — credential roots і read identity.** Спільний guard у `tool-boundary.ts` захищає `DATA_DIR/antigravity-profile`, `cliproxyapi`, `agent` і фактичний SDK auth root для read/ls/edit/write (alias і ще не створені descendants; Allow не скасовує). Read approval зберігає identity SDK-resolved target і його ancestors; байти читаються з відкритого `O_NOFOLLOW|O_NONBLOCK` дескриптора. Symlinks у path і файли з `nlink > 1` — fail closed. Межа: не OS-ізоляція від hostile same-user directory ABA swap; transient порожній `.pi-edit-*` у підміненій папці можливий.
- **F3 — DATA_DIR ownership.** Source/native беруть `flock` на directory inode, потім на `sigma.lock`, до Storage/recovery; Rust передає Node два inherited FD (перевірка type/device/inode, `nlink=1` для файла). Lease закривається після drain Pi/verification/apply/merge/proxy і Storage close; `LOCK_UN` не викликається. Другий поточний server з тим самим canonical DATA_DIR відхиляється (для паралельної instance — окремі port і DATA_DIR). Pre-F3 source lease не бере: старий спершу завершити. Git checkout, що видаляє `sigma.lock`, другого owner не створює; tools не можуть писати в `sigma.lock`.
- **F4 — Git commit scope.** `git_commit` відхиляє omitted/unsupported paths до approval і перед commit; commit йде через приватну копію index під стандартним `index.lock` (`--only`, literal descendant exclusions, D/F конфлікти зі staged paths); сторонні staged/dirty/untracked зберігаються.
- **F5/F6 — approval і durable receipt.** Approval показує повний message, native diff, parent і tree; UTF-8 bytes заморожуються в `DATA_DIR/git-intents` (quarantine object dir); drift HEAD/branch/index/mode/path/bytes після Allow відхиляється до мутації. Tool ID — `pi-tool:<sessionId>:<toolCallId>`; Pull/Switch API вимагає `X-Command-Id`. Native `update-ref` з parent-SHA CAS; receipt + policy repin — одна SQLite транзакція. Незавершені admissions після restart → `unknown`; `Repository → Unknown Git`: fresh inspect + explicit digest acknowledgement, без автоматичного replay/glob cleanup; unknown Read-owned Pull/Switch блокує Code writes у тому ж canonical root. Hooks/filters/auto-gc вимкнено для owning commands. Межа: cooperative Git locking не є ізоляцією від adversarial same-user процесу.
- **Відкриті межі Stage 0**: packaged native runtime цих змін, Push durable recovery, live-provider automatic SDK replay, hostile same-user directory ABA.
- **Native Pi SDK sign-in**: реальний OpenAI login у `.app` (canonical SDK store, 8 моделей, reopen без нового login, isolated profile). Виправлено Rust shutdown: Quit закриває stdin і чекає Node (SDK credential lock до 30 с) замість TERM/KILL через 5/8 с. Callback з неправильним state → 400; Cancel прибирає listener. Успішний callback/manual fallback не трасувалися.
- **CLIProxyAPI**: private 8.0.13 ARM64 на `127.0.0.1:8319` (чужий 8317 не чіпати), каталог 12 моделей, live Gemini Allow/Deny/Stop; autostart: власна process group або вже готовий proxy, native parent EOF завершує API і proxy.
- **AGY**: приватний профіль `DATA_DIR/antigravity-profile`, `agy-profile.ts` перевіряє sparse native settings (exact deny-list, порожні hooks/allow/ask, лише owned HOME). Supervised route BLOCKED: agy 1.2.16 `init` — 60 глобальних tool names без selected-agent spec, hook fail-closed не доведено.

## 2026-10-03 — Roles, native foundation, recovery, OAuth, Claude, AGY prep

- Roles (immutable role/model snapshots); native foundation (Apple Silicon app/DMG, bundled Node, LaunchServices, bounded shutdown/lease); Source Apply/Stop (SIGKILL → unknown → fresh observations → fresh Apply); workspace recovery (orphan → Continue → Archive → Restore, ті самі IDs); OAuth: Providers працює до моделей, одноразові prompts, operation ID, Cancel чекає SDK save/model sync.
- **Claude V2**: live Allow/Deny/Stop через `sigma-claude-cli/claude-sonnet-4-6`, correlated tool result, persisted `turn_end`, native process drained.

## 2026-10-02 — Graph і вкладене делегування

- **Graph** (проєкція журналу, не scheduler): блок = одна Pi-сесія (назва, model, рівень reasoning, роль, статус); різні стрілки для створення/делегування, повернення результату, steer/follow-up, review; creation event зберігає actor і cause окремо від `parent_id`; стрілка доставки — лише за окремою спостереженою подією; review finding — evidence, не доставка; failed/interrupted/unknown не стають успішним поверненням; legacy-сесії без вигаданих зв'язків. Snapshot — останні 2000 events (truncation позначається), cursor API — до 500 на сторінку. VoiceOver, native app, full lifecycle не доведені.
- **Nested delegation**: policy v2 root → child → grandchild (depth 2, lifetime 4 descendants, concurrency 2/service, timeout 300 с); Stop охоплює нащадків; admission reservation до filesystem allocation; SIGKILL/restart не повторює spawn. Nested writer integration — відкрито.

## 2026-09-29…30 — перші зрізи

Робочий Codex (read approval/stream/Stop), кастомні проєкти і вибір папок (`folder-picker.ts`), Code mode (`editing.ts`, diff approvals, patch export 200 files / 1 MiB), redesign UI (темна тема, три колонки, drawers <1280/<900px), B1 policy snapshot + Stop child, Git-папки і multi-repo (2–4 repos), Parallel Code workers + `worker-merge.ts`, Source Apply + revision-bound check/review (`verification.ts`, sandbox-exec deny-default).

## Dependency / license register (pin = `package-lock.json`, `Cargo.lock`)

Усі прямі залежності — MIT або Apache-2.0 (Pi coding-agent/AI, SolidJS, Fastify, Vite, vite-plugin-solid, tsx, TypeScript, Tauri). Vite 8 мав peer conflict із vite-plugin-solid 2.11.8 → лишається Vite 7. Upstream `pi-subagents@0.73.1` (MIT) переглядався як довідка, код не копіювався; кандидати browser/computer-use QA не обрані — перед адаптацією перевірити exact revision, ліцензію й notices.

## Benchmarks (`work/bench-all.mjs`, Node 24.16.0 vs Bun 1.3.14)

Microbenchmark без Pi/SSE/paint: p95 JS dispatch Node 0.011–0.015 ms, Bun 0.017–0.028 ms; RSS Node ~55 MiB, Bun ~36–39 MiB. Bun не імпортує `node:sqlite` (потрібен storage worker) → runtime Node. Ціль p95 event-to-paint <100 ms і RAM всього дерева не виміряні.
