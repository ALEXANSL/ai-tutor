import type { HomeworkFormat, HomeworkResult } from "@/lib/homework";
/** Observable deliverable checks, not a claim to have proved factual accuracy. */
export function homeworkQuality(result: HomeworkResult, format: HomeworkFormat, request: string) {
  const short = /(?:коротк|стисл|\b(?:50|80|100|120|150)\s*сл[іо]в)/iu.test(request);
  const normalizedRequest = request.replace(/не\s+(?:лише|тільки|суто)\s+текст/giu, "").replace(/без\s+(?:фото(?:графі\p{L}*)?|репродукці\p{L}*)/giu, "");
  const textOnly = /(?:лише|тільки|суто)\s+текст|без\s+(?:ілюстрац|схем|зображ|візуал)/iu.test(normalizedRequest);
  const issues: string[] = [], artifact = result.artifact;
  if (!artifact || format === "chat") return { status: "ready" as const, issues };
  issues.push(...(artifact.unresolvedRequirements ?? []));
  const tables = [...artifact.sections.flatMap(section => section.tables ?? []), ...artifact.slides.flatMap(slide => slide.table ? [slide.table] : [])];
  const visuals = [...artifact.sections.flatMap(section => section.visuals ?? []), ...artifact.slides.flatMap(slide => slide.visual ? [slide.visual] : [])];
  if (tables.some(table => table.rows.some(row => row.length !== table.columns.length))) issues.push("Є таблиця з неповними рядками.");
  if (visuals.some(visual => visual.kind === "chart" && visual.items.some(item => item.value === null))) issues.push("Для числової діаграми не надано всіх значень.");
  if (format === "docx" && !short && /реферат|доповід|есе|дослідження|огляд/iu.test(request)) {
    if (artifact.sections.length < 3 || artifact.sections.flatMap(section => section.paragraphs).join(" ").length < 1800) issues.push("Розгорнутій роботі бракує змісту, пояснень або висновків.");
  }
  if (format === "pptx") {
    if (!artifact.slides.length) issues.push("Презентація не містить слайдів.");
    if (artifact.slides.length >= 4 && !textOnly && !visuals.length && !tables.length) issues.push("Презентація поки лише текстова: немає змістовних схем або таблиць.");
    if (artifact.slides.slice(1, -1).some(slide => slide.notes.trim().length < 100)) issues.push("Змістовним слайдам бракує пояснень для виступу.");
  }
  if (!textOnly && /(?<![\p{L}])фото(?![\p{L}])|репродукці|географічн.{0,12}карт|карт[ау].{0,20}(?:Європ|Україн|світ|материк)/iu.test(normalizedRequest)) issues.push("Потрібне конкретне фото, карта або репродукція. Автоматичний експорт створює схеми, тому це зображення потрібно додати окремо.");
  if (!textOnly && /ілюстрац|малюн/iu.test(request) && !visuals.length) issues.push("Запитані візуальні матеріали відсутні. Робота потребує доповнення.");
  return { status: issues.length ? "draft" as const : "ready" as const, issues };
}
