import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeworkResultSchema, type HomeworkWork, type HomeworkFormat } from "@/lib/homework";
import { readHomework, createHomework, saveHomework } from "./store";
import type { homeworkSource } from "./source";
import { callLessonTutor, tutorFailureMessage } from "@/server/lessons/tutorModel";
import { resolveChatPages } from "@/server/lessons/chatPages";
import { moderateMessage } from "@/server/safety/moderate";
import { recordSafetyEvent } from "@/server/safety/events";
import { safetyPreambleUk } from "@/server/safety/preamble";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import type { homeworkUploads } from "./uploads";

export async function beginHomework(familyId: string, childId: string, id: string, source: Awaited<ReturnType<typeof homeworkSource>>, input: { requestId: string; question: string; format: HomeworkFormat; pages: number[]; files: string[]; revision: number; assignmentId?: string }) {
  let work = await readHomework(familyId, childId, id);
  if (work?.turns.some(turn => turn.requestId === input.requestId)) return { work, started: false };
  if (work && (work.state === "running" || work.revision !== input.revision || work.lessonKey !== source.lessonKey)) throw new Error("Робота вже готується або змінилась. Онови її перед наступним запитом.");
  if (work?.assignmentId && input.assignmentId && work.assignmentId !== input.assignmentId) throw new Error("Ця робота прив’язана до іншого шкільного завдання. Почни нову роботу.");
  if (work && work.turns.length >= 30) throw new Error("Цей діалог уже довгий. Почни нову роботу — попередню збережено.");
  const at = new Date().toISOString();
  const turn = { requestId: input.requestId, question: input.question, format: input.format, pages: input.pages, files: input.files, answer: null, at };
  if (!work) {
    work = { version: 1, revision: 0, ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}), childId, lessonKey: source.lessonKey, target: source.target, title: input.question.slice(0, 100), lessonTitle: source.lessonTitle, backHref: source.backHref, context: source.context, subject: source.subject, topic: source.topic, createdAt: at, updatedAt: at, state: "running", activeRequestId: input.requestId, turns: [turn], result: null, format: input.format, error: null };
    await createHomework(familyId, id, work);
  } else work = await saveHomework(familyId, id, work, { ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}), state: "running", activeRequestId: input.requestId, turns: [...work.turns, turn], format: input.format, error: null, context: source.context, target: source.target });
  return { work, started: true };
}
export async function runHomework(familyId: string, childId: string, id: string, requestId: string, source: Awaited<ReturnType<typeof homeworkSource>>, uploads: Awaited<ReturnType<typeof homeworkUploads>>) {
  let work = await readHomework(familyId, childId, id);
  if (!work || work.state !== "running" || work.activeRequestId !== requestId) return;
  const previous = work;
  const current = work.turns.at(-1)!;
  try {
    const moderation = await moderateMessage({ familyId, mode: "tutor_chat", message: `${current.question}\n${uploads.text}`, context: work.turns.slice(-4, -1).map(turn => turn.question) });
    await recordSafetyEvent(familyId, childId, "tutor_chat", current.question, moderation).catch(() => {});
    let result;
    if (moderation.severity === "urgent") result = { message: URGENT_REPLY_UK, artifact: null };
    else {
      const pages = await resolveChatPages(familyId, source.resolved.lessonRef, { printedPages: current.pages });
      const system = `${safetyPreambleUk("Репетитор", "репетитор")}\n\n${readFileSync(join(process.cwd(), "prompts/homework_workspace.md"), "utf8")}`;
      const prompt = JSON.stringify({ subject: work.subject, topic: work.topic, sourceContext: work.context, selectedPages: pages.context, temporaryFiles: uploads.text, history: work.turns.slice(0, -1).map(turn => ({ request: turn.question, answer: turn.answer, files: turn.files })), previousArtifact: work.result?.artifact ?? null, previousAnswer: work.result?.message ?? null, request: current.question, format: current.format });
      if (Buffer.byteLength(prompt) > 240000) throw new Error("Діалог і матеріали завеликі. Почни нову роботу з потрібним уривком.");
      const response = await callLessonTutor({ system, prompt, schema: homeworkResultSchema, documents: [...pages.documents, ...uploads.documents] }, { familyId, ref: { table: "jobs", id } });
      result = homeworkResultSchema.parse(response.result);
      if (result.artifact && ((current.format === "docx" && !result.artifact.sections.length) || (current.format === "pptx" && !result.artifact.slides.length))) throw new Error("Матеріал не відповідає вибраному формату. Спробуй уточнити запит.");
      if (Buffer.byteLength(JSON.stringify(result)) > 180000) throw new Error("Результат завеликий. Попроси коротшу роботу.");
    }
    // Re-read the CAS checkpoint: never overwrite a newer operation.
    work = await readHomework(familyId, childId, id);
    if (!work || work.activeRequestId !== requestId || work.revision !== previous.revision) return;
    const turns = work.turns.map(turn => turn.requestId === requestId ? { ...turn, answer: result.message } : turn);
    await saveHomework(familyId, id, work, { state: "ready", activeRequestId: null, turns, result: result.artifact ? result : { ...result, artifact: moderation.severity === "urgent" ? null : work.result?.artifact ?? null }, error: null });
  } catch (error) {
    const latest = await readHomework(familyId, childId, id);
    if (latest?.activeRequestId === requestId && latest.revision === previous.revision) await saveHomework(familyId, id, latest, { state: "failed", activeRequestId: null, error: `${tutorFailureMessage(error).replace(/Запит залишився у полі — спробуй (?:пізніше|ще раз)\./g, "Твій запит збережено в діалозі.")} Попередню готову роботу збережено. Автоматичного повтору немає.` });
  }
}
export async function recoverHomework(familyId: string, id: string, work: HomeworkWork) {
  if (work.state !== "running" || Date.now() - Date.parse(work.updatedAt) < 5 * 60 * 1000) return work;
  return saveHomework(familyId, id, work, { state: "failed", activeRequestId: null, error: "Не вдалося підтвердити завершення запиту. Попередній результат збережено. Автоматичного повтору немає; перевір роботу перед новим запитом." });
}
