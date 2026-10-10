import type { Prisma } from '../../../generated/prisma/client';
import { DigestRequestKind } from './meeting-digest-action';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from './meeting-digest-record.fixture';
import { requestGenerationAs } from './meeting-digest-request';
import { DigestStatus } from './meeting-digest-status';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;
const { RETRY, CATCH_UP } = DigestRequestKind;
const FIRST = [FIRST_RECORDING_ID];
const SUMMARY = 'The team agreed to ship on Friday.';

/**
 * The conditional request against a stubbed transaction client: what is read in which
 * order, for which caller, and that a refusal writes nothing. What each statement does to a
 * real row is `test/meeting-digest-request.e2e-spec.ts`'s for a retry and
 * `test/meeting-digest-catch-up.e2e-spec.ts`'s for the catch-up, and that requests at once
 * are one generation is `…-request-refusals`' and `…-catch-up-races`'.
 */
describe('requestGenerationAs', () => {
  const statements: string[] = [];
  const executeRaw = jest.fn();
  const queryRaw = jest.fn();
  const findSources = jest.fn();
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    meetingDigestSource: { findMany: findSources },
  } as unknown as Prisma.TransactionClient;

  const stored = (
    status: DigestStatus | null,
    sourceFileIds: string[] = [],
    summary: string | null = sourceFileIds.length === 0 ? null : SUMMARY,
  ): void => {
    queryRaw.mockImplementation(async (strings: ReadonlyArray<string>) => {
      statements.push(strings.join('?'));

      return [{ id: DIGEST_ID, status, summary }];
    });
    findSources.mockImplementation(async () => {
      statements.push('sources');

      return sourceFileIds.map((meetingFileId) => ({ meetingFileId }));
    });
  };

  /** The statements that wrote, in order: the empty row, if one was offered, and the request. */
  const written = (): string[] => statements.filter((text) => text.includes('INSERT'));

  beforeEach(() => {
    statements.length = 0;
    executeRaw.mockReset().mockImplementation(async (strings: ReadonlyArray<string>) => {
      statements.push(strings.join('?'));

      return 1;
    });
    queryRaw.mockReset();
    findSources.mockReset();
    stored(null);
  });

  describe('as the catch-up', () => {
    it('makes sure of a row, locks it, reads its sources, and only then asks', async () => {
      await requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, CATCH_UP);

      expect(statements).toHaveLength(4);
      expect(statements[0]).toContain('ON CONFLICT (meeting_id) DO NOTHING');
      expect(statements[1]).toContain('FOR UPDATE');
      expect(statements[2]).toBe('sources');
      // `requestGeneration`, the statement every other request is.
      expect(statements[3]).toContain('ON CONFLICT (meeting_id) DO UPDATE');
      expect(findSources).toHaveBeenCalledWith({
        where: { digestId: DIGEST_ID },
        select: { meetingFileId: true },
      });
    });

    it.each([
      ['a row with no status', null, []],
      ['a digest that does not cover a recording', READY, [SECOND_RECORDING_ID]],
    ] as const)('asks for %s', async (_what, status, sources) => {
      stored(status, [...sources]);

      await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, CATCH_UP)).resolves.toEqual({
        allowed: true,
        kind: CATCH_UP,
      });
      expect(written()).toHaveLength(2);
    });

    it.each([
      ['queued', QUEUED, [], 'UNDER_WAY'],
      ['generating', GENERATING, [], 'UNDER_WAY'],
      ['current', READY, FIRST, 'CURRENT'],
      // Left for its Retry: asked for at every boot, it would be a retry nobody made.
      ['failed', FAILED, [], 'OTHER_KIND'],
    ] as const)(
      'refuses a digest that is %s, asking for nothing',
      async (_what, status, sources, refusal) => {
        stored(status, [...sources]);

        await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, CATCH_UP)).resolves.toEqual({
          allowed: false,
          refusal,
        });
        // The empty row is offered to a meeting that already has one, and changes nothing there.
        expect(written()).toHaveLength(1);
        expect(written()[0]).toContain('DO NOTHING');
      },
    );

    it('asks all the same when the row is gone by the time it is locked', async () => {
      queryRaw.mockResolvedValue([]);

      await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, CATCH_UP)).resolves.toEqual({
        allowed: true,
        kind: CATCH_UP,
      });
      expect(findSources).not.toHaveBeenCalled();
      expect(written()).toHaveLength(2);
    });
  });

  describe('as a retry', () => {
    it('locks the row and asks for a failed digest, making no row first', async () => {
      stored(FAILED);

      await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, RETRY)).resolves.toEqual({
        allowed: true,
        kind: RETRY,
      });

      expect(statements).toHaveLength(3);
      expect(statements[0]).toContain('FOR UPDATE');
      expect(statements[1]).toBe('sources');
      expect(statements[2]).toContain('ON CONFLICT (meeting_id) DO UPDATE');
    });

    it.each([
      ['queued', QUEUED, [], 'UNDER_WAY'],
      ['generating', GENERATING, [], 'UNDER_WAY'],
      ['current', READY, FIRST, 'CURRENT'],
      // Owed a digest, and nobody's to ask for but the catch-up's.
      ['out of date', READY, [SECOND_RECORDING_ID], 'OTHER_KIND'],
      ['without a status or content', null, [], 'OTHER_KIND'],
    ] as const)(
      'refuses a digest that is %s, writing nothing at all',
      async (_what, status, sources, refusal) => {
        stored(status, [...sources]);

        await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, RETRY)).resolves.toEqual({
          allowed: false,
          refusal,
        });
        expect(written()).toEqual([]);
      },
    );

    it('refuses a meeting that has no row, and makes none for the refusal', async () => {
      queryRaw.mockImplementation(async (strings: ReadonlyArray<string>) => {
        statements.push(strings.join('?'));

        return [];
      });

      await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, FIRST, RETRY)).resolves.toEqual({
        allowed: false,
        refusal: 'OTHER_KIND',
      });
      // A row made here would be committed with the refusal: an empty digest nobody asked for.
      expect(written()).toEqual([]);
      expect(findSources).not.toHaveBeenCalled();
    });
  });

  it.each([[RETRY], [CATCH_UP]] as const)(
    'refuses a meeting with no transcribed recording before it touches the table, as %s',
    async (kind) => {
      await expect(requestGenerationAs(tx, DIGEST_MEETING_ID, [], kind)).resolves.toEqual({
        allowed: false,
        refusal: 'NO_RECORDING',
      });

      expect(statements).toEqual([]);
    },
  );
});
