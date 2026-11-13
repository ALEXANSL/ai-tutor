import "server-only";
import { randomUUID } from "node:crypto";
import { audioRequestSchema, audioRunning, type AudioPart, type AudioRequest } from "@/lib/audiobooks";
import { AiNotConfiguredError, BudgetBlockedError } from "@/server/ai/types";
import { libraryBook, physicalRange, loadAudioSource, selectedAudioParagraph } from "./library";
import { insertAudioPart, readAudioPart, saveAudioPart } from "./store";
import { audioHash, audioSegmentKey, preparedManuscript, splitAudioText } from "./text";
import { audioLessonScriptSchema } from "./models";
import { audioModelConfig, audioReservation, prepareAudioText, narrateAudio } from "./models";
import { audioExists, saveAudioBytes, deleteAudioBytes } from "./storage";
export async function startAudioPart(familyId: string, id: string, raw: AudioRequest) {
  const request = audioRequestSchema.parse(raw); const old = await readAudioPart(familyId, id);
  if (old) { if (JSON.stringify(old.request) !== JSON.stringify(request)) throw new Error("Цей запит уже має інші параметри. Створи нову частину."); return id; }
  const book = request.lesson ? await (await import("./lesson-source")).audioLessonBook(familyId, request) : await libraryBook(familyId, request.materialId); if (!book) throw new Error("Книгу не знайдено.");
  if (!request.lesson) selectedAudioParagraph(request, book);
  const range = request.lesson ? { from: 1, to: 1 } : physicalRange(request, book);
  await insertAudioPart(familyId, id, { version: 1, revision: 0, request, bookTitle: book.title, author: book.author, format: book.format, sourceFrom: range.from, sourceTo: range.to, createdAt: new Date().toISOString(), state: "preparing", phase: "prepare", published: false, token: randomUUID(), leaseUntil: 0, activeCall: false, paragraphs: [], omitted: [], notes: "", manuscript: "", sourceHash: "", segmentCount: 0, readyCount: 0, segments: [], spentUsd: 0, heldUsd: 0, error: null, receipts: [] }); return id;
}
function audioFailure(error: unknown) {
  if (error instanceof BudgetBlockedError) return "Загальний бюджет ШІ призупинив роботу. Перевір «Бюджет і моделі».";
  if (error instanceof AiNotConfiguredError) return "Перевір OpenAI та налаштування моделей аудіокниг у «Бюджет і моделі».";
  return error instanceof Error && /^[А-ЯІЇЄҐ]/u.test(error.message) && error.message.length < 400 ? error.message : "Не вдалося завершити етап. Готові частини збережено. Невизначений оплачений запит автоматично не повторюється.";
}
/** CAS lease prevents concurrent poll/self-continuations from issuing duplicate paid calls. */
export async function runAudioPart(familyId: string, id: string, token: string) {
  const initial = await readAudioPart(familyId, id);
  if (!initial || !audioRunning(initial) || initial.token !== token || initial.leaseUntil > Date.now()) return;
  if (initial.activeCall) { await saveAudioPart(familyId, id, initial, { state: "failed", leaseUntil: 0, error: "Попередній виклик перервано. Перевір готові фрагменти й резерв перед явним повтором." }); return; }
  let project: AudioPart;
  try { project = await saveAudioPart(familyId, id, initial, { leaseUntil: Date.now() + 270000 }); } catch { return; }
  const began = Date.now();
  try {
    while (audioRunning(project) && Date.now() - began < 95000) {
      if (project.phase === "prepare" && !project.paragraphs.length) {
        const source = await loadAudioSource(familyId, project.request);
        if (source.range.from !== project.sourceFrom || source.range.to !== project.sourceTo) throw new Error("Нумерація книги змінилась. Створи нову підготовку.");
        project = await saveAudioPart(familyId, id, project, { notes: source.notes ?? "", paragraphs: source.paragraphs, sourceHash: audioHash(JSON.stringify(source.paragraphs)) });
      }
      const index = project.segments.findIndex(s => !s.ready);
      if (project.phase === "audio" && index < 0) { project = await saveAudioPart(familyId, id, project, { state: "ready", leaseUntil: 0 }); break; }
      const role = project.phase === "prepare" ? project.request.lesson ? "audiobook.lesson_script" : "audiobook.prepare" : "audiobook.narrate";
      const config = await audioModelConfig(familyId, role);
      const text = project.phase === "prepare" ? JSON.stringify(project.paragraphs) : project.segments[index]!.text;
      if (project.phase === "audio") {
        // Configuration is frozen into each key, otherwise a changed voice/model could mix a book.
        if (project.segments[index]!.key !== audioSegmentKey(text, config.route.primary_model, project.request.voice)) throw new Error("Модель озвучення змінилась. Поверни попередню модель або створи нову підготовку.");
        if (await audioExists(familyId, id, project.segments[index]!.key)) {
          project = await saveAudioPart(familyId, id, project, { segments: project.segments.map((s, i) => i === index ? { ...s, ready: true } : s) }); continue;
        }
      }
      const reserve = audioReservation(config, text, project.phase === "audio", !!project.request.lesson);
      if (project.spentUsd + project.heldUsd + reserve > project.request.budgetUsd) throw new Error("Ліміт цієї частини книги недостатній. Збільш його або збережи підготовлений текст без озвучення.");
      project = await saveAudioPart(familyId, id, project, { heldUsd: project.heldUsd + reserve, activeCall: true });
      let response;
      try { response = project.phase === "prepare" ? await prepareAudioText(familyId, id, text, config, !!project.request.lesson) : await narrateAudio(familyId, id, text, project.request.voice, config); }
      catch (error) {
        if (error instanceof AiNotConfiguredError || error instanceof BudgetBlockedError) project = await saveAudioPart(familyId, id, project, { heldUsd: Math.max(0, project.heldUsd - reserve), activeCall: false });
        throw error;
      }
      // A pause/deletion changes revision+token; no stale worker may publish over it.
      const current = await readAudioPart(familyId, id); if (!current || current.token !== token || current.revision !== project.revision) {
        // A paused in-flight call still has a real bill. Settle its reservation
        // without continuing generation or replacing the paused state.
        if (current?.state === "paused" && current.leaseUntil > 0) await saveAudioPart(familyId, id, current, { spentUsd: current.spentUsd + response.costUsd, heldUsd: Math.max(0, current.heldUsd - reserve), leaseUntil: 0, activeCall: false, receipts: [...current.receipts, { role, model: `${response.model.provider}/${response.model.model}`, costUsd: response.costUsd }] });
        return;
      }
      project = await saveAudioPart(familyId, id, project, { spentUsd: project.spentUsd + response.costUsd, heldUsd: Math.max(0, project.heldUsd - reserve), activeCall: false, receipts: [...project.receipts, { role, model: `${response.model.provider}/${response.model.model}`, costUsd: response.costUsd }] });
      if (project.phase === "prepare") {
        const prepared = project.request.lesson ? (() => { const script = audioLessonScriptSchema.parse(response.result); return { text: script.manuscript, omitted: [], notes: script.notes }; })() : preparedManuscript(project.paragraphs, response.result, project.request.preserveLines);
        project = await saveAudioPart(familyId, id, project, { state: "draft", manuscript: prepared.text, omitted: prepared.omitted, notes: [project.notes, prepared.notes].filter(Boolean).join("\n"), leaseUntil: 0 });
      } else {
        const audio = response.result as { audioBase64: string; mimeType: string };
        if (audio.mimeType !== "audio/mpeg") throw new Error("Сервіс повернув непідтримуваний формат аудіо.");
        await saveAudioBytes(familyId, id, project.segments[index]!.key, audio.audioBase64);
        project = await saveAudioPart(familyId, id, project, { segments: project.segments.map((s, i) => i === index ? { ...s, ready: true } : s) });
      }
    }
    if (audioRunning(project)) await saveAudioPart(familyId, id, project, { leaseUntil: 0 });
  } catch (error) {
    const current = await readAudioPart(familyId, id);
    if (current?.token === token && current.revision === project.revision) await saveAudioPart(familyId, id, current, { state: "failed", activeCall: false, leaseUntil: 0, error: audioFailure(error) });
  }
}
export async function commandAudioPart(familyId: string, id: string, revision: number, command: "approve" | "pause" | "resume" | "publish" | "hide" | "delete" | "keep_all", text?: string, budget?: number) {
  let p = await readAudioPart(familyId, id); if (!p || p.revision !== revision) throw new Error("Стан змінився. Онови сторінку.");
  if (budget !== undefined && (budget < p.spentUsd + p.heldUsd || budget > 25 || budget < 0.5)) throw new Error("Новий ліміт має покривати витрати й резерв (до $25).");
  const request = { ...p.request, budgetUsd: budget ?? p.request.budgetUsd };
  if (command === "pause" && audioRunning(p)) return saveAudioPart(familyId, id, p, { state: "paused", request, token: randomUUID(), activeCall: false });
  if (["resume", "delete"].includes(command) && p.leaseUntil > Date.now()) throw new Error("Попередній запит ще завершується. Зачекай перед продовженням або видаленням.");
  if (command === "resume" && ["paused", "failed"].includes(p.state)) return saveAudioPart(familyId, id, p, { state: p.phase === "prepare" ? "preparing" : "generating", request, token: randomUUID(), activeCall: false, leaseUntil: 0, error: null });
  if (command === "keep_all" && ["draft", "failed"].includes(p.state) && p.phase === "prepare" && p.paragraphs.length) return saveAudioPart(familyId, id, p, { state: "draft", manuscript: p.paragraphs.map(s => s.text).join("\n\n"), omitted: [], error: null });
  if (command === "approve" && p.state === "draft") {
    const manuscript = text?.trim() ?? p.manuscript;
    if (manuscript.length < 80 || manuscript.length > 60000) throw new Error("Сценарій має містити від 80 до 60 000 символів.");
    const config = await audioModelConfig(familyId, "audiobook.narrate");
    const estimate = audioReservation(config, manuscript, true);
    if (p.spentUsd + p.heldUsd + estimate > request.budgetUsd) throw new Error("Ліміт не покриває озвучення цього тексту. Збільш його або скороти уривок.");
    return saveAudioPart(familyId, id, p, { manuscript, request, phase: "audio", state: "generating", segments: splitAudioText(manuscript).map(text => ({ text, key: audioSegmentKey(text, config.route.primary_model, request.voice), ready: false })), token: randomUUID(), error: null, leaseUntil: 0 });
  }
  if ((command === "publish" || command === "hide") && p.state === "ready") return saveAudioPart(familyId, id, p, { published: command === "publish" });
  if (command === "delete" && !audioRunning(p) && p.state !== "deleted") {
    p = await saveAudioPart(familyId, id, p, { state: "deleting", published: false, token: randomUUID(), leaseUntil: 0 });
    await deleteAudioBytes(familyId, id, p.segments.map(s => s.key));
    return saveAudioPart(familyId, id, p, { state: "deleted", paragraphs: [], manuscript: "", omitted: [], segments: [], notes: "", sourceHash: "" });
  }
  throw new Error("Ця дія зараз недоступна.");
}
