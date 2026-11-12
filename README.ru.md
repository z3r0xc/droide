<p align="center"><a href="./README.md">English</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.zh-CN.md">中文</a></p>

<div align="center">
  <img src="./docs/assets/hero.svg" width="100%"
       alt="Droide — терминальный кодинг-агент, восстановленный по своей спецификации; одна настоящая цепочка из репозитория: spec → код → тест">
</div>

**Droide** — clean-room реализация `droid` CLI v1.9.0: та же поверхность
команд, страницы help, отказы и коды выхода, восстановленные по
письменной спецификации, а не по скопированным исходникам.

Продуктовый слой — TypeScript: Node 24, ESM, типы срезаются при загрузке, шага
сборки нет. Нативный слой — Rust, за одним дочерним процессом на JSON-lines.
Оба написаны против одного контракта: [`specs/`](./specs/README.md).

## Зачем это существует

Поставляемый результат — спецификация. Реализация — это проверка того, что
спецификация достаточно полна и однозначна, чтобы по ней можно было строить.

- **SDD — сначала spec.** У каждой подсистемы один документ в `specs/`, и
  ничего не реализуется до того, как оно специфицировано. Пункты помечены
  `[observed]`, `[derived]` или `[inferred]`, и каждый несёт ссылку —
  восстановленный файл и номер строки либо записанный golden.
- **ADD — решения как записи.** Всё, что ограничивает структуру, — это ADR
  в [`docs/adr/`](./docs/adr/0000-template.md), написанный в момент принятия
  решения. Разделение на два рантайма —
  [ADR 0002](./docs/adr/0002-hybrid-rust-typescript-layers.md); правило, что
  код субъекта не копируется, —
  [ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md).
- **TDD — пункты компилируются в тесты.** Каждый поведенческий пункт называет
  хотя бы один детерминированный тест: без сети, без учётных данных, без
  системных часов. Там, где реализация покрывает меньше своего пункта, код
  говорит об этом маркером `TODO(spec …)`, а
  [`docs/gaps.md`](./docs/gaps.md) это перечисляет.

## Статус

Что работает сегодня — проверено на этом дереве:

| Поверхность | Сейчас |
| --- | --- |
| `--version`, `--help`, help подкоманд | работает — сообщает `1.9.0`; 20/20 записанных parity-кейсов против субъекта (goldens локальные, см. [ADR 0004](./docs/adr/0004-parity-harness-with-optional-oracle.md)) |
| `doctor` | работает — 16 именованных проверок; десять из них — реальные пробы (config, environment, system, binaries, filesystem, git, proxy, certs, auth, mcp), остальные сообщают `skip` с указанием причины |
| `search` / `find` | работает — обслуживается локальным индексом транскриптов с доказывающим откатом на буквальный скан; `--reindex` обновляет его |
| `mcp list`, `mcp add`, `mcp remove`, `mcp permissions` | работают — объединённая конфигурация, точечные правки JSONC с сохранением комментариев, атомарные записи, список, отзыв и очистка разрешений |
| `plugin list`, `plugin marketplace`, `plugin install`, `plugin uninstall`, `plugin update` | работают — маркетплейсы на git, валидируемые до принятия, атомарные слияния реестра, отказы при коллизиях и битых ссылках |
| `exec` | работает для вывода `text`, `json` и `stream-json` с промптом, `-f` или stdin, продолжением сессии и потоковым вводом; `stream-jsonrpc`, ACP, `--mission` и `--list-tools` отказывают |
| `resume` | работает — перечисляет сессии, принимает UUID или ссылку, продолжает через путь `exec -s`, форкает с `--fork` |
| `daemon` | работает локально — транспорт WebSocket, JSON-RPC, шлюз аутентификации, единственный экземпляр, упорядоченное завершение; Remote Control и прокси порта заявлены, но не построены |
| `droide` без аргументов | запускает интерактивную оболочку на паре TTY; введённый промпт выполняет ход агента с потоковыми строками, подтверждениями и отменой по Esc |
| нативный хелпер | 15 JSON-lines-методов (включая PTY-сессии), типизированы и валидируются на стороне TypeScript, 69 Rust-тестов, плюс контрактный тест, который запускает настоящий процесс через скомпилированный бинарник (`npm run test:native`) — **пока не подключены к исполнению инструментов** |
| набор тестов | 1096 тестов в 116 файлах: 1090 проходят, 6 пропущены, плюс 69 Rust-тестов |

`exec` требует учётных данных модели. Без них он отказывает, а не угадывает:

```console
$ node bin/droide.mjs exec -o json "hi"
Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.
```

Заявлено, в работе:

| Поверхность | Состояние |
| --- | --- |
| `mcp auth` | PKCE, loopback-колбэк, обмен токена и герметичное хранилище учётных данных реализованы и протестированы; команды, которая их связывает, нет |
| `computer register\|remove\|ssh\|port-forward`, `update` без `--check` | опции разбираются, help печатается, любое действие отказывает с кодом 1 или 2 |
| хранилища учётных данных macOS/Linux | существует только Windows DPAPI; хранилище отказывает, а не пишет открытым текстом |
| Remote Control, relay и прокси порта; интерактивный выбор сессии | заявлены в `specs/70` и `specs/10`; `docs/gaps.md` называет каждый пункт |
| нативный слой внутри рантайма инструментов | хелпер протестирован end to end, но инструменты пока достигают его через fake |

Отказ намеренный и наблюдаемый — код 64 для команды, которая специфицирована,
но не построена, код 1 для опции, которой нет:

```console
$ node bin/droide.mjs update
droide: the "update" command is specified but not implemented in this build.

$ node bin/droide.mjs exec --list-tools
--list-tools is not implemented in this build.
```

Текущая форма дерева: 11 нумерованных документов спецификации — общий контекст
плюс десять подсистемных спек, 9,333 строки в `specs/` — 123 TypeScript-файла
в `src/` (33,069 строк), 8 Rust-файлов в `crates/droide-native/src/`, 7 ADR,
906 TypeScript-тестов и 57 Rust-тестов. Каждое место, где реализация покрывает
меньше цитируемого пункта, помечено `TODO(spec …)` в коде и посчитано в
[`docs/gaps.md`](./docs/gaps.md), который перегенерирует `npm run gaps`.

## Быстрый старт

Node 24 или новее и Rust-toolchain для нативного слоя.

```sh
npm ci                          # install once; there is no build step
node bin/droide.mjs --version   # 1.9.0
node bin/droide.mjs --help
node bin/droide.mjs doctor      # 16 named checks (9 реальных проб), text or --json
node bin/droide.mjs mcp list
node bin/droide.mjs search x --json
npm test                        # 906 tests
npm run typecheck
npm run test:parity             # 20/20
cargo test --workspace          # 57 tests
```

`exec` — поверхность для машин (`text`, `json`, `stream-json`):

```sh
node bin/droide.mjs exec "review app.tsx"
node bin/droide.mjs exec -o json "review app.tsx"
node bin/droide.mjs exec -f prompt.txt --auto low
```

## Архитектура

<div align="center">
  <img src="./docs/assets/architecture.svg" width="100%"
       alt="Архитектура: продуктовый слой на TypeScript в src/ вызывает один процесс-хелпер на Rust по JSON-строкам UTF-8, версия протокола 1">
</div>

- **`src/` — продуктовый слой, TypeScript.** `cli/` разбирает аргументы и
  владеет help и отказами; `agent/` — цикл хода и модель сообщений; `tools/` —
  реестр, валидаторы, матрица разрешений и инструменты fs/shell/todo;
  `session/` — хранилище, миграции, транскрипт и поиск; `transport/` — SSE,
  дельты LLM и идентичность ошибок; `ui/` — таблицы токенов, компоненты и
  рендерер кадров; `app/` — связка между ними.
- **Граница — один дочерний процесс и одна строка на сообщение.** Запросы —
  `{"id","method","params"}`, ответы — `{"id","result"}` или
  `{"id","error":{"code","message"}}`, UTF-8, версия протокола 1, строки
  запросов ограничены 1 MiB. Клиент (`src/native/client.ts`) сопоставляет
  ответы по id и считает каждый ответ недоверенным вводом.
- **`crates/droide-native/` — нативный слой, Rust.** `main.rs` — цикл stdio,
  который сбрасывает один кадр на запрос; `protocol.rs` кадрирует и
  диспетчеризует; `paths.rs` обеспечивает containment; `search.rs` обходит и
  ищет; `sandbox.rs` описывает профили bubblewrap, seatbelt или «без изоляции»;
  `pty.rs` квотирует командную строку так, как её переразбивает субъект;
  `secrets.rs` хранит секреты через DPAPI в Windows.
- Методов пятнадцать: `native.version`, `hash.sha256`, `search.walk`,
  `search.text`, `path.resolve`, `sandbox.profile`, `pty.quote`, `pty.spawn`,
  `pty.read`, `pty.write`, `pty.resize`, `pty.kill`, `pty.close`,
  `secrets.protect`, `secrets.unprotect`. TypeScript-клиент валидирует форму
  каждого ответа, у хелпера свои тесты, а `npm run test:native` прогоняет
  контракт против скомпилированного бинарника. Слой инструментов пока достигает
  хелпера только через fake, так что подключение — следующий шаг.

## Спецификации и решения

| Документ | Тема |
| --- | --- |
| [`00-context.md`](./specs/00-context.md) | общий контекст: субъект, его доказательства и словарь |
| [`10-cli-surface.md`](./specs/10-cli-surface.md) | команды, опции, help, отказы, коды выхода |
| [`20-agent-loop.md`](./specs/20-agent-loop.md) | модель сообщений, цикл хода, адаптер провайдера |
| [`30-tools-and-sandbox.md`](./specs/30-tools-and-sandbox.md) | реестр инструментов, валидаторы, разрешения, песочница |
| [`40-sessions-and-storage.md`](./specs/40-sessions-and-storage.md) | файлы сессий, миграции, транскрипт, поиск |
| [`50-transport-and-auth.md`](./specs/50-transport-and-auth.md) | URL, заголовки, SSE, идентичность ошибок, аутентификация |
| [`60-extensions-mcp-and-skills.md`](./specs/60-extensions-mcp-and-skills.md) | серверы MCP, именование инструментов, skills, плагины |
| [`70-daemon-and-remote-control.md`](./specs/70-daemon-and-remote-control.md) | поверхность RPC демона и удалённое управление |
| [`80-exec-and-streaming.md`](./specs/80-exec-and-streaming.md) | неинтерактивные запуски и форматы потоков |
| [`90-native-layer.md`](./specs/90-native-layer.md) | процесс-хелпер и его методы |
| [`95-terminal-ui.md`](./specs/95-terminal-ui.md) | токены, возможности терминала, раскладка оболочки, кадры |

Словарь статусов — `draft`, `review`, `stable`, `blocked` — определён в
[`specs/README.md`](./specs/README.md); состояние по каждой спеке лежит в
[`docs/status.md`](./docs/status.md), а вехи и их гейты — в
[`docs/plan.md`](./docs/plan.md). Как была восстановлена каждая часть субъекта,
отображено в [`docs/architecture/README.md`](./docs/architecture/README.md) и в
реестре [`evidence/`](./evidence/README.md).

Решения, определившие сборку:

| ADR | Решение |
| --- | --- |
| [0001](./docs/adr/0001-bun-standalone-extraction.md) | восстановить встроенный JavaScript-бандл до декомпиляции нативного кода |
| [0002](./docs/adr/0002-hybrid-rust-typescript-layers.md) | Rust для нативного слоя, TypeScript для продуктового |
| [0003](./docs/adr/0003-evidence-first-clean-room-policy.md) | политика clean-room по принципу «сначала доказательства» |
| [0004](./docs/adr/0004-parity-harness-with-optional-oracle.md) | декларативные parity-кейсы с опциональным оракулом |
| [0005](./docs/adr/0005-project-name-and-parity-normalisation.md) | проект — `droide`; дизайн CLI остаётся идентичным |
| [0006](./docs/adr/0006-terminal-ui-stack.md) | терминальный UI — React + Ink, токены из спеки |
| [0007](./docs/adr/0007-update-channel.md) | обновления приходят из релизов этого репозитория, никогда от субъекта |
| [0008](./docs/adr/0008-oauth-credential-envelope.md) | учётные данные MCP OAuth запечатываются ОС, а не файлом ключа |

## Участие

Сначала прочитайте [`CONTRIBUTING.md`](./CONTRIBUTING.md). Изменение можно
мержить, когда проходят эти гейты:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (нужны локальные goldens в `.work/parity`)
5. `cargo test --workspace`
6. `npm run gaps:check`
7. пункт спеки, который оно реализует, процитирован в сообщении коммита или в
   теле PR

Метод сохраняют два правила: ничего не реализуется до того, как оно
специфицировано, и никакое поведение не сглаживается догадкой. Там, где
реализация покрывает меньше своего пункта, ставьте `TODO(spec …)`;
`npm run gaps` перегенерирует [`docs/gaps.md`](./docs/gaps.md), а
`npm run gaps:check` падает, когда он устарел.

Тесты находятся в [`tests/`](./tests/README.md): `unit/` — быстрые и герметичные,
`integration/` — пересекают границу процесса, `parity/` — проигрывают
записанные CLI-кейсы.

## Лицензия

MIT — см. [`LICENSE`](./LICENSE). Код субъекта не копируется, и никакой
проприетарный артефакт здесь не хранится
([ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md)).
