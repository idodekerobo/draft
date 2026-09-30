-- Who minted a credential. Null for credentials created before this column
-- existed and for non-user mint paths.
alter table credentials
  add column created_by_user_id uuid references users(id) on delete set null;
