import { expect, it } from "vitest";
import type { SchoolEntry } from "./eschool";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
import { schoolPageRanges, schoolTopicFocus, schoolTopicMatches } from "./eschool-topic-focus";
const packet = schoolPacketFixture();
const entry: SchoolEntry = { version: 1, revision: 0, childId: "child", identity: packet.identity, source: { ...packet.entries[1]!, topic: "Цивілізації Стародавнього Сходу", text: "Опрацювати матеріал" }, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: "subject", topicId: null, lessonHref: null, workHref: null };
const topics = [{ id: "a", title: "§16. Цивілізації Стародавнього Сходу" }, { id: "b", title: "§17. Вірування народів Сходу" }];
it("uses an explicit binding before inferred names, but never an absent/hidden topic", () => {
  expect(schoolTopicFocus({ ...entry, topicId: "b" }, topics)).toBe("b");
  expect(schoolTopicFocus({ ...entry, topicId: "hidden" }, topics)).toBeNull();
});
it("matches a unique normalized title despite paragraph prefixes or punctuation", () => {
  expect(schoolTopicFocus(entry, topics)).toBe("a");
  expect(schoolTopicFocus({ ...entry, source: { ...entry.source, topic: "Параграф 16. Цивілізації Стародавнього Сходу!" } }, topics)).toBe("a");
});
it("uses only explicit unique paragraph references, not exercise numbers or generic similarity", () => {
  const task = (text: string) => ({ ...entry, source: { ...entry.source, topic: "Робота з підручником", text } });
  expect(schoolTopicFocus(task("Опрацювати § 17"), topics)).toBe("b");
  expect(schoolTopicFocus(task("Виконати вправу 17"), topics)).toBeNull();
  expect(schoolTopicFocus(task("Опрацювати §16–17"), topics)).toBeNull();
  expect(schoolTopicFocus(task("§16 та §17"), topics)).toBeNull();
  expect(schoolTopicFocus(task("§17"), [...topics, { id: "c", title: "§17. Інший підручник" }])).toBeNull();
  expect(schoolTopicFocus(entry, [...topics, { id: "c", title: topics[0]!.title }])).toBeNull();
});

const literatureSource = "Михайло Ткач. «Моя Україна». Коротко про письменника, його пісенну лірику. Символічне втілення образу Батьківщини у пісні «Моя Україна». Мотив патріотизму";
const literatureTopics = [
  { id: "tkach", title: "Михайло Ткач. «Моя Україна»: країна в близьких образах" },
  { id: "other-work", title: "Михайло Ткач. «Ясени»: пісенна лірика" },
  { id: "other-author", title: "Дмитро Павличко. «Моя Україна»: образ Батьківщини" },
];
function withTopic(topic: string, text = "") { return { ...entry, source: { ...entry.source, topic, text } }; }
it("recognizes the reported teacher topic by named work and author despite different explanatory subtitles", () => {
  expect(schoolTopicFocus(withTopic(literatureSource), literatureTopics)).toBe("tkach");
  expect(schoolTopicFocus(withTopic(literatureSource.replaceAll("«", '"').replaceAll("»", '"')), literatureTopics)).toBe("tkach");
  expect(schoolTopicFocus(withTopic(literatureSource.replaceAll("«", "„").replaceAll("»", "“")), literatureTopics)).toBe("tkach");
  expect(schoolTopicFocus(withTopic(literatureSource), [{ id: "no-quotes", title: "Михайло Ткач. Моя Україна: лірика" }])).toBe("no-quotes");
});
it("never substitutes another author's work, chooses arbitrarily among parts, or ignores multiple named works", () => {
  expect(schoolTopicFocus(withTopic(literatureSource), literatureTopics.slice(1))).toBeNull();
  expect(schoolTopicFocus(withTopic(literatureSource), [literatureTopics[0]!, { id: "part2", title: literatureTopics[0]!.title + ". Частина 2" }])).toBeNull();
  expect(schoolTopicFocus(withTopic('«Моя Україна». Образи Батьківщини'), literatureTopics)).toBeNull();
  expect(schoolTopicFocus(withTopic('Михайло Ткач. «Моя Україна» та «Ясени»'), literatureTopics)).toBeNull();
  expect(schoolTopicFocus(withTopic(literatureSource, 'Опрацювати §17'), literatureTopics)).toBeNull();
});
it("uses meaningful topic words without requiring literal full-title equality", () => {
  const ready = [{ id: "online", title: "Безпека в соціальних мережах" }, { id: "password", title: "Надійні паролі та облікові записи" }];
  expect(schoolTopicFocus(withTopic("Правила безпеки в соціальних мережах. Практична робота"), ready)).toBe("online");
  expect(schoolTopicFocus(withTopic("Повторення. Практична робота. Відповіді на запитання"), ready)).toBeNull();
  expect(schoolTopicFocus(withTopic("Правила безпеки в соціальних мережах"), [...ready, { id: "online2", title: "Соціальні мережі: правила безпеки" }])).toBeNull();
});
it("does not let homework's other reading replace the teacher's named topic and retains explicit mapping", () => {
  expect(schoolTopicFocus(withTopic(literatureSource, 'Також прочитати «Ясени»'), literatureTopics)).toBe("tkach");
  expect(schoolTopicFocus({ ...withTopic(literatureSource), topicId: "other-work" }, literatureTopics)).toBe("other-work");
});

it("recognizes the Dickens example with an initial, author inside quotes and у/в variation", () => {
  const teacher = 'Ч. Діккенс "Різдвяна пісня у прозі": сюжет і композиція';
  expect(schoolTopicFocus(withTopic(teacher), [{ id: "dickens", title: "«Чарльз Діккенс. Різдвяна пісня в прозі»" }, { id: "gogol", title: "Вакула, Оксана і різдвяна ніч" }])).toBe("dickens");
  expect(schoolTopicFocus(withTopic(teacher), [{ id: "a", title: "«Різдвяна пісня в прозі». Частина 1" }, { id: "b", title: "«Різдвяна пісня в прозі». Частина 2" }])).toBeNull();
});

it("returns every ready lesson on the same work when the teacher's wording differs (Вертеп bug)", () => {
  const vertep = [
    { id: "family", title: "Ігор Калинець. «Вертеп Маленького Хлопчика»: родина на відстані", pageFrom: 86, pageTo: 99 },
    { id: "miracle", title: "«Вертеп Маленького Хлопчика»: різдвяне диво й реальність", pageFrom: 93, pageTo: 99 },
    { id: "other", title: "Михайло Ткач. «Моя Україна»: країна в близьких образах", pageFrom: 60, pageTo: 64 },
  ];
  const teacher = withTopic("Чарівні перетворення головного героя в основі сюжету казки «Вертеп маленького хлопчика».");
  expect(schoolTopicMatches(teacher, vertep)).toEqual(["family", "miracle"]);
  expect(schoolTopicFocus(teacher, vertep)).toBeNull();
  // Pages narrow a multi-lesson work to the lessons that cover them.
  expect(schoolTopicMatches({ ...teacher, source: { ...teacher.source, text: "Прочитати с. 86–92" } }, vertep)).toEqual(["family"]);
});
it("matches by textbook pages when the teacher's topic wording shares nothing with lesson titles", () => {
  const paged = [{ id: "p1", title: "Різдвяні образи", pageFrom: 86, pageTo: 92 }, { id: "p2", title: "Диво і реальність", pageFrom: 93, pageTo: 99 }, { id: "p3", title: "Інше", pageFrom: 120, pageTo: 125 }];
  expect(schoolTopicMatches(withTopic("Підсумкова бесіда", "Опрацювати стор. 93-99"), paged)).toEqual(["p2"]);
  expect(schoolTopicMatches(withTopic("Підсумкова бесіда", "Читати сторінки 88–95"), paged)).toEqual(["p1", "p2"]);
  expect(schoolTopicMatches(withTopic("Підсумкова бесіда", "Вправа 5"), paged)).toEqual([]);
  expect(schoolPageRanges("с. 12, стор.40–42, ст. 7")).toEqual([[12, 12], [40, 42], [7, 7]]);
});
it("lists every paragraph lesson of an explicit § range, but still refuses ambiguous numbers", () => {
  expect(schoolTopicMatches(withTopic("Робота з підручником", "Опрацювати §16–17"), topics)).toEqual(["a", "b"]);
  expect(schoolTopicMatches(withTopic("Робота з підручником", "§17"), [...topics, { id: "c", title: "§17. Інший підручник" }])).toEqual([]);
  expect(schoolTopicMatches(withTopic("«Моя Україна». Образи Батьківщини"), literatureTopics)).toEqual([]);
});
