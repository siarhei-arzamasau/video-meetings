import { Card, Skeleton } from '@heroui/react';

import { LATEST_MEETINGS_COUNT } from '@/lib/meetings';

/**
 * The real shell, not a bare spinner: `ready` then fills this frame in rather than laying the
 * page out from scratch, so nothing jumps.
 *
 * The bars are `aria-hidden` because a row of grey rectangles read aloud is noise. The sentence
 * in the `output` is what a screen reader gets instead — an `output` rather than a `div` with
 * `role="status"` because it is the element that already means this, and it holds only text,
 * which is all its content model allows.
 */
export function DashboardLoadingShell() {
  return (
    <>
      <output className="sr-only">Loading your meetings</output>

      <div className="flex flex-col gap-8" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-64 rounded-lg" />
          <Skeleton className="h-4 w-40 rounded" />
        </div>

        <Card className="p-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-16 rounded-lg" />
            <Skeleton className="h-4 w-28 rounded" />
          </div>
        </Card>

        <Card className="gap-6 p-6">
          <Skeleton className="h-6 w-40 rounded" />
          <div className="flex flex-col gap-4">
            {Array.from({ length: LATEST_MEETINGS_COUNT }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
