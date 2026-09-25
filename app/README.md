# ШІ-Репетитор — застосунок (Next.js PWA)

Код застосунку. Архітектура — `docs/02-architecture.md`, дизайн — `docs/04-design-system.md`,
зрізи — `docs/05-backlog.md`. Міграції бази — `../supabase/migrations/`.

## Структура

```
app/
  config/                 дані й конфігурація (не код): стартові налаштування сім'ї
                          (навчальний рік, клас, предмети, імена репетитора), словники перевірки імені
  public/icons/           іконки PWA (генеруються: npm run icons)
  scripts/                тестова БД, перевірка бандла на секрети, генерація іконок
  src/
    app/                  екрани й маршрути (App Router)
      (child)/            інтерфейс дитини: onboarding, today, my-tutor, about-ai, soon/[code]
      parent/             кабінет тата
      auth/               вхід через Google, колбек, вихід
      actions/            Server Actions (кожна перевіряє роль на сервері)
    components/           UI-компоненти
    core/registries/      реєстри ядра (ADR-017): навігація, режими, типи кроків, типи джерел
    modules/school/       навчальний модуль «Шкільна програма» (реєструється в ядрі)
    server/               лише серверний код (import "server-only"): auth, persona, db, env
    lib/                  спільна чиста логіка (валідація нікнейму/імені, формат PIN)
    i18n/uk.ts            усі тексти інтерфейсу
  tests/db/               RLS-тести на тимчасовому Postgres
supabase/
  migrations/             версіоновані SQL-міграції
  tests/supabase-shim.sql мінімальна імітація Supabase для локальних тестів
```

## Команди

```bash
cd app
npm ci                 # встановити залежності
cp .env.example .env.local   # і заповнити DEV-значеннями (файл у .gitignore)
npm run dev            # локальний запуск: http://localhost:3000
npm run lint           # ESLint
npm run typecheck      # TypeScript
npm test               # юніт-тести (vitest)
npm run test:db        # RLS-тести: піднімає тимчасовий PostgreSQL, застосовує міграції
npm run build          # продакшн-збірка
npm run check:bundle   # збірка з «канарковими» секретами + перевірка, що вони не потрапили в браузер
npm run build && npm run test:e2e   # Playwright: публічна/незалогінена поверхня (S0) на планшеті й телефоні
```

`npm run test:e2e` не потребує акаунтів Supabase/Google: перевіряє екрани, доступні без сесії
(вхід, offline, маніфест PWA, редіректи без сесії, відсутність секретів у HTML) у двох
в'юпортах — Lenovo Yoga 11 і Galaxy S24+ (`app/tests/e2e/`). Повні сценарії входу й PIN —
після появи акаунтів (`docs/06-test-plan.md`).

`npm run test:db` потребує локально встановленого PostgreSQL ≥ 15 (`initdb`) або змінної
`TEST_DATABASE_URL` на базу з уже застосованими міграціями.

## Як S0 запрацює на Vercel — кроки для Алекса

Акаунти створюються за `docs/03-resources-and-costs.md`, розділ 1 (кроки «До S0»). Нічого платного.

1. **Supabase — два проєкти** `ai-tutor-dev` і `ai-tutor-prod` (docs/03, 1.4, кроки 1–4).
2. **Google Cloud — вхід через Google** (docs/03, 1.5, кроки 1–6; статус застосунку — **In production**).
   У **Authorized redirect URIs** — Callback URL із Supabase обох проєктів.
3. **Supabase → Authentication → Sign In / Providers → Google → Enable** — Client ID і Secret із кроку 2
   (docs/03, 1.4, крок 5). Для кожного проєкту.
4. **Supabase → Authentication → URL Configuration** (у кожному проєкті):
   - *Site URL*: адреса застосунку у Vercel (prod — адреса продакшну; dev — адреса preview);
   - *Redirect URLs* → **Add URL**: `https://<адреса-prod>/auth/callback`; для dev-проєкту — також
     `https://*-<ваша-команда>.vercel.app/auth/callback` (усі preview) і `http://localhost:3000/auth/callback`.
5. **Supabase → SQL Editor → New query** (у кожному проєкті): по черзі вставити вміст трьох файлів із
   `supabase/migrations/` (у порядку назв) і натиснути **Run** для кожного. Очікуваний результат — «Success».
6. **Vercel → Add New… → Project → Import** репозиторію (docs/03, 1.3). На екрані імпорту:
   **Root Directory → Edit → `app`** → Continue. Framework — Next.js (визначиться сам).
7. **Vercel → Settings → Environment Variables** (docs/03, 1.14) — для S0 потрібні лише:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ALLOWLIST_PARENT_EMAILS`, `ALLOWLIST_CHILD_EMAILS`, `PIN_PEPPER` (довгий випадковий рядок, ≥ 16
   символів). Production — prod-значення, Preview/Development — dev.
   `APP_BASE_URL` (адреса застосунку) — **лише для Production**; для Preview залиште порожнім, тоді
   застосунок бере адресу конкретного preview. Після змін — **Deployments → … → Redeploy**.
   Порада: preview-адреси Vercel за замовчуванням відкриваються лише після входу у Vercel
   (Settings → Deployment Protection) — для демо на планшеті доньки це треба врахувати.
8. Увійти своїм акаунтом → **Налаштування → PIN режиму тата** → задати PIN.
9. Перевірка входу акаунтом доньки на планшеті (R-5, docs/02 10.1) — на демо.

Зміна `PIN_PEPPER` робить збережений PIN недійсним (його треба задати знову).
