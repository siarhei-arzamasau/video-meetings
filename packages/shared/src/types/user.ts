/** A person who can host or join meetings. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}
