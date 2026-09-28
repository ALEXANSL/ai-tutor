# BUG-044 — `runStructureSection` clears its cost-safety checkpoint before the pass is actually finished, so a transient failure right after can still trigger a second paid AI call

- **Серйозність:** Major (реальні гроші; вузьке, але реальне вікно того самого класу збою, який commit 984d47e мав повністю усунути)
- **Пов'язана story / ADR:** ADR-032 (incremental per-section book structuring), commit 984d47e "fix(ingest): checkpoint paid AI calls in ADR-032 structuring to stop retry double-billing"
- **Файл:** `app/src/server/ingest/pipeline.ts`, функція `runStructureSection`

## Контекст

Commit 984d47e додає checkpoint-кеш (`material_sections.structure_result`), щоб транзиторний збій у детермінованих записах ПІСЛЯ успішного платного виклику `indexing_structure` не призводив до повторного платного виклику при retry. Коментар у коді й міграції прямо каже: кеш очищується "тільки коли прохід ПОВНІСТЮ завершився успішно" ("cleared only once the pass has FULLY completed").

## Факт (підтверджено читанням коду)

У кінці `runStructureSection` (app/src/server/ingest/pipeline.ts, ~рядки 1097-1101):

```ts
const { error: assignErr } = await scope.client.rpc("assign_chunk_structure", { p_family_id: familyId, p_material_id: materialId });
if (assignErr) throw new Error(`assign_chunk_structure failed: ${assignErr.message}`);

// Clear the checkpoint (above) together with the terminal status write —
await scope.update("material_sections", { status: "ready", status_detail: null, structure_result: null }).eq("id", sectionId);
await finalizeMaterialStatus(scope, materialId);
```

`structure_result: null` (кеш очищується) записується РАЗОМ зі `status: "ready"` — але ПІСЛЯ цього рядка ще виконується `await finalizeMaterialStatus(scope, materialId)`, яка:
1. Робить два `select` (materials_sections, materials) без перевірки `.error`;
2. Викликає `patchMaterial(...)`, яка сама явно кидає `Error` при будь-якій помилці запису (`app/src/server/ingest/pipeline.ts:113-116`: `if (error) throw new Error(...)`).

Якщо `finalizeMaterialStatus` впаде через транзиторну мережеву/БД-помилку (той самий клас збою, що й вихідний інцидент — "a transient downstream failure re-runs the WHOLE job"), `runStructureSection` кине `Error`, `isRetryableIngestError` визнає його retryable, і job runner повторно викличе `runStructureSection` для того самого `sectionId`.

На цьому повторному вході: `section.structure_result` вже `null` (щойно очищений), а `section.status` вже `"ready"` — функція НЕ перевіряє `status === "ready"` на вході і не бачить кеш → cache miss → **другий платний виклик `indexing_structure`** для розділу, який уже повністю й успішно оброблений і закомічений як `ready`. Це саме той сценарій подвійного білінгу, який commit 984d47e мав закрити повністю, лише перенесений на кілька рядків пізніше (вужче вікно, але не нульове).

`runStructureOutline`, для порівняння, очищує `structure_outline_result` дійсно останнім рядком функції (після `enqueueJob`-fan-out) — там такого дефекту немає, це специфічно для `runStructureSection`.

## Кроки відтворення (юніт-тест)

1. Мок `callStructured` повертає успішну відповідь.
2. Мок `assign_chunk_structure` RPC — успіх.
3. Мок `scope.update("material_sections", …)` для фінального запису (`status:"ready", structure_result:null`) — успіх.
4. Змусити наступний виклик усередині `finalizeMaterialStatus` (напр. `patchMaterial` на `materials`) кинути помилку на першій спробі, успіх на другій — саме так, як існуючий тест уже робить для `assign_chunk_structure`, тільки крок збою переносимо на один рівень пізніше.
5. Викликати `runStructureSection(job)` — очікується reject.
6. Перевірити: `section.status === "ready"`, `section.structure_result === null` вже після першого (невдалого) виклику.
7. Викликати `runStructureSection(job)` вдруге (retry).
8. **Очікується (поточний баг):** `callStructured` викликається ВДРУГЕ — платний виклик повторюється для вже готового розділу. Тест на це зараз відсутній у `pipeline.test.ts` (наявний тест `"runStructureSection: AI called once…"` фейлить лише `assign_chunk_structure`, тобто ДО очищення кешу — не тестує збій ПІСЛЯ очищення).

## Очікуваний результат
`callStructured` викликається рівно один раз незалежно від того, на якому саме кроці після успішного AI-виклику стався транзиторний збій — включно зі збоєм у `finalizeMaterialStatus` вже ПІСЛЯ запису `status: "ready"`.

## Фактичний результат
Другий платний AI-виклик відбувається, якщо збій стається саме між очищенням `structure_result` (+ записом `status: "ready"`) і успішним завершенням `finalizeMaterialStatus`.

## Завдання для `developer`
Один із двох варіантів (перший простіший і безпечніший):
1. На вході `runStructureSection`, одразу після завантаження `section`, додати ранній вихід: якщо `section.status === "ready"` (і немає новішого re-queue, тобто без `structure_result` це вже термінальний стан) — просто `return` (нічого не робити), а не покладатися лише на порожній кеш. Це робить функцію ідемпотентною відносно вже завершеного розділу незалежно від того, де саме стався попередній збій.
2. Або: перемістити виклик `finalizeMaterialStatus(scope, materialId)` (і будь-що, що може кинути) ПЕРЕД фінальним `update(..., { structure_result: null })`, так щоб очищення кешу дійсно було найостаннішим кроком, що виконується лише після того, як усі здатні кинути помилку записи вже завершились успішно.

Рекомендую варіант 1 — він додатково захищає від будь-яких майбутніх кроків, доданих після цього місця в майбутньому, а не лише від поточного `finalizeMaterialStatus`.

Також додати юніт-тест (сценарій вище) у `pipeline.test.ts`, який явно фейлить без фіксу.
