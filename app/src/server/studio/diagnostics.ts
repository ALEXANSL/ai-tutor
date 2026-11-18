import "server-only";
import { ProviderError } from "@/server/ai/types";
import { z } from "zod";
import type { StudioFailureDiagnostic, StudioProject } from "@/lib/studio";
const processingCodes = new Set(["STUDIO-SOURCE-INTEGRITY", "STUDIO-SOURCE-STORE", "STUDIO-SOURCE-PART-SIZE", "STUDIO-SOURCE-NOTE-REF"]);
export class StudioCapturedOutputError extends Error {
 constructor(readonly failure: { code: string; paths: string[] }) { super(failure.code); }
}
const descriptions: Record<string,string> = {
 "STUDIO-AI-TIMEOUT":"Сервіс ШІ не повернув відповідь у відведений час. Результат і фактична оплата цього виклику не підтверджені.",
 "STUDIO-AI-NETWORK":"З’єднання із сервісом ШІ перервалося. Не підтверджено, чи завершився виклик.",
 "STUDIO-AI-AUTH":"Сервіс ШІ відхилив авторизацію. Перевір API-ключ і доступ до моделі.",
 "STUDIO-AI-RATE":"Сервіс ШІ відхилив запит через обмеження частоти або квоти.",
 "STUDIO-AI-REQUEST-SCHEMA":"Сервіс ШІ відхилив схему запиту. Потрібне виправлення інтеграції; нова генерація цього не усуне.",
 "STUDIO-AI-HTTP":"Сервіс ШІ повернув HTTP-помилку до отримання підтвердженого результату.",
 "STUDIO-AI-RESPONSE":"Не вдалося прочитати відповідь сервісу ШІ або підтвердити її витрати.",
 "STUDIO-AI-UNCERTAIN":"Збереженої відповіді поки немає. Локальна перевірка не запустила новий платний запит; попередній резерв збережено.",
 "STUDIO-AI-INCOMPLETE":"Сервіс ШІ повернув обірвану відповідь. Отриманий текст збережено, його не використано як готовий матеріал.",
 "STUDIO-AI-REFUSAL":"Сервіс ШІ відмовився підготувати відповідь. Відмову не підмінено навчальним матеріалом.",
 "STUDIO-AI-JSON":"Отримана відповідь не є коректним JSON.",
 "STUDIO-AI-OUTPUT-SCHEMA":"Отримана відповідь не відповідає структурі цього етапу.",
 "STUDIO-AI-RESPONSE-STATE":"Сервіс повернув витрати, але не підтвердив завершення відповіді.",
 "STUDIO-AI-NO-OUTPUT":"Сервіс повернув відомі витрати, але не надав тексту результату.",
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
 if(error instanceof ProviderError){
  const code=error.code==="timeout"?"STUDIO-AI-TIMEOUT":error.code==="network"?"STUDIO-AI-NETWORK":error.code==="invalid_schema"?"STUDIO-AI-REQUEST-SCHEMA":[401,403].includes(error.status??0)?"STUDIO-AI-AUTH":error.status===429?"STUDIO-AI-RATE":error.status!==null&&error.status>=400?"STUDIO-AI-HTTP":"STUDIO-AI-RESPONSE";
  return{phase,code,paths:[],category:"processing",at:new Date().toISOString(),...(error.provider==="openai"?{provider:"openai"}:{}),...(error.status!==null?{status:error.status}:{})};
 }
 if(error instanceof StudioCapturedOutputError && descriptions[error.failure.code])return{phase,code:error.failure.code,paths:error.failure.paths,category:"content",at:new Date().toISOString()};
 if(error instanceof z.ZodError)return{phase,code:"STUDIO-SCHEMA",paths:error.issues.slice(0,8).map(issue=>issue.path.map(value=>typeof value==="number"?String(value):String(value).replace(/[^a-zA-Z0-9_]/g,"").slice(0,40)).join(".")||"result"),category:"content",at:new Date().toISOString()};
 const match=error instanceof Error?/^(STUDIO-[A-Z-]+)(?::|$)/.exec(error.message):null;
 const code=match&&descriptions[match[1]!] ? match[1]! : "STUDIO-PROCESSING";
 return{phase,code,paths:[],category:code==="STUDIO-PROCESSING"||code==="STUDIO-AI-UNCERTAIN"||processingCodes.has(code)?"processing":"content",at:new Date().toISOString()};
}
export function studioFailureMessage(diagnostic:StudioFailureDiagnostic, saved:boolean){
 const description=diagnostic.code==="STUDIO-SCHEMA"?"Формат відповіді не відповідає структурі етапу.":descriptions[diagnostic.code]??"Не вдалося застосувати або зберегти відповідь на цьому етапі.";
 return `${diagnostic.code} · етап ${diagnostic.phase}: ${description}${diagnostic.paths.length?` Поля: ${diagnostic.paths.join(", ")}.`:""} ${saved?"Оплачену відповідь збережено. Повторна перевірка використає її без нового виклику ШІ.":"Готові частини збережено."}`;
}
