export type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
  outcome?: { status: string };
};

export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  const base = `v1:${params.childSessionKey}:${params.childRunId}`;
  if (params.outcome?.status && params.outcome.status !== "ok") {
    return `${base}:${params.outcome.status}`;
  }
  return base;
}

export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `announce:${announceId}`;
}

export function resolveQueueAnnounceId(params: {
  announceId?: string;
  sessionKey: string;
  enqueuedAt: number;
}): string {
  const announceId = params.announceId?.trim();
  if (announceId) {
    return announceId;
  }
  // Backward-compatible fallback for queue items that predate announceId.
  return `legacy:${params.sessionKey}:${params.enqueuedAt}`;
}
