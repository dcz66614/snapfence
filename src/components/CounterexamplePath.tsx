/**
 * SnapFence (P030) — counterexample path highlight + step replay. T008.
 *
 * Authority: PROJECT_BOOK.md §5.3 ("最短反例路径使用高亮线连接") and §5.4
 * ("可以逐步回放最短反例；可以查看事件前后的状态"). The highlight line is
 * an SVG polyline through the counterexample events' lane centres; the
 * replay controls step through the sequence one event at a time and show
 * the state after the current step (database record count, Blob object
 * count, in-flight operations). For a SAFE result there is no
 * counterexample: the same controls replay the full canonical sequence
 * and the panel says so.
 */

import type { SystemState } from "../core/model/types";
import type { TimelineEventItem } from "./timeline/timeline-layout";
import type { ReplayStep } from "./timeline/replay";

export interface CounterexamplePathProps {
  /** Displayed events, in order (counterexample or canonical sequence). */
  items: readonly TimelineEventItem[];
  /** True when the displayed sequence is the shortest counterexample. */
  isCounterexample: boolean;
  /** Number of events already applied (0..items.length). */
  replayStep: number;
  onReplayStepChange: (step: number) => void;
  /** Last applied replay step (null when replayStep is 0). */
  lastAppliedStep: ReplayStep | null;
  /** State after the current replay step. */
  currentState: SystemState;
}

function stateSummary(state: SystemState): string {
  const dbCount = Object.keys(state.database).length;
  const blobCount = Object.keys(state.blob).length;
  const inFlight = Object.entries(state.operationStatus)
    .filter(([, status]) => status === "IN_FLIGHT")
    .map(([opId]) => opId);
  const inFlightText = inFlight.length > 0 ? `在途操作：${inFlight.join("、")}` : "无在途操作";
  return `数据库记录 ${dbCount} 条 · Blob 对象 ${blobCount} 个 · ${inFlightText}`;
}

export function CounterexamplePath({
  items,
  isCounterexample,
  replayStep,
  onReplayStepChange,
  lastAppliedStep,
  currentState,
}: CounterexamplePathProps) {
  const total = items.length;
  const atStart = replayStep <= 0;
  const atEnd = replayStep >= total;
  const nextItem = !atEnd ? items[replayStep] : undefined;
  const heading = isCounterexample
    ? `最短反例路径（${total} 个事件）`
    : `完整事件顺序（${total} 个事件，无反例）`;
  return (
    <section className="sf-counterexample" aria-label="反例回放">
      <div className="sf-counterexample-head">
        <strong>{heading}</strong>
        <span className="sf-step-indicator">
          第 {replayStep} / {total} 步
        </span>
      </div>
      <div className="sf-replay-controls">
        <button
          type="button"
          disabled={atStart}
          onClick={() => onReplayStepChange(0)}
        >
          回到开头
        </button>
        <button
          type="button"
          disabled={atStart}
          onClick={() => onReplayStepChange(replayStep - 1)}
        >
          上一步
        </button>
        <button
          type="button"
          disabled={atEnd}
          onClick={() => onReplayStepChange(replayStep + 1)}
        >
          下一步
        </button>
        <button
          type="button"
          disabled={atEnd}
          onClick={() => onReplayStepChange(total)}
        >
          跳到结尾
        </button>
      </div>
      <div className="sf-step-detail">
        {atEnd && total > 0 ? (
          <>
            <span>回放完成：已应用全部 {total} 个事件。</span>
            <span>最终状态：{stateSummary(currentState)}</span>
            {lastAppliedStep !== null && lastAppliedStep.inFlightAfter.length > 0 ? (
              <span>最后一步后在途：{lastAppliedStep.inFlightAfter.join("、")}</span>
            ) : null}
          </>
        ) : (
          <>
            <span>
              已应用 {replayStep} / {total} 个事件。
              {nextItem !== undefined
                ? `下一步事件：${nextItem.labelZh}（${nextItem.eventId}）— ${nextItem.detail}`
                : ""}
            </span>
            <span>当前状态：{stateSummary(currentState)}</span>
            {lastAppliedStep !== null ? (
              <span>
                上一步：{lastAppliedStep.eventId}；该事件后
                {lastAppliedStep.inFlightAfter.length > 0
                  ? `在途：${lastAppliedStep.inFlightAfter.join("、")}`
                  : "无在途操作"}
              </span>
            ) : (
              <span>尚未开始回放：点击“下一步”逐步查看每个事件前后的状态。</span>
            )}
          </>
        )}
      </div>
      <ol className="sf-counterexample-list">
        {items.map((item, index) => (
          <li
            key={item.eventId}
            data-testid={`counterexample-step-${index}`}
            className={index < replayStep ? "sf-step-done" : index === replayStep ? "sf-step-current" : ""}
          >
            {index + 1}. {item.eventId}（{item.labelZh}）
          </li>
        ))}
      </ol>
    </section>
  );
}
