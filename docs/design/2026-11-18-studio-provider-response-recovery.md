# Відповідь OpenAI до перевірки формату

Новий скриншот: phase=lesson_sources, spent1.149, held1.496, cap5, genericSTUDIO-STAGE/PROCESSING. Він доводить збій поза локальним applycatch, але не конкретну providerпричину. Приватні productionлоги недоступні. Встановлена прогалина: OpenAIадаптер відкидає incomplete/invalidJSON/schemafail до returnusage, а router записує errorз0tokens; зовнішній receiptworkflow цих результатів не бачить.

Studio використовуватиме окремий captureadapter через той самий router/маршрут/бюджет. Успішна HTTPвідповідь із достовірним usage повертає внутрішній envelope(result,failure?), де incomplete/refusal/JSON/schemafailure позначено без apply. Router враховує відомі tokens, workflow зберігає immutable receipt і застосовує лише валідний completedрезультат. Інші споживачі openaiStructured зберігають чинний контракт. Невідомий usage/timeout/network зберігає резерв, без припущення про оплату.

ProviderError отримує безпечний класифікатор; UI показує окремі authentication/rate/schema/timeout/incomplete коди без raw provider message/секретів. Повтор receipt завжди локальний. Якщо receipt відсутній, звичайний retry не створює новий платний виклик; окрема явно позначена платна команда зберігає старий невизначений резерв і може запустити новий запит у межахcap. DefinitiveHTTP4xxвідмова звільняє лише поточний резерв;5xx/network ні. Чинні старі held не скидаються автоматично.

Жодної міграції, зміни навчальної рубрики, автоматичної публікації чи збільшення бюджету. Потрібні fakeHTTP→справжнійadapter/router/workflowregressions дляcompleted,incomplete,schema,timeout,4xx й незалежна перевірка витрат/cacheusage.
