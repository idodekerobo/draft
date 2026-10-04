// RoutinesView.tsx — recurring routines and their schedules

import { DataBoundary, RoutinesPanel, RoutinesSkeleton } from "draft-shared-ui";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function RoutinesView({ onReconnect }: { onReconnect: () => void }) {
  const workspaceKey = useWorkspaceKey();
  return (
    <div className="routines-view">
      <DataBoundary fallback={<RoutinesSkeleton />} errorMessage="Could not load routines.">
        <RoutinesPanel workspaceId={workspaceKey} onReconnect={onReconnect} />
      </DataBoundary>
    </div>
  );
}
