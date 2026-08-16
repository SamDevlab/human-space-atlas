export function shouldApplyPositionResult(requestId: number, latestAppliedRequestId: number): boolean {
  return requestId >= latestAppliedRequestId
}
