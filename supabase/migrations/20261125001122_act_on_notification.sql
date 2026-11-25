-- Marks a notification done or not mine, or undoes that, and records it in the workspace history. One transaction.
-- Not mine also asks the routine owner (the notification's sender) to reassign the to-do.
create or replace function act_on_notification(
  p_workspace_id uuid,
  p_notification_id uuid,
  p_actor_user_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n notifications%rowtype;
  v_actor_person uuid;
  v_actor_name text;
  v_identity jsonb;
  v_owner_person uuid;
  v_reassign uuid;
  v_reassign_state text;
  v_event text;
  v_key text;
begin
  if p_action not in ('done', 'not_mine', 'undo') then
    return jsonb_build_object('ok', false, 'code', 'invalid_action');
  end if;

  select * into n from notifications
  where id = p_notification_id and workspace_id = p_workspace_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select id, display_name into v_actor_person, v_actor_name from people
  where workspace_id = p_workspace_id and user_id = p_actor_user_id;
  if v_actor_person is distinct from n.recipient_person_id then
    return jsonb_build_object('ok', false, 'code', 'not_recipient');
  end if;
  if not n.needs_action then
    return jsonb_build_object('ok', false, 'code', 'not_actionable');
  end if;

  select jsonb_build_object('provider', provider, 'externalId', external_id, 'status', status) into v_identity
  from person_identities where id = n.matched_identity_id and workspace_id = p_workspace_id;

  if p_action = 'done' then
    if n.state = 'done' then
      return jsonb_build_object('ok', true, 'state', 'done', 'changed', false);
    end if;
    if n.state <> 'open' then
      return jsonb_build_object('ok', false, 'code', 'already_acted', 'state', n.state);
    end if;
    update notifications set state = 'done', acted_at = now() where id = n.id;
    v_event := 'notification_done';

  elsif p_action = 'not_mine' then
    if n.kind <> 'todo_routed' then
      return jsonb_build_object('ok', false, 'code', 'not_actionable');
    end if;
    if n.state = 'not_mine' then
      return jsonb_build_object('ok', true, 'state', 'not_mine', 'changed', false);
    end if;
    if n.state <> 'open' then
      return jsonb_build_object('ok', false, 'code', 'already_acted', 'state', n.state);
    end if;
    update notifications set state = 'not_mine', acted_at = now() where id = n.id;
    v_event := 'notification_not_mine';

    select id into v_owner_person from people where workspace_id = p_workspace_id and user_id = n.sender_user_id;
    if v_owner_person is not null then
      v_key := 'reassign:' || n.id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
      insert into notifications (
        workspace_id, recipient_person_id, sender_user_id, kind, subject, body_text, visibility,
        needs_action, ref_type, ref_id, agent_run_id, scheduled_task_id, idempotency_key, content_hash
      ) values (
        p_workspace_id, v_owner_person, null, 'todo_reassign',
        left('Reassign: ' || n.subject, 200),
        coalesce(v_actor_name, 'A teammate') || ' says this to-do is not theirs. Pick who should get it.',
        'private', true, 'notification', n.id::text, n.agent_run_id, n.scheduled_task_id, v_key, md5(v_key)
      ) returning id into v_reassign;
    end if;

  else
    if n.state = 'open' then
      return jsonb_build_object('ok', true, 'state', 'open', 'changed', false);
    end if;
    if n.state not in ('done', 'not_mine') then
      return jsonb_build_object('ok', false, 'code', 'stale_undo', 'state', n.state);
    end if;
    if n.state = 'not_mine' then
      select id, state into v_reassign, v_reassign_state from notifications
      where workspace_id = p_workspace_id and kind = 'todo_reassign' and ref_type = 'notification' and ref_id = n.id::text
        and state <> 'retracted'
      order by created_at desc limit 1;
      -- The owner already acted on the reassign card, so the original cannot be taken back.
      if v_reassign is not null and v_reassign_state <> 'open' then
        return jsonb_build_object('ok', false, 'code', 'stale_undo', 'state', n.state);
      end if;
      if v_reassign is not null then
        update notifications set state = 'retracted', acted_at = now() where id = v_reassign;
      end if;
    end if;
    update notifications set state = 'open', acted_at = null where id = n.id;
    v_event := 'notification_undone';
  end if;

  perform append_workspace_event(
    p_workspace_id, v_event, left(n.subject, 200), n.agent_run_id, null, null,
    jsonb_build_object(
      'notificationId', n.id, 'kind', n.kind, 'recipientPersonId', n.recipient_person_id,
      'matchedIdentity', v_identity, 'reassignNotificationId', v_reassign
    ),
    'private', n.recipient_person_id
  );

  return jsonb_build_object(
    'ok', true, 'changed', true, 'reassignNotificationId', v_reassign,
    'state', case p_action when 'done' then 'done' when 'not_mine' then 'not_mine' else 'open' end
  );
end;
$$;

revoke all on function act_on_notification(uuid, uuid, uuid, text) from public;
grant execute on function act_on_notification(uuid, uuid, uuid, text) to service_role;
