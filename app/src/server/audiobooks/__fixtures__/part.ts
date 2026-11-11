import type { AudioPart, AudioRequest, LibraryBook } from "@/lib/audiobooks";
export const materialId = "11111111-1111-4111-8111-111111111111";
export const audioId = "22222222-2222-4222-8222-222222222222";
export const familyId = "33333333-3333-4333-8333-333333333333";
export const requestFixture: AudioRequest = { materialId, title: "Розділ перший — острів", from: 23, to: 24, numbering: "source", budgetUsd: 3, voice: "nova", preserveLines: true, retainPrepared: true };
export const bookFixture: LibraryBook = { id: materialId, title: "Мандрівка на острів", author: "Тестовий автор", format: "pdf", pages: 180, settings: { author: "Тестовий автор", printedOffset: 4, printedConfirmed: true, chapters: [] }, chapters: [{ title: "Острів", from: 23, to: 24 }] };
export const narrative = "— Чи бачиш ти острів? — запитав мандрівник.\n— Бачу, — відповіла дівчинка.\n\nКорабель тихо наближався до берега. Сонячні промені торкалися хвиль, а на піску вже було видно сліди птахів. Друзі вирішили оглянути берег і повернутися до човна до вечора.";
export function partFixture(changes: Partial<AudioPart> = {}): AudioPart {
  return { version: 1, revision: 0, request: requestFixture, bookTitle: bookFixture.title, author: bookFixture.author, format: "pdf", sourceFrom: 23, sourceTo: 24, createdAt: "2026-11-11T12:00:00Z", state: "preparing", phase: "prepare", published: false, token: "44444444-4444-4444-8444-444444444444", leaseUntil: 0, activeCall: false, paragraphs: [{ id: 0, page: 23, text: narrative }], omitted: [], notes: "", manuscript: "", sourceHash: "source", segmentCount: 0, readyCount: 0, segments: [], spentUsd: 0, heldUsd: 0, error: null, receipts: [], ...changes };
}
