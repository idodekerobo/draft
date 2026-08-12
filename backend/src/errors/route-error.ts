import type { ErrorOperation } from "../types/enums";
import { recordError, type RecordErrorInput } from "./record-error";

type RouteErrorInput = Omit<RecordErrorInput, "message" | "operation"> & {
  operation?: ErrorOperation;
  errorCode: string;
};

/** Records a route-owned 5xx without delaying or changing its response. */
export function recordRouteError(input: RouteErrorInput): void {
  void recordError({
    ...input,
    operation: input.operation ?? "read",
    message: `Route operation failed: ${input.errorCode}`,
    code: input.code ?? input.errorCode,
  });
}
