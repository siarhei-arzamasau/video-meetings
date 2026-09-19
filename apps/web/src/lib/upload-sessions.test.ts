import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetUploadSession, recallUploadSession, rememberUploadSession } from './upload-sessions';

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('upload sessions', () => {
  it('remembers a session id under the file fingerprint and gives it back', () => {
    rememberUploadSession('recording.mp4:20:17', 'up1');

    expect(recallUploadSession('recording.mp4:20:17')).toBe('up1');
    // Namespaced, so it cannot collide with the token or another app on the same origin.
    expect(window.localStorage.getItem('video-meetings.upload-session.recording.mp4:20:17')).toBe(
      'up1',
    );
  });

  it('has nothing for a file that was never uploaded', () => {
    expect(recallUploadSession('other.mp4:20:17')).toBeNull();
  });

  it('forgets one, so a re-pick starts a new session', () => {
    rememberUploadSession('recording.mp4:20:17', 'up1');

    forgetUploadSession('recording.mp4:20:17');

    expect(recallUploadSession('recording.mp4:20:17')).toBeNull();
  });

  it('survives storage that throws, because losing a session id only costs a re-upload', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('window', { localStorage: throwing });

    expect(() => rememberUploadSession('a', 'up1')).not.toThrow();
    expect(recallUploadSession('a')).toBeNull();
    expect(() => forgetUploadSession('a')).not.toThrow();
  });
});
