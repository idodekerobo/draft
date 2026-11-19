import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { useSessionStream } from "./useSessionStream";
import type { LiveSessionEvent, LiveSessionsApi, SessionTranscriptPage, SessionViewResponse, SessionViewQuery } from "./types";
afterEach(cleanup);
const event=(seq:number):LiveSessionEvent=>({seq,source_id:String(seq),kind:"assistant_text",payload:{text:String(seq)},created_at:""});
const page=(seqs:number[], extras:Partial<SessionTranscriptPage>={}):SessionTranscriptPage=>({agentId:null,events:seqs.map(event),dependencies:[],before:seqs[0]??null,after:seqs.at(-1)??null,through:1000,readThrough:1000,hasOlder:true,hasNewer:false,...extras});
const snapshot=()=>({session:{id:"s",owner_user_id:"u",owner_name:"User",title:"Session",folder_name:null,host_name:null,status:"live" as const,started_at:"",ended_at:null,last_event_at:null,last_seq:1000},viewer:{id:"u",name:"User"},inputs:[],approvals:[],agents:[]});
function setup(read:(q:SessionViewQuery)=>Promise<SessionViewResponse>) {
 const calls:SessionViewQuery[]=[];
 const api={fetchView:async(_id:string,q:SessionViewQuery)=>{calls.push(q);return read(q);}} as LiveSessionsApi;
 let latest:ReturnType<typeof useSessionStream>;
 function Probe(){const state=useSessionStream(api,"s");latest=state;return <><span data-testid="seqs">{state.events.map(e=>e.seq).join(",")}</span><span data-testid="through">{state.readThrough}</span><button onClick={()=>void state.history!.loadOlder()}>older</button><button onClick={()=>void state.refresh()}>refresh</button><button onClick={()=>void state.history!.focus(5)}>focus</button><button onClick={()=>state.history!.latest()}>latest</button></>;}
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const tree=()=> <QueryClientProvider client={client}><Suspense fallback="loading"><Probe/></Suspense></QueryClientProvider>;
 const view=render(tree());return {calls,client,api,view,tree,state:()=>latest!};
}
it("opens with one recent root page, loads older history on demand, and keeps metadata current",async()=>{
 const t=setup(async q=>q.before!==undefined?{page:page([10,20],{hasOlder:false})}:{page:page([100,200]),snapshot:snapshot()});
 await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("100,200"));expect(t.calls).toEqual([{}]);
 fireEvent.click(screen.getByText("older"));await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("10,20,100,200"));
 expect(t.calls[1]).toMatchObject({before:100,through:1000,state:false});expect(t.state().history!.hasOlder).toBe(false);
});
it("advances across subagent-only activity even when root history is unchanged",async()=>{
 const t=setup(async q=>q.after!==undefined?{page:page([],{through:2000,readThrough:2000}),snapshot:snapshot()}:{page:page([100]),snapshot:snapshot()});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("refresh"));
 await waitFor(()=>expect(screen.getByTestId("through").textContent).toBe("2000"));
 expect(t.calls[1]).toMatchObject({after:1000});expect(screen.getByTestId("seqs").textContent).toBe("100");
});
it("keeps focused history separate from live catch-up and returns to cached latest",async()=>{
 const t=setup(async q=>q.around!==undefined?{page:page([5],{through:1000})}:{page:page(q.after!==undefined?[300]:[100,200],{through:q.after!==undefined?2000:1000,readThrough:q.after!==undefined?2000:1000}),snapshot:snapshot()});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("focus"));
 await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("5"));
 fireEvent.click(screen.getByText("refresh"));await waitFor(()=>expect(t.state().readThrough).toBe(2000));expect(screen.getByTestId("seqs").textContent).toBe("5");
 fireEvent.click(screen.getByText("latest"));await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("100,200,300"));
});
it("finishes a bounded in-flight initial read into cache after leaving",async()=>{
 let finish!:(value:SessionViewResponse)=>void;
 const t=setup(()=>new Promise(resolve=>{finish=resolve;}));await waitFor(()=>expect(t.calls.length).toBe(1));t.view.unmount();
 finish({page:page([100]),snapshot:snapshot()});
 await waitFor(()=>expect(t.client.getQueryCache().getAll().some(q=>(q.state.data as any)?.page?.events[0]?.seq===100)).toBe(true));
 expect(t.calls.length).toBe(1);
});

it("an older-history response cannot overwrite a newer input snapshot at the same event sequence",async()=>{
 let finishOlder!:(response:SessionViewResponse)=>void;
 const input={id:"input",author_user_id:"u",author_name:"User",text:"new message",state:"queued" as const,reason:null,created_at:"",updated_at:"",mine:true};
 const t=setup(async q=>q.before!==undefined?new Promise(resolve=>{finishOlder=resolve;}):{page:page(q.after!==undefined?[]:[100]),snapshot:{...snapshot(),inputs:q.after!==undefined?[input]:[]}});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("older"));await waitFor(()=>expect(finishOlder).toBeDefined());
 fireEvent.click(screen.getByText("refresh"));await waitFor(()=>expect(t.state().inputs[0]?.id).toBe("input"));
 finishOlder({page:page([10],{through:500,readThrough:500,hasOlder:false})});
 await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("10,100"));expect(t.state().inputs[0]?.id).toBe("input");expect(t.state().readThrough).toBe(1000);
});

it("a superseded focus request warms its cache without replacing the newer window",async()=>{
 let finishFirst!:(response:SessionViewResponse)=>void;
 const t=setup(async q=>q.around===5?new Promise(resolve=>{finishFirst=resolve;}):q.around===6?{page:page([6])}:{page:page([100]),snapshot:snapshot()});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("focus"));await waitFor(()=>expect(finishFirst).toBeDefined());
 await t.state().history!.focus(6);await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("6"));
 finishFirst({page:page([5])});await waitFor(()=>expect(t.state().history!.loading).toBe(false));expect(screen.getByTestId("seqs").textContent).toBe("6");
});

it("a live refresh finishing after older pagination keeps the newly loaded history",async()=>{
 let finishRefresh!:(response:SessionViewResponse)=>void;
 const t=setup(async q=>q.after!==undefined?new Promise(resolve=>{finishRefresh=resolve;}):q.before!==undefined?{page:page([10],{hasOlder:false})}:{page:page([100]),snapshot:snapshot()});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("refresh"));await waitFor(()=>expect(finishRefresh).toBeDefined());
 fireEvent.click(screen.getByText("older"));await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("10,100"));
 finishRefresh({page:page([200],{through:2000,readThrough:2000}),snapshot:snapshot()});
 await waitFor(()=>expect(screen.getByTestId("seqs").textContent).toBe("10,100,200"));expect(t.state().history!.hasOlder).toBe(false);
});

it("an optimistic input arriving during refresh survives its older snapshot and triggers a fresh read",async()=>{
 let finishRefresh!:(response:SessionViewResponse)=>void;let refreshes=0;
 const input={id:"input-1",author_user_id:"u",author_name:"User",text:"new message",state:"queued" as const,reason:null,created_at:"",updated_at:"",mine:true};
 const t=setup(async q=>q.after!==undefined?(++refreshes===1?new Promise(resolve=>{finishRefresh=resolve;}):{page:page([]),snapshot:{...snapshot(),inputs:[input]}}):{page:page([100]),snapshot:snapshot()});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("refresh"));await waitFor(()=>expect(finishRefresh).toBeDefined());
 t.client.setQueryData(t.state().cacheKey,(data:any)=>({...data,inputs:[input],inputRevision:1}));
 finishRefresh({page:page([]),snapshot:snapshot()});
 await waitFor(()=>expect(refreshes).toBe(2));expect(t.state().inputs[0]?.id).toBe(input.id);
});

it("keeps cached conversation visible and exposes a retryable state refresh error",async()=>{
 const t=setup(async q=>{if(q.after!==undefined)throw new Error("offline");return{page:page([100]),snapshot:snapshot()};});
 await screen.findByTestId("seqs");fireEvent.click(screen.getByText("refresh"));
 await waitFor(()=>expect(t.state().updateError).toBe("Session updates are delayed."));expect(screen.getByTestId("seqs").textContent).toBe("100");
});
