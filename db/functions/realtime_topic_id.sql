-- The id in the current topic, or null when the topic is not "<prefix>:<uuid>".
-- The pattern check makes the cast safe for any other topic.
create or replace function realtime_topic_id(p_prefix text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when t ~ ('^' || p_prefix || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then substr(t, length(p_prefix) + 2)::uuid
  end
  from (select realtime.topic() as t) x
$$;
