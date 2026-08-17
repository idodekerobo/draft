begin;

create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, instance_id, aud, role, email)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alpha@example.test'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'beta@example.test'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gamma@example.test');

insert into organizations (id, slug, name)
values
  ('20000000-0000-0000-0000-000000000001', 'org-one-rls-test', 'Org One'),
  ('20000000-0000-0000-0000-000000000002', 'org-two-rls-test', 'Org Two');

insert into teams (id, organization_id, slug, name)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'alpha-rls-test', 'Alpha'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'beta-rls-test', 'Beta'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'gamma-rls-test', 'Gamma');

insert into users (id, email, organization_id, primary_team_id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'alpha@example.test', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'beta@example.test', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'active'),
  ('10000000-0000-0000-0000-000000000003', 'gamma@example.test', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'active');

insert into workspaces (id, organization_id, team_id, slug, name)
values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'alpha-ws-rls-test', 'Alpha Workspace'),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'beta-ws-rls-test', 'Beta Workspace'),
  ('40000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'gamma-ws-rls-test', 'Gamma Workspace');

insert into workspaces (id, organization_id, team_id, slug, name, access_mode)
values
  ('40000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'alpha-restricted-rls-test', 'Alpha Restricted', 'restricted');

insert into source_connections (id, workspace_id, provider, connection_key)
values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'slack', 'alpha-rls-test'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'slack', 'beta-rls-test'),
  ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'slack', 'gamma-rls-test');

insert into credentials (id, workspace_id, provider, encrypted_payload, encryption_key_version)
values
  ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'test', decode('00', 'hex'), 'v1');

insert into scheduled_tasks (id, workspace_id, task_type, task_key, schedule_kind, interval_seconds, timezone)
values
  ('70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'ingest_source', 'alpha-rls-test', 'interval', 60, 'UTC');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select is((select count(*) from organizations), 1::bigint, 'organization remains org-scoped');
select is((select count(*) from teams), 1::bigint, 'only the primary team is visible');
select is((select count(*) from users), 1::bigint, 'only users in the primary team are visible');
select is((select count(*) from workspaces), 1::bigint, 'only primary-team workspaces are visible');
select is((select count(*) from source_connections), 1::bigint, 'own-team descendants are visible');
select ok(exists(select 1 from workspaces where id = '40000000-0000-0000-0000-000000000001'), 'own-team workspace is visible');
select ok(not exists(select 1 from workspaces where id = '40000000-0000-0000-0000-000000000002'), 'same-org other-team workspace is hidden');
select ok(not exists(select 1 from workspaces where id = '40000000-0000-0000-0000-000000000003'), 'cross-org workspace is hidden');
select ok(not exists(select 1 from workspaces where id = '40000000-0000-0000-0000-000000000004'), 'restricted workspace is hidden during the pilot');
select ok(not exists(select 1 from source_connections where id = '50000000-0000-0000-0000-000000000002'), 'same-org other-team descendant is hidden');
select ok(not exists(select 1 from source_connections where id = '50000000-0000-0000-0000-000000000003'), 'cross-org descendant is hidden');
select ok(not has_table_privilege('authenticated', 'credentials', 'select'), 'credentials are not granted to authenticated users');
select ok(not has_table_privilege('authenticated', 'scheduled_tasks', 'select'), 'scheduled tasks are not granted to authenticated users');
select ok(not has_table_privilege('authenticated', 'synthesis_run_source_items', 'select'), 'run source items are not granted to authenticated users');

reset role;
set local role anon;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;

select ok(not has_table_privilege('anon', 'organizations', 'select'), 'anonymous users cannot read organizations');
select ok(not has_table_privilege('anon', 'teams', 'select'), 'anonymous users cannot read teams');
select ok(not has_table_privilege('anon', 'users', 'select'), 'anonymous users cannot read users');
select ok(not has_table_privilege('anon', 'workspaces', 'select'), 'anonymous users cannot read workspaces');
select ok(not has_table_privilege('anon', 'source_connections', 'select'), 'anonymous users cannot read descendants');

reset role;
set local role service_role;

select throws_ok(
  $$insert into source_items (
      workspace_id, source_connection_id, item_type, external_id,
      external_version, occurred_at
    ) values (
      '40000000-0000-0000-0000-000000000002',
      '50000000-0000-0000-0000-000000000001',
      'message', 'cross-workspace-rls-test', '1', now()
    )$$,
  '23503',
  null,
  'service role cannot violate composite workspace foreign keys'
);

select * from finish();
rollback;
