---
name: draft-synthesize
description: >
  The single command for capturing context updates mid-session. Two modes:
  (1) with an explicit statement — stages that one thing as a proposal immediately;
  (2) with no args — reads the full session transcript, extracts everything worth
  capturing, and stages it as a proposal. Both modes write to proposals/ for
  curator review; nothing is applied automatically. Run /draft:publish to apply
  and push proposals to the team repo.
---

# /draft:synthesize — On-Demand Context Capture

Stage context updates from this session as a proposal — without waiting for the session to end.

**The three-command model:**
- `/draft:synthesize` — capture context from this session (one thing or everything). Stages a proposal.
- `/draft:publish` — apply approved proposals to context and push to the shared team repo.
- Personal preferences, vocabulary, working style → the orchestrator saves these directly to `~/.draft/personal/` — no slash command needed. Just tell Draft "from now on..." or "we call this..." in conversation.

---

## Step 0: Determine the invocation mode

**With an explicit statement** (e.g. `/draft:synthesize we decided to drop the bridge daemon`):
- Extract the statement from the args
- Classify it (see Step 4 classification table)
- If it's clearly personal (preference, vocabulary, working style): tell the user "That's a personal preference — I'll save it to memory directly" and save to `~/.draft/personal/memory.md` via draft-learner. No proposal needed. Done.
- If it's team context (decision, product direction, priority, company, team): skip to Step 4 with that single item. Skip Steps 1–3.

**With no args** (e.g. `/draft:synthesize`):
- Full transcript synthesis mode — proceed to Step 1.

---

## Step 1: Locate the current session transcript

Find the JSONL transcript for this active session using the Bash tool:

```bash
ls -t ~/.claude/projects/ | head -5
```

The project slug is a URL-encoded form of the current working directory path.
Find the slug for the current project:

```bash
python3 -c "
import urllib.parse, os
cwd = os.getcwd()
slug = cwd.replace('/', '-').lstrip('-')
print(slug)
"
```

Then find the most recently modified JSONL in that project's directory:

```bash
ls -t "$HOME/.claude/projects/<slug>/"*.jsonl 2>/dev/null | head -1
```

If the slug approach fails, fall back to finding the most recently modified JSONL across all projects:

```bash
find ~/.claude/projects -name "*.jsonl" -newer ~/.claude/projects -maxdepth 2 | xargs ls -t 2>/dev/null | head -1
```

Or simply find the most recent JSONL overall:

```bash
find ~/.claude/projects -name "*.jsonl" -maxdepth 2 -exec ls -t {} + 2>/dev/null | head -1
```

Store the transcript path as `TRANSCRIPT_PATH`.

If no transcript is found:
```
Could not locate the current session transcript. The transcript is written to
~/.claude/projects/<slug>/<session_id>.jsonl — check that this path exists.
```
Hard stop.

---

## Step 2: Read existing context

Read all context dimension files to understand what's already known. This is
the baseline — synthesis only surfaces net-new information NOT already in these files.

```bash
find "$DRAFT_WORKSPACE/context" -maxdepth 2 -name "index.md" | sort
```

Read each file returned. Also read `$DRAFT_WORKSPACE/context/tensions.md` if it exists.

---

## Step 3: Read the transcript

Read the transcript file at `TRANSCRIPT_PATH`. The file is JSONL — one JSON
object per line. Extract the human turns and assistant turns to reconstruct
what happened in this session.

Use sub-agents if the transcript is large — Read, Grep, paginate rather than
loading the entire file into the prompt at once.

Focus on:
- Decisions made (explicit or implied)
- Product direction changes
- Priority shifts
- Technical architecture choices
- Team or company changes
- New facts learned about users, competitors, or the market

---

## Step 4: Synthesize — three-action model

### Classification (explicit-arg mode only)

If called with an explicit statement, classify it to determine the target file:

| Type | Signal words | Target file |
|------|-------------|-------------|
| Decision | "decided", "going with", "chose", "agreed", "confirmed", "we're not doing" | `context/decisions/{slug}.md` + relevant dim |
| Priority shift | "done", "shipped", "dropped", "deferred", "blocked", "next up", "pausing" | `context/priorities/index.md` |
| Product direction | "pivoting", "the bet is", "ICP is", "targeting", "repositioning", "changed the roadmap" | `context/product/index.md` |
| Company change | "raised", "new investor", "rebranding", "acquired", "partnership" | `context/company/index.md` |
| Team change | "hired", "left", "now owns", "role change" | `context/team/index.md` |
| Personal/preference | "I prefer", "from now on", "we call it", "our word for", "don't do X" | → save to `~/.draft/personal/memory.md` directly, no proposal |

For explicit-arg mode, build a single-item `context_updates` array from the classified content. Skip the transcript steps below.

---

Apply the same synthesis rules as the daemon (transcript mode):

### What to extract (signal vs noise)

**Signal — include:**
- Specific decisions with named outcomes ("decided to use X", "dropped Y")
- Concrete product bets or strategy changes
- Priority changes (items added, completed, deferred, blocked)
- Architecture or implementation decisions
- Team or company structural changes
- Validated or invalidated hypotheses

**Noise — exclude:**
- Debugging sessions with no durable conclusion
- Code written or edited (unless it represents a design decision)
- Scheduling logistics
- Content already captured in the existing context files
- Exploratory thinking with no committed direction

### Three actions — use the right one

| Action | When to use |
|--------|-------------|
| `append` | New information that complements existing context — **default for all synthesis** |
| `tension` | New info directly contradicts existing context → route to `context/tensions.md` |
| `overwrite` | **NEVER USE** — reserved for `/draft:compact` only |

**For tensions:** When new information contradicts existing context (e.g., a new target user
contradicts the one in `context/product/index.md`), do NOT overwrite the product file.
Instead:
- Append the new information to the product file
- Write a `tension` entry pointing to `context/tensions.md`
- Before writing to tensions.md, read it first and check for an existing tension on this topic — do not create duplicate tension entries

**Format for tension entries in tensions.md:**
```
## [Short description of the contradiction]
date: YYYY-MM-DD
source: session synthesis (/draft:synthesize)

[Dimension file] currently says: [current state]
This session says: [new conflicting info]

Curator note: [brief suggestion for resolution]
```

**If no net-new information exists** (everything in this session was already in context):
```
Nothing new to synthesize — all context from this session is already captured.
Run /draft:learn if you want to save a specific decision explicitly.
```
Stop here. Do not write a proposal.

---

## Step 5: Write the proposal file

Write to `$DRAFT_WORKSPACE/proposals/` using this exact format:

**Filename:** `YYYYMMDDTHHMMSSZ-session-<short_id>.md`
- Timestamp: current UTC time
- Short ID: first 8 chars of the session ID (derived from the JSONL filename)
- Example: `20260522T143000Z-session-9fe02718.md`

**Format:**

```markdown
---
session_id: <full session id from jsonl filename>
input_source: session
synthesized_by: draft:synthesize
timestamp: <current ISO 8601 UTC>
profile: <active profile name from ~/.draft/active-profile>
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [specific content to append]
  - file: context/priorities/index.md
    action: append
    content: |
      [specific content to append]
  - file: context/tensions.md
    action: tension
    content: |
      [tension entry in format above]
---

## Synthesis preview

**Session:** <session_id>
**Source:** session transcript (on-demand via /draft:synthesize)
**Synthesized by:** draft:synthesize
**Timestamp:** <current time>

### context/product/index.md — append
[Human-readable summary of what's being appended]

### context/priorities/index.md — append
[Human-readable summary of what's being appended]
```

Use the Write tool to create the file at the full path.

---

## Step 6: Confirm to the user

After writing the proposal, confirm in 3–5 lines:

```
Proposal staged: proposals/<filename>

[N] update(s) proposed:
  • context/product/index.md — append: [one-line summary]
  • context/priorities/index.md — append: [one-line summary]

Review the proposal, then run /draft:publish to push to the shared team repo.
```

If there were tensions detected, call them out:
```
  • context/tensions.md — tension: [description of the contradiction]
    Heads up: this conflicts with what's currently in [dim file]. You'll need to resolve it.
```

---

## Rules

- **Never overwrite.** `action: overwrite` is forbidden in all synthesis — including this skill.
- **Never auto-apply.** The proposal goes to `proposals/` for curator review. It is not applied to context automatically.
- **Never ask clarifying questions** — synthesize from what's in the transcript. If something is ambiguous, omit it.
- **Signal/noise bar:** If in doubt about whether something belongs, omit it. One specific useful update is better than five vague ones.
- **Specificity rule:** Name the actual thing decided. "Discussed the product" is not a synthesis output. "Confirmed separate-clone pattern for GitHub publishing" is.
- **Already-captured rule:** If the transcript contains something already verbatim in the context files, do not re-append it.
- **Proposal format is non-negotiable:** The YAML frontmatter must be parseable by `commit-to-team-context.sh`. Do not deviate from the format.
