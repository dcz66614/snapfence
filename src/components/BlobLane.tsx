/**
 * SnapFence (P030) — Blob lane (lower track). T008.
 *
 * Authority: PROJECT_BOOK.md §5.2 (lower track: object write, object
 * delete, object update, Blob snapshot). Thin wrapper over LaneView; lane
 * assignment and positions come from the pure timeline-layout model.
 */

import type { TimelineEventItem } from "./timeline/timeline-layout";
import { LaneView } from "./timeline/LaneView";

export interface BlobLaneProps {
  items: readonly TimelineEventItem[];
  compact: boolean;
}

export function BlobLane({ items, compact }: BlobLaneProps) {
  return (
    <LaneView
      title="Blob 存储"
      subtitle="写入对象 · 删除对象 · 更新对象 · Blob 快照"
      items={items}
      accentColor="#059669"
      compact={compact}
    />
  );
}
