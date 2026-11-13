import { expect, it } from "vitest";
import { schoolSubjectCandidates } from "./eschool-subject-match";
const subjects = [{ id: "history", name: "Історія" }, { id: "english", name: "Англійська мова" }, { id: "german", name: "Німецька мова" }, { id: "nature", name: "Пізнаємо природу" }, { id: "ukrlit", name: "Українська література" }, { id: "foreign", name: "Зарубіжна література" }];
it("recognizes diary subject aliases, including mixed history and first/second foreign languages", () => {
  expect(schoolSubjectCandidates("Історія України. Всесвітня історія", subjects).map(x => x.id)).toEqual(["history"]);
  expect(schoolSubjectCandidates("Друга іноземна мова (англ.)", subjects).map(x => x.id)).toEqual(["english"]);
  expect(schoolSubjectCandidates("Перша іноземна мова (нім.)", subjects).map(x => x.id)).toEqual(["german"]);
  expect(schoolSubjectCandidates("Інтегрований курс «Пізнаємо природу»", subjects).map(x => x.id)).toEqual(["nature"]);
  expect(schoolSubjectCandidates("Українська література", subjects).map(x => x.id)).toEqual(["ukrlit"]);
});
it("offers both history curricula when a diary combines them, but never confuses foreign or separate history courses", () => {
  const separate = [{ id: "ua", name: "Історія України" }, { id: "world", name: "Всесвітня історія" }];
  expect(schoolSubjectCandidates("Історія України. Всесвітня історія", separate)).toHaveLength(2);
  expect(schoolSubjectCandidates("Всесвітня історія", separate).map(x => x.id)).toEqual(["world"]);
  expect(schoolSubjectCandidates("Всесвітня історія", separate.slice(0,1))).toEqual([]);
  expect(schoolSubjectCandidates("Іноземна мова", subjects)).toEqual([]);
});
