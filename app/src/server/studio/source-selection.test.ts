import {beforeEach,expect,it,vi} from "vitest";
import {studioProjectFixture} from "./__fixtures__/project";
const f=vi.hoisted(()=>({prepared:vi.fn(),fallback:vi.fn(),stage:vi.fn()}));
vi.mock("./base-sources",()=>({studioPreparedBaseSources:f.prepared}));vi.mock("./sources",()=>({loadStudioSources:f.fallback,stageStudioSources:f.stage}));
import{applyStudioResolution,applyStudioAssessment}from"./source-selection";
const topic="11111111-1111-4111-8111-111111111111";
const source={id:"base-1",title:"Готовий матеріал",text:"Готовий навчальний текст",page:42,kind:"lesson" as const};
const project=()=>studioProjectFixture({phase:"resolve",sourceSelection:{candidates:[{id:topic,subjectId:"subject",title:"Тема",pageFrom:42,pageTo:84,href:"/literature-v3/base"}],fallbackMaterialId:"book",selectedIds:[],assessed:false}});
beforeEach(()=>{vi.clearAllMocks();f.prepared.mockResolvedValue({sources:[source],warnings:[]});f.stage.mockResolvedValue({sources:[source],sourceNotes:[],baseHref:null,baseTitle:null,subjectName:"Предмет"});f.fallback.mockResolvedValue({sources:[],sourceNotes:[],baseHref:null,baseTitle:null,subjectName:"Предмет"});});
it("uses actual prepared subject content and checks it before any book fallback",async()=>{
 const changes=await applyStudioResolution("family",project(),{topicIds:[topic],reason:"Тема відповідає за змістом"});expect(changes.phase).toBe("assess");expect(f.prepared).toHaveBeenCalledWith("family",project().sourceSelection!.candidates,[topic]);expect(f.fallback).not.toHaveBeenCalled();
 const assessed=await applyStudioAssessment("family",{...project(),...changes},[source],{sufficient:true,reason:"Основа є, нові приклади додасть ШІ",missing:[]});expect(assessed.phase).toBe("plan");expect(f.fallback).not.toHaveBeenCalled();
});
it("falls back to already parsed book only after substantive missing content is identified, preserving prepared context",async()=>{
 await applyStudioAssessment("family",project(),[source],{sufficient:false,reason:"Відсутній текст твору",missing:["Авторський уривок"]});expect(f.fallback).toHaveBeenCalledWith("family",expect.objectContaining({materialId:"book"}),[source]);
});
it("fences unknown topic IDs and always includes an explicitly selected revision topic",async()=>{
 await expect(applyStudioResolution("family",project(),{topicIds:["22222222-2222-4222-8222-222222222222"],reason:"Вибір"})).rejects.toThrow("BASE-TOPIC");expect(f.prepared).not.toHaveBeenCalled();
 const p=project();p.request={...p.request,mode:"revision",topicId:topic,subjectId:"subject"};await applyStudioResolution("family",p,{topicIds:[],reason:"Модель пропустила явний вибір"});expect(f.prepared).toHaveBeenLastCalledWith("family",p.sourceSelection!.candidates,[topic]);
});
