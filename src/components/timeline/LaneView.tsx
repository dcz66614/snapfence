/**
 * SnapFence (P030) — generic lane renderer (shared by DatabaseLane and
 * BlobLane). T008.
 *
 * Authority: PROJECT_BOOK.md §5.2/§5.3 (two fixed horizontal lanes; normal
 * completed operations share one completion mark; counterexample events are
 * highlighted; replay shows each step's state change). Event chips are
 * absolutely positioned at the x percentages the layout model computed,
 * so "event positions correct" is a property of the pure model, tested in
 * tests/unit/ui/timeline-layout.test.ts, and this renderer only places them.
 *
 * Visual states (never colour-only — every state also has a text mark):
 * - done (already replayed): solid chip, ✓ prefix.
 * - current (replay cursor): thick outline + "当前" tag.
 * - future (not yet replayed): muted chip.
 * - counterexample event: purple left border + "反例" tag.
 * - snapshot event: dashed border (its vertical SnapshotMarker line is
 *   rendered by the Timeline container, not here).
 *
 * V-01 (T010 fix, carried from the coordinator's visual inspection of the
 * T008 screenshots): snapshot chips used to render five lines (kind,
 * event id, detail, replay mark, "反例") — the detail line ("捕获当前数据
 * 库状态" / "捕获当前 Blob 状态") only repeats what the kind label and the
 * snapshot marker already say, and the five-line chip filled the 118px
 * track so the sub-text sat on the chip border while the counterexample
 * polyline and the snapshot marker line (painted above the chips) crossed
 * through the text. Snapshot chips now omit the redundant detail line
 * (the full detail stays in the chip's `title` tooltip): at most four
 * lines, with clear space to the border. Chips also paint above the
 * overlay lines now (see timeline.css `.sf-event-chip` z-index), so no
 * line can cross chip text any more.
 */

import type { TimelineEventItem } from "./timeline-layout";

export interface LaneViewProps {
  title: string;
  subtitle: string;
  items: readonly TimelineEventItem[];
  accentColor: string;
  /**
   * Compact mode (more than 6 displayed events, e.g. G12's 10): the track
   * is taller and chips stagger across two rows (even index upper row, odd
   * index lower row), so neighbouring chips never overlap horizontally.
   */
  compact: boolean;
}

function chipBorderColor(item: TimelineEventItem, accentColor: string): string {
  if (item.isSnapshot) {
    return accentColor;
  }
  if (item.isCounterexample) {
    return "#7c3aed";
  }
  return "#cbd5e1";
}

export function LaneView({ title, subtitle, items, accentColor, compact }: LaneViewProps) {
  return (
    <section
      className="sf-lane"
      aria-label={title}
      style={{ borderLeftColor: accentColor }}
    >
      <div className="sf-lane-head">
        <span className="sf-lane-title" style={{ color: accentColor }}>
          {title}
        </span>
        <span className="sf-lane-subtitle">{subtitle}</span>
      </div>
      <div className={`sf-lane-track${compact ? " sf-compact" : ""}`}>
        <div className="sf-lane-line" />
        {items.map((item) => (
          <div
            key={item.eventId}
            className={`sf-event-chip sf-replay-${item.replayState}${item.isCounterexample ? " sf-counterexample" : ""}${item.isSnapshot ? " sf-snapshot-chip" : ""}`}
            data-testid={`event-${item.eventId}`}
            data-event-kind={item.kind}
            data-replay-state={item.replayState}
            style={{
              left: `${item.xPercent}%`,
              top: compact ? (item.index % 2 === 0 ? "25%" : "75%") : "50%",
              borderColor: chipBorderColor(item, accentColor),
            }}
            title={`${item.labelZh}：${item.detail}（${item.eventId}）`}
          >
            <span className="sf-event-kind">{item.labelZh}</span>
            <span className="sf-event-id">{item.eventId}</span>
            {/* V-01 (T010): snapshot chips omit the detail line — it only
                repeats the kind label ("捕获当前数据库状态" / "捕获当前
                Blob 状态"); the full detail stays in the title tooltip.
                Keeps snapshot chips to at most four lines so the sub-text
                never touches the chip border. */}
            {item.isSnapshot ? null : (
              <span className="sf-event-detail">{item.detail}</span>
            )}
            {item.replayState === "done" ? <span className="sf-event-mark">✓ 已回放</span> : null}
            {item.replayState === "current" ? <span className="sf-event-mark">▶ 当前</span> : null}
            {item.isCounterexample && item.replayState !== "done" ? (
              <span className="sf-event-mark">反例</span>
            ) : null}
          </div>
        ))}
        {items.length === 0 ? (
          <span className="sf-lane-empty">本轨道无事件</span>
        ) : null}
      </div>
    </section>
  );
}
