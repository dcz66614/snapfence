/**
 * SnapFence (P030) — standalone HTML export. T009.
 *
 * Authority: PROJECT_BOOK.md §11.2 (exported HTML must be self-contained,
 * load no remote scripts, load no remote fonts, make no network requests,
 * escape report text correctly, and never interpret report strings as
 * executable code), §8.4 / §4.4 / §4.7 (report fields, diagnostic codes,
 * verdicts), IMPLEMENTATION_PLAN.md §9.1 (frozen `exportHtml` signature
 * in src/core/model/contracts.ts: `(result: SearchResult) => string`).
 *
 * The output is a single static HTML document:
 * - no server and no build step needed — open the file directly;
 * - NO external resources: no `src` / `href` attributes at all, no
 *   `http://` / `https://` URLs anywhere, no CDN, no web fonts;
 * - NO JavaScript at all (and therefore no dependency on the React
 *   runtime or any other runtime): all styling is one inline `<style>`
 *   block, all content is static markup;
 * - every value taken from the SearchResult is passed through
 *   `escapeHtml` before interpolation, so `<`, `>`, `&`, quotes and
 *   non-ASCII / Chinese text can never break out of their text context.
 *
 * The output is deterministic: the same SearchResult always produces
 * byte-identical HTML (fixed section order, snapshot tables sorted by
 * key, diagnostics in the frozen sorted order).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only; no I/O, no network, no wall-clock.
 * - Reuses the S0-verified `SearchResult` / `Diagnostic` contracts
 *   without changing core semantics in `src/core/`.
 */

import type { SearchResult } from "../core/model/types";
import { sortDiagnostics } from "../core/search/search-result";
import type { ExportHtml } from "../core/model/contracts";

/**
 * Escape a string for safe interpolation into HTML text content or a
 * quoted attribute value. Escapes `&` first (so already-escaped input
 * cannot double-escape into a live entity), then `<`, `>`, `"` and `'`.
 * Non-ASCII text (including Chinese) is left as UTF-8 characters; the
 * document declares `<meta charset="utf-8">`.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Chinese label for a verdict literal (the literal itself is always shown). */
const VERDICT_LABEL: Record<SearchResult["verdict"], string> = {
  SAFE_WITHIN_BOUND: "有界安全",
  UNSAFE_WITHIN_BOUND: "有界不安全",
  INCONCLUSIVE_LIMIT: "超出搜索边界",
  INVALID_INPUT: "输入非法",
};

/** Chinese label for a diagnostic code (the code itself is always shown). */
const DIAGNOSTIC_LABEL: Record<string, string> = {
  DANGLING_REFERENCE: "悬空引用",
  ORPHAN_BLOB: "孤立 Blob",
  GENERATION_MISMATCH: "版本不一致",
  DIGEST_MISMATCH: "摘要不一致",
  IN_FLIGHT_OPERATION: "操作进行中",
  NO_COMMON_BOUNDARY: "无共同操作边界",
};

const INLINE_CSS = [
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:2em auto;max-width:900px;padding:0 1em;color:#1a1a1a;background:#ffffff;line-height:1.5}",
  "h1{font-size:1.5em;border-bottom:2px solid #333;padding-bottom:.3em}",
  "h2{font-size:1.2em;margin-top:1.5em;border-bottom:1px solid #ccc;padding-bottom:.2em}",
  "table{border-collapse:collapse;width:100%;margin:.5em 0}",
  "th,td{border:1px solid #999;padding:.35em .6em;text-align:left;vertical-align:top}",
  "th{background:#eee}",
  "code{font-family:ui-monospace,Menlo,Consolas,monospace}",
  ".verdict{font-size:1.2em;font-weight:bold;padding:.3em .6em;border:2px solid #333;display:inline-block}",
  ".verdict-safe{color:#145a1b;border-color:#145a1b}",
  ".verdict-unsafe{color:#8b0000;border-color:#8b0000}",
  ".verdict-other{color:#5a3d00;border-color:#5a3d00}",
  ".critical{color:#8b0000;font-weight:bold}",
  ".warning{color:#7a5a00;font-weight:bold}",
  ".empty{color:#666;font-style:italic}",
  "footer{margin-top:2em;border-top:1px solid #ccc;padding-top:.5em;color:#555;font-size:.9em}",
].join("\n");

function verdictClass(verdict: SearchResult["verdict"]): string {
  if (verdict === "SAFE_WITHIN_BOUND") return "verdict verdict-safe";
  if (verdict === "UNSAFE_WITHIN_BOUND") return "verdict verdict-unsafe";
  return "verdict verdict-other";
}

function diagnosticsSection(result: SearchResult): string {
  const diagnostics = sortDiagnostics(result.diagnostics);
  if (diagnostics.length === 0) {
    return '<p class="empty">无诊断（零诊断）。</p>';
  }
  const rows = diagnostics
    .map((diagnostic) => {
      const label = DIAGNOSTIC_LABEL[diagnostic.code] ?? diagnostic.code;
      const severityClass = diagnostic.severity === "CRITICAL" ? "critical" : "warning";
      const fileId = diagnostic.fileId !== undefined ? escapeHtml(diagnostic.fileId) : "—";
      const objectId =
        diagnostic.objectId !== undefined ? escapeHtml(diagnostic.objectId) : "—";
      return (
        "<tr>" +
        `<td><code>${escapeHtml(diagnostic.code)}</code><br>${escapeHtml(label)}</td>` +
        `<td class="${severityClass}">${escapeHtml(diagnostic.severity)}</td>` +
        `<td>${fileId}</td>` +
        `<td>${objectId}</td>` +
        `<td>${escapeHtml(diagnostic.message)}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  return (
    "<table>\n" +
    "<thead><tr><th>诊断代码</th><th>严重度</th><th>文件 ID</th><th>对象 ID</th><th>说明</th></tr></thead>\n" +
    `<tbody>\n${rows}\n</tbody>\n` +
    "</table>"
  );
}

function counterexampleSection(result: SearchResult): string {
  if (result.counterexample.length === 0) {
    return '<p class="empty">无反例（未发现不一致路径）。</p>';
  }
  const items = result.counterexample
    .map((eventId, index) => `<li>${index + 1}. <code>${escapeHtml(eventId)}</code></li>`)
    .join("\n");
  return (
    `<p>最短反例长度：<strong>${result.counterexampleLength}</strong> 个事件。</p>\n` +
    `<ol>\n${items}\n</ol>`
  );
}

function databaseSnapshotSection(result: SearchResult): string {
  const fileIds = Object.keys(result.databaseSnapshot).sort();
  if (fileIds.length === 0) {
    return '<p class="empty">数据库快照为空（无记录）。</p>';
  }
  const rows = fileIds
    .map((fileId) => {
      const reference = result.databaseSnapshot[fileId];
      return (
        "<tr>" +
        `<td><code>${escapeHtml(fileId)}</code></td>` +
        `<td><code>${escapeHtml(reference.objectId)}</code></td>` +
        `<td>${reference.generation}</td>` +
        `<td><code>${escapeHtml(reference.digest)}</code></td>` +
        "</tr>"
      );
    })
    .join("\n");
  return (
    "<table>\n" +
    "<thead><tr><th>文件 ID</th><th>对象 ID</th><th>版本</th><th>摘要</th></tr></thead>\n" +
    `<tbody>\n${rows}\n</tbody>\n` +
    "</table>"
  );
}

function blobSnapshotSection(result: SearchResult): string {
  const entries = Object.entries(result.blobSnapshot).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) {
    return '<p class="empty">Blob 快照为空（无对象）。</p>';
  }
  const rows = entries
    .map(
      ([key, digest]) =>
        "<tr>" +
        `<td><code>${escapeHtml(key)}</code></td>` +
        `<td><code>${escapeHtml(digest)}</code></td>` +
        "</tr>",
    )
    .join("\n");
  return (
    "<table>\n" +
    "<thead><tr><th>对象版本</th><th>摘要</th></tr></thead>\n" +
    `<tbody>\n${rows}\n</tbody>\n` +
    "</table>"
  );
}

function stringListSection(items: readonly string[]): string {
  if (items.length === 0) {
    return '<p class="empty">无。</p>';
  }
  return `<ul>\n${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}\n</ul>`;
}

/**
 * Render a SearchResult as a self-contained standalone HTML string.
 * No external resources, no JavaScript, no React runtime. All report
 * text is HTML-escaped. Deterministic: same input, byte-identical output.
 */
export const exportHtml: ExportHtml = (result: SearchResult): string => {
  const verdictLabel = VERDICT_LABEL[result.verdict];
  const lines: string[] = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>SnapFence 报告 — ${escapeHtml(result.scenarioId)}</title>`,
    "<style>",
    INLINE_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<h1>SnapFence 报告 — 快照栅</h1>",
    `<p>场景 ID：<code>${escapeHtml(result.scenarioId)}</code></p>`,
    `<p>备份策略：<code>${escapeHtml(result.strategy)}</code></p>`,
    `<p>报告格式：<code>snapfence.report/v1</code></p>`,
    `<p><span class="${verdictClass(result.verdict)}">${escapeHtml(result.verdict)}（${escapeHtml(verdictLabel)}）</span></p>`,
    `<p>事件总数：${result.eventCount}</p>`,
    "<h2>诊断</h2>",
    diagnosticsSection(result),
    "<h2>最短反例</h2>",
    counterexampleSection(result),
    "<h2>数据库快照</h2>",
    databaseSnapshotSection(result),
    "<h2>Blob 快照</h2>",
    blobSnapshotSection(result),
    "<h2>假设</h2>",
    stringListSection(result.assumptions),
    "<h2>局限</h2>",
    stringListSection(result.limitations),
    "<footer>",
    "<p>SAFE_WITHIN_BOUND 仅表示在本次指定的事件模板、策略、依赖关系和事件规模内，穷举搜索没有发现不一致路径；不表示真实生产系统绝对安全（项目书 §4.7、§6）。</p>",
    "<p>本报告为独立静态文件：不加载远程脚本、字体或任何外部资源，不发起网络请求。</p>",
    "</footer>",
    "</body>",
    "</html>",
    "",
  ];
  return lines.join("\n");
};
