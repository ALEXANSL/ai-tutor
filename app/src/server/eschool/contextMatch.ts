import "server-only";
import { z } from "zod";
import type { SchoolEntry } from "@/lib/eschool";
import type { SubjectTopicOption } from "@/server/subjects/queries";
import { schoolTopicFocus } from "@/lib/eschool-topic-focus";
import { loadVideoLessonSource } from "@/server/video-script/source";
import { searchMaterials } from "@/server/search/search";
import { callContextModel, contextModelConfig } from "./contextModel";
import { claimContextMatch, contextMatchId, finishContextMatch, readContextMatch, type ContextResult } from "./contextStore";
const shortlistSchema = z.object({ topicIds: z.array(z.string()).max(4) }).strict();
const matchSchema = z.object({ topicId: z.string(), confidence: z.number().min(0).max(1), reason: z.string().max(400), evidence: z.string().max(240) }).strict();
const answerSchema = z.object({ topicId: z.string().nullable(), confidence: z.number().min(0).max(1), reason: z.string().max(600), evidence: z.string().max(240), additionalMatches: z.array(matchSchema).max(3) }).strict();
export async function resolveSchoolContext(familyId: string, childId: string, subjectId: string, entry: SchoolEntry, topics: readonly SubjectTopicOption[]): Promise<ContextResult> {
  const known = schoolTopicFocus(entry, topics);
  if (known) return { state: "done", topicId: known, reason: "Знайдено за темою або твором.", confidence: 1 };
  if (entry.topicId || !topics.length) return { state: "done", topicId: null, reason: "Прив’язаний урок недоступний або предмет ще не має готових уроків.", confidence: 0 };
  const id = contextMatchId(familyId, childId, subjectId, entry, topics);
  const cached = await readContextMatch(familyId, childId, id);
  if (cached) return cached;
  if (!await claimContextMatch(familyId, id, childId)) return await readContextMatch(familyId, childId, id) ?? { state: "pending", topicId: null, reason: "", confidence: 0 };
  let result: ContextResult;
  try {
    if (topics.length > 300) throw new Error("SCHOOL-CONTEXT-CATALOG-LIMIT");
    const config = await contextModelConfig(familyId);
    // Both retrieval and model calls occur only inside the durable claim.
    const book = await searchMaterials(familyId, `${entry.source.topic}\n${entry.source.text.slice(0, 3000)}`, { subjectId, limit: 12 }).catch(() => ({ hits: [], mode: "text_only" as const }));
    const passages = book.hits.filter(hit => hit.subjectId === subjectId).map(hit => ({ topicId: hit.topicId, section: hit.sectionTitle, topic: hit.topicTitle, page: hit.page, text: hit.snippet.slice(0, 1400) }));
    const teacher = { subject: entry.source.subject, topic: entry.source.topic, task: entry.source.text };
    const shortlist = await callContextModel(familyId, id, { stage: "shortlist", teacher, catalog: topics.map(topic => ({ id: topic.id, title: topic.title, pages: [topic.pageFrom, topic.pageTo] })), textbookPassages: passages }, shortlistSchema, config);
    const selected = [...new Set(shortlist.topicIds)];
    if (selected.some(key => !topics.some(topic => topic.id === key))) throw new Error("SCHOOL-CONTEXT-FOREIGN-ID");
    const candidates = await Promise.all(selected.map(async topicId => {
      const topic = topics.find(item => item.id === topicId)!;
      const lesson = await loadVideoLessonSource(familyId, subjectId, topicId).catch(() => null);
      // Evenly sampled blocks retain late practice/reading instead of just the introduction.
      const blocks = lesson?.blocks ?? [];
      const sampled = blocks.length <= 8 ? blocks : Array.from({ length: 8 }, (_, i) => blocks[Math.round(i * (blocks.length - 1) / 7)]!);
      return { id: topicId, title: topic.title, lessonText: sampled.map(block => `${block.title}\n${block.text.slice(0, 1000)}`).join("\n\n").slice(0, 8000), textbook: passages.filter(hit => hit.topicId === topicId || (hit.page != null && topic.pageFrom != null && topic.pageTo != null && hit.page >= topic.pageFrom && hit.page <= topic.pageTo)) };
    }));
    if (!candidates.length) result = { state: "done", topicId: null, confidence: 0, reason: "ШІ не знайшов готового уроку, який достатньо відповідає цій темі." };
    else {
      const answer = await callContextModel(familyId, id, { stage: "verify_content", teacher, candidates }, answerSchema, config);
      const answers = [{ topicId: answer.topicId, confidence: answer.confidence, reason: answer.reason, evidence: answer.evidence }, ...(answer.additionalMatches ?? [])];
      const matches: { topicId: string; reason: string; confidence: number }[] = [];
      for (const item of answers) {
        if (!item.topicId) continue;
        const candidate = candidates.find(candidate => candidate.id === item.topicId);
        if (!candidate) throw new Error("SCHOOL-CONTEXT-FOREIGN-ID");
        const quote = item.evidence.trim();
        if (quote.length >= 20 && candidate.lessonText.includes(quote) && item.confidence >= 0.75 && !matches.some(match => match.topicId === item.topicId)) matches.push({ topicId: item.topicId, reason: item.reason, confidence: item.confidence });
      }
      result = { state: "done", topicId: matches.length === 1 && matches[0]!.confidence >= 0.88 ? matches[0]!.topicId : null, matches: matches.map(({ topicId, reason }) => ({ topicId, reason })), confidence: matches.length ? Math.max(...matches.map(item => item.confidence)) : 0, reason: matches.length > 1 ? "Тему зі щоденника розкривають кілька готових уроків." : matches[0]?.reason || (answer.topicId ? "Не вдалося достатньо впевнено підтвердити збіг реальним змістом уроку." : answer.reason) };

    }
  } catch {
    // Cache failures as well: refreshing must never repeat an uncertain paid call.
    result = { state: "failed", topicId: null, confidence: 0, reason: "ШІ-пошук зараз не завершився. Можна обрати урок зі списку або зберегти прив’язку в батьківському щоденнику." };
  }
  await finishContextMatch(familyId, id, childId, result);
  return result;
}
