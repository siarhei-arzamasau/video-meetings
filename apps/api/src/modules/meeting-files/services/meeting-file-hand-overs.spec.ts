import { holdWrite, nextTurn } from './held-write.fixture';
import { MeetingFileHandOvers } from './meeting-file-hand-overs';

const FILE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_FILE_ID = '66666666-6666-4666-8666-666666666666';

describe('MeetingFileHandOvers', () => {
  let handOvers: MeetingFileHandOvers;
  let order: string[];

  /** A hand-over as its callers write one: the write, then the announcement, in one step. */
  const handOver = (fileId: string, write: Promise<void>, name = 'hand-over'): Promise<void> =>
    handOvers.run(fileId, async () => {
      await write;
      order.push(`${name} announced`);
    });

  /** A worker's side: the claim came back, and is announced once `announced` lets it. */
  const claim = (fileId: string): Promise<number> =>
    handOvers.announced(fileId).then(() => order.push('claim announced'));

  beforeEach(() => {
    handOvers = new MeetingFileHandOvers();
    order = [];
  });

  it('has nothing to wait for while no hand-over is in flight', async () => {
    await claim(FILE_ID);

    expect(order).toEqual(['claim announced']);
  });

  it('starts the step at once, so it is registered before its write can have landed', () => {
    const step = jest.fn(() => Promise.resolve());

    void handOvers.run(FILE_ID, step);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it('holds a claim back until the hand-over in flight has announced', async () => {
    const write = holdWrite();
    const handedOver = handOver(FILE_ID, write.answered);
    const claimed = claim(FILE_ID);

    await nextTurn();
    expect(order).toEqual([]);

    write.answer();
    await Promise.all([handedOver, claimed]);

    expect(order).toEqual(['hand-over announced', 'claim announced']);
  });

  it('waits for every hand-over of the file, whichever of them returns first', async () => {
    const first = holdWrite();
    const second = holdWrite();
    void handOver(FILE_ID, first.answered, 'first');
    void handOver(FILE_ID, second.answered, 'second');
    const claimed = claim(FILE_ID);

    second.answer();
    await nextTurn();
    expect(order).toEqual(['second announced']);

    first.answer();
    await claimed;

    expect(order).toEqual(['second announced', 'first announced', 'claim announced']);
  });

  it('does not make a claim already waiting wait for a hand-over that starts after it', async () => {
    const before = holdWrite();
    const after = holdWrite();
    void handOver(FILE_ID, before.answered, 'earlier');
    const claimed = claim(FILE_ID);
    void handOver(FILE_ID, after.answered, 'later');

    before.answer();
    await claimed;

    // The later one cannot be what made the row claimable: the claim had already come back.
    expect(order).toEqual(['earlier announced', 'claim announced']);
    after.answer();
  });

  it('lets a claim go when the hand-over failed, and still fails its own caller', async () => {
    const write = holdWrite();
    const handedOver = handOver(FILE_ID, write.answered);
    const claimed = claim(FILE_ID);

    write.fail(new Error('Only a failed transcription can be retried'));

    await expect(handedOver).rejects.toThrow('Only a failed transcription can be retried');
    await claimed;
    // A write that matched no row announces nothing, and there is nothing left to wait for.
    expect(order).toEqual(['claim announced']);
  });

  it('never holds a claim back for another file', async () => {
    const write = holdWrite();
    void handOver(OTHER_FILE_ID, write.answered);

    await claim(FILE_ID);

    expect(order).toEqual(['claim announced']);
    write.answer();
  });

  it('hands back what the step resolved with', async () => {
    await expect(handOvers.run(FILE_ID, () => Promise.resolve('the file'))).resolves.toBe(
      'the file',
    );
  });

  it('keeps nothing once the last hand-over of a file has finished', async () => {
    const first = holdWrite();
    const second = holdWrite();
    const pending = (handOvers as unknown as { inFlight: Map<string, unknown> }).inFlight;
    void handOver(FILE_ID, first.answered);
    void handOver(FILE_ID, second.answered);
    void handOver(OTHER_FILE_ID, Promise.resolve());

    first.answer();
    await nextTurn();
    // One per file ever handed over would be a leak the size of the table.
    expect([...pending.keys()]).toEqual([FILE_ID]);

    second.answer();
    await nextTurn();
    expect(pending.size).toBe(0);
  });
});
