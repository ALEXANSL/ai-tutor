vi.mock("./paid-result", () => {
  const receipts = new Map<string, unknown>();
  return { writeStudioPaidResult: async (_family: string, _project: string, pending: { id: string }, result: unknown) => { receipts.set(pending.id, structuredClone(result)); }, readStudioPaidResult: async (_family: string, _project: string, pending: { id: string }) => receipts.get(pending.id) ?? null };
});
import{beforeEach,expect,it,vi}from"vitest";
import type{StudioProject,StudioSource}from"@/lib/studio";
import{studioLessonFixture,studioProjectFixture}from"./__fixtures__/project";
const f=vi.hoisted(()=>({project:null as StudioProject|null,parts:[] as StudioSource[][],notes:new Map<string,unknown>(),available:vi.fn(),prepared:vi.fn(),load:vi.fn(),model:vi.fn(),cache:vi.fn(),seen:[] as string[]}));
vi.mock("./base-sources",()=>({studioBaseCandidates:f.available,studioPreparedBaseSources:f.prepared}));
vi.mock("./sources",async original=>({...await original<typeof import("./sources")>(),loadStudioSources:f.load}));
vi.mock("./source-catalog",()=>({saveStudioSourceCatalog:f.cache,readStudioSourceCatalog:async()=>null,studioSourceAnalysisContract:()=>"test-contract"}));
vi.mock("./source-corpus",async original=>({...await original<typeof import("./source-corpus")>(),readStudioSourcePart:async(_f:string,_c:unknown,index:number)=>f.parts[index],readStudioSourceNotes:async(_f:string,_c:string,refs:string[])=>refs.map(ref=>f.notes.get(ref)),writeStudioSourceNote:async(_f:string,_c:string,note:unknown)=>{const ref=`note-${f.notes.size}`;f.notes.set(ref,structuredClone(note));return ref;}}));
vi.mock("./store",()=>({STUDIO_STEP:"studio.step",readStudioProject:async()=>structuredClone(f.project),createStudioProject:async(_f:string,project:StudioProject,id:string)=>{f.project=structuredClone(project);return id;},saveStudioProject:async(_f:string,_id:string,previous:StudioProject,changes:Partial<StudioProject>)=>{if(previous.revision!==f.project!.revision)throw Error("stale");f.project={...f.project!,...structuredClone(changes),revision:previous.revision+1};return structuredClone(f.project);}}));
vi.mock("./model",()=>({studioModelConfig:async()=>({route:{params:{max_tokens:8000}},rates:{}}),studioReservation:()=>0.1,callStudioModel:f.model}));
vi.mock("./review-history",()=>({saveStudioReviewEvent:vi.fn()}));vi.mock("./publish",()=>({prepareStudioPublication:vi.fn(),activateStudioPublication:vi.fn()}));vi.mock("@/server/jobs/runner",()=>({registerJobHandler:vi.fn(),enqueueJob:vi.fn()}));
import{pauseStudio,resumeStudio,runStudioStep,startStudio}from"./workflow";
import{packStudioSources}from"./source-corpus";
const id="11111111-1111-4111-8111-111111111111",topic="22222222-2222-4222-8222-222222222222";
const source=(index:number):StudioSource=>({id:`page-${index}`,title:`Сторінка ${index}`,page:index,kind:"book",text:`Навчальний матеріал сторінки ${index}. `.repeat(45)});
const step=()=>runStudioStep({id:"step",family_id:"family",type:"studio.step",payload:{projectId:id,token:f.project!.token},attempts:1,max_attempts:1},Date.now()+220000);
async function until(state:string){for(let i=0;i<200&&f.project?.state!==state;i++){await step();if(f.project?.state==="failed")throw Error(f.project.error??"failed");}expect(f.project!.state).toBe(state);}
beforeEach(()=>{vi.clearAllMocks();f.project=null;f.notes.clear();f.seen=[];f.available.mockResolvedValue({topics:[],subjectName:null,fallbackMaterialId:null});f.prepared.mockResolvedValue({sources:[{...source(1),id:"base-1",kind:"lesson"}],warnings:[]});f.model.mockImplementation(async(_family,_id,role,_system,prompt)=>{
 const input=JSON.parse(prompt);let result:unknown;
 if(role==="studio.resolve")result={topicIds:[topic],reason:"Збігається зміст теми"};
 else if(role==="studio.assess")result={sufficient:true,reason:"Матеріалу достатньо, автор додасть пояснення",missing:[]};
 else if(role==="studio.source"){f.seen.push(...input.sources.filter((s:StudioSource)=>s.kind==="book").map((s:StudioSource)=>s.id));result={title:`Огляд ${input.sourceTask.fromPart}`,summary:input.sources.map((s:StudioSource)=>`${s.title}: навчальні поняття й приклади.`).join("\n"),topics:["Поняття, приклади й застосування"],limitations:[],quotes:[]};}
 else if(role==="studio.plan"){const sources=input.sources as StudioSource[];result={title:"Автоматичний курс",overview:"Програма з логічними темами й поясненнями",objectives:["Зрозуміти матеріал"],prerequisites:[],limitations:[],sourceExclusions:[],lessons:Array.from({length:input.planningBatch.count},(_,offset)=>{const index=input.planningBatch.startLesson-1+offset;const mapped=sources.filter((_,i)=>i%input.planningBatch.totalLessons===index);return{title:`Змістовна тема ${index+1}`,goal:"Пояснити поняття на прикладах",topics:["Навчальна тема"],sourceIds:(mapped.length?mapped:sources.slice(0,1)).map(s=>s.id)}})};}
 else if(role==="studio.author")result={...studioLessonFixture,title:input.currentLesson.title,sourceIds:input.sources.slice(0,2).map((s:StudioSource)=>s.id),blocks:studioLessonFixture.blocks.map(block=>({...block,narration:block.kind==="code"?block.narration:null}))};
 else if(role==="studio.design")result={visuals:[]};else result={verdict:"pass",summary:"Зміст і перевірки узгоджені",issues:[],corrections:[]};
 return{result,model:{provider:"openai",model:"test"},costUsd:0.005};
 });});
it("prepares forty automatically named lessons from existing subject material without reading the book",async()=>{
 f.available.mockResolvedValue({topics:[{id:topic,subjectId:"subject",title:"Відповідна базова тема",pageFrom:42,pageTo:84}],subjectName:"Предмет",fallbackMaterialId:"book"});
 const request={...studioProjectFixture().request,lessonCount:40,sourceText:"",subjectId:"subject",materialId:"book"};
 await startStudio("family",request,id);await until("generating");expect(f.load).not.toHaveBeenCalled();expect(f.prepared).toHaveBeenCalledTimes(1);expect(f.project!.plan!.lessons).toHaveLength(40);
 await until("ready");expect(f.project!.units).toHaveLength(40);expect(f.project!.units.every(unit=>unit.review?.verdict==="pass")).toBe(true);expect(f.model.mock.calls.some(call=>call[2]==="studio.source")).toBe(false);expect(f.load).not.toHaveBeenCalled();
});
it("checkpoints all 306 parsed pages and automatically builds ten lessons when no prepared source exists",async()=>{
 const originals=Array.from({length:306},(_,i)=>source(i+1));f.parts=packStudioSources(originals);
 f.load.mockResolvedValue({sources:[],sourceNotes:["Лише вже розпізнаний текст"],subjectName:null,baseHref:null,baseTitle:null,sourceCorpus:{id:"corpus",partCount:f.parts.length,chunkCount:306,characterCount:originals.reduce((n,s)=>n+s.text.length,0),blankChunks:0,pageFrom:1,pageTo:306,analyzed:0,notes:[],catalog:[],reduceCursor:0,reduced:[]}});
 await startStudio("family",{...studioProjectFixture().request,lessonCount:10,sourceText:"",materialId:"book",pageFrom:null,pageTo:null},id);
 await step();const completed=f.project!.sourceCorpus!.analyzed,cost=f.project!.spentUsd;
 await pauseStudio("family",id,f.project!.revision);await resumeStudio("family",id,f.project!.revision,"retry");expect(f.project!.sourceCorpus!.analyzed).toBe(completed);expect(f.project!.spentUsd).toBe(cost);expect(f.load).toHaveBeenCalledTimes(1);
 await until("generating");expect(new Set(f.seen).size).toBe(306);expect(f.cache).toHaveBeenCalledTimes(1);expect(f.project!.plan!.lessons).toHaveLength(10);
 await until("ready");expect(f.project!.units).toHaveLength(10);expect(f.project!.units.every(unit=>unit.sourceContext&&unit.review?.verdict==="pass")).toBe(true);expect(f.project!.request.budgetUsd).toBe(3);expect(f.project!.request.pageFrom).toBeNull();
});
it("reuses a completed neutral catalog without restarting paid book analysis",async()=>{
 f.notes.set("cached",{fromPart:0,toPart:0,source:{id:"book-parts-1-1",title:"Огляд матеріалу",text:"Готовий нейтральний огляд",kind:"summary",page:null}});
 f.load.mockResolvedValue({sources:[],sourceNotes:["Огляд уже підготовлено"],subjectName:null,baseHref:null,baseTitle:null,sourceCorpus:{id:"corpus",partCount:1,chunkCount:43,characterCount:70000,blankChunks:0,pageFrom:42,pageTo:84,analyzed:1,notes:["cached"],catalog:["cached"],reduceCursor:0,reduced:[]}});
 await startStudio("family",{...studioProjectFixture().request,sourceText:"",materialId:"book"},id);expect(f.project!.phase).toBe("plan");await until("generating");expect(f.model.mock.calls.map(call=>call[2])).toEqual(["studio.plan"]);
});
