import "server-only";
import { z } from "zod";
import { studioPlanBatchSchema, type StudioSource } from "@/lib/studio";
import { studioSourceNoteSchema, type StudioSourceTask } from "./source-orchestration";
export function studioPlanStageSchema(count:number,sources:StudioSource[],requiresSources:boolean){
 if(!Number.isSafeInteger(count)||count<1||count>6)throw new Error("STUDIO-PLAN-COUNT");
 const ids=[...new Set(sources.map(source=>source.id))];
 if(requiresSources&&!ids.length)throw new Error("STUDIO-SOURCE-STATE");
 const id=ids.length?z.enum(ids as [string,...string[]]):z.string().min(1).max(100);
 const lesson=studioPlanBatchSchema.shape.lessons.element.extend({sourceIds:z.array(id).min(requiresSources?1:0).max(200).optional()});
 // With a corpus, references must be explicit in every lesson, not merely schema-optional.
 const mapped=requiresSources?lesson.extend({sourceIds:z.array(id).min(1).max(200)}):lesson;
 return studioPlanBatchSchema.extend({lessons:z.array(mapped).length(count),sourceExclusions:z.array(z.object({sourceId:id,reason:z.string().trim().min(1).max(500)}).strict()).max(200).optional()});
}
export function studioSourceStageSchema(task:StudioSourceTask){
 const ids=[...new Set([...task.sources.filter(source=>source.kind!=="summary").map(source=>source.id),...(task.verifiedQuotes??[]).map(quote=>quote.sourceId)])];
 const quotes=ids.length?z.array(z.object({sourceId:z.enum(ids as [string,...string[]]),text:z.string().trim().min(1).max(1800)}).strict()).max(task.reducing?3:6):studioSourceNoteSchema.shape.quotes.max(0);
 return studioSourceNoteSchema.extend({quotes,...(task.reducing?{summary:z.string().trim().min(1).max(4000)}:{})});
}
