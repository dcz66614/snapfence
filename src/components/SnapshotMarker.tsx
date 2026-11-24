/**
 * SnapFence (P030) — snapshot marker (vertical line). T008.
 *
 * Authority: PROJECT_BOOK.md §5.3 ("快照位置使用竖向标记"). A marker is a
 * dashed vertical line spanning both lanes at the snapshot event's x
 * position, labelled with the snapshot kind. Database snapshot: blue;
 * Blob snapshot: green. Colour is never the only signal — the label text
 * is always rendered.
 */

export interface SnapshotMarkerProps {
  /** "数据库快照" or "Blob 快照". */
  labelZh: string;
  /** Horizontal position, as a percentage of the timeline width. */
  xPercent: number;
  /** "database" (blue) or "blob" (green). */
  lane: "database" | "blob";
}

const MARKER_COLORS: Readonly<Record<SnapshotMarkerProps["lane"], string>> = {
  database: "#2563eb",
  blob: "#059669",
} as const;

export function SnapshotMarker({ labelZh, xPercent, lane }: SnapshotMarkerProps) {
  const color = MARKER_COLORS[lane];
  // The two labels share one 46px strip above the lanes (see timeline.css),
  // so they are staggered vertically by lane and can never cover each other
  // when the two snapshots sit close together (e.g. G12: 83.6% / 87.8%).
  const labelTop = lane === "database" ? 0 : 23;
  return (
    <div
      className="sf-snapshot-marker"
      data-testid={`snapshot-marker-${lane}`}
      style={{ left: `${xPercent}%`, borderLeftColor: color }}
      title={labelZh}
    >
      <span
        className="sf-snapshot-label"
        style={{ backgroundColor: color, top: labelTop }}
      >
        {labelZh}
      </span>
    </div>
  );
}
