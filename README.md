# SnapFence（快照栅）

应用级备份快照一致性模型检查器。本地运行，全部使用合成数据，不上传任何内容。

## 一句话

SnapFence 把数据库与文件/Blob 存储之间的上传、删除、更新表示为确定性事件，
枚举不同备份策略下可能发生的并发交错，判断两份独立快照是否对应同一个完整应用操作边界，
并输出最短的不一致反例。

**SnapFence 不是备份软件，也不是恢复软件。** 它回答的是备份之前的一个问题：
数据库和文件存储分别取得了备份，但这两份备份是否属于同一个逻辑状态？

## 能证明什么，不能证明什么

- 能证明：在给定的合成模型、事件模板和搜索边界内，确定性枚举合法事件交错；
  判断数据库与 Blob 快照是否对应同一个完整操作边界；识别悬空引用、孤立 Blob、
  版本与摘要不一致；找到最短的不一致事件序列；相同输入重复运行得到相同结果。
- 不能证明：真实应用的事务实现一定正确；真实备份程序一定按预期执行快照；
  真实恢复过程一定能够成功；真实数据的元数据、权限和属性一定得到保留。
- **模型检查不等于真实恢复。** `SAFE_WITHIN_BOUND` 的正确解释是：
  在本次指定的事件模板、策略与事件规模内，穷举搜索没有发现不一致路径。
  它不是“这个应用在任何真实运行条件下都不会出现备份不一致”。
- 全部数据均为合成数据，**0 真人参与**。没有经过用户调查，不宣称已验证的用户价值。

## 三种逻辑操作（事件模板，冻结）

| 操作 | 事件顺序 |
|---|---|
| 上传 UPLOAD | `BLOB_PUT -> DB_LINK` |
| 删除 DELETE | `DB_UNLINK -> BLOB_DELETE` |
| 更新 UPDATE | `BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD` |

一个逻辑操作只有在其全部事件完成后才算完成；只完成部分事件的操作属于进行中状态，
不能把中间状态当作已提交的完整应用状态。

## 三种备份策略（冻结）

| 策略 | 含义 |
|---|---|
| 数据库优先 DB_FIRST | 数据库快照先于 Blob 快照（`DB_SNAPSHOT < BLOB_SNAPSHOT`）；应用写入可以在两个快照之间继续发生。 |
| 文件优先 FILE_FIRST | Blob 快照先于数据库快照（`BLOB_SNAPSHOT < DB_SNAPSHOT`）；应用写入可以在两个快照之间继续发生。 |
| 暂停写入 PAUSE_WRITES | 所有已经开始的逻辑操作必须先完成；两个快照之间不允许出现任何数据修改事件；快照完成后才能恢复写入。 |

## 判定与诊断

搜索结果（`snapfence.report/v1`）有 4 种判定：

| 判定 | 含义 |
|---|---|
| `SAFE_WITHIN_BOUND` | 所有合法搜索路径均满足快照一致性（有界结论，见上）。 |
| `UNSAFE_WITHIN_BOUND` | 至少存在一条不一致路径，并输出最短反例。 |
| `INCONCLUSIVE_LIMIT` | 输入超过支持的有界搜索规模（永不静默降级为 SAFE）。 |
| `INVALID_INPUT` | 事件 DAG、操作依赖或策略输入不合法。 |

诊断代码（6 个，PROJECT_BOOK.md §4.4）：

| 代码 | 严重度 | 含义 |
|---|---|---|
| `DANGLING_REFERENCE` | CRITICAL | 数据库引用的对象不存在。 |
| `ORPHAN_BLOB` | WARNING | Blob 快照存在数据库未引用的对象。 |
| `GENERATION_MISMATCH` | CRITICAL | 数据库引用的版本与 Blob 版本不一致。 |
| `DIGEST_MISMATCH` | CRITICAL | 对象内容摘要与数据库记录不一致。 |
| `IN_FLIGHT_OPERATION` | WARNING | 快照对应的状态包含未完成操作（仅值不一致对的解释性诊断；值一致的快照对零诊断）。 |
| `NO_COMMON_BOUNDARY` | CRITICAL | 找不到两份快照共同对应的合法操作边界。 |

孤立 Blob 不等于必然丢失用户数据（可能是可重新导入或清理的残留数据）；
悬空引用表示数据库指向不存在的对象，可能导致损坏记录或无法访问的文件。
两者必须区分，不得把所有不一致都称为不可恢复的数据丢失。

## 性能（实测值，T012）

搜索边界：最大 **10 个事件**（含 2 个快照事件），单场景时限 **1 秒**（1000 ms，PROJECT_BOOK.md §10 冻结）。

| 指标 | 实测值 |
|---|---|
| 场景总数 | 24/24 通过（U01–U12 全部 `UNSAFE_WITHIN_BOUND`，G01–G12 全部 `SAFE_WITHIN_BOUND`） |
| 最慢场景 G12（10 个事件）纯算法 | max 8.187 ms，中位 5.609 ms |
| 最慢场景 G12 Worker 稳态往返 | max 8.239 ms |
| 最慢场景 G12 Worker 首跑 | 13.430 ms |
| 阈值余量 | 最慢样本 8.187 ms，仅为 1000 ms 阈值的 0.82% |

计时为机器相对值（Linux 7.0.0-44-generic、AMD EPYC 9D25、4 vCPU、7934 MB、Node v24.22.1），
在其他机器上须重测。完整数据见 `05_tests/benchmark/performance.json`。

正确性门禁 S0（T007）：14/14 PASS——24/24 Golden、独立 Python Oracle 24/24 一致、
最短反例可重复、外部 API 调用 0。测试总数：vitest 455 + Oracle 39 = 494，全绿。

## 运行

```sh
npm ci            # 安装依赖（版本见 package-lock.json）
npm run dev       # 开发服务器
npm run build     # 构建（tsc + vite）
npm run preview   # 本地预览构建产物
```

产品运行不需要后端、不访问互联网、不调用模型、不上传任何输入、不需要 GPU。

## 测试

```sh
npm test          # 全部 vitest 套件（455 个测试）
npm run s0:gate   # S0 核心正确性门禁（14/14 PASS）
npm run test:oracle  # 独立 Python Oracle（39 个测试；从 04_source/source 运行，
                      # 实际命令为 python3 -m unittest discover -s ../../oracle/python/tests -v）
npm run bench:10-events  # 10 事件性能基准（24/24 < 1 s；会重写 performance.json/log，
                          # 跑完须用 git checkout -- 恢复）
```

## 文档

- `docs/USER_GUIDE.md` — 用户操作指南。
- `docs/ALGORITHM.md` — 算法说明（状态模型、BFS 搜索、一致性不变量、最短反例、Oracle 独立性）。
- `docs/LIMITATIONS.md` — 已知局限（T005–T012 与 FIX-V-01 全部承载项）。
- `docs/SECURITY.md` — 安全说明（无网络、无遥测、无真实数据、漏洞报告渠道）。
- `docs/MODEL_CONTRACT.md` — 冻结的模型契约（T001）。
- `THIRD_PARTY_NOTICES.md` — 第三方依赖许可证清单。
- `../01_project_book/PROJECT_BOOK.md` — 产品与算法权威规格（v1.0.1）。
- `../02_implementation_plan/IMPLEMENTATION_PLAN.md` — 实施计划（T001–T014）。

## 许可证

MIT License。见 `LICENSE`（版权行格式参照 P029 TableFork 的 LICENSE，
`Copyright (c) 2026 TableFork Contributors`，版权主体改为 SnapFence Contributors）。
第三方依赖许可证见 `THIRD_PARTY_NOTICES.md`。
