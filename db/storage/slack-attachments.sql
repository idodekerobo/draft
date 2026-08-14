-- Private Slack attachment storage. Not publicly readable.
--
-- Object key convention:
--   slack/<organization_id>/<workspace_id>/<channel_id>/<file_id>-<sanitized_name>
-- referenced by content hash + key in slack_messages.files_json. No secret
-- Slack download URLs are ever persisted.
--
-- No storage.objects policy: all access goes through the service-role
-- client (bypasses RLS); there is no authenticated-user read/write path.

insert into storage.buckets (id, name, public)
values ('slack-attachments', 'slack-attachments', false)
on conflict (id) do nothing;
