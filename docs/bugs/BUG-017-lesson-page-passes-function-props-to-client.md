# BUG-017 — «Functions cannot be passed directly to Client Components» на КОЖНОМУ відкритті `/lesson/[sessionId]`

| Поле | Значення |
|---|---|
| Серйозність | **Critical** (кожне відкриття екрана уроку) |
| Зріз | S3/S4 (`(child)/lesson/[sessionId]/page.tsx` → `LessonRunner`) |
| Знайдено | Продакшн-логи Vercel: `Error: Functions cannot be passed directly to Client Components unless you explicitly expose it by marking it with 'use server'.` |
| Статус | **Fixed** (2026-09-26) |

## Що сталося

`app/src/app/(child)/lesson/[sessionId]/page.tsx` — серверний компонент — робив:

```ts
const t = uk.child.lesson;
...
<LessonRunner ... labels={t} />
```

`LessonRunner` — `"use client"` — приймав `labels: Labels` як пропс. `uk.child.lesson`
містить не лише рядки, а й дві функції-форматери:

- `stepOf: (k: number, n: number) => \`Крок ${k} з ${n}\``
- `sourceRef: (title: string, page: number | null) => ...`

React Server Components серіалізують пропси, що перетинають межу сервер→клієнт (Flight
protocol); функцію так передати не можна (лише Server Action, позначену `"use server"`).
Оскільки `uk.child.lesson` завжди містить ці дві функції, **кожен** рендер екрана уроку падав
з цією помилкою — не лише коли компонент фактично викликав `sourceRef`/`stepOf`, а на самому
акті передачі пропса.

Той самий патерн знайдено і в `app/(child)/friend/page.tsx` → `FriendChatScreen`
(`labels={uk.child.friend}`) — сьогодні в `uk.child.friend` функцій немає, тож там не падало,
але додавання будь-якої функції в цей неймспейс завтра відтворило б точно той самий баг.
Усі інші клієнтські компоненти уроку (`LessonPicker`, `LessonPausedScreen`,
`LessonSummaryScreen`, `DragSortStep`, `ChildStartLessonButton` тощо) вже імпортували `uk`
напряму (вони самі `"use client"` або їхній рендер не перетинає цю межу) — цього класу помилки
там не було.

## Виправлення

1. **`LessonRunner.tsx`:** замінено `import type { uk }` на звичайний імпорт значення
   (`import { uk } from "@/i18n/uk"`); головний компонент більше не приймає `labels` як пропс —
   бере `const t = uk.child.lesson;` сам, локально. Це безпечно: сам файл — клієнтський модуль,
   і статичний імпорт об'єкта (з функціями всередині) відбувається лише в браузерному бандлі,
   а не через серверний пропс-серіалізатор. Внутрішні під-компоненти в тому самому файлі
   (`StepBody`, `BreakOfferScreen`, `BlockCompleteScreen`, `TopicChat`) і далі отримують
   `labels` як звичайний пропс — це вже не перетинає сервер→клієнт межу, тож нешкідливо.
2. **`page.tsx`:** прибрано `const t = uk.child.lesson;`, імпорт `uk` і пропс `labels={t}`.
3. **`FriendChatScreen.tsx` / `friend/page.tsx`:** той самий фікс превентивно (той самий клас
   бага, поки без функцій у `uk.child.friend`, але щоб не повторилося).

## Тести (`src/i18n/uk.rsc-props.test.ts`, `src/server/lessons/schema.test.ts` — лише перший стосується цього бага)

- `uk.child.lesson.sourceRef`/`.stepOf` справді функції (документує реальну поверхню бага).
- **Справжнє відтворення**, не мок: окремий процес Node, запущений з `--conditions react-server`
  і власним `react-server-dom-webpack` Next.js (той самий серіалізатор, що працює в проді),
  реально серіалізує об'єкт-пропс із двома функціями через `renderToPipeableStream` і отримує
  рядок `"Functions cannot be passed directly to Client Components..."` — точно ту саму
  помилку, що впала в логах Vercel.
- Статичні перевірки джерела: `page.tsx` більше не імпортує `uk` і не передає `labels=`;
  `LessonRunner.tsx` імпортує `uk` як значення й читає `t` локально; той самий фікс
  підтверджено для `friend/page.tsx` + `FriendChatScreen.tsx`.

## Перевірено вручну

`npm run build` (webpack) — успішно; `check:bundle` — 0 leaks; e2e (`NODE_USE_ENV_PROXY=1`) —
58/58 зелені, зокрема сторінки без сесії (у продакшн-білді без бекенд-секретів справжній
контент `/lesson/[sessionId]` не рендериться — цей клас смоук-тестів не міг спіймати саме цей
баг, тому основна перевірка — юніт-тест вище, що реально відтворює механізм). Живе демо на
реальному уроці — лишається за Алексом.
