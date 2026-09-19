import fs from 'node:fs';
import path from 'node:path';

import { useApiSuite } from './utils/api-suite';
import { meetingFilesDir } from './utils/fixtures';

/**
 * The PRD's "checked at boot, not at the first upload": booting the app is what creates the
 * storage root and its temp directory, so a misconfigured directory fails startup rather than
 * the first upload.
 */
describe('meeting file storage at boot', () => {
  useApiSuite();

  it('creates the storage root and its tmp directory when the app starts', () => {
    const tmp = path.join(meetingFilesDir(), 'tmp');

    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.statSync(tmp).isDirectory()).toBe(true);
  });
});
