/**
 * The single boundary between the web app and the API. Every call to the backend goes through
 * one of these wrappers — components never call `fetch` themselves — and every one of them is
 * re-exported here, so a caller imports `@/lib/api-client` whichever file it lives in.
 *
 * `core.ts` holds the transport the wrappers share (`apiFetch`, `ApiError`, the bearer header,
 * and the one `XMLHttpRequest` path that exists because `fetch` cannot report upload
 * progress); the rest are grouped by the part of the API they call.
 */
export { ApiError, buildApiUrl, getApiBaseUrl, apiFetch } from './core';
export type { UploadOptions } from './core';
export { getHealth, register, login, getMe, changePassword } from './auth';
export { deleteAvatar, fetchAvatar, updateDisplayName, uploadAvatar } from './user';
export { listMeetings, getMeeting } from './meetings';
export {
  NOT_AN_EVENT_STREAM_MESSAGE,
  deleteMeetingFile,
  downloadMeetingFile,
  fetchThumbnail,
  listMeetingFiles,
  openMeetingFileEvents,
  retryMeetingFile,
  uploadMeetingFile,
} from './meeting-files';
export { abortUpload, completeUpload, createUpload, getUpload, putChunk } from './uploads';
