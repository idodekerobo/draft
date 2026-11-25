alter table public.agent_query_log
  add column session_id uuid references public.sessions(id) on delete set null;

create index agent_query_log_session_occurred_idx
  on public.agent_query_log (session_id, occurred_at)
  where session_id is not null;
