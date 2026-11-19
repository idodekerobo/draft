import { expect, it } from "bun:test";
import { mergeTranscriptEvents, mergeTranscriptPage } from "./transcript-pages";
import type { LiveSessionEvent, SessionTranscriptPage } from "./types";
const event = (seq: number): LiveSessionEvent => ({seq,source_id:String(seq),kind:"assistant_text",payload:{text:String(seq)},created_at:""});
const page = (seqs: number[], extras: Partial<SessionTranscriptPage> = {}): SessionTranscriptPage => ({agentId:null,events:seqs.map(event),dependencies:[],before:seqs[0]??null,after:seqs.at(-1)??null,hasOlder:true,hasNewer:false,through:1000,readThrough:1000,...extras});
it("merges old and new pages in order and deduplicates repeated events", () => {
 expect(mergeTranscriptEvents([event(100)], [event(50),event(100),event(150)]).map(e=>e.seq)).toEqual([50,100,150]);
});
it("older pages cannot regress live cursors or current forward availability", () => {
 const current=page([100,200],{hasNewer:true,readThrough:200});
 const merged=mergeTranscriptPage(current,page([50],{hasOlder:false,through:500,readThrough:500}),"older");
 expect(merged.events.map(e=>e.seq)).toEqual([50,100,200]);expect(merged.before).toBe(50);expect(merged.after).toBe(200);
 expect(merged.readThrough).toBe(200);expect(merged.through).toBe(1000);expect(merged.hasNewer).toBe(true);expect(merged.hasOlder).toBe(false);
});
it("an empty filtered forward page advances read-through without moving history boundaries", () => {
 const merged=mergeTranscriptPage(page([100,200]),page([],{through:2000,readThrough:2000,hasOlder:true}));
 expect(merged.readThrough).toBe(2000);expect(merged.before).toBe(100);expect(merged.after).toBe(200);
});
it("counterpart hydration does not change primary page boundaries", () => {
 const merged=mergeTranscriptPage(page([100],{dependencies:[event(1)]}),page([200],{dependencies:[event(300)]}));
 expect(merged.events.map(e=>e.seq)).toEqual([100,200]);expect(merged.dependencies.map(e=>e.seq)).toEqual([1,300]);expect(merged.after).toBe(200);
});
