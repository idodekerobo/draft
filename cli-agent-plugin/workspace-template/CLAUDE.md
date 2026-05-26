# Draft — Workspace Context

## Workspace structure
!`tree -L 2 --charset ascii $DRAFT_WORKSPACE/context/ 2>/dev/null || echo "(context/ not found — run /draft:setup)"`

## Context index
!`python3 -c "
import os
from pathlib import Path
ws = os.environ.get('DRAFT_WORKSPACE', os.path.expanduser('~/.draft/workspace'))
ctx = Path(ws) / 'context'
files = sorted(ctx.glob('*/index.md'))
if not files:
    print('No context loaded yet — run /draft:setup to initialize your shared context workspace.')
else:
    for idx in files:
        try:
            text = idx.read_text()
            parts = text.split('---')
            fm = parts[1].strip() if len(parts) >= 3 else text[:300]
            print(f'**{idx.parent.name}**')
            print(fm)
            print()
        except Exception:
            pass
" 2>/dev/null || echo "Run /draft:setup to initialize your shared context workspace."`

## Current priorities
!`cat $DRAFT_WORKSPACE/context/priorities/index.md 2>/dev/null || echo "No priorities recorded yet."`

## Memory
!`cat ~/.draft/personal/memory.md 2>/dev/null || echo "No memory yet."`
