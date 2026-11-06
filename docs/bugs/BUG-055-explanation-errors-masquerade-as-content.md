# BUG-055 — збій пояснення видається за навчальний матеріал

2026-11-06. На скриншоті математики замість пояснення — fallback з `explainStepAgain`, також доступне повторне озвучення цієї помилки.

Підтверджено кодом: catch будь-якої помилки router повертав звичайний текст, зберігав його як AI message і повертав status ok. UI синтезував для нього аудіо. Це приховувало бюджетне блокування, відсутню конфігурацію, provider errors і timeout за однаковим «за хвилинку».

Виправлення: невдалий запит не записується як відповідь; server actions повертають безпечну категорію причини. UI показує alert і повторну спробу, не викликає TTS для помилки. Provider error bodies, ключі, текст дитини не передаються в UI чи нові логи. Legacy action також обробляє помилку. Успішні пояснення/озвучення збережені.

Це виправлення прихованої помилки, не підтвердження відновлення production AI. Конкретну причину останнього запиту не встановлено: у поточному середовищі немає authenticated production logs/DB. Після релізу потрібна повторна спроба з новою категорією. Не змінюємо модель, бюджет, матеріали чи імпорти навмання.

Перевірено: 1822 unit tests, TypeScript, production build, ESLint (0 errors / 8 existing warnings), client bundle scan 101 files / 0 leaks. Regression: failed model call does not insert an AI message; error bodies remain private; no failed explanation TTS; a retry succeeds and plays normally. Це mock-based перевірки, не авторизований production AI-виклик.
