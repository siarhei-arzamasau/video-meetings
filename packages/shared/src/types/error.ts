/**
 * The body of every failing API response.
 *
 * The API's `HttpExceptionFilter` normalises unhandled throws into this shape too, so a client
 * can read it without first deciding whether the failure was deliberate.
 */
export interface ApiErrorResponse {
  statusCode: number;
  /**
   * An array when the request failed validation — `ValidationPipe` reports one entry per
   * broken rule, and a client that renders it as a string prints a comma-joined run-on.
   */
  message: string | string[];
  /** ISO 8601 timestamp. */
  timestamp: string;
  path: string;
}
