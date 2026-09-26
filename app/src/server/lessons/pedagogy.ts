/**
 * The evidence-based teaching-technique catalog referenced by US-6.9 КП-1
 * (principle P-P) and ADR-022: `lesson_planning` picks ≥ 2 of these for a
 * block, `lesson_generation` applies them, `lesson_review` checks that ≥ 2
 * were actually used and that they fit (US-6.9 КП-2). Keys are stable
 * strings stored in `library_items.pedagogy.techniques[].key` — never
 * renamed, only added to (a passport already saved keeps its old key even
 * if the label text here later changes).
 */
export interface PedagogyTechnique {
  key: string;
  labelUk: string;
  /** One line the prompt can quote — what the technique means in practice. */
  promptDoc: string;
}

export const PEDAGOGY_TECHNIQUES: PedagogyTechnique[] = [
  { key: "retrieval_practice", labelUk: "Активне пригадування", promptDoc: "Дитина спершу пригадує/пробує сама, перш ніж побачити готове пояснення." },
  { key: "spaced_repetition", labelUk: "Інтервальне повторення", promptDoc: "Коротке посилання на те, що вивчалося раніше з цієї теми (US-9.2)." },
  { key: "interleaving", labelUk: "Чергування форматів/задач", promptDoc: "Кроки різних типів і формулювань підряд, а не серія однакових вправ." },
  { key: "worked_example_fading", labelUk: "Розв'язаний приклад із поступовим зменшенням підказок", promptDoc: "Спершу повністю розв'язаний приклад, далі — та сама задача з меншою підказкою." },
  { key: "concrete_to_abstract", labelUk: "Від конкретного прикладу до абстрактного правила", promptDoc: "Спершу життєвий/наочний приклад, потім — узагальнення в термін чи формулу." },
  { key: "dual_coding", labelUk: "Подвійне кодування", promptDoc: "Текст супроводжується інтерактивним чи візуальним компонентом (US-6.8), де це доречно." },
  { key: "socratic_questioning", labelUk: "Сократичні запитання", promptDoc: "Питання, що підводять дитину до відповіді, замість готового висновку." },
  { key: "formative_check", labelUk: "Формувальне оцінювання з миттєвим відгуком", promptDoc: "Контрольний крок (choice/open/interactive) одразу після пояснення, з конкретним відгуком (US-16.2)." },
  { key: "error_as_material", labelUk: "Помилка як матеріал для пояснення", promptDoc: "Пояснення при неправильній відповіді використовує саму помилку, не просто повторює правило (US-6.3)." },
  { key: "personal_interest", labelUk: "Приклад з інтересів дитини", promptDoc: "Приклад чи аналогія спирається на узагальнений інтерес з профілю (напр. «космос»), без подробиць з життя (US-10.3)." },
  { key: "real_life_ua_context", labelUk: "Життєвий або український контекст", promptDoc: "Приклад із повсякденного життя чи українських реалій, не абстрактний і не іноземний за замовчуванням." },
  { key: "short_chunking", labelUk: "Короткі блоки", promptDoc: "Матеріал розбитий на невеликі кроки, жоден пасивний фрагмент не довший за 90 секунд читання." },
  { key: "playful_framing", labelUk: "Гейміфікація без маніпуляцій", promptDoc: "Гра/виклик у подачі без штучних нагород, таймерів тиску чи страху пропустити (NFR-SAFE-12)." },
];

export const PEDAGOGY_TECHNIQUE_KEYS = PEDAGOGY_TECHNIQUES.map((t) => t.key) as [string, ...string[]];

export function pedagogyCatalogForPrompt(): string {
  return PEDAGOGY_TECHNIQUES.map((t) => `- ${t.key}: ${t.labelUk} — ${t.promptDoc}`).join("\n");
}

/** Rubric criteria `lesson_review` scores 0–2 each (US-6.11 КП-1, ADR-022). */
export const REVIEW_CRITERIA = [
  "methodology",
  "factualAccuracy",
  "ageGrade",
  "variety",
  "safety",
  "hook",
  "visibleOutcome",
  "warmth",
  "aesthetics",
] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];

export const REVIEW_CRITERION_LABELS_UK: Record<ReviewCriterion, string> = {
  methodology: "Методична якість (≥ 2 доказові прийоми, доречно застосовані)",
  factualAccuracy: "Фактична точність і несуперечність підручнику",
  ageGrade: "Відповідність віку та класу дитини (передані окремо в кожному виклику)",
  variety: "Різноманітність активностей",
  safety: "Безпека контенту й відсутність персональних даних дитини",
  hook: "«Гачок» на старті блоку (не сухе визначення)",
  visibleOutcome: "Видимий результат наприкінці блоку",
  warmth: "Тепло тону, заохочення, без осуду помилок",
  aesthetics: "Естетика/захопливість подачі (не сухий текст)",
};
