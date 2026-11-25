-- Execution contract, expand step. A run's launch contract is now execution (target + adapter), toolset,
-- computer and continuation. A session stores its execution target and adapter instead of a runtime.
-- The new columns stay nullable until the contract step, so code that has not shipped yet can still insert rows.
-- Every update below only touches rows that are still null, so the backfill can run again after the new code deploys.

alter table agent_runs
  add column execution    jsonb,
  add column toolset      jsonb,
  add column computer     jsonb,
  add column continuation jsonb,
  alter column runtime drop not null;

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

-- A new session no longer carries a runtime, so the 'local' default must not fill it in.
alter table sessions
  add column execution_target text,
  add column adapter_id       text,
  alter column runtime drop not null,
  alter column runtime drop default;

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

-- During the expand step, a cloud session the old code created has no execution target yet.
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
    and (execution_target = 'sandbox' or (execution_target is null and runtime = 'cloud'))
    and status = 'sleeping' and deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function claim_cloud_session_wake(uuid, uuid) from public;
grant execute on function claim_cloud_session_wake(uuid, uuid) to service_role;
