import { routinesQueryOptions, useDraftApi, useQuery, useQueryClient, type RoutineAgentStatus } from "draft-shared-ui";
import { useWorkspaceKey } from "../DesktopQueryProvider";

/** Whether each agent is connected for the workspace's routines. It reads the same list the Routines page does, so both agree. */
export function useRoutineAgents() {
  const api = useDraftApi();
  const workspaceKey = useWorkspaceKey();
  const queryClient = useQueryClient();
  const options = routinesQueryOptions(api, workspaceKey);
  const { data } = useQuery(options);

  const status = (harness: string): RoutineAgentStatus | undefined => data?.agents?.[harness];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: options.queryKey });
  return { status, refresh };
}
