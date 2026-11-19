import { afterEach, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrackFn } from "../analytics/events";
import { SessionView } from "./SessionView";
import type { LiveSession, LiveSessionEvent, LiveSessionsApi, SessionAgentSummary, SessionTranscriptPage, SessionViewQuery, SessionViewResponse } from "./types";
afterEach(cleanup);
const session={id:"s",owner_user_id:"u",owner_name:"User",title:"Paged session",folder_name:null,host_name:null,status:"live" as const,started_at:"",ended_at:null,last_event_at:null,last_seq:1000};
const agent:SessionAgentSummary={key:"agent:a1",agentId:"a1",hostSeq:1,firstSeq:2,lastSeq:900,name:"worker",description:"Inspect files",model:null,steps:100,state:"working",isError:false};
const root:LiveSessionEvent[]=[{seq:1,source_id:"spawn",kind:"tool_use",payload:{name:"Agent",tool_use_id:"spawn",input:{name:"worker"}},created_at:""},{seq:1000,source_id:"root",kind:"assistant_text",payload:{text:"Latest root answer"},created_at:""}];
const child:LiveSessionEvent[]=[{seq:500,source_id:"child",kind:"assistant_text",payload:{text:"Private agent answer",agent_id:"a1"},created_at:""}];
const page=(events:LiveSessionEvent[],agentId:string|null=null):SessionTranscriptPage=>({agentId,events,dependencies:[],before:events[0]?.seq??null,after:events.at(-1)?.seq??null,hasOlder:false,hasNewer:false,through:1000,readThrough:1000});
function setup(options:{failAgent?:boolean;orphan?:boolean;approval?:boolean;track?:TrackFn;session?:Partial<LiveSession>}={}){
 const calls:SessionViewQuery[]=[];let fail=options.failAgent??false;
 const summary=options.orphan?{...agent,hostSeq:null,firstSeq:500}:agent;
 const fetchView=async(_id:string,q:SessionViewQuery):Promise<SessionViewResponse>=>{
  calls.push(q);
  if(q.agentId||q.around===500){if(fail)throw new Error("agent failed");return {page:page(child,"a1")};}
  return {page:page(q.after!==undefined?[]:options.orphan?[root[1]!]:root),...(q.state===false?{}:{snapshot:{session:{...session,...options.session},viewer:{id:"u",name:"User"},inputs:[],approvals:options.approval?[{seq:2,source_id:"perm:old",kind:"permission_request" as const,payload:{requestId:"old",name:"Bash",input:{command:"ls"}},created_at:""}]:[],agents:[summary]}})};
 };
 const api:LiveSessionsApi={listSessions:async()=>[],fetchView,fetchEvents:async()=>{throw new Error("Legacy history must not be read");},sendMessage:async()=>{},actOnInput:async()=>{},decideApproval:async()=>({ok:true}),stop:async()=>({withdrawn:[]}),setMode:async()=>{}};
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const tree=(focusSeq:number|null=null)=><QueryClientProvider client={client}><SessionView api={api} sessionId="s" shareBaseUrl="https://draft.test" focusSeq={focusSeq} track={options.track}/></QueryClientProvider>;
 return {calls,client,tree,api,recover:()=>{fail=false;}};
}
function toggle(details:HTMLDetailsElement,open:boolean){act(()=>{details.open=open;fireEvent(details,new Event("toggle"));});}
it("loads root only, fetches on expansion, and reuses the cached agent transcript",async()=>{
 const t=setup();const {container}=render(t.tree());await screen.findByText("Latest root answer");
 expect(t.calls).toEqual([{}]);expect(screen.queryByText("Private agent answer")).toBeNull();
 const details=container.querySelector<HTMLDetailsElement>("#m-1 > details")!;expect(details.textContent).toContain("100 steps");
 toggle(details,true);await screen.findByText("Private agent answer");expect(t.calls.some(q=>q.agentId==="a1")).toBe(true);
 expect(container.querySelector("#m-500 button[aria-label='Copy link to message']")).not.toBeNull();
 toggle(details,false);expect(screen.queryByText("Private agent answer")).toBeNull();toggle(details,true);
 expect(screen.getByText("Private agent answer")).toBeTruthy();
});
it("shows an agent-local error without hiding root content or the composer",async()=>{
 const t=setup({failAgent:true});const {container}=render(t.tree());await screen.findByText("Latest root answer");toggle(container.querySelector<HTMLDetailsElement>("#m-1 > details")!,true);
 await screen.findByText(/Could not load agent messages/);expect(screen.getByRole("textbox")).toBeTruthy();expect(screen.getByText("Latest root answer")).toBeTruthy();
 t.recover();fireEvent.click(screen.getByRole("button",{name:"Retry"}));await screen.findByText("Private agent answer");
});
it("loads a deep link into a collapsed agent before scrolling",async()=>{
 const t=setup();const scrolled:string[]=[];const old=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(){scrolled.push(this.id);};
 try {render(t.tree(500));await screen.findByText("Private agent answer");await waitFor(()=>expect(scrolled).toContain("m-500"));expect(t.calls.some(q=>q.around===500)).toBe(true);}
 finally{Element.prototype.scrollIntoView=old;}
});
it("can open an orphan agent without a launch event in the root window",async()=>{
 const t=setup({orphan:true});const {container}=render(t.tree());await screen.findByText("Latest root answer");
 toggle(container.querySelector<HTMLDetailsElement>(".ui-stream__item--agent > details")!,true);await screen.findByText("Private agent answer");
});

it("shows a current approval even when its request is outside loaded history",async()=>{
 const t=setup({approval:true});render(t.tree());await screen.findByText("Latest root answer");
 expect(screen.getByRole("group",{name:"Permission request: Bash"})).toBeTruthy();expect(screen.getByRole("button",{name:"Allow"})).toBeTruthy();
 expect(t.calls).toEqual([{}]);
});

it("preserves the visible message when older history arrives without native scroll anchoring",async()=>{
 const old=Element.prototype.getBoundingClientRect;
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 let finish!:(response:SessionViewResponse)=>void;
 const api:LiveSessionsApi={listSessions:async()=>[],fetchView:async(_id:string,q:SessionViewQuery)=>q.before!==undefined?new Promise<SessionViewResponse>(resolve=>{finish=resolve;}):{page:{...page([{...root[1]!,seq:100},{...root[1]!,seq:200}]),hasOlder:true},snapshot:{session,viewer:{id:"u",name:"User"},inputs:[],approvals:[],agents:[]}},fetchEvents:async()=>{throw Error("legacy");},sendMessage:async()=>{},actOnInput:async()=>{},decideApproval:async()=>({ok:true}),stop:async()=>({withdrawn:[]}),setMode:async()=>{}};
 try {
  const {container}=render(<QueryClientProvider client={client}><SessionView api={api} sessionId="scroll-paged"/></QueryClientProvider>);
  await screen.findByRole("heading",{name:"Paged session"});
  const scroll=container.querySelector<HTMLElement>(".ui-session__scroll")!;
  Object.defineProperty(scroll,"scrollTop",{configurable:true,writable:true,value:100});
  Element.prototype.getBoundingClientRect=function(){
   if(this===scroll)return {top:0,bottom:300,height:300,left:0,right:800,width:800,x:0,y:0,toJSON(){return {};}};
   if(this.matches(".ui-stream__item")){
    const index=Array.from(container.querySelectorAll(".ui-stream>.ui-stream__item")).indexOf(this);
    const top=index*100-scroll.scrollTop;
    return {top,bottom:top+100,height:100,left:0,right:800,width:800,x:0,y:top,toJSON(){return {};}};
   }
   return old.call(this);
  };
  const before=container.querySelector("#m-200")!.getBoundingClientRect().top;
  fireEvent.click(screen.getByRole("button",{name:"Load older messages"}));
  await waitFor(()=>expect(finish).toBeDefined());
  expect(container.querySelector("#m-200")!.getBoundingClientRect().top).toBe(before);
  finish({page:page([{...root[1]!,seq:10},{...root[1]!,seq:20}])});
  await waitFor(()=>expect(container.querySelector("#m-10")).not.toBeNull());
  expect(container.querySelector("#m-200")!.getBoundingClientRect().top).toBe(before);
  expect(scroll.style.overflowAnchor).toBe("");
 }finally{Element.prototype.getBoundingClientRect=old;}
});

it("resolves a link to an orphan agent's first message with a unique message DOM id",async()=>{
 const t=setup({orphan:true});const old=Element.prototype.scrollIntoView;const scrolled:string[]=[];
 Element.prototype.scrollIntoView=function(){scrolled.push(this.id);};
 try{const {container}=render(t.tree(500));await screen.findByText("Private agent answer");await waitFor(()=>expect(scrolled).toContain("m-500"));expect(container.querySelectorAll("#m-500").length).toBe(1);}
 finally{Element.prototype.scrollIntoView=old;}
});

it("counts a paged session once while subagent pages are opened and reused", async () => {
 const track = mock((_event: string, _properties: unknown) => {});
 const t = setup({ track: track as TrackFn, session: { mine: true } });
 const { container } = render(t.tree());
 await screen.findByText("Latest root answer");
 const details = container.querySelector<HTMLDetailsElement>("#m-1 > details")!;
 toggle(details, true);
 await screen.findByText("Private agent answer");
 toggle(details, false);
 toggle(details, true);
 expect(track.mock.calls).toEqual([["session_viewed", { live_session_id: "s", is_owner: true, entry: "list" }]]);
});

it("counts an ended routine opened through the paged view as a result, not multiplayer", async () => {
 const track = mock((_event: string, _properties: unknown) => {});
 const t = setup({ track: track as TrackFn, session: { session_type: "routine", status: "ended" } });
 render(t.tree());
 await screen.findByText("Latest root answer");
 expect(track.mock.calls).toEqual([["routine_result_viewed", { live_session_id: "s" }]]);
});
