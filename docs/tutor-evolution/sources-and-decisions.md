# Аудит, джерела та межі висновків

Перевірено 2026-10-21 за checkout `54de85e5647ec9fb89c492ff6d238a32fce641a4`. Публічні офіційні сторінки отримано через HTTPS; нижче прямі посилання. Документація може змінюватися: перед реалізацією звірити потрібну версію CLI/SDK та умови обліковки.

## Підтверджені спостереження в репозиторії

| Спостереження | Доказ | Наслідок |
|---|---|---|
| Репетитор обмежений підручником | `app/prompts/tutor_chat.md`: «спираючись ЛИШЕ на надані фрагменти», вимога сторінок | Узгоджено змінити prompt і політику, не лише UI |
| Голос бачить обмежений фрагмент | `app/src/server/voice/lessonContext.ts`: selected step, `.slice(0, 6000)` | Додати маніфест і on-demand retrieval |
| Voice-гілка оминає пошук задач | `app/src/server/lessons/chat.ts`: voice + stepContext; перші 12 chunks, останні 20 messages | Спільний resolver для тексту/голосу, relevance замість порядку |
| Є точний пошук задач | `app/src/server/lessons/mathCourseV2Search.ts`: `original_number` | Повторно використати, пріоритет current lesson/book |
| Є hybrid пошук матеріалів | `app/src/server/search/search.ts` | Це внутрішній пошук, не автоматичний вебпошук |
| Вікова політика зашита | `app/src/server/safety/preamble.ts`: 11–12, обмеження посилань | Потрібна конфігурована вікова група й контрольовані citations |
| Пам’ять вже описана, але не реалізована як curated assertions | `docs/01-requirements.md`: US-10.1–10.3; profile зараз nickname/persona/pacing | Реалізувати provenance/edit/forget, не прирівнювати chat history до пам’яті |
| Чотири форми, більше історичних форматів | `app/src/app/parent/materials/page.tsx`, importer modules | Один entry point, кілька legacy adapters |
| Є обробка шляхів/старих медіа | `app/src/server/lessons/courseAssetFiles.ts`, `literatureV3Persist.ts` | Використати й розширити на інші адаптери |
| Імпорт не атомарний | Послідовні REST upsert; V3 action прибирає staging у `finally` | Retry/TTL і окремий publication slice |
| Claude-ролі вже є | `.claude/agents/`, `CLAUDE.md` | Перенести загальні правила, не припускати cross-provider orchestration |

В аудиті брали участь окремі агенти вимог/педагогіки та команди/інфраструктури. Вони виконували read-only аналіз; це не запущена зовнішня команда Claude/Gemini.

## Офіційні джерела інтеграції

| Джерело | Що підтверджує / чого не доводить |
|---|---|
| [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web.md) | `claude -p … --cloud <session>` доставляє follow-up у наявну вебсесію; потрібен account login, API key недостатньо; ack не є завершенням |
| [Claude headless](https://code.claude.com/docs/en/headless.md) | JSON/stream-json, budget/turn limits, scripted `--bare`; явна передача правил для bare |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) | Окремий програмний worker; не автоматичне керування чужою браузерною сесією |
| [Claude permissions](https://code.claude.com/docs/en/permissions.md) | Tool permissions, які не замінюють sandbox ОС |
| [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode) | `codex exec`, structured output та автоматизація; потрібна звірка з установленою версією |
| [Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) | CLI wrapper, threads, run/runStreamed, schema; не спільний мультивендорний session store |
| [Gemini headless](https://geminicli.com/docs/cli/headless/) | `-p`, JSON/stream-json; актуальна сторінка містить попередження щодо unpaid/Google One й Antigravity CLI |
| [Gemini authentication](https://geminicli.com/docs/get-started/authentication/) | Способи авторизації, різні квоти/умови; доступ користувача треба звірити для обраного adapter |
| [Gemini sandbox](https://geminicli.com/docs/cli/sandbox/) | Ізоляція виконання, яку потрібно явно налаштувати |
| [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/) | Інструментальна інтеграція; MCP не створює спільну чергу розробників сам по собі |
| [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) | Мінімальні permissions, ізоляція secrets, ризик privileged execution недовіреного коду |

## Конкретні умови для дитячого застосунку

- [Gemini API Terms](https://ai.google.dev/gemini-api/terms): мінімум 18 років для API-користувача та заборона використання Services як частини застосунків, спрямованих на або ймовірно доступних особам до 18. Платний режим не скасовує цю умову. У плані Gemini залишається внутрішнім інструментом розробки дорослої команди, без дитячих даних. Для інших продуктів Google потрібен окремий аналіз умов, не припущення про виняток.
- Там само: unpaid дані можуть використовуватися для поліпшення продуктів і review; paid має інший data-use режим, але no-training не дорівнює no-retention. Обмеження на використання outputs також врахувати до будь-якого майбутнього навчання власної моделі.
- [OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance): для персональних даних дітей до 13 років або застосовного віку цифрової згоди потрібен zero data retention до обробки. Платна API-підписка сама по собі не доводить ZDR. Точний вік і режим організації тут не встановлювалися; не робимо висновку про відповідність поточного production лише за класом дитини. Перед новим профілюванням і передаванням пам’яті потрібна перевірка фактичних налаштувань та endpoint eligibility.
- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search) і [Google grounding](https://ai.google.dev/gemini-api/docs/google-search) описують технічні citations/grounding, але не доводять істинність кожної відповіді й не скасовують вікових/даних умов. Це порівняння можливостей, не рішення підключити Google до дитячого runtime.

Ці пункти визначають конкретний вибір адаптерів і мінімізацію даних, а не додатковий загальний approval-процес для кожного виправлення.

## Межі перевірки середовища

Виявлено Codex CLI 0.163.0 і gh 2.46.0; `claude`/`gemini` executable відсутні в PATH. Перевірялися назви credential-конфігурації та readiness, а не значення ключів. У цьому executor не підтверджено cloud-session авторизацію Claude чи Gemini API adapter. Власник повідомив, що API й доступи вже є в його сервісах; це сумісні твердження.

Жодних платних model calls, нових міграцій, імпорту приватного контенту чи deploy у межах цього аналізу. Попередні public smoke/voice mocks не називаємо перевіркою всього authenticated child flow. Вебсесія Claude й зовнішній Gemini ще не виконували пробну задачу через запропонований bridge.

## Зафіксовані проєктні рішення

- Першими виправляємо знання уроку й природність діалогу, не замінюємо працюючий голосовий транспорт.
- Curriculum core зберігає зв’язок із підручником; exploratory conversation може виходити за його межі.
- Пам’ять пояснювана, обмежена й керована; немає прихованого психологічного профілю або навчання моделі на дитячих розмовах за замовчуванням.
- Основний імпорт — один ZIP; legacy parsers зберігаються; відсутність медіа не блокує текстовий курс.
- Оркестратор розробки відокремлений від дитячого runtime; GitHub артефакти й перевірений SHA важливіші за обіцянки в чаті.
- Ілюстрації в чинних уроках не переставляємо. Відео, власна модель й повна бібліотека — після найближчих зрізів.
