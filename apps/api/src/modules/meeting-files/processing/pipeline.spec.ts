import type { ProcessingStep } from './step';
import { PIPELINE, buildPipeline } from './pipeline';

describe('PIPELINE', () => {
  it('runs verify before preview, so nothing reads an object that is not whole', () => {
    expect(PIPELINE.map(({ name }) => name)).toEqual(['verify', 'preview']);
  });

  it('queues for transcription last, so a file that fails a step is never queued', () => {
    const queueTranscription: ProcessingStep = {
      name: 'queue-transcription',
      run: () => Promise.resolve({}),
    };

    expect(buildPipeline(queueTranscription).map(({ name }) => name)).toEqual([
      'verify',
      'preview',
      'queue-transcription',
    ]);
  });

  it('leaves PIPELINE untouched, so building it twice cannot grow the list', () => {
    const queueTranscription: ProcessingStep = {
      name: 'queue-transcription',
      run: () => Promise.resolve({}),
    };

    buildPipeline(queueTranscription);
    buildPipeline(queueTranscription);

    expect(PIPELINE).toHaveLength(2);
  });
});
