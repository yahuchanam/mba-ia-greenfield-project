export const STORAGE_URL_TTL = {
  /** Presigned UploadPart PUT URLs — client may take a while on big parts. */
  UPLOAD_PART_SECONDS: 3600,
  /** Presigned GET URLs for stream/download — short-lived on purpose. */
  GET_SECONDS: 900,
} as const;
