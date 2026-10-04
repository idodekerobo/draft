// RoutinesView.tsx — recurring routines and their schedules

import { RoutinesPanel } from "draft-shared-ui";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function RoutinesView({ onReconnect }: { onReconnect: () => void }) {
  const workspaceKey = useWorkspaceKey();
  return (
    <div className="routines-view ui-routines-page">
      <RoutinesPanel workspaceId={workspaceKey} onReconnect={onReconnect} />
    </div>
  );
}
