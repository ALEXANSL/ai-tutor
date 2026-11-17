// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopCurrentlyPlaying } from "./singleAudioPlayback";
import { NarrationButton } from "./NarrationButton";
const audios: MockAudio[]=[];
class MockAudio extends EventTarget { pause=vi.fn();play=vi.fn().mockResolvedValue(undefined);constructor(public src:string){super();audios.push(this);} }
let root:Root|null,host:HTMLDivElement;
const text="Повне навчальне пояснення з прикладами. ".repeat(210)+"Останній висновок.",audio={status:"ok",audioMime:"audio/mpeg",audioBase64:"AAAA"};
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("Audio",MockAudio);stopCurrentlyPlaying();audios.length=0;host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root?.unmount());stopCurrentlyPlaying();host.remove();vi.unstubAllGlobals();});
it("reads every part in order and advances the lesson only after the final audio ends",async()=>{
 const synthesize=vi.fn(),part=vi.fn(async(text:string,index:number)=>{ void text; void index; return audio; }),ended=vi.fn();act(()=>root!.render(<NarrationButton identity="long" text={text} synthesize={synthesize} synthesizePart={part} onEnded={ended}/>));
 await act(async()=>host.querySelector('button')!.click());expect(audios).toHaveLength(1);expect(ended).not.toHaveBeenCalled();
 for(let index=0;index<audios.length;index++)await act(async()=>{audios[index]!.dispatchEvent(new Event("ended"));});
 expect(part.mock.calls.map(call=>call[0]).join("")).toBe(text);expect(synthesize).not.toHaveBeenCalled();expect(ended).toHaveBeenCalledOnce();
});
it("does not play a pending continuation after leaving the lesson",async()=>{
 let resolve!:(value:typeof audio)=>void;const pending=new Promise<typeof audio>(done=>{resolve=done;});const part=vi.fn().mockResolvedValueOnce(audio).mockReturnValueOnce(pending),ended=vi.fn();
 act(()=>root!.render(<NarrationButton identity="long" text={text} synthesize={async()=>audio} synthesizePart={part} onEnded={ended}/>));await act(async()=>host.querySelector('button')!.click());await act(async()=>audios[0]!.dispatchEvent(new Event("ended")));expect(part).toHaveBeenCalledTimes(2);
 act(()=>{root!.unmount();root=null;});await act(async()=>resolve(audio));expect(audios).toHaveLength(1);expect(ended).not.toHaveBeenCalled();
});
it("does not request another paid part after playback is explicitly stopped",async()=>{
 const part=vi.fn(async(text:string,index:number)=>{ void text; void index; return audio; });act(()=>root!.render(<NarrationButton identity="long" text={text} synthesize={async()=>audio} synthesizePart={part}/>));await act(async()=>host.querySelector('button')!.click());act(()=>stopCurrentlyPlaying());await act(async()=>audios[0]!.dispatchEvent(new Event("ended")));expect(part).toHaveBeenCalledOnce();
});
