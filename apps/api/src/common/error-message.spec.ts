import { describeError, errorMessage } from './error-message';

describe('errorMessage', () => {
  it('is an error’s message, and anything else as a string', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full');
    expect(errorMessage('disk full')).toBe('disk full');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('describeError', () => {
  it('is the stack of an error nothing was wrapped in', () => {
    const error = new Error('disk full');

    expect(describeError(error)).toBe(error.stack);
  });

  // The reason it exists: `Error.stack` stops at the wrapper, and the wrapper is a sentence
  // this code chose. What a reader of the log needs is what it was wrapped around.
  it('puts the stack of each cause under the error that wraps it', () => {
    const missing = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const storage = new Error('The object could not be read', { cause: missing });
    const answer = new Error('Internal server error', { cause: storage });

    const described = describeError(answer);

    expect(described.split('\nCaused by: ')).toEqual([answer.stack, storage.stack, missing.stack]);
  });

  it('describes a cause that is not an error as the string it is', () => {
    const error = new Error('The request failed', { cause: 'socket hang up' });

    expect(describeError(error)).toBe(`${String(error.stack)}\nCaused by: socket hang up`);
  });

  it('describes a thrown value that is not an error', () => {
    expect(describeError('timed out')).toBe('timed out');
    expect(describeError(null)).toBe('null');
  });

  it('falls back to the message of an error with no stack', () => {
    const error = new Error('disk full');
    delete error.stack;

    expect(describeError(error)).toBe('disk full');
  });

  it('stops at an error that is its own cause', () => {
    const error = new Error('round and round');
    error.cause = error;

    const described = describeError(error);

    expect(described.split('\nCaused by: ').length).toBeLessThanOrEqual(6);
  });
});
