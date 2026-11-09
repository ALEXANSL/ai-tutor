/** Text chat can contain several textbook pages. Voice transcripts stay separately bounded. */
export const MAX_LESSON_QUESTION_CHARS = 20_000;
export const MAX_LESSON_SOURCE_PAGES = 2;
export interface LessonChatAttachments { printedPages: number[]; }
/** Recent-first input; current question is sent separately and is never clipped. */
export function lessonChatHistory(messages: { author: string; content: string }[], currentQuestion: string): string {
  let remaining = 24_000;
  let skippedCurrent = false;
  const kept: string[] = [];
  for (const message of messages) {
    if (!skippedCurrent && message.author === "child" && message.content === currentQuestion) { skippedCurrent = true; continue; }
    const line = `${message.author}: ${message.content}`;
    if (line.length > remaining) {
      if (remaining > 100) kept.push(`${line.slice(0, remaining)}\n[давніший фрагмент історії скорочено]`);
      break;
    }
    kept.push(line); remaining -= line.length;
  }
  return kept.reverse().join("\n") || "(немає)";
}
