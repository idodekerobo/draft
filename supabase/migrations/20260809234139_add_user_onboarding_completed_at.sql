-- Server-side record of whether a user has finished the desktop app's
-- onboarding wizard. Per-user, not per-workspace: many users can share a
-- workspace, and the wizard has per-device/per-user steps (connecting
-- Claude Code locally, analytics consent) alongside workspace-level steps
-- (context bootstrap, integrations) that already self-skip when already
-- done. A workspace-level flag would let one teammate's completion hide
-- the wizard from every later teammate who still needs those personal
-- steps.
alter table users
  add column onboarding_completed_at timestamptz;
