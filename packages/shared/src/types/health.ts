/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  uptimeSeconds: number;
}
