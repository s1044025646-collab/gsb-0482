export type ErrorCode =
  | "E_MISSING_FIELD"
  | "E_DUPLICATE_NODE"
  | "E_BAD_FORMAT"
  | "E_BAD_FRAME_TYPE"
  | "E_BAD_HEX"
  | "E_ID_RANGE"
  | "E_DLC_RANGE"
  | "E_DATA_LENGTH"
  | "E_REMOTE_PAYLOAD"
  | "E_TOO_MANY_NODES"
  | "E_EMPTY_SCENARIO"
  | "E_NOT_FOUND"
  | "E_BAD_REQUEST"
  | "E_EXPORT_LIMIT"
  | "E_INTERNAL";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function errorBody(err: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (err instanceof ApiError) {
    return { error: { code: err.code, message: err.message, details: err.details } };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { error: { code: "E_INTERNAL", message: msg } };
}
