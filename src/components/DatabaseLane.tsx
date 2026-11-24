/**
 * SnapFence (P030) — database lane (upper track). T008.
 *
 * Authority: PROJECT_BOOK.md §5.2 (upper track: record insert, reference
 * delete, version repoint, database snapshot). Thin wrapper over LaneView;
 * lane assignment and positions come from the pure timeline-layout model.
 */

import type { TimelineEventItem } from "./timeline/timeline-layout";
import { LaneView } from "./timeline/LaneView";

export interface DatabaseLaneProps {
  items: readonly TimelineEventItem[];
  compact: boolean;
}

export function DatabaseLane({ items, compact }: DatabaseLaneProps) {
  return (
    <LaneView
      title="数据库"
      subtitle="插入记录 · 删除引用 · 切换对象版本 · 数据库快照"
      items={items}
      accentColor="#2563eb"
      compact={compact}
    />
  );
}
