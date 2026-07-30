import {
  applyAutomatedMaintainerOutput,
  type AutomatedMaintainerResult,
  type TrustedMaintainerMetadata,
} from 'draft-core/automated-maintainer';
import { validateMaintainerOutput } from 'draft-core/maintainer';

export type AutomatedMaintainerRouteResult = AutomatedMaintainerResult & {
  meetingIds: string[];
};

/**
 * The single trust boundary for automated synthesis output.
 *
 * Model output must satisfy the strict maintainer contract before it reaches
 * the handler. Meeting sources must also provide an explicit receipt list.
 */
export function routeAutomatedMaintainerOutput(
  raw: string,
  metadata: TrustedMaintainerMetadata,
  workspace: string,
): AutomatedMaintainerRouteResult {
  const validation = validateMaintainerOutput(raw);
  if (!validation.ok) {
    throw new Error(`invalid maintainer output: ${validation.error}`);
  }
  if (
    (metadata.input_source === 'granola' || metadata.input_source === 'fireflies')
    && validation.output.meeting_ids === undefined
  ) {
    throw new Error(`${metadata.input_source} maintainer output must include meeting_ids`);
  }

  const result = applyAutomatedMaintainerOutput(validation.output, metadata, workspace);
  return { ...result, meetingIds: validation.output.meeting_ids ?? [] };
}
