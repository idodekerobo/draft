-- Private. Backend uploads a run's assembled input bundle here and hands
-- the Fly sandbox machine a short-TTL signed URL to pull it, instead of
-- embedding bundle content into the Fly Machines API's config.files
-- payload (plans/draftv2/0042-fly-sandbox-bundle-ingestion-fix.md).
--
-- Object key convention:
--   sandbox_uploads/<organization_id>/<workspace_id>/<run_id>.json
--
-- No storage.objects policy: all access goes through the service-role
-- client (bypasses RLS); there is no authenticated-user read/write path.

insert into storage.buckets (id, name, public)
values ('sandbox-bundles', 'sandbox-bundles', false)
on conflict (id) do nothing;
