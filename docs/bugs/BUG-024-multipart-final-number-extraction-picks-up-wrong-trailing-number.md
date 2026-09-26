# BUG-024 — `extractExpectedPartResults` (BUG-022 fix) can grab the wrong number when a lettered sub-part contains more than one number after its result

| Поле | Значення |
|---|---|
| Статус | **Open** |
| Серйозність | **Major** (risk of a false-positive `correct` on a step where one sub-part's arithmetic is actually wrong; not safety-critical, does not touch BUG-013 override) |
| Зріз | S3 (педагогічний конвеєр / оцінювання відповідей), continuation of BUG-019/BUG-021/BUG-022 |
| Пов'язано з | `extractExpectedPartResults`/`matchesMultiPartFinalNumbers` in `app/src/server/lessons/orchestrator.ts` (introduced by the BUG-022 fix, commit `1d2ea8f`) |

## Контекст
Independent QA review of commit `1d2ea8f` (BUG-021 + BUG-022 fixes), before merging `claude/intelligent-carson-6exmc1` into `main`. This is **not** a safety-override regression — the `moderation.severity === "urgent"` override in `submitStepAnswer` (orchestrator.ts, after `evaluateAnswer`) was re-verified line-by-line and unconditionally overwrites `verdict`/`explanation` after any deterministic fast path or LLM call runs, exactly as claimed. This bug is specifically about the new multi-part deterministic grader's number-extraction heuristic.

## Кроки відтворення
`extractExpectedPartResults(expectedAnswerUk)` takes, for each lettered sub-part (а)/б)/в)…), the **last** number appearing in that sub-part's text slice (from right after its own marker to right before the next marker) as "the" expected final result for that sub-part. This assumes a sub-part's text always ends with its result and never contains any other number afterward. That assumption breaks whenever a sub-part's reference text includes a number *after* the actual result — e.g. a self-check aside, a figure/page reference, or units expressed as a second number.

Reproduced standalone (identical logic copied verbatim from the source):

```js
const tricky =
  "а) 25% від 800 км = 200 км (перевірка: 200 х 4 = 800), " +
  "б) 10% від 800 км = 80 км, в) 5% від 800 км = 40 км.";

extractExpectedPartResults(tricky);
// -> [800, 80, 40]   (part "а" should be 200 — the actual result — not 800,
//     the last number in the self-check parenthetical)
```

Consequently:
```js
matchesMultiPartFinalNumbers("200, 80, 40", tricky); // -> false (the genuinely correct answer misses the fast path — safe, falls to the LLM)
matchesMultiPartFinalNumbers("800, 80, 40", tricky); // -> true  (a CHILD'S ARITHMETIC MISTAKE — forgetting to divide by 4 — is graded `correct`)
```

A second, more directly BUG-022-shaped reproduction using the exact production wording style, with a trailing figure reference instead of a self-check:
```js
const tricky2 = "а) 800:2=400 км, б) 800:4=200 км, в) 800:4·3=600 км (див. мал. 2).";
extractExpectedPartResults(tricky2); // -> [400, 200, 2]  — last part's result silently replaced by the figure number "2"
matchesMultiPartFinalNumbers("400, 200, 2", tricky2);   // -> true  (child literally writing the figure number "2" instead of "600" is graded correct)
matchesMultiPartFinalNumbers("400, 200, 600", tricky2); // -> false (the genuinely correct answer misses the deterministic fast path)
```

## Очікувано
The deterministic multi-part fast path should only ever fire `true` when it is unambiguous which number is each sub-part's actual final result (per its own design intent: "It only ever returns `true` (an exact, unambiguous match)"). A sub-part containing more than one number after its lettered marker is exactly the "can't confidently parse" case the function's own doc comment says should fall through to the LLM evaluator (`fewer than two lettered parts, a part with no number, a different count of numbers than parts` — this fourth case, "a part with an AMBIGUOUS extra number", is missing from that list and from the code).

## Фактично
- **Safe direction (common case):** when the wrongly-extracted number doesn't match anything the child would plausibly type, the fast path silently misses (falls through to the LLM, which still grades correctly) — no harm, just a missed optimization.
- **Unsafe direction (the actual bug):** when a child makes a real arithmetic mistake that happens to produce the same wrong number the extractor picked up (very plausible for "forgot to divide once more" type mistakes, as in the first repro, or when the reference text ends with an incidental small number like a figure/page reference, as in the second repro — a small number like "2" or "1" is exactly the kind of number a genuinely wrong short numeric answer could also coincidentally be, or that a child skipping a sub-part / miscounting sub-parts could produce), the deterministic check fast-paths a **substantively wrong or nonsensical answer straight to `correct`**, with `callStructured` (the LLM evaluator) never even invoked — there is no second layer of judgement to catch it, exactly the failure mode BUG-021 already flagged for the word-fragment case, now reappearing for numbers via a different code path.
- This is content-format-dependent risk, not a contrived edge case: `expectedAnswerUk` is LLM-generated per lesson (`app/src/server/lessons/generate.ts`/`pipeline.ts`), not hand-authored from a fixed template, so nothing currently constrains the generator to always end each lettered sub-part's text with exactly one number and nothing else — a self-check aside, a units clarification, or a "see figure/page N" style annotation are all plausible generated phrasings.

## Ризик / вплив
- Не зачіпає safety-override (BUG-013) — перевірено, порядок виконання в `submitStepAnswer` незмінний, `moderation.severity === "urgent"` перезаписує `verdict`/`explanation` безумовно після будь-якого детермінованого чи LLM вердикту.
- Педагогічно шкідливо в той самий спосіб, що BUG-021: дитина, що фактично помилилась в обчисленні одного з підпунктів, отримує «Молодець, правильно!» і рухається далі, не отримавши жодного пояснення своєї помилки (порушує D-74/P-H у протилежний бік — тепер уже не "занадто суворо", а "занадто щедро й неправильно").
- Ширше: та сама вада логіки ("останнє число в тексті = результат") могла б так само зіпсувати сам БУГ-022 регресійний тест, якби `expectedAnswerUk` у реальному уроці був сформульований трохи інакше (з поясненням чи посиланням після числа) — тобто поточний unit-тест перевіряє лише один конкретний, "зручний" формат вхідного тексту, а не стійкість самої функції-екстрактора до формату.

## Завдання для developer
1. Зробити `extractExpectedPartResults` менш крихким: замість "просто останнє число в слайсі", розпізнавати результат детерміновано лише коли він однозначний — наприклад, вимагати, щоб число-результат стояло одразу після `=` (знака рівності) у тому ж підрядку, і повертати `null` (fallback до LLM), якщо після цього `=` є ще якийсь текст з числами (дужки, "див. мал./стор. N" тощо) замість жорсткого припущення "останнє число — завжди результат".
2. Якщо немає надійного способу однозначно ідентифікувати результат підпункту (наприклад, немає `=` взагалі), функція вже і так має повертати `null` — переконатися, що це так, і додати явний тест на цей випадок (сторонній трейлінг-номер після результату → `null`, а не тихий неправильний `[wrong_number, ...]`).
3. Додати регресійні автотести саме на обидва репро вище: (а) sub-part з self-check дужкою після результату; (б) sub-part з посиланням на малюнок/сторінку після результату — обидва мають повертати `null` з `extractExpectedPartResults` (fallback до LLM), а НЕ хибний вердикт `correct` для явно неправильної/безглуздої відповіді дитини, що збігається з хибно видобутим числом.
4. Незалежна QA-перевірка перед мержем — знову перевірити, що фікс не звужує вже наявний BUG-022 регресійний тест (реальний приклад "400, 200 і 600" все ще має проходити без звернення до LLM), і що safety-override (BUG-013) не зачеплено.

## Примітка щодо перевірки порядку числових пар (окрема перевірка QA, НЕ баг)
Для повноти: QA також перевірила, що коли дитина дає правильні кінцеві числа у **неправильному порядку** відносно підпунктів (напр. "600, 400, 200" замість "400, 200, 600"), `matchesMultiPartFinalNumbers` коректно повертає `false` (позиційне порівняння по індексу ловить це) — жодного хибного `correct`, відповідь іде до LLM-оцінювача як і мало б бути. Це поведінка коректна, регресії немає.
