-- The AI lab a workspace picked for Draft's own agent (Home). Allowed values live in code
-- (core/src/model-provider.ts), not in a check, so adding a lab needs no migration.
alter table workspaces
  add column default_model_provider text not null default 'anthropic';
