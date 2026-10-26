# Предмети: готові матеріали та програми проходження

## Рішення PO, 2026-10-26

Матеріали готуються поза застосунком у ChatGPT за універсальним промптом і завантажуються готовим ZIP. Масова підготовка, індексація підручників для генерації й стара генерація уроків більше не є користувацьким сценарієм. Сторінка предмета — каталог чинних уроків і додаткових відео.

## Аудит поточного стану

- Parent subject page вимагала indexed textbook, попри готові V3 lessons/virtual PDF. Subject overview теж показував неправдиве «немає підручника».
- BulkWarmupPanel, StartLessonButton, library cards і ForecastPlanPanel належать попередньому AI-generation потоку; вибір current topic запускав warmAhead у фоні. SQL set_current_topic до того ж потребує indexed materials, тому це не готовий механізм планування нового ZIP-контенту.
- ContentAdmin list/cleanup охоплює чотири старі системи й не знає V3. Стара cleanup RPC архівує всі topics предмета, включно з topics чинного V3, при цьому самі V3 lessons не враховує. Масова очистка не є вибірковим видаленням дублікатів.
- Child subject page ще мала fallback підготовки/генерації, якщо імпортованого уроку немає, і запитувала warmup statuses навіть для готових курсів.
- Наявний ForecastPlan — прогноз сусідніх тем одного предмета за старими topic_dependencies. На child today досі placeholder. Міжпредметної програми проходження немає.

## Поточний зріз очищення UI

Основний parent screen: назва, імпорт готового ZIP, каталог доступних імпортованих уроків, додаткові відео. Вибір поточної теми зі старим SQL book gate не переноситься в новий сценарій: його замінить окремий composer програми. Налаштування назви та прив’язки вже наявних PDF — у другорядній згортці. Немає вимоги індексації, bulk generation, хибного старого прогнозу, old library cards чи broad cleanup. Retired bulk API й global cleanup API повертають пояснення без enqueue/RPC навіть для старих відкритих вкладок; set_current_topic не запускає warm-ahead. Вже наявні jobs не скасовувалися без інвентаризації. Child screen показує готові уроки; порожній каталог не пропонує генерувати їх.

Не видаляти існуючі записи/файли/спроби за ознакою «старий формат»: math/course/literature V2 лишаються чинними. Canonical active imported lesson визначається вже наявним resolver по topic_id. Точні дублікати пакетів із різними topic_id потребують окремого read-only inventory (system, package_key, topic_id, stable lesson_key, status, hasProgress, video references), preview і вибіркового архівування. У runtime немає production service-role/SQL доступу; такий inventory/cleanup не виконано.

## Навчальна програма — перший корисний MVP

Тато створює програму («Наздогнати пропущені теми»), вибирає уроки з різних предметів, задає порядок і необов’язкові тижні/дати. Базовий режим — гнучка черга, без покарання за перерви/повітряні тривоги. На today дитина бачить «Продовжити» і кілька наступних завдань, із переходом у вже наявний reader. Пауза зберігає місце.

Програма посилається на матеріали, не копіює/генерує їх повторно. Referenced lesson: family + subject_id + topic_id + source system + lesson_id; для стійкості до оновлень також package_key/stable lesson_key/revision. Не зіставляти за назвою. Якщо матеріал недоступний, позначити needs_attention й дати татові заміну, не переводити на інший урок мовчки.

Сутності: study_programs (family_id, child_id, title, draft/active/paused/completed), study_program_items (program_id, subject_id, lesson reference, position, optional target_date, required/optional), study_item_progress (child_id, item_id, not_started/in_progress/completed/skipped, resume reference, completion provenance). RLS за family/child. Унікальні positions у програмі, атомарний reorder, версія/updated_at для конфлікту двох пристроїв. Навчальна програма відокремлена від каталогу/активації предмета.

Completion: відкриття уроку не означає засвоєння; завершення reading/flow, тестові результати й ручна позначка тата — різні події. Не зараховувати перегляд відео як перевірку знань. Кожен із п’яти readers має окремі вже наявні джерела attempts/progress: спочатку інвентаризувати їх, потім зробити adapter, а не вигадати одну універсальну оцінку.

## Послідовність реалізації

1. Вирівняти каталог і прибрати generation UI (цей зріз); отримати inventory legacy duplicates до будь-якого архівування.
2. Нові SQL tables/RLS/RPC для draft programs/items, family tests, parent composer (вибір предмета → уроків, reorder, зберегти draft). Верифікувати застосування міграцій у production перед frontend release.
3. Publish/activate, child today queue, deep-link до reader, pause/resume, unavailable-material handling. Без нових model calls.
4. Верифікований progress adapter п’яти readers, ручне завершення/пропуск з явним provenance, parent огляд. Статуси з різних пристроїв не перезаписують завершення старішим state.
5. Лише після ручного MVP — пропозиції AI щодо порядку/повторення, з урахуванням інтересів, часу, бюджету й явним застосуванням змін татом. Рекомендація не переписує програму автоматично.

## Приймання майбутнього MVP

Змішана черга history→math→language; reorder; два пристрої; перерва й resume; повторний імпорт зі стабільним lesson id; видалений/вимкнений матеріал; інша сім’я; skip без удаваного завершення; existing reader не регресує; жодного прихованого AI-generation job. Календар і автоматичне планування не оголошуються реалізованими цим документом.
