import { PIPELINE } from './pipeline';

describe('PIPELINE', () => {
  it('runs verify before preview, so nothing reads an object that is not whole', () => {
    expect(PIPELINE.map(({ name }) => name)).toEqual(['verify', 'preview']);
  });
});
