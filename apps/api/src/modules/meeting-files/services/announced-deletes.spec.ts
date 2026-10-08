import { AnnouncedDeletes, REMEMBERED_DELETES } from './announced-deletes';

const FILE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_FILE_ID = '66666666-6666-4666-8666-666666666666';

const numbered = (index: number): string => `file-${String(index)}`;

describe('AnnouncedDeletes', () => {
  let deleted: AnnouncedDeletes;

  beforeEach(() => {
    deleted = new AnnouncedDeletes();
  });

  it('passes every event of a file nobody has deleted', () => {
    expect(deleted.admits({ id: FILE_ID, status: 'uploaded' })).toBe(true);
    expect(deleted.admits({ id: FILE_ID, status: 'processing' })).toBe(true);
    expect(deleted.admits({ id: FILE_ID, status: 'ready' })).toBe(true);
  });

  it('passes the delete, and nothing for that file after it but the delete again', () => {
    expect(deleted.admits({ id: FILE_ID, status: 'deleted' })).toBe(true);

    // A worker's write that committed before the delete, announced after it.
    expect(deleted.admits({ id: FILE_ID, status: 'ready' })).toBe(false);
    // The purge repeats the delete, and a subscriber removes the row on either.
    expect(deleted.admits({ id: FILE_ID, status: 'deleted' })).toBe(true);
    expect(deleted.admits({ id: FILE_ID, status: 'ready' })).toBe(false);
  });

  it('holds one file’s delete against that file only', () => {
    deleted.admits({ id: FILE_ID, status: 'deleted' });

    expect(deleted.admits({ id: OTHER_FILE_ID, status: 'ready' })).toBe(true);
  });

  it('remembers a bounded number of deletes, and forgets the oldest first', () => {
    for (let index = 0; index <= REMEMBERED_DELETES; index += 1) {
      deleted.admits({ id: numbered(index), status: 'deleted' });
    }

    // One more than it keeps: the first is forgotten, the rest are not.
    expect(deleted.admits({ id: numbered(0), status: 'ready' })).toBe(true);
    expect(deleted.admits({ id: numbered(1), status: 'ready' })).toBe(false);
    expect(deleted.admits({ id: numbered(REMEMBERED_DELETES), status: 'ready' })).toBe(false);
  });

  it('counts a repeated delete as the newest, so its purge does not age it out early', () => {
    deleted.admits({ id: FILE_ID, status: 'deleted' });

    for (let index = 1; index < REMEMBERED_DELETES; index += 1) {
      deleted.admits({ id: numbered(index), status: 'deleted' });
    }

    // The purge's repeat, and then one more delete: the oldest goes, and it is not this file.
    deleted.admits({ id: FILE_ID, status: 'deleted' });
    deleted.admits({ id: OTHER_FILE_ID, status: 'deleted' });

    expect(deleted.admits({ id: FILE_ID, status: 'ready' })).toBe(false);
    expect(deleted.admits({ id: numbered(1), status: 'ready' })).toBe(true);
  });
});
