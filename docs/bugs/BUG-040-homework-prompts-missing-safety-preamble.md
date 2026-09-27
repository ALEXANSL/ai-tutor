# BUG-040 — Нові промпти «домашки з репетитором» (US-8.7) не отримують безпекову преамбулу

| Поле | Значення |
|---|---|
| Статус | **Fixed** — три виклики US-8.7 (`startHomeworkProblem`, `continueHomeworkAttempt`/`homeworkFallbackSolution`) тепер додають `safetyPreambleUk(tutorName, roleNoun)` перед системним промптом, точно за тим самим патерном, що вже був у `askTopicChat`/`explainStepAgain` цього файлу (`tutorGender` протягнуто через `homeworkProblemFlow`/`startHomeworkProblem`/`continueHomeworkAttempt`/`homeworkFallbackSolution`, оскільки ці промпти, на відміну від `step_reinforcement` у `orchestrator.ts`, самі підставляють справжнє ім'я репетитора, а не залишають `{{tutor_name}}`-плейсхолдер для generic-преамбули). Додано 3 регресійні тести в `homework.test.ts`, що перевіряють наявність преамбули в системному промпті кожного з трьох викликів (method/attempt_feedback/fallback). `npm run typecheck`, `npm test`, `npm run build` — усі проходять. |
| Серйозність | **Major (безпека)** |
| Пов'язано з | `app/src/server/lessons/chat.ts` (`startHomeworkProblem`, `continueHomeworkAttempt`, `homeworkFallbackSolution`), `app/prompts/homework_method.md`/`homework_attempt.md`/`homework_fallback.md` |

## Опис
`app/src/server/safety/preamble.ts` документує інваріант: `safetyPreambleUk`/`safetyPreambleGenericUk` **додається до кожного промпту кожної ролі, що говорить з дитиною напряму**. Усі наявні ролі дотримуються цього — `askTopicChat`'s звичайний шлях і `explainStepAgain` (`chat.ts`) додають `safetyPreambleUk(...)`; обидва виклики `step_reinforcement` в `orchestrator.ts` (US-6.15) додають `safetyPreambleGenericUk()`.

Три нові промпти US-8.7 (`homework_method.md`, `homework_attempt.md`, `homework_fallback.md`, викликані з `startHomeworkProblem`/`continueHomeworkAttempt`/`homeworkFallbackSolution`) будують `system2` через голий `fillTemplate(system, {tutor_name})` — **без жодної преамбули**.

## Чому це важливо
Детермінований `severity: 'urgent'`-override (BUG-013) досі спрацьовує коректно (перевіряється в коді ДО виклику моделі), тож це **не** регресія самого BUG-013-механізму. Але сама модель у цьому потоці втрачає явні інструкції преамбули (не обіцяти зберегти секрет від тата, не давати особисту інформацію, не обіцяти нагороди тощо) саме на тій поверхні (вільний текстовий чат про домашнє завдання), де дитина природно пише вільний текст і сіра зона (не класифікована як «urgent», але потенційно чутлива) найімовірніша.

## Завдання для developer
Додати `safetyPreambleUk(tutorName, ...)` (чи `safetyPreambleGenericUk()`, за тим самим патерном, що вже є для `step_reinforcement` у `orchestrator.ts`) на початок системного промпту всіх трьох викликів US-8.7 (`startHomeworkProblem`, `continueHomeworkAttempt`, `homeworkFallbackSolution`) — так само, як це вже зроблено для `askTopicChat`/`explainStepAgain` в тому ж файлі. Точковий фікс, не займатись іншою логікою цих функцій.

Прогнати `npm run typecheck`, `npm test`, `npm run build` перед комітом.
