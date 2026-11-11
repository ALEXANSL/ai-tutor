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
