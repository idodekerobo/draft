create or replace function sync_user_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger sync_user_email_on_auth_update
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function sync_user_email();
