# Sigma

[English](README.md) · **Українська**

Локальний GUI для Pi SDK: чат зі збереженою історією, Code у вибраній Git-папці або worktree, керовані approvals/checks/review, multi-repo tasks і Graph фактичної оркестрації. Сесії завжди працюють у режимі редагування (кореневий агент може редагувати файли й делегувати дочірнім агентам; єдиний воркер редагує робочу копію напряму, паралельні воркери зливаються автоматично за повного доступу, інакше — після вашого схвалення) — типово безпосередньо у вибраній папці або в окремому worktree; модель і reasoning обираються в самому чаті. Дозволи на інструменти визначає профіль сесії.

Стан продукту, відкритий backlog і критерії приймання — [PLAN.md](PLAN.md). Операційний контекст для наступного агента — [HANDOFF.md](HANDOFF.md). Детальна поведінка (Git, Code, recovery, межі дозволів) — [docs/FEATURES.md](docs/FEATURES.md). Історія — [docs/history/CHANGELOG.md](docs/history/CHANGELOG.md).

## Зміст

1. [Два способи запуску](#1-два-способи-запуску)
2. [Вимоги](#2-вимоги)
3. [Варіант A: macOS app з DMG](#3-варіант-a-macos-app-з-dmg)
4. [Варіант B: запуск з вихідного коду](#4-варіант-b-запуск-з-вихідного-коду)
5. [Перший сценарій](#5-перший-сценарій)
6. [Підключення провайдерів](#6-підключення-провайдерів)
7. [Збірка macOS app з коду](#7-збірка-macos-app-з-коду)
8. [Перевірки](#8-перевірки)
9. [Усунення проблем](#9-усунення-проблем)
10. [Browser QA, cleanup, міграція](#10-browser-qa-cleanup-міграція)
11. [Дані й безпека](#11-дані-й-безпека)

## 1. Два способи запуску

- **Варіант A: macOS app з DMG.** Найпростіший шлях: встановити `Sigma.app`, двічі клікнути. Термінал не потрібен. DMG збирається локально (публічного завантаження немає), див. [розділ 7](#7-збірка-macos-app-з-коду).
- **Варіант B: запуск з вихідного коду.** Потрібні Node.js і npm. Сервіс працює в терміналі, UI відкривається в браузері на `http://127.0.0.1:4318`.

Обидва варіанти дають однаковий UI. Відмінність у каталозі даних і порту (див. [розділ 11](#11-дані-й-безпека)).

## 2. Вимоги

| Для чого | Що потрібно | Як перевірити |
|---|---|---|
| Варіант A | macOS на Apple Silicon (app bundle `aarch64`), macOS 13.5 або новіша | Apple menu → About This Mac |
| Варіант B | Node.js 24.16+ і npm; macOS потрібен для системного вибору папок | `node -v` |
| Збірка app з коду | Rust toolchain (`rustc`, `cargo`) і Cargo cache | `cargo --version` |

Для збірки app один раз (з мережею) завантажити Rust-залежності:

```sh
cargo fetch --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 3. Варіант A: macOS app з DMG

1. **Знайти DMG.** Він з'являється після `npm run desktop:build`:

   ```
   release/Sigma_<version>_aarch64.dmg
   ```

   `<version>` — це версія з `package.json`.

   Якщо файлу немає, спершу виконати [збірку](#7-збірка-macos-app-з-коду).

2. **Відкрити DMG** подвійним кліком у Finder. Очікується вікно з `Sigma.app`.

3. **Перетягнути `Sigma.app` до Applications**, потім витягти (eject) змонтований диск.

4. **Перший запуск.** Відкрити Sigma з Applications. Якщо DMG зібрано на цьому ж Mac, застосунок зазвичай відкривається без зауважень.

   Підпис лише ad-hoc: Apple Developer ID і notarization немає (поза scope за рішенням власника). Якщо DMG потрапив з іншої машини (браузер, AirDrop, месенджер), macOS додає quarantine і може заблокувати запуск повідомленням «cannot be opened», «is damaged» або «Apple could not verify». Це очікувано. Розблокувати можна одним зі способів (лише для збірки, якій ви довіряєте, тобто власної):

   - Finder → правий клік на `Sigma.app` → **Open** → **Open**.
   - Після першої заблокованої спроби: System Settings → Privacy & Security → **Open Anyway**.
   - У Terminal:

     ```sh
     xattr -dr com.apple.quarantine /Applications/Sigma.app
     ```

5. **Що відбувається при старті.** Застосунок сам запускає вбудований Node-сервіс на вільному loopback-порту й відкриває вікно. Тримати термінал відкритим не треба. Очікується вікно Sigma з бічною панеллю.

6. **Де дані.** `~/Library/Application Support/dev.sigma.app` (права `0700`).

7. **Вихід.** Cmd+Q або Sigma → Quit. Graceful shutdown чекає на завершення збережень, тож не вбивайте процес примусово.

8. **CLIProxyAPI у складі app.** Bundled CLIProxyAPI є лише якщо binary був доступний під час збірки (див. [розділ 7](#7-збірка-macos-app-з-коду)). За наявності він при першому старті копіюється в app data з перевіркою pinned sha256, але app сам його не запускає: proxy стартує лише після натискання **Connect local proxy** (**Providers → Local model gateways**). Далі Sigma запам'ятовує цей вибір і запускає proxy при кожному старті; **Disconnect** зупиняє його й вимикає автозапуск. Інсталяції, де вже є вхід в Antigravity, зберігають автозапуск. Стан видно в **Providers**; якщо binary немає, **Providers** показує `not_installed`. Ручні кроки: Connect і одноразовий вхід в Antigravity ([6c](#6c-local-cliproxyapi-antigravity-login)).

Далі: [Перший сценарій](#5-перший-сценарій).

## 4. Варіант B: запуск з вихідного коду

1. **Перейти в каталог проєкту.**

   ```sh
   cd Sigma
   ```

2. **Перевірити Node.** Потрібна версія 24.16 або новіша.

   ```sh
   node -v
   ```

3. **Встановити залежності** (у свіжій копії; скрипти встановлення вимкнені).

   ```sh
   npm ci --ignore-scripts
   ```

4. **Запустити.**

   ```sh
   npm start
   ```

   `npm start` спершу збирає UI (`prestart`: `tsc --noEmit` і `vite build`), потім запускає сервіс. Це може тривати до хвилини.

5. **Дочекатися рядка** у терміналі:

   ```
   Sigma API listening on http://127.0.0.1:4318
   ```

6. **Відкрити** [http://127.0.0.1:4318](http://127.0.0.1:4318) у браузері.

7. **Зупинка.** Термінал лишити відкритим на час роботи; Ctrl+C зупиняє сервіс.

Дані source-запуску лежать у `.data/` або в каталозі зі `SIGMA_DATA_DIR`.

### Якщо порт 4318 зайнятий

Вибрати інший порт і окремі дані. Чужий процес не зупиняти.

```sh
SIGMA_PORT=4330 SIGMA_DATA_DIR="$PWD/.scratch/source-4330/data" npm start
```

Другий сервер із тим самим canonical `DATA_DIR` відхиляється незалежно від порту (lease береться до recovery). Тому дані мають бути окремі для кожного одночасного сервера. Змінні `SIGMA_*` замінили `PI_ORCH_*`; старі назви читаються як запасні.

### Офлайн демонстрація без провайдера

Корисно, щоб перевірити UI й протокол без жодного акаунта.

```sh
PI_OFFLINE=1 \
PI_CODING_AGENT_DIR="$PWD/.scratch/readme-demo/agent" \
SIGMA_DEMO=1 \
SIGMA_PORT=4319 \
SIGMA_DATA_DIR="$PWD/.scratch/readme-demo/data" \
npm start
```

Відкрити `http://127.0.0.1:4319` і вибрати модель `sigma-demo/offline` у нижній панелі чату. Це детермінований локальний провайдер; він не підтверджує роботу OpenAI чи Claude. Prompts: `hello`, `read:package.json`, `delegate2: inspect A | inspect B`, `slow task`, `fail-provider`. Для Code додатково: `edit:{"path":"file.txt","edits":[{"oldText":"old","newText":"new"}]}` і `write:{"path":"new.txt","content":"hello"}`. Для нового fixture брати нові data/agent каталоги; ці змінні не переносити в live запуск.

### Режим розробки

Два окремі термінали:

```sh
npm run dev:server
```

```sh
npm run dev:web
```

`dev:web` це Vite на `127.0.0.1:4317`. Після змін server source потрібен перезапуск власного Node; production UI після нового build потребує reload.

## 5. Перший сценарій

Однаковий для обох варіантів.

1. Відкрити **Providers** у бічній панелі (меню доступне і без моделей) і підключити провайдер ([розділ 6](#6-підключення-провайдерів)). Для швидкої перевірки без акаунта використати [офлайн демонстрацію](#офлайн-демонстрація-без-провайдера).
2. Натиснути **New session**.
3. Вибрати каталог (папку) і, за потреби, **Separate Git worktree**.
4. Описати мету в полі внизу, за бажанням вибравши модель і reasoning у його панелі, та натиснути Enter (або кнопку надсилання): сесія створюється в режимі редагування (агент може редагувати файли й делегувати дочірнім агентам), і перший запит одразу надсилається.
5. Продовжити розмову. За Full access (типово) інструменти виконуються без запитів, а кожна дія записується. Якщо Agent access перемкнено на ask, кожна операція відкриває панель дозволу над полем вводу, у тому ж стилі, що й запитання агента: нумеровані варіанти **Allow once** (**Apply this change** для правок файлів, **Commit** для `git_commit`), **Allow … for this chat** (усі агенти чату далі виконують цей інструмент без запитів; для `git_commit` не пропонується; скасувати можна кнопкою **Ask again** у Changes → Approvals, а після перезапуску Sigma знову питає) і **Deny**, а також поле, щоб відмовити й написати агенту, що робити натомість. Клавіші 1–3 обирають варіант; кілька запитів показуються по одному.
6. **Stop** перериває відповідь.
7. Сесії лишаються в **Sessions** після перезапуску.

**Зображення.** До повідомлення можна додати до 4 зображень (PNG, JPEG, GIF, WebP): кнопкою скріпки, вставкою з буфера обміну або перетягуванням на поле вводу. Великі зображення спершу зменшуються в браузері (довша сторона 2000 px, близько 3,5 МБ). Вкладення дозволені лише для моделей, що приймають зображення (моделі OpenAI, моделі Claude Code CLI і маршрут Antigravity без нагляду; поле вводу повідомляє, якщо вибрана модель не читає зображень). Зображення надсилаються разом із запитом і не зберігаються Sigma поза історією Pi. Надіслані зображення показуються маленькими мініатюрами у вашому повідомленні (клік відкриває зображення повністю); вони читаються з історії Pi на вимогу. Маршрут Antigravity без нагляду отримує їх як тимчасові файли поза робочою копією (AGY відкриває їх через `view_file`); після завершення ходу файли видаляються.

**Чати без проєкту.** Натисніть **+** біля **Chats** у бічній панелі (або надішліть повідомлення з порожнього поля без вибраної папки), щоб почати чат без проєкту. Sigma створює нову робочу папку `~/Documents/Sigma/<YYYY-MM-DD>/<короткий slug>` (Git-репозиторій з одним порожнім комітом, щоб працював режим редагування) і запускає сесію в ній; чат з'являється в **Chats**. Корінь можна змінити через `SIGMA_SCRATCH_ROOT`.

**@-згадки.** Введіть `@` у полі повідомлення, щоб вибрати файли й теки проєкту, skills та інструменти, згруповані як Files, Skills і Tools та відфільтровані під час набору (стрілки для переміщення, Enter або Tab для вставки, Esc для закриття). Посилання лишається видимим у повідомленні як звичайний текст: `@src/app.ts`, `@"my dir/notes.md"` (шляхи з пробілами), `@skill:name` або `@tool:name`. Під час надсилання Sigma розв'язує посилання й передає агентові контекст: вміст файлів до 32 КБ (більші або бінарні файли лише називаються, щоб агент міг їх прочитати), переліки тек, повний текст skill разом з його базовою текою та прохання використати вибраний інструмент. Шляхи розв'язуються лише всередині робочої папки сесії, а все, що не розв'язалося, лишається звичайним текстом. Skills читаються з `.claude/skills`, `.agents/skills` і `.pi/skills` у проєкті, з `~/.claude/skills` і `~/.agents/skills` та з теки агента Pi; у чаті показується лише те, що ви ввели.

## 6. Підключення провайдерів

| Провайдер | Як підключити | Примітки |
|---|---|---|
| OpenAI через Pi SDK (OpenAI/Codex) | **Sign in**, виконати поточний prompt/browser link; **Cancel sign-in**, **Reload status**, **Refresh provider** (при `sync_pending`, без повторного login) | Credentials лишаються в штатному Pi SDK store; Sigma не пише tokens у SQLite. Перевірено OpenAI; інші SDK flows, expiry, quota не перевірені |
| Claude Code CLI | **Official CLI accounts → Claude Code → Refresh status → Connect local route**, моделі Claude Fable 5.1, Opus 5.5, Sonnet 5.5 і Haiku 4.5 · official CLI | Використовує вже авторизований `claude`; credentials не копіюються. **Disconnect** вимикає лише маршрут |
| Local CLIProxyAPI (Antigravity) | Стартує лише після **Connect local proxy** (далі автозапуск при кожному старті; **Disconnect** вимикає); **Local model gateways**; sign-in лише явно: `node scripts/cliproxy-local.mjs login` | Окремий private deployment у `DATA_DIR/cliproxyapi`, `127.0.0.1:8319`, моделі `sigma-cliproxy`; стани `not_installed/needs_login/starting/ready/degraded/stopped/borrowed` видно в Providers; чужий 8317 не чіпається; binary входить у app лише якщо був доступний під час збірки (див. розділ 7; інакше `not_installed`) |
| Antigravity (unsupervised) | **Providers → Antigravity (unsupervised)**: checkbox + підтвердження, вимкнено за замовчуванням | **Увага:** AGY виконує власні file/shell/browser tools **без Pi Allow/Deny**. Деталі: [6d](#6d-antigravity-unsupervised) |
| Direct native AGY (supervised) | не підтримується | **BLOCKED**: native tools agy вимкнути неможливо; supervised route не зареєстровано |

Sigma підтримує лише три родини провайдерів: OpenAI (вхід ChatGPT/Codex або API key через Pi SDK), Claude Code (офіційний CLI) та Antigravity (офіційний CLI, unsupervised-режим, локальний CLIProxyAPI). Решта вбудованих провайдерів Pi SDK (Gemini/Google, Anthropic, OpenRouter, GitHub Copilot тощо) навмисно недоступні: їх немає в Providers, вхід неможливий, а їхніх моделей немає ніде в Sigma.

У всіх маршрутів, крім unsupervised AGY, `read`/`ls`/`edit`/`write`, `bash`, `git_commit` і QA-дії проходять через Pi. **За замовчуванням увімкнено Full access:** агенти виконують ці tools без запитів, а кожна дія все одно записується як схвалена. Щоб знову отримувати Allow/Deny на кожну дію, зняти **Providers → Agent access → Full access** (вибір зберігається в `DATA_DIR/agent-access.json`). Захист шляхів workspace і credentials діє в обох режимах. **Agents** це проста відповідність роль → модель + reasoning (Planner, Researcher, Implementation, Reviewer, QA; за замовчуванням "Same as chat model" і "Model default"; явна модель має підтримувати обраний рівень, а рівень, якого немає в моделі чату, замінюється на default моделі). Модель, обрана в чаті, є оркестратором і сама вирішує, яких агентів викликати за розміром задачі: мала задача, жодного; середня, наприклад implementer і reviewer; складна, planner/researcher, implementer, reviewer і QA. Нові sessions/tasks зберігають snapshot відповідності, workspace і режиму; root-сесія завжди використовує модель і reasoning із чату, а делеговані агенти використовують reasoning своєї ролі.

**Reasoning.** Нижня панель чату показує вибір Reasoning лише для моделей, що його підтримують, і лише рівні, які приймає цей провайдер («Default reasoning» = значення за замовчуванням моделі): OpenAI (Codex) `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` (точний список залежить від моделі), Claude Code CLI `low`/`medium`/`high`/`xhigh`/`max` для Fable 5.1, Opus 5.5 і Sonnet 5.5 (Haiku 4.5 не має керування reasoning; застаріла Sonnet 4.6, що лишається лише для наявних сесій, пропонує `low`/`medium`/`high`/`max`), Antigravity через CLIProxyAPI `low`/`medium`/`high`; офлайн-демо та unsupervised AGY не мають цього керування. Вибір застосовується до кореневої сесії (або до координатора й репозиторних сесій project task); делеговані агенти використовують reasoning своєї ролі. У відкритій сесії модель і reasoning можна змінити з тієї ж панелі; зміна діє для наступних запитів і зберігається після перезапуску. Це недоступне під час виконання, для делегованих агентів, для сесій multi-repository task та для unsupervised AGY. Непідтримуваний рівень відхиляється, а не змінюється.

### 6a. Pi SDK OAuth

1. **Providers** → **Pi SDK accounts** → натиснути на рядок провайдера, щоб розгорнути його → **Sign in**.
2. Виконати показаний prompt або відкрити browser link і завершити вхід.
3. Очікується, що провайдер стане підключеним і у виборі моделі чату з'являться його моделі.
4. Якщо вхід треба скасувати, натиснути **Cancel sign-in**. Якщо статус застарів, **Reload status**. Якщо стан `sync_pending`, натиснути **Refresh provider** (повторний login не потрібен).

### 6b. Claude Code CLI

1. Переконатися, що офіційний `claude` уже встановлений і авторизований (вхід робиться в самому CLI, не в Sigma).
2. **Providers** → **Official CLI accounts** → **Claude Code** → **Refresh status**.
3. Натиснути **Connect local route**.
4. У нижній панелі чату вибрати одну з моделей Claude (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) · official CLI.
5. Якщо статус показує, що потрібен login, завершити вхід в офіційному CLI і знову натиснути **Refresh status**. Після перезапуску Sigma теж натиснути **Refresh status**.

### 6c. Local CLIProxyAPI (Antigravity login)

Процес proxy працює лише після вашого opt-in через **Connect local proxy**; до цього його стан `stopped` («Local proxy is off»). Передумови: у складі app (додається під час збірки) або в `DATA_DIR/cliproxyapi` є pinned binary CLIProxyAPI (інакше стан `not_installed`, див. [розділ 7](#7-збірка-macos-app-з-коду)). Порт `127.0.0.1:8319` має бути вільним. Чужий proxy на 8317 Sigma ніколи не чіпає.

Скрипт `scripts/cliproxy-local.mjs login` бере каталог даних зі `SIGMA_DATA_DIR` (типово `.data` у корені проєкту), тому для встановленого app треба вказати каталог app data і запускати скрипт з клону репозиторію.

1. У Sigma: **Providers → Local model gateways → Antigravity · local CLIProxyAPI**, натиснути **Connect local proxy**. Це запускає proxy (стан `needs_login`, поки немає входу) і змушує Sigma запускати його при кожному старті.

2. Для встановленого app (з каталогу репозиторію):

   ```sh
   SIGMA_DATA_DIR="$HOME/Library/Application Support/dev.sigma.app" node scripts/cliproxy-local.mjs login
   ```

   Для source-запуску з типовими даними достатньо:

   ```sh
   node scripts/cliproxy-local.mjs login
   ```

   (з нетиповим `SIGMA_DATA_DIR` вказати ту саму змінну.)

3. Скрипт друкує «Complete Antigravity sign-in in the browser opened by CLIProxyAPI.» і відкриває браузер. Завершити вхід Antigravity. OAuth callback використовує порт 51122.
4. Коли команда завершиться, вона надрукує «Sign-in command ended. Connect or refresh the local proxy in Sigma to verify availability.» і виставить права `0600` на auth-файли.
5. У Sigma в тому ж місці натиснути **Connect local proxy** ще раз (після підключення кнопка стає **Refresh models**). Очікується стан `ready` і моделі `sigma-cliproxy`.

Якщо скрипт друкує «Local proxy could not run», перевірте, що binary справді встановлено в `DATA_DIR/cliproxyapi` і що `SIGMA_DATA_DIR` вказує на правильний каталог.

### 6d. Antigravity (unsupervised)

Вимкнено за замовчуванням. **Увага:** AGY виконує власні file/shell/browser tools **без Pi Allow/Deny**, Sigma лише показує повідомлене AGY read-only.

1. **Providers → Antigravity (unsupervised)**.
2. Увімкнути checkbox і підтвердити.
3. Працює лише для нових code-сесій у worktree; у Activity з'являється позначка «Executed by AGY (unsupervised)».
4. Вимкнення Stop-ає активні AGY runs.

## 7. Збірка macOS app з коду

Потрібні Rust toolchain і Cargo cache (див. [розділ 2](#2-вимоги)).

1. Зібрати relocatable Apple Silicon app/DMG з bundled Node і compiled runtime (мінімальна macOS 13.5):

   ```sh
   npm run desktop:build
   ```

   Збірка автоматично додає CLIProxyAPI в bundle, якщо існує `.data/cliproxyapi/bin/CLIProxyAPI-8.0.13` (sha256 перевіряється). Цей файл з'являється після одного запуску Sigma з source (`npm start`) за наявності binary. Збірка друкує `CLIProxyAPI CLIProxyAPI-8.0.13 staged ... (sha256 ...)`, якщо binary додано, або `No SIGMA_CLIPROXY_BINARY and no provisioned ...: CLIProxyAPI not staged` інакше. Тоді `npm run desktop:build` зупиняється ще до збірки app, бо збірка без proxy показувала б `not_installed`; `npm run desktop:dev` працює і без нього.

   `SIGMA_CLIPROXY_BINARY` потрібен лише як override для binary в іншому місці, наприклад:

   ```sh
   SIGMA_CLIPROXY_BINARY="$PWD/.data/cliproxyapi/bin/CLIProxyAPI-8.0.13" npm run desktop:build
   ```

   Якщо змінна вказує на неіснуючий файл, збірка зупиняється з чіткою помилкою; приберіть змінну, щоб використати типовий шлях.

2. Артефакти:
   - app: `.scratch/native-cargo-target/release/bundle/macos/Sigma.app`
   - DMG: `release/Sigma_<version>_aarch64.dmg` (корінь репозиторію; збірка також лишає копію в `.scratch/native-cargo-target/release/bundle/dmg/Sigma_<version>_aarch64.dmg`, яку перевіряє packaged-gate)

3. Окремі кроки: `npm run desktop:emit` (компіляція desktop runtime), `npm run desktop:package` (build + emit + пакування runtime), `npm run desktop:dev` (пакування і `tauri dev`).

4. Перевірка зібраних артефактів:

   ```sh
   node scripts/packaged-gate.mjs
   ```

   Опції: `--app <Sigma.app>`, `--dmg <Sigma.dmg>`, `--skip-launch`.

   Gate перевіряє app/DMG (manifest, hash, codesign на read-only mount) і запускає cold/restart/degraded/Quit gates. Кожен запуск використовує `SIGMA_QA=1` і свіжий ізольований `SIGMA_DATA_DIR`, тож реальні дані app не чіпаються. Порт 8319 має бути вільним. Evidence: `.scratch/packaged-gate-<ts>/`.

Сторонні licenses і Go notices входять у bundle. Підпис ad-hoc (sealed підпис, `codesign --verify --deep --strict` до DMG); notarization і public distribution поза scope. Старі `.data` і `work/tauri-data` автоматично не мігруються, лише явна міграція ([розділ 10](#10-browser-qa-cleanup-міграція)).

### Версіонування

SemVer. Поки версія нижче 1.0: кожна нова функція піднімає minor, кожне помітне виправлення чи правка UI піднімає patch; зміни лише в документації, лише в тестах і внутрішній рефакторинг не потребують підвищення. Версію піднімають один раз на злиту зміну:

```sh
npm run version:bump -- minor   # або patch, major, X.Y.Z
node scripts/bump-version.mjs   # перевірка: усі файли мають однакову версію
```

Скрипт синхронізує `package.json`, `package-lock.json`, `tauri.conf.json`, `Cargo.toml` і `Cargo.lock`; назва DMG слідує за версією.

### Оновлення

Sigma оновлює себе з GitHub Releases (`drenkas/Sigma`) через Tauri updater. Приблизно через 10 секунд після запуску, а потім кожні ~6 годин, застосунок перевіряє `https://github.com/drenkas/Sigma/releases/latest/download/latest.json`. Якщо є новіша версія, внизу бічної панелі з'являється невелика кругла кнопка завантаження (підказка: **Update to vX.Y.Z and restart**); натискання завантажує підписаний архів, перевіряє його публічним ключем із `tauri.conf.json`, замінює app, коректно зупиняє локальний сервіс і перезапускається. **Sigma → Check for Updates…** запускає перевірку вручну і показує ту саму кнопку (або діалог «актуальна версія»). Перевірка вимкнена в debug-збірках і при `SIGMA_DISABLE_UPDATER=1`.

Як випустити реліз:

```sh
npm run version:bump -- minor        # або patch
npm run desktop:build                # підписаний Sigma.app + DMG
npm run release:prepare              # release/Sigma_<v>_aarch64.app.tar.gz (+ .sig) і release/latest.json
```

Далі створити GitHub release з тегом `v<version>` і завантажити `release/Sigma_<version>_aarch64.dmg`, `release/Sigma_<version>_aarch64.app.tar.gz` та `release/latest.json`. `release:prepare` нічого не завантажує; `SIGMA_RELEASE_NOTES` додає опис змін у діалог оновлення.

- Приватний ключ updater лежить у `~/.tauri/sigma-updater.key` (можна змінити через `TAURI_SIGNING_PRIVATE_KEY_PATH`). Ніколи не комітити; якщо ключ втрачено, наявні інсталяції не оновлюються, і новий DMG доведеться встановити вручну.
- Перша інсталяція з DMG потребує одноразово правий клік → **Open** (ad-hoc підпис, без notarization). Оновлення, встановлені updater-ом, не отримують quarantine-прапорець, тож повторного запиту Gatekeeper немає.
- `Sigma.app` має лежати в `/Applications` (або в іншій теці з правом запису), щоб updater міг замінити app.

## 8. Перевірки

```sh
npm run build
```

`tsc --noEmit` і `vite build`.

```sh
npm run check
```

Авторитетна послідовна команда (`--test-concurrency=1`): ≈10 хв.

```sh
npm run check:parallel
```

Допоміжна; може давати fixture timeouts, тож результат авторитетним не вважати.

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Rust-тести.

```sh
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

```sh
node work/bench-all.mjs
```

Лише JS dispatch Node/Bun, не benchmark Pi/SSE/paint.

Node-тести запускаються з `SIGMA_APPROVAL_MODE=ask` (діє лише без збереженого вибору доступу), використовують offline провайдери й synthetic CLI в ізольованих HOME/agent/data під `.scratch/` (`SIGMA_TEST_DIR` — батьківський каталог). Тест CLIProxyAPI lifecycle потребує локального pinned binary. Assertions і production timeouts не послаблювати заради PASS.

## 9. Усунення проблем

| Симптом | Що робити |
|---|---|
| Порт 4318 зайнятий | Див. [Якщо порт 4318 зайнятий](#якщо-порт-4318-зайнятий) |
| Сервер відмовляється стартувати, бо `DATA_DIR` належить іншому серверу (lease) | Той самий каталог даних уже використовує інший запущений Sigma (source або app). Штатно завершити його (Ctrl+C або Cmd+Q) або взяти інший `SIGMA_DATA_DIR` |
| macOS блокує Sigma.app («cannot be opened», «damaged», «Apple could not verify») | Quarantine на ad-hoc збірці. Див. [розділ 3, крок 4](#3-варіант-a-macos-app-з-dmg): right-click → Open, Open Anyway або `xattr -dr com.apple.quarantine /Applications/Sigma.app` |
| `npm ci` падає або застосунок не стартує на старому Node | Перевірити `node -v`; потрібна 24.16+ |
| Providers показує `not_installed` для proxy | Збірка не знайшла binary. Один раз запустити Sigma з source, щоб з'явився `.data/cliproxyapi/bin/CLIProxyAPI-8.0.13`, і перезібрати звичайним `npm run desktop:build` ([розділ 7](#7-збірка-macos-app-з-коду)), або покласти pinned binary у `DATA_DIR/cliproxyapi/bin/CLIProxyAPI-8.0.13` |
| Proxy у стані `needs_login` | Виконати Antigravity login ([6c](#6c-local-cliproxyapi-antigravity-login)), потім ще раз **Connect local proxy** (після підключення **Refresh models**) |
| Порт 8319 зайнятий | Звільнити його (свій старий Sigma/proxy завершити штатно); чужий proxy на 8317 Sigma не чіпає. `packaged-gate.mjs` також вимагає вільний 8319 |
| Claude Code CLI просить login | Завершити вхід в офіційному `claude` і натиснути **Refresh status** |

## 10. Browser QA, cleanup, міграція

- **Browser QA** (Changes → Browser QA): owned Chrome for Testing (`SIGMA_QA_CHROMIUM`) у `sandbox-exec` на immutable preview; `qa_*` tools лише для qa-role агентів, з per-action approvals, якщо Full access вимкнено; QA gate до фінальної receipt. Desktop QA не реалізовано.
- **Cleanup**: sidebar → Archived → «Clean up archived sessions…»: preview і явне схвалення; видаляє лише чисті worktree/scratch архівних сесій.
- **Apply до source.** У сесії з окремим worktree **Changes → Prepare source Apply** копіює зміни в оригінальну папку після схвалення точного diff. Спершу пройдена перевірка (check) і review рекомендовані, але не обов'язкові; панель попереджає, якщо для поточної ревізії їх немає.
- **Міграція legacy даних** лише явно, одне джерело: `npm run migrate:preview -- --source <dir>`, `npm run migrate:stage -- --source <dir> --authorize <sha256>`, `npm run migrate:status`; публікація при старті (`SIGMA_MIGRATE_PUBLISH`). Деталі — [docs/FEATURES.md](docs/FEATURES.md).

## 11. Дані й безпека

- Дані: `.data/` або `SIGMA_DATA_DIR` (source), `~/Library/Application Support/dev.sigma.app` (native app); права каталогу `0700`. SQLite WAL зберігає lifecycle/commands/approvals/events; Pi SDK: JSONL історію й credentials.
- Сервер слухає лише loopback, перевіряє Host, Origin і HttpOnly cookie (з портом у назві).
- Дозволені інструменти (крім unsupervised AGY): `read` конкретного файла, `ls` каталогу, у Code `edit`/`write`. Credential roots застосунку (AGY/proxy/SDK) недоступні файловим інструментам навіть після Allow; symlinks/hardlinks fail closed.
- **Інструмент `bash` («Run command»)**: кореневі Code/Parallel-сесії та всі делеговані агенти (planner, researcher, worker, reviewer, QA) можуть виконувати shell-команди: `npm test`, `npm install`, `git`, лінтери, build-інструменти, `curl` тощо. Недоступний для read-only кореневих сесій, координаторів multi-repository, незалежного ревʼюера ревізії та unsupervised AGY. Команда виконується на хості через `/bin/zsh -lc` у власній папці агента (вибрана папка або її ізольований worktree), з доступом до мережі та вашим оточенням без внутрішніх змінних Sigma і ключів провайдерів (`SIGMA_*`, `PI_*`, `*_API_KEY`, `*_TOKEN`, ...). Запуск іде під macOS `sandbox-exec`, який забороняє читання й запис лише credential-файлів: файлів типу `auth.json` (`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, `~/.claude/.credentials.json`, `credentials.json` тощо у прихованих папках home), `~/.cli-proxy-api/`, `agent-access.json`, `native-providers.json`, `state.sqlite` та sign-in-папок CLIProxyAPI і Antigravity і key-файлів Pi SDK Sigma; решта, зокрема інше в цих папках, лишається доступною; без `sandbox-exec` команда не виконується. В Ask-режимі кожна команда потребує Allow/Deny, повна команда показується до запуску; у Full access вона запускається одразу, але записується в Approvals та Activity (команда й код виходу). Тайм-аут за замовчуванням 300 с (до 1800 с); вивід обмежено останніми 30 KB; вся група процесів команди завершується за тайм-аутом, після Stop і при виході з Sigma. **Увага:** команда може змінити чи видалити все, до чого має доступ ваш обліковий запис (домашня папка, інші проєкти, встановлені інструменти), і користуватися мережею; sandbox захищає лише credential-файли. Якщо не довіряєте завданню — використовуйте Ask-режим.
- Після crash невизначені дії стають `unknown` і не повторюються автоматично.
- Це host-перевірки, а не OS-ізоляція від іншого процесу того ж користувача.
