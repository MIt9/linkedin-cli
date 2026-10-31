# linkedin-cli

CLI для LinkedIn через локальний сервіс і розширення Chrome (`extension/`). Замінює MCP-міст `linkedin-ex`, не змінюючи його. Усі команди — у [COMMANDS.md](COMMANDS.md).

```
linkedin (CLI)  --HTTP+токен-->  локальний сервіс (Bun, 127.0.0.1:47851)  --WebSocket /ext-->  розширення Chrome  -->  LinkedIn
```

Сервіс — єдиний власник черги (SQLite), бюджету дій, стану зупинки та з'єднання з розширенням. Вони не залежать від агента чи його інструкцій.

> Статус: усе перевірено автотестами з фальшивим розширенням; скомпільований бінарник, `install.sh` і `extension install` перевірено локально у тимчасових каталогах. Наживо на LinkedIn, у справжньому Chrome (завантаження розширення, `reload`) і справжнє завантаження оновлення з віддаленого хоста не перевірялися. Підпису й нотаризації macOS немає.

## Встановлення

Chrome Web Store не використовується: CLI — один скомпільований бінарник (розширення вбудоване в нього), розширення вантажиться в Chrome як unpacked зі **стабільного каталогу** `~/.linkedin-cli/extension`.

### Для користувача macOS (бінарник)

```sh
curl -fsSL https://github.com/MIt9/linkedin-cli/releases/latest/download/install.sh | sh
# або, з клону:  sh scripts/install.sh
# інше джерело:  LINKEDIN_CLI_BASE_URL=https://ВАШ.ХОСТ/linkedin-cli sh scripts/install.sh
```

Типове джерело: `https://github.com/MIt9/linkedin-cli/releases/latest/download` (GitHub Releases, остання версія). Якщо `install.sh` отримав 404 на типовому URL і `gh` авторизований (`gh auth status`), він спробує `gh release download`; інакше зупиниться з повідомленням "release not found" (перевірте URL і що реліз існує). Для власного `LINKEDIN_CLI_BASE_URL` fallback не вмикається.

`scripts/install.sh` (POSIX sh, без `sudo`, можна запускати повторно): визначає архітектуру (`arm64`/`x64`), бере `latest.json` за `LINKEDIN_CLI_BASE_URL`, перевіряє sha256, ставить `~/.local/bin/linkedin` (попередній бінарник лишається як `linkedin.old`) і запускає `linkedin extension install --text`. Якщо `~/.local/bin` не в `PATH`, скрипт наприкінці надрукує рядок для `~/.zshrc` (сам файл не змінює):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Gatekeeper: бінарник **не підписаний і не нотаризований** (підпис Apple Developer ID і нотаризація не робилися). Завантаження через `curl`/`install.sh` не ставить мітку карантину, тож зазвичай запускається без запитань. Якщо ви завантажили архів браузером і macOS пише, що програму не можна відкрити, зніміть мітку:

```sh
xattr -d com.apple.quarantine ~/.local/bin/linkedin
```

### Перший запуск і підключення розширення

```sh
linkedin extension install --text --open   # копіює розширення в ~/.linkedin-cli/extension, відкриває chrome://extensions
linkedin service start
linkedin doctor --text
```

За замовчуванням команди друкують JSON (його читають агенти). Для людини є прапорець `--text` (`extension install`, `doctor`, `update`): коротке пояснення звичайною мовою. `install.sh` сам викликає `linkedin extension install --text`, тож після `curl ... | sh` ви бачите:

```
Extension 0.2.4 installed to /Users/you/.linkedin-cli/extension
Extension ID: pkgbinmnaaomjnafdfocndamjhaaoffl
Path copied to clipboard

Next, in Chrome:
  1. Open chrome://extensions
  2. Turn on Developer mode (top right)
  3. If an older 'LinkedIn CLI Bridge' is loaded, click Remove (the extension ID changed in 0.2.x; Reload is not enough)
  4. Click Load unpacked, press Cmd+Shift+G in the folder dialog, paste the path (Cmd+V) and confirm
  5. Then run: linkedin service start && linkedin doctor

Done: linkedin 0.2.4 installed to /Users/you/.local/bin/linkedin.
Now finish the Chrome steps above; the last one starts the service and checks everything.
```

Рядок «Path copied to clipboard» з'являється, лише якщо `pbcopy` спрацював; якщо файли вже були актуальні, перший рядок скаже `already installed ... (files unchanged)`, а якщо стару папку замінено, буде `Previous folder kept as ...extension.bak`. Без `--text` `extension install` друкує JSON із `path`, `extensionId` і трьома ручними кроками.

`linkedin doctor --text` друкує по рядку на перевірку, для збоїв додає відступний рядок `fix:` і підсумок (код виходу 1 лишається):

```
[ok] binary version: linkedin 0.2.4 (/Users/you/.local/bin/linkedin)
[FAIL] service running: not running
    fix: Run `linkedin service start`.
Problems found: 1 of 9 checks failed. Apply the fix lines above, then run: linkedin doctor --text
```

Це робиться один раз: каталог стабільний, а ID розширення зафіксований ключем у `manifest.json` (`pkgbinmnaaomjnafdfocndamjhaaoffl`). Сервіс приймає `/ext` лише від `chrome-extension://<цей ID>`. `linkedin service status` має показати `extensionPinned: true`, `connected: true`, `match: true`.

> Міграція з 0.1.x: розширення, раніше завантажене з `extension/` репозиторію, мало інший ID (без ключа) і новий сервіс його не прийме. Видаліть його (Remove) в `chrome://extensions` і додайте `~/.linkedin-cli/extension` (Load unpacked).

Стан зберігається в `~/.linkedin-cli` (змінна `LINKEDIN_CLI_DIR`, права 700), порт — `47851` (змінна `LINKEDIN_CLI_PORT` або `linkedin config set port N`, див. «Конфлікт порту»). Там лежать `state.db` (черга, журнал дій), `token` (права 600), `service.pid`, `service.log`, `extension/`.

### Для розробника (з вихідників)

Потрібен [Bun](https://bun.sh) ≥ 1.2.

```sh
cd linkedin-cli
bun install
bun link            # додає команду `linkedin` (працює з src/, без збірки); або: bun src/cli.ts ...
linkedin extension install   # бере розширення з ./extension
```

Збірка релізу: `bun scripts/build.ts` (архітектура цієї машини) або `bun scripts/build.ts --all` (`arm64` + `x64`; крос-ціль потребує мережі, щоб Bun завантажив рантайм). У `dist/` з'являються `linkedin` (для локальної перевірки), `linkedin-<версія>-darwin-<arch>.tar.gz`, `extension-<версія>.tar.gz` і `latest.json` із sha256. Розширення вбудовується в бінарник константою часу компіляції `EXT_BUNDLE_JSON` (`{шлях: base64}`), окремих файлів поряд із бінарником немає. Збірка відмовляється, якщо `major.minor` розширення і пакета різні (версії піднімаються разом). `dist/` у git не потрапляє: бінарники живуть лише в GitHub Releases (див. «Реліз»).

## Використання

Результат — JSON на stdout. Помилка — JSON на stderr і ненульовий код виходу.

```sh
linkedin people search --keywords "react tech lead" --network 2
linkedin people profile https://www.linkedin.com/in/some-slug/ --no-details
linkedin post list --limit 5
```

### Довідка (`--help`)

Кожна команда та кожен параметр мають опис. Довідка береться з тієї самої таблиці `src/commands.ts`, за якою працює розбір і валідація прапорців, тож розходитися вони не можуть.

```sh
linkedin --help                       # групи з описами
linkedin post --help                  # команди групи
linkedin post publish --help          # опис, side effect, ліміти, параметри, вивід, приклади
linkedin help post publish            # те саме (help <група> [команда])
linkedin post publish --help --json   # структурована довідка для агентів
```

Вибір: звичайний результат команд завжди JSON, а **`--help` за замовчуванням друкує читабельний текст** (також у pipe); структурований JSON — лише з `--json`. JSON-довідка команди: `description`, `sideEffect` (`read|outward|destructive|local`), `notes` (для зовнішніх дій: без `--confirm` лише preview, ліміти), `output`, `examples`, `arguments` і `options`. Кожен параметр має `type` (`string|number|boolean|enum`), `required`, `repeatable`, `description`, а за потреби `default`, `min`/`max`, `values`. Хибне значення enum або число поза діапазоном → код 2 (USAGE) з переліком допустимих значень.

### Зовнішні дії: preview і `--confirm`

Публікація, планування, запрошення, повідомлення, коментар, відповідь, лайк коментаря, відповідь на запрошення, відкликання, видалення запланованого, `browser click/type` та `queue enqueue` таких дій без `--confirm` нічого не надсилають, а повертають `{"preview": true, ...}` з точними аргументами й станом бюджету.

```sh
linkedin comment add POST_URL --text "Дякую!"             # preview
linkedin comment add POST_URL --text "Дякую!" --confirm   # виконання
```

Обмеження, які примусово виконує сервіс:

- спільний бюджет 15 дій на годину і 60 на добу (post, schedule, connect, message send, comment, reply, like comment); запрошення — ще 20 за 24 год;
- пауза 20–30 с між зовнішніми діями;
- перевірка медіа (існування, тип, справжній вміст зображення, 1 відео без зображень, до 20 зображень) і вкладень (звичайний файл, 1 Б – 20 МБ);
- стан **HALTED** після checkpoint/captcha/логіну (відповідь розширення `code: "HALT"`): усі виклики відхиляються, поки не виконано `linkedin service resume`;
- невідомий результат дії (розрив, тайм-аут, перезапуск сервісу під час виконання) → `unverified`, ніколи не повторюється автоматично.

### Черга

```sh
linkedin queue enqueue commentPost --args '{"post":"URL","text":"Привіт"}' --key my-1 --confirm
linkedin queue enqueue schedule --args '{...}' --not-before 2026-11-01T09:00:00Z --confirm
linkedin queue list --status unverified
linkedin queue get 12          # також: queue show 12
linkedin queue cancel 12       # лише для queued
```

Стани: `queued`, `running`, `done`, `failed`, `cancelled`, `unverified`. Один воркер виконує завдання по черзі. Той самий `--key` повертає наявне завдання.

### Конфлікт порту

Порт за замовчуванням — `47851`. Порядок вибору: змінна `LINKEDIN_CLI_PORT` > `~/.linkedin-cli/config.json` > `47851`.

**Симптом:** `linkedin service start` завершується кодом 8 і помилкою `PORT_IN_USE`: порт зайнятий іншим процесом (повідомлення називає порт і, якщо знайдено через `lsof`, PID власника). Сервіс при цьому не запускається, `service.pid` не лишається. Те саме дає `service run` у передньому плані.

**Сервіс старої версії** (без заголовка `x-linkedin-cli`) не вважається чужим процесом: якщо pid із `service.pid` живий і це `service run` / наш бінарник або власник порту, `service status` його бачить, а `service stop` зупиняє його сигналом SIGTERM (до 5 с очікування), після чого `service start` працює як звичайно.

**Як змінити порт:**

```sh
linkedin config set port 50123      # ціле число 1024-65535; інше — помилка USAGE
linkedin service stop               # якщо сервіс уже працює на старому порту
linkedin service start
linkedin service status             # port і extensionUrl: ws://127.0.0.1:50123/ext
```

`linkedin config get [port]` показує поточне значення й джерело (`env`/`config`/`default`), `linkedin config unset port` повертає типовий порт. Якщо порт у конфігурації змінено, а сервіс ще працює на старому, `service status` покаже `port` (де він працює), `configuredPort` і `portMismatch: true`; щоб застосувати новий порт, перезапустіть сервіс.

**Розширення Chrome:** відкрийте popup розширення «LinkedIn CLI Bridge» і введіть той самий порт (поле зберігається в `chrome.storage` під ключем `cli_port`, типово `47851`). Готовий URL — поле `extensionUrl` у `linkedin service status`. Після зміни порту переконайтеся, що `service status` показує `connected: true`.

### Коди виходу

| Код | Назва | Значення |
|---|---|---|
| 0 | OK | Успіх (включно з preview) |
| 1 | FAILED | Помилка розширення, скасоване завдання, внутрішня помилка, сервіс уже запущено |
| 2 | USAGE | Невірні прапорці або аргументи; відхилена валідація (`INVALID`); невідоме завдання (`NOT_FOUND`) |
| 3 | SERVICE_UNAVAILABLE | Сервіс не запущено, недоступний або відхилив токен |
| 4 | UNVERIFIED | Результат невідомий: перевірте LinkedIn, не повторюйте наосліп |
| 5 | HALTED | Зупинка (checkpoint/captcha/логін). Вирішіть у Chrome, потім `service resume` |
| 6 | RATE_LIMIT | Бюджет вичерпано; `error.retryAt` — epoch мс |
| 7 | EXTENSION_UNAVAILABLE | Розширення не підключене (`EXTENSION_NOT_CONNECTED`) або несумісна версія (`VERSION_MISMATCH`) |
| 8 | PORT_IN_USE | Порт сервісу зайнятий іншим процесом; змініть його: `linkedin config set port N` |

Помилка на stderr: `{"error":{"code":"RATE_LIMIT","message":"...","retryAt":1730000000000}}`.

## Реліз

Релізи робить git-хук `.githooks/pre-push`: реліз у GitHub створюється при `git push` тега `v*`. Chrome Web Store не використовується.

**Один раз після клонування** (хуки не клонуються разом із репозиторієм):

```sh
bun run hooks      # = sh scripts/install-hooks.sh: git config core.hooksPath .githooks (повторний запуск безпечний)
```

**Процедура:**

```sh
# 1. однакова нова версія в package.json і extension/manifest.json
# 2. git commit -am "0.2.3: ..."
git tag v0.2.3                      # лише легкий тег, не annotated
git push origin main                # коміт має вже бути на remote (див. нижче)
git push origin v0.2.3              # тут спрацьовує хук
```

Хук реагує **лише** на `refs/tags/v*`; будь-який інший push він пропускає мовчки. Для тега він по черзі:

1. перевіряє, що тег = `v` + версія з `package.json` = `v` + версія з `extension/manifest.json`, що тег легкий (не annotated), вказує на поточний `HEAD`, що робоче дерево чисте і що коміт уже є на remote;
2. запускає `bun test` і `bun run typecheck`;
3. збирає реліз (`bun run build`). За замовчуванням лише архітектура цієї машини (`RELEASE_TARGETS=host`); `RELEASE_TARGETS=all` додає `--all` (arm64 + x64), для крос-цілі Bun потрібна мережа. Хук друкує `built arches: …`;
4. перевіряє `dist/latest.json`: версія, і для кожного зібраного архіву та розширення є запис із sha256, що збігається з файлом; зайвих `.tar.gz` у `dist/` немає;
5. якщо реліз для тега вже існує (`gh release view`), зупиняється: існуючі релізи ніколи не перезаписуються;
6. виконує `gh release create <тег> --target <sha коміту> --title <тег> --notes <git log від попереднього v*-тега> dist/*.tar.gz dist/latest.json scripts/install.sh`. `install.sh` потрапляє в асети, тож працює `releases/latest/download/install.sh`.

Будь-який збій дає ненульовий код: push скасовується, хук пише, що саме впало і як повторити (`git push origin <тег>`).

| Змінна | Дія |
| --- | --- |
| `SKIP_RELEASE=1` | хук пропускається (одним рядком повідомляє про це) |
| `RELEASE_DRY_RUN=1` | усі перевірки і збірка виконуються, але `gh release create` лише друкується, а не запускається |
| `RELEASE_TARGETS=host\|all` | які архітектури збирати, типово `host` |
| `RELEASE_TEST_CMD`, `RELEASE_TYPECHECK_CMD`, `RELEASE_BUILD_CMD` | замінюють `bun test`, `bun run typecheck`, `bun run build` (для тестів хука) |

Спробувати без публікації: `RELEASE_DRY_RUN=1 git push origin v0.2.3` (сам тег при цьому все одно піде на remote, якщо хук завершиться успішно).

**Обмеження.**

- `pre-push` виконується **до** передачі даних. Тому коміт має бути на remote заздалегідь (`git push origin main` окремо перед тегом: `gh` створює реліз на боці GitHub, і він не знайде ще не відправлений коміт; хук це перевіряє за `refs/remotes/<remote>`). Тег також має бути легким: `gh` створює тег на GitHub сам, а annotated-тег із іншим об'єктом push потім відхилить.
- Якщо реліз створено, а сам push після хука відхилено (наприклад, non-fast-forward), реліз залишається. Виправте причину й відправте тег ще раз: `git push origin <тег>` (хук побачить, що реліз існує, і зупиниться; тоді або `SKIP_RELEASE=1 git push origin <тег>`, або видаліть реліз вручну й повторіть).
- Хук і `gh` працюють з репозиторієм за замовчуванням для `gh` (remote `origin`).
- Реальне створення релізу в GitHub у цьому репозиторії поки не перевірялося (лише локальний bare-репозиторій і фальшивий `gh`).

## Версії, оновлення, відкат

Версії сервісу і розширення сумісні, якщо збігаються `major.minor`. Розширення при підключенні надсилає `hello`; при невідповідності сервіс відповідає `reject`, а виклики повертають код 7.

### Оновлення

```sh
linkedin update --check     # типове джерело: https://github.com/MIt9/linkedin-cli/releases/latest/download
# інше джерело (необов'язково): linkedin config set update_url https://ВАШ.ХОСТ/linkedin-cli  (або env LINKEDIN_CLI_UPDATE_URL); лише https, http лише для localhost;
# `linkedin config unset update_url` повертає типове
linkedin update --check     # порівняти версії, нічого не змінює
linkedin update
```

`update` завантажує бінарник і розширення з `latest.json`, перевіряє sha256 (і що новий бінарник запускається), атомарно підміняє бінарник (попередній стає `<бінарник>.old`), оновлює `~/.linkedin-cli/extension` (інша версія зберігається як `extension.bak`). Далі, **лише якщо жодне завдання не `running`**, перезапускає сервіс і просить розширення перезавантажитися (`{type:"reload"}` через `/ext`; воно перепідключається до нового сервісу протягом ~30 с). Якщо завдання виконуються, `update` повідомить про це й пропустить перезапуск та reload: пізніше виконайте `linkedin service stop && linkedin service start` і Reload розширення в `chrome://extensions`. Працює лише для скомпільованого бінарника; з вихідників — `git pull`. Міграції `state.db` застосовуються автоматично й лише вперед; перед великим оновленням скопіюйте `~/.linkedin-cli/state.db`.

### Відкат

- Бінарник: `mv ~/.local/bin/linkedin.old ~/.local/bin/linkedin` (якщо ставили не в `~/.local/bin` — поряд із вашим бінарником), потім `linkedin service stop && linkedin service start`.
- Розширення: `rm -rf ~/.linkedin-cli/extension && mv ~/.linkedin-cli/extension.bak ~/.linkedin-cli/extension`, потім Reload у `chrome://extensions`.
- Версії CLI і розширення мають збігатися за `major.minor`, тож відкочуйте обидва.

### Діагностика: `linkedin doctor`

Перевіряє: версію бінарника, права каталогу стану (700) і `token` (600), чи працює сервіс, порт (вільний чи наш), підключення розширення, сумісність версій, чи файли розширення в `~/.linkedin-cli/extension` ті самі, що вбудовані в бінарник, стан HALTED, наявність Chrome. Результат — JSON `{ok, checks:[{name, ok, detail, fix}]}`; для кожної невдалої перевірки `fix` каже, що робити. Код виходу 1, якщо хоч одна перевірка не пройдена.

### Видалення

```sh
linkedin service stop
rm -f ~/.local/bin/linkedin ~/.local/bin/linkedin.old
rm -rf ~/.linkedin-cli        # УВАГА: це й черга, журнал дій і токен (state.db)
```

Розширення видаліть у `chrome://extensions` (Remove). Рядок `export PATH=...` у `~/.zshrc`, якщо додавали, приберіть вручну.

## Відновлення після збою

- **Сервіс упав або вбитий.** Просто `linkedin service start`: застарілий pid-файл замінюється. Завдання `queued` збережено. Завдання, що були `running`, стають `unverified` (зовнішні дії) або повертаються в `queued` (читальні). Зовнішні дії **не** повторюються: перевірте LinkedIn вручну (`linkedin queue list --status unverified`), потім за потреби поставте нове завдання.
- **`unverified`.** Відкрийте LinkedIn, перевірте, чи дія відбулася. Журнал спроб — таблиця `actions` у `state.db`.
- **Кінець бюджету (код 6).** Зачекайте до `retryAt`; завдання з черги чекають самі.
- **HALTED (код 5).** Відкрийте Chrome, пройдіть перевірку LinkedIn вручну, потім `linkedin service resume` (сервіс також знімає зупинку в розширенні). Стан зупинки зберігається після перезапуску сервісу.
- **Сервіс не стартує.** Дивіться `~/.linkedin-cli/service.log`. «Already running» — інший екземпляр тримає pid-файл/порт; `linkedin service stop`. Якщо порт зайнято сторонньою програмою — змініть `LINKEDIN_CLI_PORT` (і URL у розширенні).
- **Розширення не підключається.** Chrome має бути запущений, розширення увімкнене; будильник перепідключає кожні ~30 с.

## Безпека

Сервіс слухає лише `127.0.0.1`. CLI автентифікується токеном із файлу з правами 600; запити з заголовком `Origin` (веб-сторінки) відхиляються. До `/ext` приймаються лише з'єднання з `Origin: chrome-extension://<ID>`, де ID виводиться з поля `key` у маніфесті розширення (`extensionPinned: true`). Якщо ключа немає, приймається будь-який `chrome-extension://` і `service status` покаже `extensionPinned: false` (попередження в `service.log`).

## Публічний репозиторій

Публічні тут вихідний код, тести, документація і релізи (бінарник, `latest.json`, `install.sh`); ваші дані, токен і `state.db` лишаються лише на вашому комп'ютері. Інструмент автоматизує LinkedIn, а це порушує User Agreement LinkedIn; відповідальність за використання (і за можливі обмеження акаунта) несете ви.

- Бінарник не підписаний і не нотаризований (див. примітку про Gatekeeper вище).
- Сервіс слухає лише `127.0.0.1`, файл токена має права 600, жодні дані не залишають вашу машину (окрім самих запитів до LinkedIn із вашого Chrome і перевірки оновлень на `update_url`).

Ліцензію поки не обрано, тож за замовчуванням усі права захищені автором.

## Розробка

```sh
bun test && bun run typecheck
bun scripts/build.ts      # dist/: бінарник, tar.gz, latest.json
bun run hooks             # один раз після клонування: git-хуки з .githooks
```

Тести запускають справжній сервіс на тимчасовому порту й каталозі та підключають до нього фальшиве розширення. Змінні `LINKEDIN_CLI_LIMIT_HOUR`, `LINKEDIN_CLI_LIMIT_DAY`, `LINKEDIN_CLI_GAP_MIN_MS`, `LINKEDIN_CLI_GAP_MAX_MS`, `LINKEDIN_CLI_CALL_TIMEOUT_MS` існують лише для тестів; не задавайте їх у щоденній роботі. Так само `LINKEDIN_CLI_EXT_SRC` (каталог розширення замість вбудованого), `LINKEDIN_CLI_BINARY_PATH` (який бінарник замінює `update`) і `LINKEDIN_CLI_RELOAD_WAIT_MS`.
