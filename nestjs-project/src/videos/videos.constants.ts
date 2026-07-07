export const PROCESS_VIDEO_QUEUE = 'process-video';
export const PROCESS_VIDEO_JOB = 'process-video';

/** YouTube-like length; UNIQUE constraint + regenerate-on-conflict is the hard guarantee. */
export const PUBLIC_ID_LENGTH = 11;
export const MAX_PUBLIC_ID_RETRIES = 5;

/** Retry policy TD-08 relies on: exhausted attempts land the job in the failed (DLQ) state. */
export const PROCESS_VIDEO_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
} as const;
