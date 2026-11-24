# SnapFence 算法说明

权威规格：`01_project_book/PROJECT_BOOK.md` §3–§4、§8–§10；
冻结模型契约：`docs/MODEL_CONTRACT.md`（T001）。
本文件只解释算法，不改变任何冻结定义。

## 1. 状态模型

系统状态 `S = (D, B, Q)`：

- `D`：数据库引用映射，`fileId -> BlobReference { objectId, generation, digest }`。
- `B`：Blob 对象映射，`(objectId, generation) -> digest`；键的冻结格式为
  `"<objectId>@<generation>"`（`blobVersionKey()`）。
- `Q`：各逻辑操作的完成状态。

MVP 假设每个文件记录引用一个独立对象版本，不实现共享 Blob、跨文件去重或
对象引用计数。DELETE/UPDATE 蕴含其文件已预存在第 1 代（I-02）。

## 2. 操作模板（冻结）

| 操作 | 事件顺序 |
|---|---|
| 上传 UPLOAD | `BLOB_PUT -> DB_LINK` |
| 删除 DELETE | `DB_UNLINK -> BLOB_DELETE` |
| 更新 UPDATE | `BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD` |

事件 ID 格式为 `<opId>:<事件类型>`；两个快照事件为 `DB_SNAPSHOT` 与
`BLOB_SNAPSHOT`。一个逻辑操作只有在其全部事件完成后才算完成。

## 3. 备份策略（冻结）

- **DB_FIRST**：`DB_SNAPSHOT < BLOB_SNAPSHOT`。数据库快照先于 Blob 快照；
  应用写入可以在两个快照之间继续发生。
- **FILE_FIRST**：`BLOB_SNAPSHOT < DB_SNAPSHOT`。Blob 快照先于数据库快照；
  应用写入可以在两个快照之间继续发生。
- **PAUSE_WRITES**：所有已经开始的逻辑操作必须先完成；两个快照之间不允许
  出现任何数据修改事件；快照完成后才能恢复写入。

`Scenario.snapshotsAfter`（ADR-001，可选）：所列操作必须全部完成，快照事件
才进入候选集合；未指定时快照可在任意合法位置出现（全交错）。所列 opId
必须存在于 `operations` 中，否则为 `INVALID_INPUT`。

## 4. 一致性不变量（PROJECT_BOOK §4.3）

设 `D_s` 为数据库快照，`B_s` 为 Blob 快照，`D(k)`、`B(k)` 为某个合法操作
边界 `k` 的数据库与 Blob 状态。快照对一致，当且仅当存在 `k` 使得
`D_s = D(k)` 且 `B_s = B(k)`。

一个状态是合法操作边界，当且仅当每个逻辑操作要么尚未开始，要么其全部原子
事件已经完成。任何只完成部分事件的操作都属于进行中状态——即使两个快照恰好
都捕获了这个中间状态，也不能将它误判为完整应用提交状态。

在该边界上还必须满足：每个数据库引用都能找到对应 Blob 对象版本；对象版本
和 digest 必须一致；不存在未被数据库记录引用的已提交 Blob；不存在尚未完成
的逻辑操作。

**值优先规则（ADR-002）**：一致性判定以值为准——当且仅当存在 `k` 使
`(D_s, B_s) = (D(k), B(k))` 时一致。`IN_FLIGHT_OPERATION` 只作值不一致快照对
的解释性诊断；值一致的快照对零诊断，即使捕获时有操作在进行中。

## 5. BFS 有界交错搜索

生产实现：`src/core/search/bfs.ts`（`runSearch`），确定性 BFS。

- **候选集**：每步取所有依赖已满足的未执行事件，按固定事件 ID 顺序处理。
- **快照落点约束**：`snapshotsAfter` 所列操作未全部完成时，快照事件不进入
  候选集（ADR-001）。
- **终态**：两个快照事件都已执行的状态；终态不再扩展。
- **状态去重键**：已执行事件集合、当前数据库状态、当前 Blob 状态、两个快照
  捕获状态、各逻辑操作完成状态；另有保守扩展（捕获时在途操作集合），只减少
  合并、永不弱化去重正确性。
- **确定性**：不依赖随机数、系统时间或对象遍历顺序。相同输入产生完全相同的
  结果与反例。
- **边界**：最大 10 个事件（含 2 个快照事件）。输入超过支持规模时返回
  `INCONCLUSIVE_LIMIT`，永不静默降级为 SAFE。

### 5.1 诊断（PROJECT_BOOK §4.4）

| 代码 | 严重度 | 触发条件 |
|---|---|---|
| `DANGLING_REFERENCE` | CRITICAL | 数据库引用的对象版本在 Blob 快照中不存在。 |
| `ORPHAN_BLOB` | WARNING | Blob 快照存在数据库未引用的对象版本。 |
| `GENERATION_MISMATCH` | CRITICAL | 数据库引用的版本与 Blob 版本不一致。 |
| `DIGEST_MISMATCH` | CRITICAL | 对象内容摘要与数据库记录不一致。 |
| `IN_FLIGHT_OPERATION` | WARNING | 快照对应的状态包含未完成操作（仅值不一致对）。 |
| `NO_COMMON_BOUNDARY` | CRITICAL | 找不到两份快照共同对应的合法操作边界。 |

### 5.2 最短反例

BFS 按事件执行步数递增搜索，因此第一次找到的不一致路径具有最小事件长度；
多个最短路径同时存在时，按事件 ID 字典序固定排序，选择确定性结果。

**前缀口径（L-10）**：最短反例在第二个快照事件处结束，不含其后的事件。
因此 PROJECT_BOOK §9 的三个示例场景（A 孤立文件、B 悬空引用、C 删除跨快照）
的最短反例长度均为 3，而非 4。24 个 Golden 的全部 12 条 U 反例长度均为 3，
诊断码集合均为 `[IN_FLIGHT_OPERATION, NO_COMMON_BOUNDARY, ORPHAN_BLOB]`；
12 个 G 场景反例长度均为 0，零诊断。

反例输出：反例事件顺序、每个事件的输入/输出状态、数据库与 Blob 快照捕获
内容、不一致类型、第一个导致完整性失败的操作、反例长度。

### 5.3 判定

| 判定 | 含义 |
|---|---|
| `SAFE_WITHIN_BOUND` | 所有合法搜索路径均满足快照一致性（有界结论）。 |
| `UNSAFE_WITHIN_BOUND` | 至少存在一条不一致路径，并能输出最短反例。 |
| `INCONCLUSIVE_LIMIT` | 输入超过支持的有界搜索规模。 |
| `INVALID_INPUT` | 事件 DAG、操作依赖或策略输入不合法。 |

## 6. 独立 Python Oracle

Oracle（`oracle/python/`）是开发期独立参考计算器，不是产品运行时依赖。
它与生产 TypeScript BFS 不共享核心实现：

- **不同算法**：Oracle 用 DFS 枚举合法拓扑顺序，生产用 BFS；
  Oracle 不做状态去重（节点上限 200,000，超限报 `INCONCLUSIVE_LIMIT`）。
- **不同状态表示**：Oracle 用元组 Blob 键，生产用字符串键
  `"<objectId>@<generation>"`。
- **不同摘要推导**：Oracle 蕴含预存记录的 digest 推导为
  `fixture-digest-<fileId>-v1`，生产为 `fixture-digest-<fileId>-<objectId>`。
- **独立性保证**：Oracle 只读夹具的 `scenario` 键，从不读取 `expected*` 字段；
  不导入、不读取任何生产 TypeScript 模块或生产测试输出；纯 Python 标准库。
- **验收结果**：24/24 parity——判定、最短反例长度、反例事件序列、诊断码集合
  与生产 `runSearch` 及夹具期望逐项一致；12 个 UNSAFE 全部检出，12 个 SAFE
  零误报。Oracle 自身单元套件 39 个测试全绿。

## 7. 性能

搜索边界：最大 10 个事件，单场景时限 1 秒（1000 ms，PROJECT_BOOK §10 冻结）。
T012 实测（`05_tests/benchmark/performance.json`，24/24 PASS）：

- 最慢场景 G12（10 个事件）纯算法：max 8.187 ms，中位 5.609 ms。
- 最慢场景 G12 Worker 稳态往返：max 8.239 ms；首跑 13.430 ms。
- 最慢样本 8.187 ms，仅为 1000 ms 阈值的 0.82%。

计时为机器相对值（Linux 7.0.0-44-generic、AMD EPYC 9D25、4 vCPU、7934 MB、
Node v24.22.1），在其他机器上须重测。Worker 往返为 node 内
`LocalWorkerTransport` 进程内测量（非真实浏览器 Worker 线程）；真实浏览器
Worker 往返由 T010 的 Chrome CDP 证据覆盖（≤ 10 ms），与 node 内测量同量级。

S0 门禁（T007）同一算法的独立测量：24 场景纯搜索最慢 10.8 ms（G12），
同样远低于 1 秒阈值；S0 判定为 14/14 PASS。
