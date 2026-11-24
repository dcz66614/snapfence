/**
 * SnapFence (P030) — result inspector (consistency diagnostics panel). T008.
 *
 * Authority: PROJECT_BOOK.md §5.2 (right-hand diagnostics area: final
 * verdict, inconsistency types, affected file IDs, shortest counterexample
 * length, event order, database/Blob state diff), §4.4 (the 6 diagnostic
 * codes), §4.7 (the 4 verdict literals), §6 (honest boundary). Every code
 * and verdict is rendered with its frozen literal verbatim in a <code>
 * element, next to its Chinese explanation — the literal is the contract,
 * the Chinese text is the reading aid, never a replacement.
 */

import type { SearchResult, SearchVerdict } from "../core/model/types";
import {
  STRATEGY_LABELS,
  diagnosticMarkers,
  snapshotDiff,
} from "./timeline/timeline-layout";

/** Chinese reading of each verdict literal (PROJECT_BOOK.md §4.7/§6). */
export const VERDICT_EXPLANATIONS: Readonly<Record<SearchVerdict, string>> = {
  SAFE_WITHIN_BOUND:
    "在界内安全：在本次指定的事件模板、策略与事件规模内，穷举搜索没有发现不一致路径。这不代表真实生产系统绝对安全。",
  UNSAFE_WITHIN_BOUND:
    "在界内发现不一致：至少存在一条不一致路径，下方给出最短反例。",
  INCONCLUSIVE_LIMIT:
    "超出搜索界限：输入超过支持的有界搜索规模，无法判定，不得当作安全。",
  INVALID_INPUT:
    "输入非法：事件 DAG、操作依赖或策略输入不合法，未执行搜索。",
} as const;

export interface ResultInspectorProps {
  result: SearchResult;
}

export function ResultInspector({ result }: ResultInspectorProps) {
  const markers = diagnosticMarkers(result);
  const diff = snapshotDiff(result);
  const verdictExplanation = VERDICT_EXPLANATIONS[result.verdict];
  return (
    <section className="sf-inspector" aria-label="一致性诊断">
      <h2>一致性诊断</h2>
      <dl className="sf-verdict">
        <div>
          <dt>最终判定</dt>
          <dd>
            <code>{result.verdict}</code>
            <span className="sf-verdict-zh">{verdictExplanation}</span>
          </dd>
        </div>
        <div>
          <dt>场景</dt>
          <dd>
            {result.scenarioId}（{STRATEGY_LABELS[result.strategy]} · {result.strategy}）
          </dd>
        </div>
        <div>
          <dt>事件总数</dt>
          <dd>{result.eventCount} 个（含 2 个快照事件）</dd>
        </div>
        <div>
          <dt>最短反例长度</dt>
          <dd>{result.counterexampleLength}</dd>
        </div>
        <div>
          <dt>报告版本</dt>
          <dd>
            <code>{result.schemaVersion}</code>
          </dd>
        </div>
      </dl>

      <h3>诊断（{markers.length}）</h3>
      {markers.length === 0 ? (
        <p>无诊断——两份快照对应同一个完整操作边界。</p>
      ) : (
        <ul className="sf-diagnostics">
          {markers.map((marker, index) => (
            <li
              key={`${marker.code}-${index}`}
              data-testid={`diagnostic-${marker.code}`}
              className="sf-diagnostic"
              style={{ borderLeftColor: marker.color }}
            >
              <span className="sf-diagnostic-head">
                <code>{marker.code}</code>
                <span className="sf-diagnostic-label" style={{ color: marker.color }}>
                  {marker.labelZh}
                </span>
                <span className="sf-diagnostic-severity">{marker.severity}</span>
              </span>
              <span className="sf-diagnostic-explanation">{marker.explanationZh}</span>
              {marker.fileId !== undefined ? (
                <span className="sf-diagnostic-target">受影响的文件：{marker.fileId}</span>
              ) : null}
              {marker.objectId !== undefined ? (
                <span className="sf-diagnostic-target">受影响的对象：{marker.objectId}</span>
              ) : null}
              <span className="sf-diagnostic-message">{marker.message}</span>
              <details>
                <summary>展开诊断代码解释</summary>
                <p>
                  诊断代码 <code>{marker.code}</code>（严重度 {marker.severity}）：
                  {marker.explanationZh}
                  孤立对象不等于必然丢失用户数据；悬空引用表示数据库指向不存在的对象，
                  可能导致应用出现损坏记录或无法访问的文件（项目书 §4.4）。
                </p>
              </details>
            </li>
          ))}
        </ul>
      )}

      <h3>最短反例事件顺序</h3>
      {result.counterexample.length === 0 ? (
        <p>无反例（判定为安全或无法判定）。</p>
      ) : (
        <ol className="sf-counterexample-sequence">
          {result.counterexample.map((eventId, index) => (
            <li key={`${eventId}-${index}`}>
              {index + 1}. <code>{eventId}</code>
            </li>
          ))}
        </ol>
      )}

      <h3>快照差异：数据库 vs Blob</h3>
      {diff.length === 0 ? (
        <p>两份快照均为空。</p>
      ) : (
        <table className="sf-diff-table">
          <thead>
            <tr>
              <th>记录 / 对象</th>
              <th>数据库</th>
              <th>Blob</th>
              <th>状态</th>
              <th>诊断代码</th>
            </tr>
          </thead>
          <tbody>
            {diff.map((row) => (
              <tr
                key={row.key}
                data-testid={`diff-row-${row.kind}`}
                className={`sf-diff-${row.kind}`}
              >
                <td>
                  <code>{row.key}</code>
                </td>
                <td>{row.inDatabase ? "有记录" : "无记录"}</td>
                <td>{row.inBlob ? "有对象" : "无对象"}</td>
                <td>
                  <span
                    className="sf-diff-status"
                    style={{
                      color:
                        row.kind === "ok"
                          ? "#15803d"
                          : row.kind === "orphan"
                            ? "#b45309"
                            : "#dc2626",
                    }}
                  >
                    {row.status}
                  </span>
                </td>
                <td>
                  {row.codes.length > 0
                    ? row.codes.map((code) => <code key={code}>{code}</code>)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="sf-diff-legend">
        红色“悬空引用”与黄色“孤立对象”使用不同颜色与文字标签区分：悬空引用是数据库指向不存在的对象；
        孤立对象是 Blob 中存在但数据库未引用的对象。
      </p>

      <details>
        <summary>假设与局限</summary>
        <h4>假设</h4>
        <ul>
          {result.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <h4>局限</h4>
        <ul>
          {result.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
