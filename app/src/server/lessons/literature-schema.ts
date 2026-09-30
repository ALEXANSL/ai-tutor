import "server-only";
import { z } from "zod";

/**
 * Structured-output schema for the `literature_extraction` role
 * (S33, PO decision 2026-09-30, corrected same day — see
 * `literatureExtraction.ts`'s module doc). The model returns ONE topic
 * (paragraph-group) per array item, matching the PO's reference format
 * (`lessons/NN.md` + `tests/NN.json`): adapted explanation, short quoted
 * excerpts of a literary work (never its full text — copyright), verbatim
 * textbook question numbering and page references, one test module per
 * topic.
 */

const questionItemSchema = z.object({
  /** Exactly as printed in the textbook ("1", "2а", "12"). Never invented. */
  number: z.string().min(1).max(12),
  textUk: z.string().min(1).max(2000),
});

const questionGroupSchema = z.object({
  /** e.g. "Запитання і завдання", "Працюємо вдома". */
  labelUk: z.string().min(1).max(120),
  /** Textbook page this group of questions is printed on. */
  page: z.number().int().min(1).max(5000).nullable(),
  /** PDF page (may differ from the textbook page by a constant offset). */
  pdfPage: z.number().int().min(1).max(5000).nullable(),
  items: z.array(questionItemSchema).min(1).max(40),
});

const sublessonSchema = z.object({
  /** e.g. "5.1", "5.2" — the textbook's own sub-lesson numbering within the topic. */
  no: z.string().min(1).max(10),
  titleUk: z.string().min(1).max(250),
  questionGroups: z.array(questionGroupSchema).max(6),
});

export const literatureTopicSchema = z.object({
  /** 1-based topic number, matching the textbook's own "Тема N" numbering. */
  topicNo: z.number().int().min(1).max(500),
  sectionTitleUk: z.string().max(200).optional(),
  titleUk: z.string().min(1).max(300),
  textbookPageFrom: z.number().int().min(1).max(5000).nullable(),
  textbookPageTo: z.number().int().min(1).max(5000).nullable(),
  pdfPageFrom: z.number().int().min(1).max(5000).nullable(),
  pdfPageTo: z.number().int().min(1).max(5000).nullable(),
  goalUk: z.string().min(1).max(600),
  keyConceptsUk: z.array(z.string().min(1).max(400)).max(12),
  explanationMdUk: z.string().min(1).max(6000),
  /** Null when this topic has no single literary work (e.g. an intro/theory topic). */
  work: z
    .object({
      titleUk: z.string().min(1).max(300),
      /**
       * PO correction 2026-09-30: NEVER the complete text of the work
       * (copyright — reproducing a whole literary work is a real legal
       * risk, unlike a short quote). Short, citation-length excerpts only
       * (a few sentences/lines each, clearly attributed) — the child reads
       * the actual complete work from the family's own licensed PDF via
       * `textbookPageFrom/To`/`pdfPageFrom/To` above (a future page-opening
       * viewer, out of scope for this slice).
       */
      excerptsUk: z.string().min(1).max(4000),
      summaryUk: z.string().min(1).max(3000),
      charactersUk: z.string().max(1000).optional(),
      ideaUk: z.string().max(1000).optional(),
    })
    .nullable(),
  sublessons: z.array(sublessonSchema).min(1).max(10),
  teacherNoteUk: z.string().max(1500).optional(),
  /** Interactive test module for this topic (PO instruction 2026-09-30). */
  test: z.object({
    questions: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          type: z.enum(["single", "multiple", "truefalse", "match", "order", "open"]),
          questionUk: z.string().min(1).max(1000),
          /** `single`/`multiple`/`truefalse`: answer options shown to the child. */
          options: z.array(z.string().min(1).max(400)).max(10).optional(),
          /** `single`: index into `options`. `multiple`: indices. `truefalse`: 0=Правда/1=Неправда. `order`: correct sequence of indices/ids. */
          answer: z.union([z.number().int(), z.array(z.number().int()), z.array(z.string())]).optional(),
          /** `match`: left→right pairs. */
          pairs: z.array(z.object({ leftUk: z.string().min(1).max(300), rightUk: z.string().min(1).max(300) })).max(10).optional(),
          /** `open`: no fixed answer — a model/teacher rubric instead. */
          expectedAnswerUk: z.string().max(600).optional(),
          explanationUk: z.string().min(1).max(600),
        }),
      )
      .min(3)
      .max(30),
  }),
});
export type LiteratureTopicOut = z.infer<typeof literatureTopicSchema>;

export const literatureExtractionSchema = z.object({
  topics: z.array(literatureTopicSchema).min(1).max(20),
});
export type LiteratureExtractionOut = z.infer<typeof literatureExtractionSchema>;
