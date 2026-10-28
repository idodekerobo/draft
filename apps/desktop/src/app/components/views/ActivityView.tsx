// ActivityView.tsx — cloud synthesis run history

import { ActivityPanel } from "draft-shared-ui";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

export function ActivityView({ onFixInConnections }: { onFixInConnections: () => void }) {
  return (
    <div className="activity">
      <div className="ui-page">
        <ActivityPanel workspaceId={useWorkspaceKey()} onFixInConnections={onFixInConnections} />
      </div>
    </div>
  );
}
