/** Stable machine-readable error codes. The client maps these to localized text. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHENTICATED: 'unauthenticated',
  TOKEN_EXPIRED: 'token_expired',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  DUPLICATE_MEDICATION: 'duplicate_medication',
  HIGH_RISK_CONFIRMATION_REQUIRED: 'high_risk_confirmation_required',
  RATE_LIMITED: 'rate_limited',
  OTP_INVALID: 'otp_invalid',
  OTP_EXPIRED: 'otp_expired',
  OTP_TOO_MANY_ATTEMPTS: 'otp_too_many_attempts',
  INVITATION_EXPIRED: 'invitation_expired',
  INVITATION_INVALID: 'invitation_invalid',
  INVITATION_ALREADY_USED: 'invitation_already_used',
  DOSE_ALREADY_RESOLVED: 'dose_already_resolved',
  DOSE_NOT_ACTIONABLE: 'dose_not_actionable',
  VOICE_CONFIDENCE_TOO_LOW: 'voice_confidence_too_low',
  STOCK_TRACKING_DISABLED: 'stock_tracking_disabled',
  CONSENT_REQUIRED: 'consent_required',
  UPLOAD_REJECTED: 'upload_rejected',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail for validation failures. Never contains health data. */
    details?: Array<{ path: string; message: string }>;
    requestId?: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Array<{ path: string; message: string }>;
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    options?: { details?: Array<{ path: string; message: string }>; meta?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options?.details;
    this.meta = options?.meta;
  }

  static unauthenticated(msg = 'Authentication required') {
    return new AppError(ERROR_CODES.UNAUTHENTICATED, 401, msg);
  }
  static forbidden(msg = 'You do not have access to this resource') {
    return new AppError(ERROR_CODES.FORBIDDEN, 403, msg);
  }
  static notFound(msg = 'Resource not found') {
    return new AppError(ERROR_CODES.NOT_FOUND, 404, msg);
  }
  static conflict(code: ErrorCode, msg: string, meta?: Record<string, unknown>) {
    return new AppError(code, 409, msg, { meta });
  }
  static badRequest(code: ErrorCode, msg: string, details?: Array<{ path: string; message: string }>) {
    return new AppError(code, 400, msg, { details });
  }
}
