-- ── Private sandbox bundle storage bucket ──────────────────────────────
-- Not publicly readable. Backend uploads a run's assembled input bundle
-- here and hands the Fly sandbox machine a short-TTL signed URL to pull it,
-- instead of embedding bundle content directly into the Fly Machines API's
-- config.files payload (see plans/draftv2/0042-fly-sandbox-bundle-ingestion-fix.md).
-- Object key convention:
--   sandbox_uploads/<organization_id>/<workspace_id>/<run_id>.json
-- All access goes through the service-role client (bypasses RLS); there is
-- no authenticated-user read/write path to this bucket.

insert into storage.buckets (id, name, public)
values ('sandbox-bundles', 'sandbox-bundles', false)
on conflict (id) do nothing;
