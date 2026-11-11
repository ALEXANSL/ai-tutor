import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ detail: vi.fn(), legacy: vi.fn(), videos: vi.fn(), focus: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "family", via: "account" }), requireChild: async () => ({ ctx: { familyId: "family" }, profile: { id: "child" } }) }));
vi.mock("@/server/eschool/subjectFocus", () => ({ schoolSubjectFocus: mock.focus }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: mock.detail, getSubjectForecastPlan: mock.legacy }));
vi.mock("@/server/subjects/contentAdmin", () => ({ listSubjectPackages: async () => [], listSubjectPdfMaterials: async () => [] }));
vi.mock("@/server/lessons/videoLessons", () => ({ listVideoLessonsForSubject: mock.videos }));
vi.mock("@/server/lessons/warmup", () => ({ getTopicWarmupStatuses: mock.legacy }));
vi.mock("@/server/lessons/literatureV2Search", () => ({ getLiteratureV2TextbookForSubject: async () => null }));
vi.mock("@/server/lessons/mathCourseV2Search", () => ({ getMathCourseV2TextbookForSubject: async () => null }));
vi.mock("@/components/parent/subjects/RenameSubjectForm", () => ({ RenameSubjectForm: () => <span>Назва</span> }));
vi.mock("@/components/parent/subjects/TextbookLinkPanel", () => ({ TextbookLinkPanel: () => null }));
vi.mock("@/components/parent/subjects/VideoLessonsPanel", () => ({ VideoLessonsPanel: () => <span>Відеоматеріали</span> }));
vi.mock("@/components/child/SubjectVideoLessons", () => ({ SubjectVideoLessons: () => <span>Додатковий відеокаталог</span> }));
vi.mock("@/components/child/LastLessonHighlight", () => ({ LastLessonHighlight: ({ children, focusRequest }: { children: React.ReactNode; focusRequest?: string }) => <div data-focus={focusRequest}>{children}</div> }));
vi.mock("@/components/child/VideoLessonButton", () => ({ VideoLessonButton: () => <button>Відео</button> }));
vi.mock("@/components/course-v2/LiteratureV2Search", () => ({ LiteratureV2Search: () => null }));
vi.mock("@/components/course-v2/LiteratureV3Search", () => ({ LiteratureV3Search: () => null }));
vi.mock("@/components/course-v2/MathCourseV2Search", () => ({ MathCourseV2Search: () => null }));
import ParentPage from "./[id]/page";
import ChildPage from "@/app/(child)/subject/[id]/page";
const id = "11111111-1111-4111-8111-111111111111";
const topic = { id: "topic", title: "§16. Цивілізації", pageFrom: 20, pageTo: 21, literatureLessonId: null, courseLessonId: null, mathCourseV2LessonId: null, literatureV2LessonId: null, literatureV3LessonId: "chapter", hasVideoLesson: false };
beforeEach(() => { vi.clearAllMocks(); mock.detail.mockResolvedValue({ id, name: "Історія", childVisible: true, hasTextbook: false, currentTopicId: "topic", topics: [topic] }); mock.videos.mockResolvedValue([]); mock.focus.mockResolvedValue(null); });
it("parent sees the actual chapter catalog without requiring an indexed textbook or loading legacy plans", async () => {
  const html = renderToStaticMarkup(await ParentPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain("Цивілізації"); expect(html).toContain("Додати готовий курс ZIP");
  expect(html).not.toContain("Масова підготовка"); expect(html).not.toContain("Очистити старий контент"); expect(html).not.toContain("Немає підручника"); expect(mock.legacy).not.toHaveBeenCalled();
});
it("child enters the same existing reader without warming a new lesson", async () => {
  const html = renderToStaticMarkup(await ChildPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('href="/literature-v3/chapter"'); expect(html.indexOf("Цивілізації")).toBeLessThan(html.indexOf("Додатковий відеокаталог")); expect(mock.legacy).not.toHaveBeenCalled();
});
it("indexed-only leftovers do not offer the retired generation pipeline", async () => {
  mock.detail.mockResolvedValue({ id, name: "Історія", childVisible: true, hasTextbook: true, topics: [{ ...topic, title: "Стара індексована тема", literatureV3LessonId: null }] });
  const html = renderToStaticMarkup(await ChildPage({ params: Promise.resolve({ id }) }));
  expect(html).not.toContain("Стара індексована тема"); expect(html).not.toContain("Підготувати"); expect(html).toContain("Готових уроків поки немає"); expect(mock.legacy).not.toHaveBeenCalled();
});

it("carries an owned diary focus into the visible topic list and reports uncertain matches", async () => {
  const entryId = "22222222-2222-4222-8222-222222222222";
  mock.focus.mockResolvedValue({ entryId, title: "Цивілізації", topicId: "topic" });
  const page = () => ChildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ school: entryId }) });
  const html = renderToStaticMarkup(await page());
  expect(mock.focus).toHaveBeenCalledWith("family", "child", id, entryId, [topic]);
  expect(html).toContain(`data-focus="${entryId}"`); expect(html).toContain("Потрібну тему виділено");
  mock.focus.mockResolvedValue({ entryId, title: "Невідома тема", topicId: null });
  const unmatched = renderToStaticMarkup(await page());
  expect(unmatched).toContain("Однозначного збігу"); expect(unmatched).not.toContain("data-focus=");
});
