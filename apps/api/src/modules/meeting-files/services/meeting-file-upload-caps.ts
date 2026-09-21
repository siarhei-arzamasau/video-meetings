/** The two limits a new session is checked against. */
export interface UploadCaps {
  /** Non-deleted files one meeting may hold. */
  meetingFiles: number;
  /** Unpurged sessions one user may hold, across every meeting. */
  openUploadsPerUploader: number;
}

/** Which cap refused a new session. */
export enum UploadCapReached {
  MEETING_FILES = 'MEETING_FILES',
  OPEN_UPLOADS = 'OPEN_UPLOADS',
}
