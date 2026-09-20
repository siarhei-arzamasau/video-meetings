import type { ProcessingStep } from './step';
import { PIPELINE, buildPipeline } from './pipeline';

describe('PIPELINE', () => {
  it('runs verify before preview, so nothing reads an object that is not whole', () => {
    expect(PIPELINE.map(({ name }) => name)).toEqual(['verify', 'preview']);
  });

  it('appends transcription last, after the object is known to be whole and readable', () => {
    const transcribe: ProcessingStep = { name: 'transcribe', run: () => Promise.resolve({}) };

    expect(buildPipeline(transcribe).map(({ name }) => name)).toEqual([
      'verify',
      'preview',
      'transcribe',
    ]);
  });

  it('leaves PIPELINE untouched, so building it twice cannot grow the list', () => {
    const transcribe: ProcessingStep = { name: 'transcribe', run: () => Promise.resolve({}) };

    buildPipeline(transcribe);
    buildPipeline(transcribe);

    expect(PIPELINE).toHaveLength(2);
  });
});
