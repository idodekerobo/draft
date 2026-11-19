-- Private. Holds the folder snapshot a cloud session starts from. The backend
-- hands the desktop a signed upload URL and the sandbox host a signed download
-- URL, so there is no authenticated read or write path.
--
-- Object key convention:
--   <workspace_id>/<session_id>/seed.tar.gz
--
-- The bucket caps each file at 200 MB (209715200 bytes).
insert into storage.buckets (id, name, public, file_size_limit)
values ('session-seeds', 'session-seeds', false, 209715200)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;
