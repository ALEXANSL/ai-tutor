import { expect, it } from "vitest";
import type { SchoolEntry } from "./eschool";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
import { schoolTopicFocus } from "./eschool-topic-focus";
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
