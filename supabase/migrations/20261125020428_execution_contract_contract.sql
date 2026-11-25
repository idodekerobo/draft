-- Finish the execution contract after all writers use the new columns.
-- Catch rows written by the previous backend between expand and deployment.
begin;
set local lock_timeout = '5s';
lock table agent_runs, sessions in access exclusive mode;

-- Cloud runs: a sandbox target. Interactive runs use the terminal adapter, every other kind the one-shot adapter.
update agent_runs
set execution = jsonb_build_object(
      'target', jsonb_build_object('type', 'sandbox'),
      'adapterId', case
        when kind = 'interactive' then 'claude-terminal'
        when harness = 'codex' then 'codex-exec'
        else 'claude-print'
      end),
    toolset = coalesce(runtime -> 'toolset', '{"nativeTools":[],"mcpServers":[],"skills":[],"instructions":[]}'::jsonb),
    computer = jsonb_build_object(
      'type', 'sandbox',
      'profileId', 'default',
      'workingDirectory', case when kind = 'interactive' then '/data/workspace' else '/run' end,
      'network', coalesce(runtime ->> 'network', 'restricted'))
where execution is null and runtime ->> 'type' = 'cloud';

-- Local runs: a host target and the host's own computer.
update agent_runs
set execution = jsonb_build_object(
      'target', jsonb_build_object('type', 'host', 'hostId', runtime ->> 'hostId'),
      'adapterId', case when harness = 'codex' then 'codex-app-server' else 'claude-terminal' end),
    toolset = '{"nativeTools":[],"mcpServers":[],"skills":[],"instructions":[]}'::jsonb,
    computer = jsonb_build_object('type', 'host_computer', 'computerId', runtime ->> 'hostId', 'workingDirectory', '')
where execution is null and runtime ->> 'type' = 'local';

update sessions
set execution_target = case runtime when 'cloud' then 'sandbox' else 'host' end
where execution_target is null and runtime is not null;

update sessions
set adapter_id = case
      when session_type = 'routine' and harness = 'codex' then 'codex-exec'
      when session_type = 'routine' then 'claude-print'
      when harness = 'codex' then 'codex-app-server'
      else 'claude-terminal'
    end
where adapter_id is null;

update sessions set execution_target = 'sandbox' where session_type = 'routine';

-- Moves a sleeping cloud session to starting, so a wake can start its next run.
-- Returns true for the one caller that moved it, so two sends to a sleeping session start one run.
-- It also sets last_seen: the stale-session sweep would mark the new host host_offline before its first heartbeat.
create or replace function claim_cloud_session_wake(p_session_id uuid, p_workspace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'starting',
      last_seen = now()
  where id = p_session_id and workspace_id = p_workspace_id
    and execution_target = 'sandbox'
    and status = 'sleeping' and deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function claim_cloud_session_wake(uuid, uuid) from public;
grant execute on function claim_cloud_session_wake(uuid, uuid) to service_role;

alter table agent_runs
  alter column execution set not null,
  alter column toolset set not null,
  alter column computer set not null,
  drop column runtime;

alter table sessions
  alter column execution_target set not null,
  alter column adapter_id set not null,
  drop column runtime;
commit;
