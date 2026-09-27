# ADR-029. Розпізнавання номерів вправ/задач при індексації (US-2.8) і точний пошук за номером для «домашки з репетитором» (US-8.7)

- **Статус:** прийнято (пряме доручення `architect`, повторний наголос PO 2026-09-28, `docs/01-requirements.md` §12.26, D-106/D-107; закриває технічну основу US-2.8 (D-72) і дає остаточну специфікацію державної машини US-8.7 (D-73), яку ADR-028 §3 навмисно залишив «окремою, ширшою роботою» й лише заскафолдив)
- **Вимоги:** US-2.8 (E-2), US-8.7 (E-8), D-72, D-73, D-106, NFR-LANG-3 (без вигадування джерела), NFR-COST-4; пов'язані ADR-008 (гібридний пошук/`chunks`), ADR-017 (універсальний конвеєр індексації), ADR-020 (реєстр інтерактивних компонентів — не зачіпається), ADR-022 (педагогічний конвеєр, `SourceRefOut`), ADR-023 (роль `step_reinforcement`, заскафолджена в S27), ADR-028 (двигун ремедіаційного діалогу, `messages.meta`, попередній ескіз §3 цього самого потоку — цей ADR його уточнює й закриває)

## Контекст

`sourceRefs` (матеріал + сторінка) уже показуються під кожним кроком уроку (`LessonRunner.tsx`, `t.sourceRef`) і в чаті теми (`server/lessons/chat.ts`) — але лише сторінка, без номера конкретної вправи/задачі підручника. Без цього:

1. **US-2.8** не виконана: дитина не бачить «с. 42, № 117» поруч зі сторінкою.
2. **US-8.7** («поясни задачу №117») технічно не може почати роботу — сценарій «дитина називає номер» вимагає **однозначного, надійного** способу знайти саме ЦЮ задачу (текст, сторінку, тему), а не здогадуватись.

Два жорсткі обмеження задають форму рішення:

- **US-2.8 КП-3:** розпізнавання номерів — частина **одноразової** індексації підручника (`ingest.structure`, роль `indexing_structure`), без окремого ШІ-виклику при кожному показі кроку чи повідомлення чату.
- **US-2.8 КП-2 / US-8.7 КП-7:** система **ніколи** не показує вигаданий чи невпевнено визначений номер; пошук за номером у чаті — **точний**, не нечіткий: якщо однозначного збігу нема, ШІ перепитує сторінку, а не вигадує умову задачі.

Ключове технічне спостереження: `buildOutline` (`server/ingest/structure.ts`) уже сьогодні для кожної не-крайової сторінки виокремлює до 6 «headings»-рядків через `isHeadingLike`, а її регулярний вираз (`HEADING`) **уже зараз** зловлює рядки виду `117. Розв'яжи рівняння` (шаблон `\d{1,2}(\.\d{1,2}){0,2}[.)]?\s+\p{Lu}` — той самий, що ловить нумеровані параграфи). Тобто кандидати на номери вправ **вже потрапляють** у витяг, який бачить модель `indexing_structure`, — не вистачає лише (а) явної інструкції промпту дістати їх у структурований вигляд і (б) місця в БД, куди їх покласти. Це підтверджує, що КП-3 (без нового виклику) реалізовний буквально без зміни витягу тексту.

## Рішення

### 1. Розширення `indexing_structure` (US-2.8, технічна основа)

**Схема (`server/ingest/structure.ts`, `buildStructureSchema`)** — новий **верхньорівневий** масив (не вкладений у розділи/теми, бо нумерація вправ і межі розділів — різні осі):

```ts
problems: z.array(z.object({
  number: z.string().min(1).max(12),
  page: z.number().int().nullable(),
})).max(500),
```

**Промпт (`prompts/indexing_structure.md`)** — нове правило (додається до наявних 9, нумерація не змінюється):

```
10. Якщо тип книги — підручник і на сторінках видно пронумеровані вправи чи задачі
    (наприклад «117.», «№ 117», «Вправа 5», «117а»), додай їх у problems: { number, page }.
    Додавай ЛИШЕ якщо номер видно однозначно і це справді вправа/задача — а не номер
    параграфа, розділу, малюнка, року чи сторінки. Якщо є найменший сумнів — НЕ додавай
    цю вправу. Вигаданих чи неоднозначних номерів бути не повинно (як і в п. 1).
```

Жодних нових плейсхолдерів у `USER`-частині не потрібно — `{{outline}}` уже містить кандидатні рядки (див. «Контекст» вище).

**Чиста функція нормалізації** (аналог `normalizeSections`, поруч у `structure.ts`):

```ts
export function normalizeProblems(
  answer: { problems: { number: string; page: number | null }[] },
  strategy: StructureStrategyKey,
  pageCount: number,
): { number: string; page: number }[] {
  if (strategy !== "textbook") return []; // МВП: лише підручник (див. «Альтернативи»)
  const seen = new Map<string, { number: string; page: number }>();
  for (const p of answer.problems) {
    const number = p.number.trim().slice(0, 12);
    const page = clampPage(p.page, pageCount);
    if (!number || page == null || /\s/.test(number)) continue;
    const key = `${page}:${number.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { number, page });
  }
  return [...seen.values()];
}
```

Гейтинг за `strategy === "textbook"` — та сама умова, що вже застосовується до `topics`/`dependencies` (`runStructure`), тому жодного нового розгалуження логіки, лише ще одне поле під тим самим `if`.

### 2. Дані: нова таблиця `material_problems` (не jsonb-масив, не колонка `materials`)

```sql
create table if not exists public.material_problems (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  section_id       uuid references public.material_sections (id) on delete set null,
  topic_id         uuid references public.topics (id) on delete set null,
  number           text not null check (number = trim(number) and number !~ '\s' and char_length(number) between 1 and 12),
  page             integer not null,
  source           text not null default 'ai' check (source in ('ai')),
  created_at       timestamptz not null default now()
);
comment on table public.material_problems is
  'ADR-029 (US-2.8): пронумеровані вправи/задачі підручника, розпізнані ОДИН РАЗ при ingest.structure (indexing_structure). Ніколи не вигадується — лише те, що модель однозначно побачила у витягу (КП-2). Без ручного редагування в MVP (source завжди ai) — переіндексація повністю перебудовує набір рядків матеріалу (delete+insert), на відміну від material_sections/topics, де manual_override зберігається: тут немає UI ручної корекції, тож немає що зберігати.';

-- Точний (не нечіткий!) пошук за номером у межах теми — основа US-8.7 КП-7.
create unique index if not exists material_problems_topic_number_uidx
  on public.material_problems (material_id, topic_id, number) where topic_id is not null;
create index if not exists material_problems_material_number_idx
  on public.material_problems (material_id, number);
create index if not exists material_problems_owner_idx on public.material_problems (owner_family_id);

alter table public.material_problems enable row level security;
drop policy if exists material_problems_select_parent on public.material_problems;
create policy material_problems_select_parent on public.material_problems for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');
revoke all on public.material_problems from anon;
revoke insert, update, delete, truncate on public.material_problems from authenticated;

-- Той самий принцип, що assign_chunk_structure (S1) — найвужчий діапазон сторінок, що містить номер.
create or replace function public.assign_problem_structure(p_family_id uuid, p_material_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.material_problems p
       set section_id = (
             select s.id from public.material_sections s
              where s.material_id = p.material_id and p.page between s.page_from and s.page_to
              order by s.page_to - s.page_from, s.sort_order limit 1),
           topic_id = (
             select t.id from public.topics t
              where t.material_id = p.material_id and p.page between t.page_from and t.page_to
              order by t.page_to - t.page_from, t.sort_order limit 1)
     where p.material_id = p_material_id and p.owner_family_id = p_family_id
    returning p.id
  )
  select count(*)::integer from upd
$$;
revoke all on function public.assign_problem_structure(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_problem_structure(uuid, uuid) to service_role;
```

**Чому нова таблиця, а не `jsonb`-масив у `materials`/`topics` (див. і «Альтернативи»):** US-8.7 КП-7 вимагає **точного, надійного** пошуку «чи є задача №117 у цій темі», а не нечіткого збігу — це або `unique index` + `= number`, або нічого. `jsonb`-масив унеможливив би унікальність і швидкий індексований точний пошук без розгортання масиву в кожен запит.

**`runStructure` (`server/ingest/pipeline.ts`)** — вставляється між обробкою `topic_dependencies`/`material_topic_links` і викликом `assign_chunk_structure` (той самий виклик `answer`, тепер уже містить `problems`):

```ts
await scope.delete("material_problems").eq("material_id", materialId);
const problems = normalizeProblems(answer, strategy, m.page_count ?? pages.size);
if (problems.length) {
  await scope.insert("material_problems", problems.map((p) => ({
    owner_family_id: familyId, material_id: materialId, number: p.number, page: p.page,
  })));
}
await scope.client.rpc("assign_problem_structure", { p_family_id: familyId, p_material_id: materialId });
```

(Виконується щоразу — і при першій індексації, і при переіндексації; `delete`+`insert` навмисно простіше за `mergeByTitle`, бо жодна інша таблиця не тримає стабільного FK на `material_problems.id` — і лекції (`sourceRefs`), і чат (`messages.meta`) звертаються до рядка **за значенням** `(material_id, page, number)`, а не за `id`, тож перебудова ідентичності при переіндексації нічого не ламає.)

### 3. Цитата кроку/чату: `sourceRefs.problemNumber` — з подвійною перевіркою від вигадування

**`server/lessons/schema.ts`** — розширення вже наявного `SourceRefOut`/`sourceRefSchema` (ADR-022):

```ts
export interface SourceRefOut {
  materialId: string;
  materialTitle: string;
  page: number | null;
  problemNumber?: string | null; // НОВЕ (ADR-029): лише якщо крок буквально грунтується на цій вправі підручника
}
const sourceRefSchema = z.object({
  materialId: z.string().uuid(),
  materialTitle: z.string().min(1).max(200),
  page: z.number().int().min(1).max(5000).nullable(),
  problemNumber: z.string().min(1).max(12).nullable().optional(),
});
```

**Контекст `lesson_generation` (ADR-022 пайплайн)** отримує для сторінок, включених у фрагменти теми блоку, короткий список відомих номерів (запит до `material_problems` за `topic_id`/`material_id` перед побудовою промпту), у форматі на кшталт:

```
Відомі номери вправ на наданих сторінках: стор. 42 — № 117, 118; стор. 43 — № 119.
Якщо приклад чи вправа кроку буквально відповідає одній із цих задач підручника — вкажи її
номер у sourceRefs.problemNumber. Якщо крок не спирається буквально на жодну з них — залиш
null. НІКОЛИ не вказуй номер, якого немає в цьому списку.
```

**Захист від вигадування — не лише промпт, а й сервер (defense in depth, NFR-LANG-3):** одразу після отримання відповіді `lesson_generation` (до передачі в `lesson_review`, там, де сьогодні `GeneratedStep[]` мапиться в рядки `library_steps`), кожен `sourceRef.problemNumber !== null` **перевіряється** проти `material_problems` (`material_id` + `page` + `number` — точний збіг); якщо рядка нема — поле мовчки обнуляється (лишається сама сторінка), подія пишеться в технічний журнал (той самий патерн, що вже застосовується до інших «модель могла вигадати» точок конвеєра). Модель може помилитися чи піддатись спокусі процитувати «схожий» номер — БД гарантує, що дитина його ніколи не побачить, якщо його не було в реально розпізнаному наборі.

**UI (`LessonRunner.tsx`/`uk.ts`, D-106 — окрема, вже описана PO-задача для `developer`, сумісна з цим ADR без змін схеми):** `t.sourceRef(materialTitle, page, problemNumber?)` формує `«Матеріал, с. 42, № 117»`, коли `problemNumber` є, і сьогоднішній `«Матеріал, с. 42»` — коли ні. Назва розділу/параграфа (окреме уточнення D-106) додається з уже наявних `material_sections`/`topics` тим самим викликом — не залежить від цього ADR.

### 4. US-8.7: точний пошук за номером + фінальна специфікація стейт-машини (продовжує ADR-028 §3)

ADR-028 §3 уже спроєктував носій стану (`messages.meta`, форма `{kind:'homework_problem', problemNumber, stage, attemptNo}`) і назвав це «окремою роботою, яка чекає на US-2.8». Цей розділ — та сама робота: **як саме** `problemNumber`, названий дитиною, перетворюється на конкретний, надійний `ProblemRef`, і як три вже описані ADR-028 стадії (`method` → `attempt_feedback` → `fallback`) отримують текст задачі для опори.

**4.1. Точний пошук (`resolveProblemRef`, нова функція `server/lessons/chat.ts`) — ніякого нечіткого збігу (КП-7):**

```ts
interface ProblemRef { materialId: string; materialTitle: string; page: number; topicId: string | null }

async function resolveProblemRef(
  familyId: string, topicId: string, subjectId: string, rawNumber: string, pageHint?: number,
): Promise<{ kind: "found"; ref: ProblemRef } | { kind: "ambiguous" | "not_found" }> {
  const number = rawNumber.trim().replace(/^№\s*/, "");
  // Крок 1: точний збіг у МЕЖАХ теми поточного чату (найчастіший випадок — ДЗ по щойно
  // пройденій темі).
  let rows = await queryProblems({ familyId, topicId, number, page: pageHint });
  if (rows.length === 1) return { kind: "found", ref: toRef(rows[0]) };
  if (rows.length > 1) return { kind: "ambiguous" };
  // Крок 2: точний збіг серед УСІХ тем цього предмета (задачник/підручник міг бути
  // прив'язаний до іншої теми, ніж поточний чат) — досі ТОЧНИЙ збіг за номером, лише
  // ширший скоуп, не нечіткий пошук.
  rows = await queryProblems({ familyId, subjectId, number, page: pageHint });
  if (rows.length === 1) return { kind: "found", ref: toRef(rows[0]) };
  return rows.length > 1 ? { kind: "ambiguous" } : { kind: "not_found" };
}
```

`ambiguous`/`not_found` (без ще названої сторінки) → відповідь **не** запускає цикл ДЗ і **не** пише `messages.meta` — це звичайна репліка `tutor_chat`-рівня: «Скажи, будь ласка, ще й сторінку — у мене кілька/жодної задачі під № 117». Коли дитина називає сторінку — `resolveProblemRef` викликається повторно з `pageHint`, тепер подвійно обмежений (номер **і** сторінка) — детермінований результат.

**4.2. Текст задачі для першого пояснення — з `chunks`, не вигаданий:** щойно `ProblemRef` знайдено, повний текст сторінки береться з уже проіндексованих `chunks` (`material_id = ref.materialId AND page = ref.page`, той самий шлях, що вже читає структура) і йде в контекст виклику `method` як буквальний текст сторінки підручника (не сама модель відтворює умову з пам'яті).

**4.3. Три виклики циклу — та сама роль `step_reinforcement` (ADR-023 S27, той самий маршрут, що US-6.15 — ВП-38 «спільна базова модель»), різні схеми:**

| Стадія | Схема відповіді | Що робить |
|---|---|---|
| `method` (перший виклик) | `{ methodUk: string(≤900) }` | Пояснює підхід/правило типу задачі за текстом сторінки — **без** розв'язку саме цієї задачі й без відповіді (КП-1). Зберігається як AI-повідомлення, `meta = {kind:'homework_problem', problemNumber, materialId, page, stage:'method', attemptNo:0}`. |
| `attempt_feedback` (на кожне наступне повідомлення дитини, поки `attemptNo < 2`) | `{ messageKind: 'attempt'\|'give_me_answer_request'\|'other', verdict: 'correct'\|'incorrect_or_partial'\|null, explanationUk: string(≤900) }` | Спершу — **модерація насамперед** (`moderateMessage`, `severity:'urgent'` перериває все й повертає `URGENT_REPLY_UK`, лічильник не інкрементується — той самий беззаперечний пріоритет, що ADR-028 §5). Інакше: `give_me_answer_request` → доброзичлива відмова видати відповідь достроково (КП-5), `attemptNo` **не** інкрементується (спроби ще не було). `attempt`+`correct` → `stage:'solved'`. `attempt`+`incorrect_or_partial`, `attemptNo+1 < 2` → `stage:'attempt_feedback'`, `attemptNo+1`, конкретна причина помилки (КП-3, той самий принцип, що US-6.15 КП-1). `attempt`+`incorrect_or_partial`, вичерпано → наступний виклик `fallback`. |
| `fallback` (лише після 2 невдалих спроб — ВП-38) | `{ solutionUk: string(≤1200) }` | Повний розв'язок покроково, явно як **останній**, не перший крок взаємодії (КП-4). `stage:'fallback'`. |

**4.4. Вартість/маршрутизація (КП-8) — без нової ролі `model_routes`, окремий рядок журналу через `ref_table`, не через роль:**

Усі три виклики позначаються `ai_calls.role = 'step_reinforcement'` (та сама роль/модель, що US-6.15 — жодного нового рядка в `model_routes` не потрібно) **і** `ai_calls.ref_table = 'messages'`, `ref_id = <id AI-повідомлення стадії 'method' цього циклу>` (той самий anchor-id для всіх викликів одного розбору задачі — `attempt_feedback`/`fallback` передають той самий `ref_id`, що й `method`, у виклик `callStructured`). Це **відрізняється** від US-6.15, де ремедіація тегується `ref_table = 'step_attempts'`. Журнал витрат (кабінет тата, NFR-COST-4) групує рядок за парою `(role, ref_table)`, тому «розбір задачі за номером» і «закріплення» лишаються двома окремими рядками, попри спільну роль — саме так виконується КП-8 без подвоєння `model_routes`. **Розробнику:** мапінг «роль+`ref_table` → підпис українською» — одна нова гілка (`ref_table='messages' && meta.kind='homework_problem'` → «Розбір задачі за номером») у тому самому місці коду, де вже сформовано підпис «Закріплення» для `ref_table='step_attempts'` (ADR-028 КП-8).

Бюджетна поведінка — та сама, що вже застосована до `step_reinforcement` для US-6.15 (не вимикається режимом бюджету, дешевшою може бути лише модель) — жодної додаткової роботи, лише той самий прапорець ролі, вже існуючий.

## Вплив на вартість

- **`indexing_structure`:** маргінальний приріст токенів (нове поле `problems` у виводі + один рядок промпту) — у межах уже закладеної оцінки $1–1,5/книгу (`docs/03` розд. 3.8/3.9б), окремим рядком не рахується.
- **`lesson_generation`:** маргінальний приріст контексту (короткий список відомих номерів на сторінках блоку) — у межах запасу конвеєра (`docs/03` розд. 3.2а).
- **US-8.7 цикл:** уже оцінено в `docs/03` розд. 3.2в (написано наперед, до цього ADR) — до 2 спроб + пояснення методу + рідкісний fallback, той самий порядок вартості, що `step_reinforcement` для US-6.15 (одиниці центів за виклик); докладати нову оцінку не потрібно, це той самий рядок кошторису, тепер підтверджений конкретним механізмом.
- **Разові:** жодних нових `model_routes`, жодного нового провайдера — $0 інфраструктурного приросту.

## Альтернативи

| Варіант | Чому ні |
|---|---|
| `jsonb`-масив номерів у `materials`/`topics` замість нової таблиці | КП-7 вимагає точний, надійний, індексований пошук («чи є №117 у цій темі») — масив унеможливлює `unique index` і швидкий точний запит без розгортання в кожному чаті |
| Нечіткий/текстовий пошук номера (як звичайний пошук по чатах, US-8.4) | КП-7 явно забороняє це для US-8.7 — неоднозначність тут веде до вигаданої умови задачі, а не до «не той результат пошуку серед інших» |
| Окремий ШІ-виклик «знайди номер вправи» при кожному «поясни задачу №N» | Прямо суперечить US-2.8 КП-3 (розпізнавання — частина одноразової індексації); зайва вартість і затримка на кожен запит дитини |
| `mergeByTitle`-подібне збереження ідентичності рядків `material_problems` між переіндексаціями (як `topics`/`material_sections`) | Немає UI ручної корекції номерів у MVP (на відміну від тем/розділів) і немає FK на `material_problems.id` ззовні (пошук завжди за значенням `number`+`page`/`topic_id`) — зберігати ідентичність нема для чого; `delete`+`insert` простіше й безпечніше (не тягне застарілих рядків після зникнення вправи з нового скану) |
| Розпізнавання номерів і для `kind='reference'` (задачники), не лише `kind='textbook'` | Не в обсязі поточного запиту PO (D-106 говорить про підручник); гейтинг ідентичний до вже наявного гейтингу `topics`/`dependencies` за `strategy==='textbook'` — розширення на задачники можливе без зміни схеми (лише зняти умову strategy), але свідомо відкладено, щоб не розширювати обсяг понад запит (див. «Питання для Алекса») |
| Нова роль `model_routes` (напр. `homework_solver`) окремо від `step_reinforcement` | ВП-38(б) прямо вимагає «той самий базовий параметр моделі», що й US-6.15; окрема роль подвоїла б налаштування в кабінеті тата без користі — розрізнення на рівні `ref_table`, а не ролі, задовольняє КП-8 дешевше |

## Наслідки

- **Нова таблиця** `material_problems` (+ 3 індекси, RLS за патерном `materials`/`chunks`) і нова SQL-функція `assign_problem_structure` (дзеркалить `assign_chunk_structure`).
- **Розширення схеми виводу** `indexing_structure` (`buildStructureSchema` → поле `problems`) і промпту (`prompts/indexing_structure.md`, нове правило 10); нова чиста функція `normalizeProblems` (`server/ingest/structure.ts`); `runStructure` (`server/ingest/pipeline.ts`) вставляє/перебудовує `material_problems` і викликає `assign_problem_structure` для кожного матеріалу типу «підручник».
- **Розширення `SourceRefOut`/`sourceRefSchema`** (`server/lessons/schema.ts`) необов'язковим `problemNumber`; новий крок серверної валідації («не в БД → обнулити») одразу після `lesson_generation`, до `lesson_review`.
- **Розширення контексту `lesson_generation`** коротким списком відомих номерів вправ на сторінках блоку.
- **Нові функції** `server/lessons/chat.ts`: `resolveProblemRef`, `explainProblemMethod`, `checkProblemAttempt`/`submitProblemAttempt`, `solveProblemFallback` (точні сигнатури — вище); диспетчеризація за `messages.meta.stage` для чату теми, той самий чат, що й звичайні питання (US-8.1/8.2), без нової таблиці чи нового виду чату.
- **Немає нової колонки БД для стану чату** — `messages.meta` вже існує (ADR-028); додаються лише два нові, зворотно сумісні optional-ключі всередині нього (`materialId`, `page`) для аудиту/діагностики.
- **Немає нової ролі `model_routes`** — `step_reinforcement` (ADR-023) перевикористовується; окремий рядок кошторису й журналу забезпечує теговання `ai_calls.ref_table`/`ref_id`, не нова роль.
- Вартість — без нового рядка кошторису (уже врахована в `docs/03` розд. 3.2в/3.8).
- **Питання для Алекса (не блокує реалізацію, рекомендація архітектора вже застосована як дефолт):** чи варто з часом поширити розпізнавання номерів і на прив'язані задачники/збірники вправ (`kind='reference'`), а не лише сам підручник — корисно, якщо ДЗ частіше задають із задачника, ніж з підручника. Рекомендація: почати з підручника (як і сформульовано в D-106/US-2.8), переглянути після кількох тижнів реального використання «поясни задачу №N» (`docs/STATUS.md`).
