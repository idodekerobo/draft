-- Home: a notification can need a person's action, and carries the state of that action.
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('message', 'todo_routed', 'run_result', 'connection_attention', 'identity_proposed', 'todo_reassign'));

alter table notifications
  add column needs_action        boolean not null default false,
  add column state               text not null default 'open'
                                   check (state in ('open', 'done', 'not_mine', 'retracted')),
  add column ref_type            text,
  add column ref_id              text,
  add column matched_identity_id uuid,
  add column seen_at             timestamptz,
  add column acted_at            timestamptz;

create index notifications_needs_action_idx on notifications (recipient_person_id)
  where needs_action and state = 'open';

grant update on table notifications to service_role;
