# ADR-030. Керування переліком шкільних предметів і курсів у батьківському кабінеті (E-22, US-22.1…22.3)

- **Статус:** прийнято
- **Вимоги:** US-22.1, US-22.2, US-22.3 (E-22, D-99/D-100/D-101, `docs/01-requirements.md` §6, §12.22); беклог S31 (`docs/05-backlog.md`); ВП-52 закрито PO (гейт «сіра плитка» vs «повне приховування» за `kind`); пов'язані ADR-017 (модульна архітектура, «предмет = дані»), ADR-021 (multi-year growth, `academic_years`/`grade` — курси свідомо поза цим виміром), ADR-008/ADR-022 (педагогічний конвеєр — без змін), S1-міграція `20260925100100_s0_modules_years_subjects.sql` (наявна `subjects`, наявне відкликання `INSERT`/`UPDATE`), `20260927100000_s2_current_topic_atomic.sql` (взірець SECURITY DEFINER RPC-гейту)
- **Не входить в цей ADR:** US-22.4 (мультиселект тем і масова нічна підготовка уроків, D-108) — окрема, вже спроєктована задача (ADR-023 §3/§4, черга `library.warm_topic`, бюджетна логіка); тут вона не переглядається й не дублюється.

## Контекст

`subjects` (ADR-017 «предмет = дані») сьогодні — це рівно 10 рядків, які вставляє bootstrap `app/config/family-defaults.json` під час реєстрації нової сім'ї; редагування файлу **не** зачіпає вже створену сім'ю Алекса (перевірено кодом). PO протестував завантаження книги «Claude Prototyping Framework» (ADR-024) — вона проіндексувалась, але прикріпити її нема куди: немає ні відповідного шкільного предмета («Інформатика»), ні механізму завести щось поза шкільною програмою («курс»). PO двома повідомленнями розширив запит до повноцінного керування переліком предметів/курсів з перевіркою дублювання, групуванням курсів і перемикачем видимості (D-100/D-101).

Три технічні факти визначають форму рішення:

1. **`INSERT`/`UPDATE` на `subjects` відкликано в ролі `authenticated`** (`20260925100100_s0_modules_years_subjects.sql`, рядок `revoke insert, update, delete, truncate … from authenticated`). Сьогодні тато не може додати чи змінити рядок `subjects` навіть якщо захоче — потрібні нові SECURITY DEFINER RPC, аналогічні вже наявному `public.set_current_topic` (`20260927100000_s2_current_topic_atomic.sql`): `revoke all … from public, anon, authenticated; grant execute … to service_role;`, викликані через `scope.client.rpc(...)` (`forFamily(...).client`, службовий ключ на сервері) з server action, яка вже пройшла `requireParentAccess()`.
2. **`subjects.active` уже існує й уже читається** дитячим інтерфейсом (`app/src/server/subjects/queries.ts`, `app/src/app/(child)/today/page.tsx`, `app/src/app/(child)/subject/[id]/page.tsx`), але жодної серверної дії, щоб тато міг це поле змінити, немає (перевірено — нуль збігів `set_subject_active`/`toggleSubjectActive`/`course_groups` у `app/src`). Бракує лише запису, не читання.
3. **ВП-52 закрито PO (2026-09-27):** поведінка `active=false` різна за `kind`. `kind='school_subject'` (усі 10 стандартних + нові) — нинішня поведінка **без змін**: сіра неактивна плитка, видима, `aria-disabled`. `kind='course'` (і будь-який майбутній некласовий тип) — **повне приховування** з дитячого інтерфейсу.

## Рішення

### 1. Схема БД

Нова міграція `supabase/migrations/20261007100000_s31_subjects_courses.sql` (номер — заглушка на дату застосування; `developer` підставляє фактичну).

```sql
-- 1) subjects.kind — точкове розширення, без нового learning_module і без
--    переписування конвеєра індексації/уроків (ADR-017 вже трактує "предмет = рядок").
--    default 'school_subject' покриває всі 10 наявних рядків БЕЗ ручного backfill:
--    Postgres проставляє DEFAULT для існуючих рядків атомарно в тій самій команді ADD COLUMN.
alter table public.subjects
  add column if not exists kind text not null default 'school_subject'
    check (kind in ('school_subject', 'course'));
comment on column public.subjects.kind is
  'US-22.1/22.2 (E-22): "school_subject" — предмет НУШ (у т.ч. усі 10 стандартних, завжди
   цей kind, ніколи course — КП-7 US-22.1); "course" — татів курс поза шкільною програмою.
   Керує (а) окремим переліком дублювання за назвою (kind-scoped), (б) видимістю дитині при
   active=false: school_subject -> сіра плитка (без змін), course -> повне приховування (ВП-52).';

-- 2) course_groups — новий, необов'язковий рівень "Група -> Курси" (US-22.3),
--    за аналогією з "Предмет -> Теми".
create table if not exists public.course_groups (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid not null references public.families (id) on delete cascade,
  name_uk          text not null check (char_length(name_uk) between 1 and 120),
  active           boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists course_groups_owner_idx on public.course_groups (owner_family_id);
drop trigger if exists course_groups_touch on public.course_groups;
create trigger course_groups_touch before update on public.course_groups
  for each row execute function app_private.touch_updated_at();

-- Дублювання назви групи — regнерозчутливо, обрізання пробілів, у межах сім'ї (КП-1 US-22.3).
create unique index if not exists course_groups_owner_name_uidx
  on public.course_groups (owner_family_id, lower(trim(name_uk)));

-- 3) subjects.group_id — nullable, має сенс лише для kind='course' (КП-2 US-22.3:
--    курс належить щонайбільше одній групі; шкільний предмет НІКОЛИ не має групи —
--    перевіряється в RPC нижче, не в CHECK, бо CHECK не бачить іншу таблицю простим способом
--    без volatile-функції; RPC-гейт достатній, бо це єдиний шлях запису).
alter table public.subjects
  add column if not exists group_id uuid references public.course_groups (id) on delete set null;
create index if not exists subjects_group_id_idx on public.subjects (group_id) where group_id is not null;

-- 4) Дублювання назви предмета/курсу — regнерозчутливо, trim+lower, ОКРЕМО в межах kind
--    (КП-2 US-22.1, КП-2 US-22.2: "Історія" (школа) і майбутній курс "Історія" не конфліктують).
--    Частковий унікальний індекс, не `unique(owner_family_id, code)` — code генерується
--    автоматично (slug) і не ловить дубль за людською назвою (D-100 preamble).
create unique index if not exists subjects_owner_kind_name_uidx
  on public.subjects (owner_family_id, kind, lower(trim(name_uk)))
  where owner_family_id is not null;

-- RLS: course_groups читає лише своя сім'я (той самий патерн, що subjects_select).
alter table public.course_groups enable row level security;
create policy course_groups_select on public.course_groups
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()));
revoke all on public.course_groups from anon;
revoke insert, update, delete, truncate on public.course_groups from authenticated;
```

**Чому `unique index` на `lower(trim(name_uk))`, а не `unique(code)` розширений:** `code` — технічний slug (`^[a-z][a-z0-9_.]*$`), генерується сервером з людської назви при створенні і ніколи не редагується татом напряму; два різних написання («Інформатика» і «інформатика ») дали б різний `code` лише випадково, тож перевірка дублювання мусить дивитись на `name_uk`, не на `code`.

**Чому `kind` не диктує наявність `group_id` через `CHECK`:** декларативний `CHECK` у Postgres не бачить чужий рядок (чи `kind='course'` дійсно) без `volatile`/subquery-функції в constraint (заборонено — constraint має бути immutable-виразним). Простіше й надійніше — переносимо цю перевірку в саму RPC (єдиний шлях запису), як показано нижче: `add_course` завжди приймає `group_id`, `add_subject` (шкільний предмет) — ніколи.

**Backfill не потрібен.** `alter table … add column kind text not null default 'school_subject'` у сучасних Postgres (11+, Supabase — актуальна версія) — метадані-only операція: DEFAULT застосовується для існуючих рядків без переписування таблиці і без окремого `UPDATE`. Усі 10 наявних рядків отримують `kind='school_subject'` автоматично, того самого моменту, коли колонка з'являється.

### 2. Нові SECURITY DEFINER RPC — гейт «лише тато»

Гейт «лише тато» реалізується на **двох рівнях**, за точним взірцем `set_current_topic`/`setCurrentTopicAction`:

1. **Server action** (`"use server"`, `app/src/app/actions/subjects.ts`, розширюється) викликає `const { familyId } = await requireParentAccess();` **перед** будь-яким зверненням до RPC — це і є фактичний гейт «лише тато» (та сама функція, що вже захищає `setCurrentTopicAction`; допускає і власний Google-акаунт тата, і планшет у режимі PIN-«тато», `via: "tablet"` — той самий рівень чутливості, що активація предмета, не рівень Drive OAuth/PIN-налаштувань, де використовується суворіший `requireParentAccount`).
2. **RPC сама** — `security definer`, `revoke all … from public, anon, authenticated; grant execute … to service_role;` — виконується виключно через службовий клієнт (`forFamily(familyId).client`, ключ лише на сервері, ADR-018 K-2/CLAUDE.md «ключі лише на сервері»), і **повторно перевіряє** `owner_family_id = p_family_id` для будь-якого переданого `group_id`/`id` (ніколи не довіряє клієнту навіть у межах уже гейтованого виклику — той самий принцип, що `set_current_topic` re-перевіряє власність теми/предмета).

Жодної додаткової перевірки ролі *всередині* RPC не потрібно (RPC і так недосяжна нікому, крім `service_role`, який викликається лише зі server actions, що вже пройшли `requireParentAccess`) — точно та сама, вже усталена, двошарова модель, що для `set_current_topic`.

```sql
-- add_subject: школа (kind='school_subject', ЗАВЖДИ, КП-7 US-22.1) — активна = false за
-- замовчуванням (як і решта 10 предметів до активації), тому окремого gate тут не треба:
-- активація йде окремою RPC set_subject_active (нижче), тим самим шляхом, що й для
-- стандартних предметів (set_current_topic вже вміє активувати ПІД ЧАС вибору теми; тут -
-- прямий перемикач, коли теми ще нема чи тато просто вмикає/вимикає).
create or replace function public.add_subject(p_family_id uuid, p_name_uk text)
returns table (out_id uuid, out_code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := trim(p_name_uk);
  v_code  text;
  v_id    uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'school_subject'
       and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  v_code := public.slugify_subject_code(p_family_id, v_name); -- нова невелика helper-функція
                                                               -- (slug + числовий суфікс при
                                                               -- колізії code, той самий підхід,
                                                               -- що вже десь використовується
                                                               -- для унікальних технічних кодів)
  insert into public.subjects (owner_family_id, code, name_uk, kind, active, is_stub)
  values (p_family_id, v_code, v_name, 'school_subject', false, false)
  returning id, code into v_id, v_code;
  return query select v_id, v_code;
end; $$;
revoke all on function public.add_subject(uuid, text) from public, anon, authenticated;
grant execute on function public.add_subject(uuid, text) to service_role;

-- rename_subject: та сама перевірка дублювання, той самий kind (kind не змінюється тут —
-- перетворення "предмет" <-> "курс" немає в US-22.1..22.3, свідомо не в обсязі).
create or replace function public.rename_subject(p_family_id uuid, p_subject_id uuid, p_name_uk text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_kind text;
begin
  select kind into v_kind from public.subjects
   where id = p_subject_id and owner_family_id = p_family_id;
  if v_kind is null then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = v_kind
       and lower(trim(name_uk)) = lower(v_name) and id <> p_subject_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.subjects set name_uk = v_name where id = p_subject_id;
end; $$;
revoke all on function public.rename_subject(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rename_subject(uuid, uuid, text) to service_role;

-- set_subject_active: єдиний запис-шлях до наявного subjects.active (D-101) — та сама
-- перевірка власності, що інші RPC; child-facing поведінка вже готова читати це поле,
-- лише розрізняючи kind (крок 3 нижче).
create or replace function public.set_subject_active(p_family_id uuid, p_subject_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.subjects set active = p_active
   where id = p_subject_id and owner_family_id = p_family_id and is_stub = false;
  if not found then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
end; $$;
revoke all on function public.set_subject_active(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_subject_active(uuid, uuid, boolean) to service_role;

-- add_course: kind='course' ЗАВЖДИ; group_id — необов'язковий, перевіряється власність
-- групи тут (а не в CHECK, див. п.1); дублювання — окремо серед курсів (КП-2 US-22.2).
create or replace function public.add_course(p_family_id uuid, p_name_uk text, p_group_id uuid default null)
returns table (out_id uuid, out_code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_code text;
  v_id   uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id
  ) then
    raise exception using errcode = 'P0012', message = 'group_not_found';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'course'
       and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  v_code := public.slugify_subject_code(p_family_id, v_name);
  insert into public.subjects
    (owner_family_id, code, name_uk, kind, active, is_stub, group_id,
     config)
  values
    (p_family_id, v_code, v_name, 'course', false, false, p_group_id,
     jsonb_build_object('requires_diagnostic', false)) -- КП-4 US-22.2: курс не потребує
                                                          -- вступної діагностики за замовчуванням
                                                          -- (конвенція в jsonb, без нової
                                                          -- колонки — E-5/діагностика ще не
                                                          -- реалізована в коді сьогодні, це
                                                          -- підготовка "на майбутнє", читає
                                                          -- майбутній діагностичний модуль)
  returning id, code into v_id, v_code;
  return query select v_id, v_code;
end; $$;
revoke all on function public.add_course(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.add_course(uuid, text, uuid) to service_role;

-- rename_course / set_group для наявного курсу — той самий принцип, one RPC:
create or replace function public.update_course(
  p_family_id uuid, p_subject_id uuid, p_name_uk text, p_group_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
begin
  if not exists (
    select 1 from public.subjects
     where id = p_subject_id and owner_family_id = p_family_id and kind = 'course'
  ) then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id
  ) then
    raise exception using errcode = 'P0012', message = 'group_not_found';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'course'
       and lower(trim(name_uk)) = lower(v_name) and id <> p_subject_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.subjects set name_uk = v_name, group_id = p_group_id where id = p_subject_id;
end; $$;
revoke all on function public.update_course(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.update_course(uuid, uuid, text, uuid) to service_role;

-- add_course_group / rename_course_group / set_course_group_active — дзеркалить
-- add_subject/rename_subject/set_subject_active, лише таблиця course_groups.
create or replace function public.add_course_group(p_family_id uuid, p_name_uk text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_id   uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.course_groups
     where owner_family_id = p_family_id and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  insert into public.course_groups (owner_family_id, name_uk, active)
  values (p_family_id, v_name, false) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.add_course_group(uuid, text) from public, anon, authenticated;
grant execute on function public.add_course_group(uuid, text) to service_role;

create or replace function public.rename_course_group(p_family_id uuid, p_group_id uuid, p_name_uk text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
begin
  if not exists (select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id) then
    raise exception using errcode = 'P0002', message = 'group_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.course_groups
     where owner_family_id = p_family_id and lower(trim(name_uk)) = lower(v_name) and id <> p_group_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.course_groups set name_uk = v_name where id = p_group_id;
end; $$;
revoke all on function public.rename_course_group(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rename_course_group(uuid, uuid, text) to service_role;

create or replace function public.set_course_group_active(p_family_id uuid, p_group_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.course_groups set active = p_active
   where id = p_group_id and owner_family_id = p_family_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'group_not_found';
  end if;
end; $$;
revoke all on function public.set_course_group_active(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_course_group_active(uuid, uuid, boolean) to service_role;
```

**Помилки → повідомлення тату** — те саме мапування `errcode → uk-текст`, що вже робить `RPC_ERROR_MESSAGE` у `app/src/app/actions/subjects.ts` (`P0002`→«не знайдено», далі новий рядок `P0010`→«Введіть назву», `P0011`→«Такий предмет/курс уже є» (текст різниться для school_subject/course — `errcode` той самий, текст обирає server action за тим, яку саме дію викликали), `P0012`→«Групу не знайдено»).

**Видалення (КП-4 US-22.1) — свідомо НЕ RPC у цьому ADR-і, окрема, вужча дія:** `delete_subject`/`delete_course`/`delete_course_group`, дозволена лише якщо в предмета/курсу немає жодного показаного дитині блоку (жодної `library_items`/`lesson_sessions`/`points_ledger` з цим `subject_id`) — той самий принцип, що US-19.4 КП-1 («бібліотека ніколи не видаляється автоматично»). `developer` додає цю перевірку прямим SQL `not exists (...)` у власному `security definer`-гейті (`delete_subject(p_family_id, p_subject_id)`) за тим самим взірцем; не деталізовано тут рядок-у-рядок, бо це просте розширення того самого патерну, а точний перелік «показаних дитині блоків» варто звірити з `developer` на момент реалізації (може з'явитись нова таблиця між цим ADR і моментом кодування).

**`slugify_subject_code`:** невелика допоміжна `immutable`-подібна SQL-функція (транслітерація кирилиці в латинку + `lower` + заміна не-`[a-z0-9_]` на `_`, обрізання до розумної довжини, при колізії — числовий суфікс `_2`, `_3`…), щоб задовольнити наявний `check (code ~ '^[a-z][a-z0-9_.]*$')` і `unique nulls not distinct (owner_family_id, code)` без ручного введення `code` татом (тато вводить лише людську назву — `code` суто технічний, ніде не показується дитині чи тату). Якщо просте транслітераційне рішення виявиться незручним (кириличні омографи тощо), прийнятна проста заглушка — `subject-<uuid_short>` — `code` ніде не показується користувачу, тож косметика тут не критична; рекомендація архітектора — почати з максимально простого варіанту (uuid-суфікс), не City ускладнювати транслітерацію заради поля, яке ніхто не бачить.

### 3. Дитячий інтерфейс — `kind`-умовний фільтр/рендер (без зміни схеми показу)

Підтверджено: жодної нової таблиці чи стану не потрібно — лише розширення двох наявних запитів і одного компонента рендеру, `kind`-умовно.

**`app/src/app/(child)/today/page.tsx`** (зараз запитує `subjects` без `kind`/`group_id`) — розширюється:

```ts
const { data: subjects } = await supabase
  .from("subjects")
  .select("id, code, name_uk, active, is_stub, sort_order, config, kind, group_id")
  .order("sort_order")
  .returns<SubjectRow[]>(); // SubjectRow (server/db/types.ts) отримує kind, group_id

const { data: groups } = await supabase
  .from("course_groups")
  .select("id, name_uk, active")
  .returns<CourseGroupRow[]>();
const groupById = new Map((groups ?? []).map((g) => [g.id, g]));
```

Рендер-цикл (заміна єдиного блоку `(subjects ?? []).map(...)`) розділяється на **дві секції** (шкільні предмети — без змін вище/нижче; курси — нова секція, US-22.2 КП-5):

```ts
const schoolSubjects = (subjects ?? []).filter((s) => s.kind === "school_subject");
const courses = (subjects ?? []).filter((s) => s.kind === "course").filter((s) => {
  // ВП-52: ефективна видимість курсу = group.active AND course.active (US-22.3 КП-3).
  // Курс поза групою -> лише власний .active. group_id, що вказує на видалену групу
  // (on delete set null уже це унеможливлює), тут не трапляється.
  const group = s.group_id ? groupById.get(s.group_id) : null;
  const groupOk = !s.group_id || (group?.active ?? false);
  return s.active && groupOk; // active=false АБО group inactive -> ПОВНІСТЮ прибирається (не рендериться взагалі)
});
```

`schoolSubjects` рендериться **точно так само, як і сьогодні** (активний → лінк на `/subject/[id]`; неактивний, не stub → сіра плитка `opacity-55 aria-disabled` — рядки 76–89 наявного файлу, без жодної зміни коду цієї гілки). `courses` — **новий блок JSX** нижче, з бейджем «курс» (текст/іконка — рішення `designer`), який рендерить лише вже відфільтровані (`active && groupOk`) рядки — тобто в неактивному стані курс просто **відсутній у масиві**, немає навіть галузі "сіра плитка" для нього (US-22.2 КП-6 буквально: `active=false` → зникає). Групи, у яких немає жодного видимого курсу (усі власні `active=false`, або сама група `active=false`), не рендерять порожню картку — секція «Курси» цілком не показується, коли `courses.length === 0` (той самий принцип порожнього стану, що вже описаний для US-23.1 КП-7).

**`app/src/server/subjects/queries.ts` (`listSubjectsOverview`, `getSubjectDetail`) — кабінет тата, не дитина:** тут `kind`-фільтрація **НЕ потрібна** — тато повинен бачити і предмети, і курси, і активні, і неактивні (керує переліком). Зміна тут — **додати параметр** `kind: 'school_subject' | 'course'` до обох функцій (або дві тонкі обгортки `listSubjectsOverview`/`listCoursesOverview`, `getSubjectDetail`/`getCourseDetail`, що діляться спільною внутрішньою реалізацією з `kind`-фільтром у `WHERE`), щоб побудувати **два окремі списки** — «Предмети» (`app/parent/subjects`, лише `kind='school_subject'`) і новий «Курси» (`app/parent/courses`, лише `kind='course'`, `+ group_id`/групова навігація) — саме так, як US-22.2 КП-1 явно вимагає «окремий, не той самий список». `SubjectOverviewItem`/`SubjectDetail` отримують необов'язкові поля `kind`, `groupId`/`groupName` для курсового представлення; жодних змін щодо школи, крім доданого `kind`-фільтра в WHERE.

**`app/src/app/(child)/subject/[id]/page.tsx`** — жодних змін: `getSubjectDetail` + `if (!subject.active) notFound()` уже коректно обробляє й курс (перевірка `active` та сама), єдине уточнення — якщо курс належить неактивній групі, `getSubjectDetail`/цей маршрут мають так само повертати `notFound()` (пряме посилання дитини на курс під вимкненою групою не повинно працювати в обхід «Сьогодні»): додається той самий вираз ефективної видимості `s.active && groupOk` у сам `getSubjectDetail` (для kind='course'; для kind='school_subject' — group_id завжди null, вираз тривіально `true`), одна умова, спільна для обох kind.

**`app/src/server/books/queries.ts` (`listSubjects`, форма прикріплення книги, US-2.6 КП-5/US-22.2 КП-3):** без жодної зміни — вже повертає всі `is_stub=false` рядки `subjects` незалежно від `kind`; щойно з'являється рядок `kind='course'`, він одразу видно у випадаючому списку «Мої книги → предмет» — саме так закривається реальний блокер PO (прикріпити книгу до курсу — той самий, уже готовий UI/дія, `updateBookAction`, без жодної нової кнопки «Прив'язати до курсу»; можна опційно перейменувати підпис поля в UI з «Предмет» на «Предмет / курс» — косметика для `designer`, не логіка).

### 4. Де в кабінеті це живе (підтвердження шару даних/дій, не візуального макета)

- **`app/parent/subjects`** (наявний маршрут, `app/src/app/parent/subjects/page.tsx`) — розширюється формою «Додати шкільний предмет» (викликає `addSubjectAction` → `add_subject`) і перемикачем активності на кожній картці (`toggleSubjectActiveAction` → `set_subject_active`); деталь предмета (`app/src/app/parent/subjects/[id]/page.tsx`, вже містить `CurrentTopicPicker`) отримує форму перейменування (`renameSubjectAction` → `rename_subject`).
- **`app/parent/courses`** (новий маршрут, дзеркалить структуру `app/parent/subjects` + `[id]`) — список курсів (`kind='course'` через новий `listCoursesOverview`), форма «Додати курс» (`addCourseAction` → `add_course`, з опційним вибором групи), перемикач активності курсу (`toggleCourseActiveAction` → `set_subject_active`, та сама RPC, `kind` не перевіряється в самій RPC — вона універсальна для обох kind, розрізнення лише в тому, яка server action її викликає й з яким текстом помилки); деталь курсу — перейменування (`update_course`) + прикріплення матеріалу (лінк на вже наявний `app/parent/books/[id]` → `BookSettingsForm`, US-2.6 КП-5, без нового UI, лише `subjects`-список тепер містить курси).
- **`app/parent/courses/groups`** (Should, US-22.3) — новий, найлегший екран: список груп (`add_course_group`/`rename_course_group`/`set_course_group_active`), і на екрані курсу — випадаючий список «Група» (той самий принцип, що `select` предмета в `BookSettingsForm`).
- **Стиль компонентів** — той самий, що вже усталений `CurrentTopicPicker.tsx`/`BookForms.tsx`: клієнтський `"use client"` форм-компонент + `useActionState` + server action у `app/src/app/actions/subjects.ts` (розширюється новими експортами `addSubjectAction`, `renameSubjectAction`, `toggleSubjectActiveAction`, `addCourseAction`, `updateCourseAction`, `toggleCourseActiveAction`, `addCourseGroupAction`, `renameCourseGroupAction`, `toggleCourseGroupActiveAction`) + `revalidatePath` на відповідний список. Жодного нового патерну — точкове розширення наявного файлу тим самим стилем, що вже містить `setCurrentTopicAction`.
- **Одна деталь для UI (не логіки):** перемикач «Шкільний предмет» / «Курс» при створенні (КП-7 US-22.1 — тато обирає `kind` явно, немає евристики на сервері) реалізується просто як **дві різні кнопки/форми на двох різних екранах** («Додати предмет» на `/parent/subjects` завжди викликає `add_subject`, «Додати курс» на `/parent/courses` завжди викликає `add_course`) — не один перемикач в одній формі; так простіше й напряму відповідає тому, що це «окремий список» (US-22.2 КП-1), а не одна форма з полем вибору.

### 5. Активна сесія при вимкненні (US-22.1 КП-6/US-22.2 КП-6) — підтвердження: без нової логіки

`set_subject_active`/`set_course_group_active` лише пишуть `active`/`active` — не чіпають `lesson_sessions`. Оскільки й «Сьогодні», і `/subject/[id]` вже фільтрують за `active` **на кожному завантаженні сторінки** (server component, не client-side realtime-підписка), поточна вже відкрита сторінка уроку (`/subject/[id]/lesson/...`, якщо такий маршрут існує в наступному зрізі, чи еквівалент) просто не перечитує список предметів посеред кроку — природний наслідок архітектури «читання при заході на сторінку», без жодного спеціального коду «не переривати сесію». Нова спроба зайти на `/subject/[id]` чи повернутись на «Сьогодні» вже отримає оновлений, відфільтрований список — задовольняє КП-6 обох US без додаткової реалізації.

## Вплив на вартість

`[$S]` — мізерно. Нові рядки метаданих (RPC-виклики — прості `UPDATE`/`INSERT`, без ШІ), без жодного нового виклику моделі понад те, що вже рахується для індексації книги (US-2.6) чи генерації уроку. Жодного нового рядка `model_routes`, жодного нового провайдера.

## Альтернативи

| Варіант | Чому ні |
|---|---|
| Новий `learning_modules`-рядок `courses` замість розширення `subjects.kind` | ADR-017 вже трактує «предмет = дані»; курс — це рівно такий самий рядок `subjects` за формою (назва, теми, матеріали, активність), просто без прив'язки до класу/навчального року. Новий модуль подвоїв би конвеєр індексації/уроків, який курс і так повторно використовує без жодної зміни (US-22.2 КП-3 явно вимагає той самий, не новий, конвеєр). |
| `CHECK`-обмеження в БД замість RPC-перевірки для «`group_id` лише для `kind='course'`» | Декларативний `CHECK` у Postgres не бачить `kind` іншого рядка через прості (immutable) вирази без subquery/volatile-функції в constraint (не підтримується); RPC — єдиний шлях запису, тож перевірка там еквівалентно надійна і простіша. |
| Дозволити RLS-політику `INSERT`/`UPDATE authenticated` замість SECURITY DEFINER RPC | Це відновило б пряму можливість для будь-якого автентифікованого клієнта (включно з дитячою сесією через спільний `family_id`) редагувати `subjects` в обхід перевірки ролі/дублювання на сервері — прямо суперечить наявному свідомому рішенню відкликати ці права (коментар у самій міграції S0) і патерну, вже усталеному для `set_current_topic`. |
| Перевикористати `set_current_topic` для активації нового предмета замість окремої `set_subject_active` | `set_current_topic` вимагає готового підручника (`no_textbook`-гейт) і одразу прив'язує тему — не підходить для простого перемикача «показати/сховати» серед предметів, у яких тема ще не вибрана (КП-1 US-22.1: новий предмет одразу видно неактивним, до підручника); окрема, вужча RPC чіткіша й безпечніша (менше побічних ефектів на виклик). |
| Одна універсальна форма «Додати предмет/курс» з полем-перемикачем `kind` замість двох окремих екранів | US-22.2 КП-1 прямо вимагає «окремий, не той самий список» — об'єднана форма плутає модель (тато щоразу вибирає тип) там, де сам факт «я на екрані Курси» вже й так однозначно визначає `kind`; два прості, тонкі UI-шляхи дешевші й зрозуміліші, ніж один розгалужений. |

## Наслідки

- **Нова колонка** `subjects.kind` (`school_subject`/`course`, `CHECK`, `default 'school_subject'`, без backfill-кроку) і `subjects.group_id` (nullable FK на нову `course_groups`).
- **Нова таблиця** `course_groups` (RLS `select`-only для `authenticated`, як і `subjects`).
- **Новий частковий унікальний індекс** `subjects_owner_kind_name_uidx` (`owner_family_id, kind, lower(trim(name_uk))`) і `course_groups_owner_name_uidx` (`owner_family_id, lower(trim(name_uk))`) — дублювання за назвою `trim`+`lower`, окремо в межах `kind`.
- **9 нових SECURITY DEFINER RPC**, `service_role`-only, гейт «лише тато» через `requireParentAccess()` у server actions, що їх викликають: `add_subject`, `rename_subject`, `set_subject_active`, `add_course`, `update_course`, `add_course_group`, `rename_course_group`, `set_course_group_active` (`set_subject_active` перевикористовується і для курсу — той самий предмет-рядок) + допоміжна `slugify_subject_code`.
- **Розширення** `app/src/app/actions/subjects.ts` (нові server actions за взірцем `setCurrentTopicAction`), `app/src/server/subjects/queries.ts` (`kind`-параметр/дві обгортки), `app/src/server/db/types.ts` (`SubjectRow.kind`, `.group_id`, новий `CourseGroupRow`).
- **Новий маршрут** `app/parent/courses` (+ `[id]`, + `groups`), дзеркалить `app/parent/subjects`.
- **Розширення** `app/src/app/(child)/today/page.tsx` (`kind`-умовний рендер, нова секція «Курси», ефективна видимість `active AND group.active`) і `app/src/app/(child)/subject/[id]/page.tsx` (та сама умова видимості в `getSubjectDetail`) — без зміни поведінки для `kind='school_subject'`.
- **Немає зміни** в `server/books/queries.ts`, `BookForms.tsx`, `updateBookAction` — прикріплення матеріалу до курсу працює вже наявним шляхом US-2.6 КП-5, щойно з'являється рядок `kind='course'` у `subjects`.
- **Видалення предмета/курсу (КП-4 US-22.1)** свідомо залишено як окрема, вужча RPC для `developer` на етапі реалізації (перелік «показаних дитині блоків», що блокують видалення, варто звірити на той момент — може з'явитися нова таблиця між цим ADR і кодуванням).

## Питання/примітки для Алекса (не блокують реалізацію — рекомендації архітектора вже застосовано як дефолти)

1. **ВП-49 (якість нового шкільного предмета):** цей ADR не вирішує, чи новий предмет (напр. «Інформатика») проходить окремий предметний зріз якості (як S18–S23) чи одразу йде звичайним конвеєром без спеціальної перевірки — це продуктове рішення, не архітектурне; технічно обидва варіанти сумісні зі схемою вище без змін.
2. **ВП-53 (третій стан «чернетка»):** свідомо не додано — `active=false` вже і є «чернетка» в наявній моделі (предмет видно тату, дитині — сіро/сховано залежно від `kind`); якщо PO згодом захоче явний третій стан (наприклад, «ще не готово» відмінне від «готово, але вимкнено»), це нова колонка `status` окремим ADR, не зачіпає рішення тут.
3. **`code`-генерація (`slugify_subject_code`)** ніде не показується користувачу — архітектор свідомо не деталізує точний алгоритм транслітерації тут (питання для `developer` на етапі реалізації, тривіальне рішення прийнятне).
