# BUG-021 — `matchesExpectedBySubstance` (BUG-019 fix) can grade an incomplete/wrong open answer as fully `correct`

| Поле | Значення |
|---|---|
| Статус | **New** |
| Серйозність | **Major** — grading-correctness regression risk introduced by the BUG-019 fix (opposite failure mode: false positive `correct` instead of false negative) |
| Зріз | S3 (педагогічний конвеєр / оцінювання відповідей) |
| Пов'язано з | `matchesExpectedBySubstance` / `evaluateAnswer` in `app/src/server/lessons/orchestrator.ts` (introduced by the 2026-09-26 BUG-019 fix, commit `1a5dbe5`) |

## Контекст
Незалежна QA-перевірка фіксу BUG-019/BUG-020 (перед мержем `claude/intelligent-carson-6exmc1` у `main`). Це **не** блокер safety-override (BUG-013 перевірено окремо і не зачеплено — дет. нижче), а окрема проблема якості нового детермінованого попереднього кроку оцінювання відкритих відповідей.

## Кроки відтворення
`matchesExpectedBySubstance(answerText, expectedAnswerUk)` (orchestrator.ts:262-273) after normalizing punctuation/case, returns `true` if the child's *entire* answer is either equal to the reference answer, **or appears anywhere inside it as a contiguous word sequence** — with no requirement that the child's answer actually be a complete/adequate answer to the question, and no minimum-length/coverage threshold.

Reproduced standalone (same normalization/matching logic, copied verbatim from the source):

```js
// Питання: "Хто написав «Кобзар»?"  Еталон: "Тарас Шевченко"
matchesExpectedBySubstance("Тарас", "Тарас Шевченко");     // -> true
matchesExpectedBySubstance("Шевченко", "Тарас Шевченко");   // -> true

// Питання: "Навколо чого рухається Земля і чому?" Еталон: "Земля обертається навколо Сонця"
matchesExpectedBySubstance("сонця", "земля обертається навколо сонця"); // -> true (single keyword, no actual sentence/answer given)
```

Both are marked `correct` immediately, **without ever calling the LLM evaluator** — so there's no second layer of judgement that could catch that the answer is only a fragment.

## Очікувано
An answer that is only *part* of a multi-word/multi-fact reference answer, and does not stand on its own as a complete correct answer, should be graded `partial` (or go to the LLM evaluator, whose rewritten prompt explicitly allows a short-but-complete answer as `correct` while still catching an incomplete one) — not short-circuited to `correct` before the model ever sees it. This is exactly the distinction the fix's own new system prompt draws: *"`partial` — тільки коли сам РЕЗУЛЬТАТ неповний чи частково вірний по суті."*

## Фактично
Any single word (or short word-run) that happens to occur verbatim inside a longer reference answer is graded fully `correct`, regardless of whether it actually answers the question by itself. This re-introduces a milder version of the class of problem BUG-019 was meant to fix (grading not matching what a real teacher would do) — just in the opposite direction (over-crediting instead of under-crediting).

## Ризик / вплив
- Не safety-критично: не впливає на override BUG-013 (перевірено — `matchesExpectedBySubstance` виконується лише для `step.type === "open"` і завжди рахується/перезаписується безумовним `if (moderation.severity === "urgent")` блоком нижче за течією в `submitStepAnswer`, так само як і будь-який інший вердикт з `evaluateAnswer`; існуючий тест `"an 'urgent' open answer ALWAYS gets the deterministic go-to-dad reply"` це підтверджує і надалі проходить).
- Педагогічно шкідливо: дитина, що вгадала одне ключове слово з довгої еталонної відповіді (не сформулювавши фактичну відповідь), отримує повне підтвердження «Молодець, правильно!» і рухається далі, не засвоївши матеріал — розробники писали `expectedAnswerUk` як повне речення саме тому, що очікують повної відповіді по суті, а не одного співпадаючого слова.
- Найбільш імовірний реальний сценарій: питання з відкритою відповіддю, де еталон — речення з кількох слів і дитина випадково вгадує/переписує одне слово з формулювання питання, яке також трапляється в еталоні (наприклад, слово з умови задачі повторюється в очікуваній відповіді).

## Завдання для developer
1. Додати мінімальний поріг «покриття» перед тим, як зараховувати частковий збіг за словами як `correct` — наприклад, не давати `matchesExpectedBySubstance` спрацьовувати, коли довжина відповіді дитини (в словах) суттєво коротша за еталон (скажімо, менше half чи менше конкретної частки слів еталону), АБО обмежити цей fast-path лише випадком, коли `answer === expected` після нормалізації (повний збіг), а часткові підрядкові збіги (коротший фрагмент всередині довшого еталону) завжди відправляти до LLM-оцінювача — саме він, за новим промптом, має вирішувати, чи це `correct` (коротка, але повна відповідь по суті) чи `partial`/`incorrect` (лише фрагмент).
2. Додати автотест-регресію на цей конкретний випадок (одне слово з довгого еталону, що не є самостійною повною відповіддю, не повинно оминати LLM-оцінювач і автоматично отримувати `correct`).
3. Переконатися, що це не ламає вже наявні тести BUG-019 (`"а) 5 б) 12 в) 20"` — повний збіг за словами з еталоном `"а) 5, б) 12, в) 20."`, і відповідь-цифра `"2"` проти еталону `"Правильна відповідь — 2."` — обидва мають перевірятись: чи це full-length match, а не просто «одне слово з багатослівного еталону». Наведені приклади в тестах — це збіг **усієї** відповіді дитини як підрядка еталону; проблема саме коли відповідь дитини значно коротша за еталон.

## Примітка
Не блокує мерж поточного фіксу BUG-019/BUG-020 (немає впливу на safety-override BUG-013, немає регресії існуючих тестів), але має бути виправлено до того, як `matchesExpectedBySubstance` набуде більше реального трафіку — інакше можливе накопичення хибних `correct` вердиктів на реальних уроках.
