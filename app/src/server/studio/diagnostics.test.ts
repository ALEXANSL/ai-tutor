import{expect,it}from"vitest";
import{z}from"zod";
import{studioFailureDiagnostic,studioFailureMessage}from"./diagnostics";
import{studioParentView}from"@/lib/studio-parent-view";
import{studioProjectFixture}from"./__fixtures__/project";
it("reports stage and schema paths while withholding raw values, provider errors and private receipts",()=>{
 const invalid=z.object({summary:z.string()}).safeParse({summary:123});if(invalid.success)throw Error("invalid fixture");const diagnostic=studioFailureDiagnostic(invalid.error,"analyze");expect(diagnostic).toMatchObject({phase:"analyze",code:"STUDIO-SCHEMA",paths:["summary"],category:"content"});expect(studioFailureMessage(diagnostic,true)).toContain("без нового виклику ШІ");
 const unknown=studioFailureMessage(studioFailureDiagnostic(new Error("api_key=PRIVATE_TOKEN content=private book"),"analyze"),true);expect(unknown).not.toMatch(/PRIVATE_TOKEN|private book|api_key/);
 const pending={id:"private-receipt",phase:"analyze" as const,cursor:0,inputHash:"private-hash",reservedUsd:0.1,billed:true};const parent=studioParentView(studioProjectFixture({state:"failed",pendingModelCall:pending,unresolvedModelCalls:[pending],regeneration:{pending,diagnostic},failureDiagnostic:diagnostic}));expect(parent.savedModelResult).toBe(true);expect(parent.canRegenerate).toBe(true);expect(JSON.stringify(parent)).not.toMatch(/private-receipt|private-hash/);
});
