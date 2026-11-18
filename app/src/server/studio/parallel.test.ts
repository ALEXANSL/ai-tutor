vi.mock("./paid-result", () => {
  const receipts = new Map<string, unknown>();
  return { writeStudioPaidResult: async (_family: string, _project: string, pending: { id: string }, result: unknown) => { receipts.set(pending.id, structuredClone(result)); }, readStudioPaidResult: async (_family: string, _project: string, pending: { id: string }) => receipts.get(pending.id) ?? null };
});
import { beforeEach, expect, it, vi } from "vitest";
import { studioLessonFixture, studioVisualFixture, studioPlanFixture, studioProjectFixture } from "./__fixtures__/project";
import type { StudioProject } from "@/lib/studio";
const f = vi.hoisted(() => ({ projects: {} as Record<string, StudioProject>, rows: [] as Record<string, unknown>[], calls: vi.fn() }));
vi.mock("./store", () => ({ STUDIO_STEP: "studio.step", readStudioProject: async (_family: string, id: string) => structuredClone(f.projects[id]), saveStudioProject: async (_family: string, id: string, previous: StudioProject, changes: Partial<StudioProject>) => { if (previous.revision !== f.projects[id]!.revision) throw new Error("stale"); f.projects[id] = { ...f.projects[id]!, ...changes, revision: previous.revision + 1 }; return structuredClone(f.projects[id]); } }));
vi.mock("./review-history", () => ({saveStudioReviewEvent:vi.fn()}));
vi.mock("./sources", () => ({})); vi.mock("./publish", () => ({}));
vi.mock("./model", () => ({ studioModelConfig: async () => ({ route: { params: { max_tokens: 1000 } }, rates: {} }), studioReservation: () => 0.1, callStudioModel: f.calls }));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(values?: Record<string, unknown>, filters: ((row: Record<string, unknown>) => boolean)[] = []) {
    const run = () => { const rows = f.rows.filter(row => row.family_id === family && filters.every(filter => filter(row))); if (values) rows.forEach(row => Object.assign(row, values)); return { data: rows[0] ? structuredClone(rows[0]) : null, error: null }; };
    const value = (row: Record<string, unknown>, field: string) => field.startsWith("payload->>") ? (row.payload as Record<string, unknown>)[field.split("->>")[1]!] : row[field];
    const chain = { eq: (field: string, expected: unknown) => query(values, [...filters, row => value(row, field) === expected]), lte: (field: string, expected: string) => query(values, [...filters, row => String(value(row, field)) <= expected]), limit: () => chain, select: () => chain, maybeSingle: async () => run(), then: (resolve: (result: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve) }; return chain;
  }
  return { select: () => query(), update: (_table: string, values: Record<string, unknown>) => query(values) };
} }));
import { runStudioQueue } from "./workflow";
const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.clearAllMocks(); f.projects = { [id]: studioProjectFixture(), [secondId]: studioProjectFixture({ token: "44444444-4444-4444-8444-444444444444" }) }; f.rows = [id, secondId].map((projectId, index) => ({ id: `step${index}`, family_id: "family", type: "studio.step", status: "queued", payload: { projectId, token: f.projects[projectId]!.token }, attempts: 0, max_attempts: 1, run_after: new Date(0).toISOString() })); });
it("runs two separate projects with overlapping provider requests without canceling or mixing their states", async () => {
  const finish: Record<string, (value: unknown) => void> = {};
  f.calls.mockImplementation(async (_family, projectId: string) => new Promise(resolve => { finish[projectId] = resolve; }));
  f.projects[id]!.request.title = "Завдання А"; f.projects[secondId]!.request.title = "Завдання Б";
  const first = runStudioQueue("family", id, f.projects[id]!.token), second = runStudioQueue("family", secondId, f.projects[secondId]!.token);
  await vi.waitFor(() => expect(Object.keys(finish)).toHaveLength(2));
  finish[secondId]!({ result: { ...studioPlanFixture, title: "Проєкт Б" }, model: { provider: "openai", model: "test" }, costUsd: 0.02 }); await second;
  expect(f.projects[secondId]!.state).toBe("plan_ready"); expect(f.projects[id]!.activeCall).toBe(true);
  finish[id]!({ result: { ...studioPlanFixture, title: "Проєкт А" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 }); await first;
  expect(f.calls.mock.calls.map(call => JSON.parse(call[4]).request.title).sort()).toEqual(["Завдання А", "Завдання Б"]);
  expect(f.projects[id]!.plan!.title).toBe("Проєкт А"); expect(f.projects[secondId]!.plan!.title).toBe("Проєкт Б"); expect(f.projects[id]!.spentUsd).toBe(0.01); expect(f.projects[secondId]!.spentUsd).toBe(0.02); expect(f.rows.every(row => row.status === "done")).toBe(true);
});

it("keeps ten concurrently submitted autonomous projects isolated through final review",async()=>{
  const ids=Array.from({length:10},(_,i)=>"11111111-1111-4111-8111-"+String(i).padStart(12,"0"));
  f.projects=Object.fromEntries(ids.map(id=>[id,studioProjectFixture({autonomous:true})]));
  f.rows=ids.map(id=>({id:"step"+id,family_id:"family",type:"studio.step",status:"queued",payload:{projectId:id,token:f.projects[id]!.token},attempts:0,max_attempts:1,run_after:new Date(0).toISOString()}));
  f.calls.mockImplementation(async (_family,id,role) => ({result:role === "studio.plan" ? {...studioPlanFixture,title:id} : role === "studio.author" ? studioLessonFixture : role === "studio.design" ? {visuals:[studioVisualFixture]} : {verdict:"pass",summary:"Зміст перевірено.",issues:[],corrections:[]},model:{provider:"openai",model:"test"},costUsd:0.02}));
  await Promise.all(ids.map(id=>runStudioQueue("family",id,f.projects[id]!.token)));
  for(const id of ids) expect(f.projects[id]).toMatchObject({state:"ready",plan:{title:id},spentUsd:0.08});
});
