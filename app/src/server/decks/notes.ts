import { posix } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { decodeEntities } from "@/server/ingest/extract-epub";

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}=["']([^"']+)["']`))?.[1] ?? "";

/** Slide order comes from the presentation relationships, not slide filenames. */
export function speakerNotes(bytes: Uint8Array): string[] {
  let total = 0;
  const parts = unzipSync(bytes, { filter: part => {
    if (!/^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/.test(part.name)) return false;
    total += part.originalSize;
    if (total > 32 * 1024 * 1024) throw new Error("Нотатки PPTX перевищують доступний обсяг.");
    return true;
  } });
  const xml = (path: string) => parts[path] ? strFromU8(parts[path]!) : "";
  function relations(path: string) {
    const rels = posix.join(posix.dirname(path), "_rels", posix.basename(path) + ".rels");
    return [...xml(rels).matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => {
      const target = attr(tag, "Target");
      return { id: attr(tag, "Id"), type: attr(tag, "Type"), path: attr(tag, "TargetMode") === "External" ? "" : target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(path), target) };
    });
  }
  const main = "ppt/presentation.xml", slides = relations(main);
  const notes = [...xml(main).matchAll(/<p:sldId\b[^>]*>/g)].map(([tag]) => {
    const slide = slides.find(r => r.id === attr(tag, "r:id"));
    if (!slide?.path) throw new Error("Не вдалося визначити порядок слайдів PPTX.");
    const note = relations(slide.path).find(r => r.type.endsWith("/notesSlide"));
    if (!note?.path) return "";
    return [...xml(note.path).matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter(([shape]) => /<p:ph\b[^>]*type=["']body["']/.test(shape))
      .flatMap(([shape]) => [...shape.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map(([p]) => [...p.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeEntities(m[1]!)).join(""))).join("\n").trim().slice(0, 8000);
  });
  if (!notes.length) throw new Error("У PPTX не знайдено слайдів.");
  return notes;
}
