import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ select: vi.fn(), single: vi.fn(), filters: [] as [string, unknown][], family: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => { f.family(familyId);return { select: (...args: unknown[]) => { f.select(...args); const chain = { eq: (key: string,value: unknown) => {f.filters.push([key,value]);return chain;},gte: (key: string,value: unknown) => {f.filters.push([`gte:${key}`,value]);return chain;},lte: (key: string,value: unknown) => {f.filters.push([`lte:${key}`,value]);return chain;},order: () => chain,limit: () => chain,maybeSingle: f.single };return chain; } }; } }));
import { studioProjectFixture } from "./__fixtures__/project";
import { legacyStudioProviderFailure, studioDiagnosticFromHistory } from "./provider-history";
const at="2026-11-18T15:00:00.000Z";
const project=()=>studioProjectFixture({state:"failed",phase:"lesson_sources",spentUsd:1.149,heldUsd:1.496,failureDiagnostic:{phase:"lesson_sources",code:"STUDIO-PROCESSING",category:"processing",paths:[],at}});
beforeEach(()=>{vi.clearAllMocks();f.filters=[];f.single.mockResolvedValue({data:{provider:"openai",error:"openai network error: TimeoutError",created_at:at},error:null});});
it("recovers a safe legacy timeout cause from the same family/project/phase/time window without changing money",async()=>{
 const before=project();const result=await studioDiagnosticFromHistory("family","project",before);expect(result.failureDiagnostic).toMatchObject({code:"STUDIO-AI-TIMEOUT",phase:"lesson_sources",evidence:"provider_audit"});expect(result.spentUsd).toBe(1.149);expect(result.heldUsd).toBe(1.496);expect(before.failureDiagnostic?.code).toBe("STUDIO-PROCESSING");expect(f.family).toHaveBeenCalledWith("family");expect(f.filters).toContainEqual(["ref_id","project"]);expect(f.filters).toContainEqual(["role","studio.source"]);expect(f.filters).toContainEqual(["gte:created_at","2026-11-18T14:59:30.000Z"]);expect(f.filters).toContainEqual(["lte:created_at","2026-11-18T15:00:01.000Z"]);
});
it("never returns raw provider messages and refuses stale, missing, unrecognized, or unavailable audit entries",async()=>{
 for(const data of [null,{provider:"openai",error:"api_key=SECRET",created_at:at},{provider:"openai",error:"openai network error: TimeoutError",created_at:"2026-11-18T13:00:00.000Z"},{provider:"anthropic",error:"openai network error: TimeoutError",created_at:at}]){f.single.mockResolvedValueOnce({data,error:null});const input=project();expect(await studioDiagnosticFromHistory("family","project",input)).toBe(input);}
 f.single.mockRejectedValueOnce(new Error("private database error"));const input=project();expect(await studioDiagnosticFromHistory("family","project",input)).toBe(input);
});
it("does not replace specific diagnostics or query active projects",async()=>{
 const p=project();p.state="generating";expect(await studioDiagnosticFromHistory("family","project",p)).toBe(p);p.state="failed";p.failureDiagnostic!.code="STUDIO-AI-TIMEOUT";expect(await studioDiagnosticFromHistory("family","project",p)).toBe(p);expect(f.select).not.toHaveBeenCalled();
});
it("recognizes only known legacy provider error categories",()=>{
 expect(legacyStudioProviderFailure("openai responses error 401")).toMatchObject({status:401});expect(legacyStudioProviderFailure("openai response incomplete (max_output_tokens?)")).toMatchObject({failure:{code:"STUDIO-AI-INCOMPLETE"}});expect(legacyStudioProviderFailure("openai structured output did not match the schema: PRIVATE_BOOK_TEXT")).toMatchObject({failure:{code:"STUDIO-AI-OUTPUT-SCHEMA",paths:[]}});expect(legacyStudioProviderFailure("something private")).toBeNull();
});
