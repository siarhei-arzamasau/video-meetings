/** A write a spec answers by hand, so the spec decides when the database "returns". */
export interface HeldWrite<T> {
  answered: Promise<T>;
  answer(value: T): void;
  fail(error: Error): void;
}

export function holdWrite<T = void>(): HeldWrite<T> {
  // Filled in by the promise's executor, which runs before `new Promise` returns.
  const settle: { answer?: (value: T) => void; fail?: (error: Error) => void } = {};
  const answered = new Promise<T>((resolve, reject) => {
    settle.answer = resolve;
    settle.fail = reject;
  });

  return {
    answered,
    answer: (value) => settle.answer?.(value),
    fail: (error) => settle.fail?.(error),
  };
}

/** Lets everything already resolved run, as far as a later turn of the event loop. */
export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
