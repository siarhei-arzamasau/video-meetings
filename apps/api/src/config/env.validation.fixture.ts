/** The least an environment needs to validate: what every case in these specs starts from. */
export const VALID = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/video_meetings',
  JWT_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
};
