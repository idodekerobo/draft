import { createClient } from '@supabase/supabase-js';
import { strict as assert } from 'node:assert';
const url=process.env.SUPABASE_URL!;
if (!url.includes('zpmnbwvpasxbgiifbeti')) throw new Error('Staging only');
const db=createClient(url,process.env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false}});
const suffix=crypto.randomUUID();let user:string|undefined;let org:string|undefined;
async function row(table:string, values:Record<string,unknown>) { const r=await db.from(table).insert(values).select().single();if(r.error)throw r.error;return r.data; }
async function read(sessionId:string,ws:string,query:Record<string,unknown>={}) { const r=await db.rpc('read_session_view',{p_session_id:sessionId,p_workspace_id:ws,...query});if(r.error)throw r.error;return r.data; }
try {
 const created=await db.auth.admin.createUser({email:`view-${suffix}@example.test`,email_confirm:true,password:suffix+"-Test1!"});if(created.error)throw created.error;user=created.data.user.id;
 org=(await row('organizations',{slug:'view-'+suffix,name:'Session view test'})).id;
 const team=await row('teams',{organization_id:org,slug:'view-'+suffix,name:'Test'});
 const workspace=await row('workspaces',{organization_id:org,team_id:team.id,slug:'view-'+suffix,name:'Test'});
 const session=await row('sessions',{workspace_id:workspace.id,owner_user_id:user,host_id:'view-test'});
 const events:any[]=[{source_id:'call',kind:'tool_use',payload:{name:'Agent',tool_use_id:'spawn',input:{name:'worker',description:'Test work'}}},{source_id:'perm:q',kind:'permission_request',payload:{requestId:'q',name:'Bash'}}];
 for(let i=0;i<1000;i++)events.push({source_id:'agent-'+i,kind:i%2?'tool_result':'tool_use',payload:{agent_id:'a1',name:'Bash',tool_use_id:'t'+Math.floor(i/2),content:'Large output '.repeat(100),input:{command:'ls'}}});
 events.push({source_id:'spawn-result',kind:'tool_result',payload:{tool_use_id:'spawn',content:'agentId: a1'}});
 for(let i=0;i<250;i++)events.push({source_id:'root-'+i,kind:'assistant_text',payload:{text:'root '+i}});
 const appended=await db.rpc('append_session_events',{p_session_id:session.id,p_workspace_id:workspace.id,p_host_id:'view-test',p_events:events});if(appended.error)throw appended.error;
 const start=performance.now();const latest=await read(session.id,workspace.id);const ms=performance.now()-start;
 assert.equal(latest.page.events.length,200);assert(latest.page.events.every((e:any)=>!e.payload.agent_id));assert.equal(latest.page.hasOlder,true);
 assert.equal(latest.snapshot.approvals.length,1);assert.equal(latest.snapshot.agents[0].agentId,'a1');assert.equal(latest.snapshot.agents[0].steps,500);
 const older=await read(session.id,workspace.id,{p_before:latest.page.before,p_through:latest.page.through,p_state:false});
 assert(older.page.events.every((e:any)=>e.seq<latest.page.before));assert(!older.snapshot);assert(older.page.events.some((e:any)=>e.source_id==='call'));
 const cross=await read(session.id,workspace.id,{p_around:1003,p_limit:1,p_state:false});assert(cross.page.dependencies.some((e:any)=>e.source_id==='call'));
 const agent=await read(session.id,workspace.id,{p_agent_id:'a1',p_state:false});assert.equal(agent.page.events.length,200);assert(agent.page.events.every((e:any)=>e.payload.agent_id==='a1'));
 const around=await read(session.id,workspace.id,{p_around:500,p_state:false});assert.equal(around.page.agentId,'a1');assert(around.page.events.some((e:any)=>e.seq===500));
 const empty=await read(session.id,workspace.id,{p_after:latest.page.through,p_state:false});assert.equal(empty.page.events.length,0);assert.equal(empty.page.readThrough,latest.page.through);
 const bounded=await read(session.id,workspace.id,{p_through:100,p_agent_id:'a1',p_state:false});assert(bounded.page.events.every((e:any)=>e.seq<=100));
 const later=await db.rpc('append_session_events',{p_session_id:session.id,p_workspace_id:workspace.id,p_host_id:'view-test',p_events:[
  {source_id:'idle',kind:'session_note',payload:{agent_message:{from:'worker',type:'idle',text:'done'}}},
  {source_id:'resume',kind:'tool_use',payload:{name:'Agent',tool_use_id:'resume',input:{resume:'a1'}}},
  {source_id:'resume-result',kind:'tool_result',payload:{tool_use_id:'resume',content:'agentId: a1'}},
  {source_id:'new-agent-output',kind:'assistant_text',payload:{agent_id:'a1',text:'continued'}}
 ]});if(later.error)throw later.error;
 const resumed=await read(session.id,workspace.id,{p_after:latest.page.through});
 assert.equal(resumed.snapshot.agents.length,1);assert.equal(resumed.snapshot.agents[0].key,'agent:a1');assert.equal(resumed.snapshot.agents[0].hostSeq,1);assert.equal(resumed.snapshot.agents[0].state,'working');
 const agentOnly=await read(session.id,workspace.id,{p_after:later.data.last_seq-1,p_state:false});assert.equal(agentOnly.page.events.length,0);assert.equal(agentOnly.page.readThrough,later.data.last_seq);
 const asyncSession=await row('sessions',{workspace_id:workspace.id,owner_user_id:user,host_id:'view-test'});
 let eventNumber=0;
 async function advance(payloads:any[]) {
  const r=await db.rpc('append_session_events',{p_session_id:asyncSession.id,p_workspace_id:workspace.id,p_host_id:'view-test',p_events:payloads.map(e=>({...e,source_id:'async-'+(++eventNumber)}))});if(r.error)throw r.error;
  return (await read(asyncSession.id,workspace.id)).snapshot.agents;
 }
 let agents=await advance([
  {kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:00Z',name:'Agent',tool_use_id:'async',input:{description:'Read Drive'}}},
  {kind:'tool_result',payload:{timestamp:'2026-11-20T01:00:01Z',tool_use_id:'async',agent_result:{id:'async-1',async:true,model:'opus'}}},
  {kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:02Z',agent_id:'async-1',name:'Read'}}
 ]);
 assert.equal(agents[0].state,'working');assert.equal(agents[0].async,true);assert.equal(agents[0].steps,1);assert.equal(agents[0].model,'opus');
 agents=await advance([{kind:'session_note',payload:{timestamp:'2026-11-20T01:00:04Z',agent_lifecycle:{id:'async-1',state:'idle',isError:false}}}]);
 assert.equal(agents[0].state,'idle');
 agents=await advance([{kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:03Z',agent_id:'async-1',name:'Read'}}]);
 assert.equal(agents[0].state,'idle');assert.equal(agents[0].steps,2);
 agents=await advance([{kind:'tool_result',payload:{timestamp:'2026-11-20T01:00:05Z',agent_lifecycle:{id:'async-1',state:'working',isError:false}}}]);
 assert.equal(agents.length,1);assert.equal(agents[0].state,'working');assert.equal(agents[0].key,'agent:async-1');
 agents=await advance([{kind:'session_note',payload:{timestamp:'2026-11-20T01:00:06Z',agent_lifecycle:{id:'async-1',state:'idle',isError:true}}}]);
 assert.equal(agents[0].state,'idle');assert.equal(agents[0].isError,true);
 agents=await advance([
  {kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:07Z',name:'Agent',tool_use_id:'sync',input:{description:'Sync work'}}},
  {kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:08Z',agent_id:'sync-1',name:'Read'}},
  {kind:'tool_result',payload:{timestamp:'2026-11-20T01:00:09Z',tool_use_id:'sync',agent_result:{id:'sync-1',async:false,model:'opus'}}}
 ]);
 assert.equal(agents.find((a:any)=>a.agentId==='sync-1').state,'idle');
 agents=await advance([
  {kind:'tool_use',payload:{timestamp:'2026-11-20T01:00:10Z',name:'Agent',tool_use_id:'team',input:{name:'reviewer'}}},
  {kind:'tool_result',payload:{timestamp:'2026-11-20T01:00:11Z',tool_use_id:'team',agent_result:{id:'team-1',async:false,model:'opus'}}},
  {kind:'session_note',payload:{timestamp:'2026-11-20T01:00:12Z',agent_message:{from:'reviewer',type:'idle',text:'done'}}}
 ]);
 assert.equal(agents.find((a:any)=>a.agentId==='team-1').state,'idle');
 agents=await advance([{kind:'session_note',payload:{timestamp:'2026-11-20T01:00:13Z',agent_id:'team-1',agent_message:{from:'team-lead',type:'message',text:'Review again'}}}]);
 assert.equal(agents.find((a:any)=>a.agentId==='team-1').state,'working');
 console.log('Async lifecycle: launch, activity, completion, delayed activity, resume, failure, synchronous completion verified');
 const anonymous=createClient(url,process.env.SUPABASE_PUBLISHABLE_KEY!,{auth:{persistSession:false}});
 const denied=await anonymous.rpc('read_session_view',{p_session_id:session.id,p_workspace_id:workspace.id});assert(denied.error);
 const signed=await anonymous.auth.signInWithPassword({email:`view-${suffix}@example.test`,password:suffix+'-Test1!'});if(signed.error)throw signed.error;
 const deniedUser=await anonymous.rpc('read_session_view',{p_session_id:session.id,p_workspace_id:workspace.id});assert(deniedUser.error);
 const explanation=await db.rpc('read_session_view',{p_session_id:session.id,p_workspace_id:workspace.id}).explain({analyze:true,buffers:true,format:'json'});
 const explainAvailable=!explanation.error;
 const foreign=await db.rpc('read_session_view',{p_session_id:session.id,p_workspace_id:crypto.randomUUID()});assert(foreign.error?.message.includes('session_not_found'));
 console.log(JSON.stringify({scenarios:12,explainAvailable,events:events.length,bootstrap_ms:Math.round(ms),bootstrap_bytes:JSON.stringify(latest).length,root_page:latest.page.events.length,agent_page:agent.page.events.length}));
} finally {
 if(org){const r=await db.from('organizations').delete().eq('id',org);if(r.error)console.error('Cleanup org failed',r.error.message);}
 if(user){const r=await db.auth.admin.deleteUser(user);if(r.error)console.error('Cleanup user failed',r.error.message);}
}
