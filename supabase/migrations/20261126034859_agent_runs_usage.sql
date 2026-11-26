-- The token use and cost a harness reported for a run: { inputTokens, outputTokens,
-- cacheReadTokens, cacheWriteTokens, costUsd | null }. Null until a runner reports it.
alter table agent_runs add column usage_json jsonb;
