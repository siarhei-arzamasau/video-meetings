'use client';

import type { DragEvent } from 'react';
import { useState } from 'react';

export interface DropTarget {
  /** True while a drag carrying files is over the target or one of its children. */
  isDragging: boolean;
  handlers: {
    onDragEnter(event: DragEvent<HTMLDivElement>): void;
    onDragOver(event: DragEvent<HTMLDivElement>): void;
    onDragLeave(event: DragEvent<HTMLDivElement>): void;
    onDrop(event: DragEvent<HTMLDivElement>): void;
  };
}

/**
 * A drop target that only reacts to a drag carrying files, so dragging selected text or a
 * link across the card does not light it up.
 *
 * The depth counter is the point: `dragenter` and `dragleave` fire for every child the
 * pointer crosses, so a boolean would switch off the moment the drag moved from the card onto
 * a row inside it. Counting enters against leaves keeps the target lit until the drag has
 * actually left.
 */
export function useDropTarget(onFiles: (files: FileList) => void): DropTarget {
  const [dragDepth, setDragDepth] = useState(0);

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      setDragDepth((depth) => Math.max(0, depth - 1));
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) {
      return;
    }

    event.preventDefault();
    setDragDepth(0);
    onFiles(event.dataTransfer.files);
  }

  return {
    isDragging: dragDepth > 0,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

/**
 * Whether a drag carries files. `types` is the only thing readable during a drag — `files` is
 * empty until the drop — and a drag from the desktop always lists `Files`.
 */
function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes('Files');
}
