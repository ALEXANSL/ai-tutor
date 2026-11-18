import{expect,it}from"vitest";
import{studioPlanFixture}from"./__fixtures__/project";
import{studioPlanStageSchema,studioSourceStageSchema}from"./stage-schema";
const source={id:"book-parts-1-1",title:"Опора",text:"Матеріал",page:null,kind:"summary" as const};
it("requires the requested count and only real source-group IDs in the provider plan schema",()=>{
 const schema=studioPlanStageSchema(1,[source],true),lesson={...studioPlanFixture.lessons[0]!,sourceIds:[source.id]};
 expect(schema.safeParse({...studioPlanFixture,lessons:[lesson]}).success).toBe(true);expect(schema.safeParse({...studioPlanFixture,lessons:[lesson,lesson]}).success).toBe(false);expect(schema.safeParse({...studioPlanFixture,lessons:[{...lesson,sourceIds:["made-up"]}]}).success).toBe(false);expect(schema.safeParse({...studioPlanFixture,lessons:[{...lesson,sourceIds:[]}]}).success).toBe(false);
});
it("allows only current raw IDs or inherited verified evidence IDs for newly generated quotes",()=>{
 const schema=studioSourceStageSchema({scope:"book",reducing:false,sources:[source],fromPart:0,toPart:0,count:1});const result={title:"Огляд",summary:"Конспект",topics:["Тема"],limitations:[],quotes:[]};expect(schema.safeParse(result).success).toBe(true);expect(schema.safeParse({...result,quotes:[{sourceId:source.id,text:"Переказ"}]}).success).toBe(false);
});
