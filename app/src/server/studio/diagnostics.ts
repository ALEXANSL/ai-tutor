import "server-only";
import { z } from "zod";
import type { StudioFailureDiagnostic, StudioProject } from "@/lib/studio";
const processingCodes = new Set(["STUDIO-SOURCE-INTEGRITY", "STUDIO-SOURCE-STORE", "STUDIO-SOURCE-PART-SIZE", "STUDIO-SOURCE-NOTE-REF"]);
const descriptions: Record<string,string> = {
 "STUDIO-SOURCE-INTEGRITY":"Збережений текст або його метадані не пройшли перевірку цілісності.", "STUDIO-SOURCE-STORE":"Не вдалося підтвердити збереження опорних матеріалів.", "STUDIO-SOURCE-PART-SIZE":"Пакет вихідного тексту перевищив місткість збереження.", "STUDIO-SOURCE-NOTE-REF":"Нотатка не узгоджена з діапазоном збереженого джерела.", "STUDIO-SOURCE-NOTE-SIZE":"Обсяг опорної нотатки перевищив місткість збереження.",
 "STUDIO-RESULT-CONTEXT":"Контекст етапу змінився; стару відповідь не застосовано до іншого матеріалу.",
 "STUDIO-PLAN-COUNT":"План містить іншу кількість уроків, ніж замовлено.", "STUDIO-PLAN-DUPLICATE":"У плані повторюються назви уроків.",
 "STUDIO-SOURCE-REF":"Результат посилається на джерело, якого не було в цьому запиті.", "STUDIO-SOURCE-PLAN":"План посилається на відсутні частини джерела.", "STUDIO-SOURCE-COVERAGE":"Не всі частини матеріалу призначено урокам або обґрунтовано виключено.",
 "STUDIO-INCOMPLETE-LESSON":"В уроці бракує повного пояснення, прикладу або практики.", "STUDIO-LESSON-SIZE":"Обсяг уроку перевищив місткість цього етапу.",
 "STUDIO-DUPLICATE-OPTIONS":"У квізі повторюються варіанти відповіді.", "STUDIO-TOUCH-QUIZ":"Квіз вимагає письмової відповіді замість вибору.", "STUDIO-TYPING-ASSESSMENT":"Обов’язкова практика вимагає введення тексту.",
 "STUDIO-NATIVE-NARRATION":"Мова авторського озвучення не відповідає мовному блоку.", "STUDIO-LANGUAGE-CONTENT":"Бракує українського пояснення або іншомовного слухового прикладу.", "STUDIO-LANGUAGE-MISMATCH":"Мова блоку не відповідає налаштуванням уроку.",
 "STUDIO-VISUAL-REF":"Схема посилається на відсутній блок або має некоректні розміри.", "STUDIO-CORRECTION-REF":"Рецензія посилається на відсутній блок або схему.", "STUDIO-CORRECTION-MISSING":"Рецензія не містить конкретного плану виправлень.", "STUDIO-REVIEW-CONFLICT":"Вердикт рецензента суперечить його зауваженням.",
 "STUDIO-BASE-TOPIC":"Обрано базову тему, якої немає у перевіреному переліку.", "STUDIO-SOURCE-NO-PROGRESS":"Зведення не зменшило обсяг матеріалу.", "STUDIO-SOURCE-STATE":"Неузгоджений стан підготовки джерел.",
};
export function studioFailureDiagnostic(error:unknown, phase:StudioProject["phase"]):StudioFailureDiagnostic{
 if(error instanceof z.ZodError)return{phase,code:"STUDIO-SCHEMA",paths:error.issues.slice(0,8).map(issue=>issue.path.map(value=>typeof value==="number"?String(value):String(value).replace(/[^a-zA-Z0-9_]/g,"").slice(0,40)).join(".")||"result"),category:"content",at:new Date().toISOString()};
 const match=error instanceof Error?/^(STUDIO-[A-Z-]+)(?::|$)/.exec(error.message):null;
 const code=match&&descriptions[match[1]!] ? match[1]! : "STUDIO-PROCESSING";
 return{phase,code,paths:[],category:code==="STUDIO-PROCESSING"||processingCodes.has(code)?"processing":"content",at:new Date().toISOString()};
}
export function studioFailureMessage(diagnostic:StudioFailureDiagnostic, saved:boolean){
 const description=diagnostic.code==="STUDIO-SCHEMA"?"Формат відповіді не відповідає структурі етапу.":descriptions[diagnostic.code]??"Не вдалося застосувати або зберегти відповідь на цьому етапі.";
 return `${diagnostic.code} · етап ${diagnostic.phase}: ${description}${diagnostic.paths.length?` Поля: ${diagnostic.paths.join(", ")}.`:""} ${saved?"Оплачену відповідь збережено. Повторна перевірка використає її без нового виклику ШІ.":"Готові частини збережено."}`;
}
