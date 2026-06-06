import os
import subprocess
from pathlib import Path


def _read_active_profile() -> str:
    """Read the active Draft profile at runtime — not cached at install time."""
    profile_file = Path.home() / ".draft" / "active-profile"
    try:
        return profile_file.read_text().strip() or "default"
    except Exception:
        return "default"


def register(ctx):
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)


def on_session_start(event):
    # Resolve active profile at runtime so profile switches take effect
    # without reinstalling the plugin.
    profile = _read_active_profile()
    draft_global = Path.home() / ".draft"

    os.environ["DRAFT_WORKSPACE"] = str(draft_global / "workspaces" / profile)
    os.environ["DRAFT_PROFILE"] = profile
    os.environ["DRAFT_SHARED"] = str(draft_global / "shared")

    # Ensure daemon is running (draft start is idempotent)
    subprocess.Popen(["draft", "start"], capture_output=True)


def on_session_end(event):
    script = Path.home() / ".draft" / "shared" / "hooks" / "hermes-session-end.sh"
    session_id = getattr(event, "session_id", "") or ""
    transcript_path = getattr(event, "transcript_path", "") or ""
    subprocess.Popen(
        ["bash", str(script), session_id, transcript_path],
        capture_output=True,
    )
