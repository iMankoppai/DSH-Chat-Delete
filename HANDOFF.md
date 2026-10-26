# HANDOFF — DSH Chat Delete（dsh-session-cleaner）

- 更新：2026-10-26
- 当前版本：**0.9.3**（工作区干净，`git log -1` 即本版）
- 已安装：`~/.dsh/profiles/desktop` 的 `local/` 与 `node_modules/` 均为 0.9.3（已 `sync-deploy`，**要完全重启 DSH 才生效**）
- 仓库：**https://github.com/iMankoppai/DSH-Chat-Delete**（公开，`origin`）
- 上游 `jackxiao17/dsh-session-cleaner` 仅作参考（`upstream` remote，无推送权限），本仓库自 v0.8.0 起独立维护
- 交接对象：下一个接手这个插件的人/AI。先读本文件，再读 [使用手册.md](使用手册.md)；项目自身的功能说明见 [README.md](README.md)。

---

## 1. 这是什么

DeepSeek Harness（DSH）的会话清理插件：把「删除会话」做成先进回收站、可恢复、可撤销的操作，并在设置页提供整页的「会话回收站 + 已归档」管理界面。

核心能力：
- 侧栏会话 `···` 菜单「删除」→ 进回收站（目录整体 rename，原子操作）
- 设置 → 会话回收站：已归档 / 回收站两个页签；批量选择、查看对话、导出 MD/JSON、取消归档、移入回收站、恢复、彻底删除、清空
- 保留期（0/7/30/90 天）、删除后 toast「撤销」、正文搜索与匹配片段、100 条/页分页
- 删除父会话不误删 fork 分支；摘除 fork 的 `parentSession` 血缘前先把它记进回收站快照，**恢复父会话时写回**（≤48MB 日志）
- 审计日志、版本显示与「检查更新」

## 2. 代码与安装位置

| 项目 | 路径 |
| --- | --- |
| 源码仓库（唯一开发目录） | `<repo>` |
| 安装源（profile local） | `%USERPROFILE%\.dsh\profiles\desktop\local\dsh-session-cleaner` |
| 实际加载目录 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-cleaner` |
| profile 清单 | `%USERPROFILE%\.dsh\profiles\desktop\package.json` |
| 插件数据目录 | `%USERPROFILE%\.dsh\dsh-session-cleaner\` |
| 08.3 备份 | `...\local\dsh-session-cleaner.backup-0.8.3-20261022-123210` |

安装机制：profile 的 `package.json` 里
- `dependencies` 有 `"dsh-session-cleaner": "file:./local/dsh-session-cleaner"`
- `dsh.profile.bundles` 里必须有 `"dsh-session-cleaner"`

两处安装副本都是**拷贝**，不是符号链接：改完源码必须重新同步（见第 4 节）。

当前 profile bundles 还包含：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dshmarket`、`dsh-right`、`@dsh-pet/bridge`、`dsh-computer-use-native`。

## 3. 运行环境

- Windows；PowerShell 7.6.7（本机约定优先 `pwsh`）
- 系统 Node `v24.21.0`；pnpm `12.5.1`（全局）
- DSH 桌面应用 44.7.0（Electron）；宿主 dsh 版本 `0.2.1-rc.2`
- `DSH_HOME=%USERPROFILE%\.dsh`
- `desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop …` 会直接报错；只能用界面/手动文件维护

## 4. 常用命令（在仓库根目录执行）

```powershell
# 全量验证（322 项；内部会跑可靠性回归与客户端交互回归）
node scripts/verify.mjs

# 语法检查
npm run check

# 一键同步到两处安装目录（会先 node --check，再复制 lib、package.json、
# cordis.patch.yml、icon.svg、README、locale）
pwsh -File scripts\sync-deploy.ps1      # 或双击 scripts\sync-deploy.cmd

# 发版（打包 zip / 可选 git+GitHub Release；默认带代理与鉴权逻辑）
pwsh -File scripts\release.ps1 -DryRun
```

改完代码的固定流程：**改 → `node scripts/verify.mjs` → `sync-deploy` → 完全重启 DSH**。
只改 `lib/client.js` 时刷新页面即可先用；改 `lib/index.js` 必须重启（宿主半侧启动时加载）。

## 5. 代码结构

```
lib/index.js     宿主半侧：HTTP API（/session-cleaner/api）、回收站/归档/设置/导出、
                 对账与清理队列、审计日志、fork 血缘处理
lib/client.js    浏览器半侧：设置页 section、两个页签、批量选择、内联详情、
                 导出下拉、撤销 toast、分页、导航图标
cordis.patch.yml 把插件插入 profile 的 bundle 层
package.json     version / exports / dsh.bundle / dsh.client / scripts
scripts/verify.mjs           维护者验证台（mock 宿主 + 真实临时目录）
scripts/regressions.mjs      可靠性/搜索/导出/设置回归（被 verify 调用）
scripts/client-regressions.mjs 客户端设置页交互回归（被 verify 调用）
scripts/sync-deploy.ps1/.cmd 一键同步
scripts/release.ps1          发版脚本
.github/workflows/verify.yml CI
```

数据位置：
- 回收站：`~/.dsh/dsh-session-cleaner/trash/items/<id>/`，快照 `trash/meta/<id>.json`
- 设置：`~/.dsh/dsh-session-cleaner/settings.json`（`{ "retentionDays": 0|7|30|90 }`）
- 审计：`~/.dsh/dsh-session-cleaner/audit.log`（JSONL：trash/restore/purge）

## 6. 关键行为与容易踩的坑

1. **bundle 列表可能被别的安装器清空**（2026-10-24 发生过：`dsh.profile.bundles` 被重写成只剩 base/web-app，插件“消失”）。文件没丢，恢复方式：
   - `package.json` 的 bundles 补回 `dshmarket`、`dsh-session-cleaner`、`dsh-right`、`@dsh-pet/bridge`、`dsh-computer-use-native`
   - bundles 里写的是**包名**；每个包自带的 `cordis.patch.yml` 负责 `insert` 出自己的插件行。两件事不同层，同 id 不会重复。2026-10-26 实测：bundles 含 `dsh-computer-use-native` 且插件正常工作——旧版本文档写的“不要把它加进 bundles”是错的，已纠正
   - 改完重启；改动前备份 package.json
2. **启动是全有或全无**：任何一个 bundle 解析失败，DSH 起不来。加 bundle 前先确认 `node_modules/<pkg>/package.json` 存在。
3. **profile 被 Electron 独占**：不能用 CLI 装/改 desktop profile；只能改文件或用应用内插件市场。
4. **pnpm 供应链策略**：`minimumReleaseAge` 可能拦截较新的 `dshmarket`；曾临时在 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: [dshmarket]` 才装上（现已移除）。重装依赖失败时先看这里。
5. **版本号只在 `package.json`**：`lib/index.js` 直接读取它（顶层 await），改版本只改 package.json + README 更新记录。
6. **设置页导航图标是 DOM 认领**：宿主 `settings.section` 没有 `icon` 字段，插件按行文本匹配 `[role="dialog"] nav button` 并注入垃圾桶 SVG。宿主改结构时图标可能失效，但不影响功能。
7. **归档列表有 60 秒缓存**；批量操作后会失效重建，短暂看到旧数据属正常。
8. **fork 血缘改写仅处理 ≤48MB 的日志**（要整份重压缩），更大的跳过：删除时不摘、恢复时也不写回，只保留分支本身，接口如实回报。
9. **安装副本是拷贝**：直接改 `local/` 或 `node_modules/` 会在下次同步时被覆盖；只改仓库源码。
10. **正文搜索是全量串行解压**，慢起来是真的慢：2026-10-26 实测 25 个已归档会话 / 39MB 耗时 **约 8.5 秒**（前端 350ms 防抖后要盯着「正在搜索正文…」）。结果有缓存（按日志大小 + mtime 失效），重复搜同一个词很快。要提速就得把逐会话解压并行化，或给搜索加提前退出，属于可优化项而非缺陷。

## 7. 版本线与最近改动

```
feat: fork 血缘可还原 + 界面回报 (v0.9.3)   ← 提交号见 `git log -1`
29944f9 style: 行内按钮统一尺寸并调整顺序 (v0.9.2)
54a159d feat: 批量选择模式整行可点 (v0.9.1)
65b5947 feat: 0.9.0 可靠性与管理体验升级（Codex 贡献）
b6c045c feat: 批量选择模式与搜索行合并 (v0.8.3)
481b9e2 chore: 移除「恢复并打开」(v0.8.2)
96bbd18 feat: 批量勾选与恢复并打开 (v0.8.1)
2b3cd63 feat: 设置页会话回收站与归档视图 (v0.8.0)
```

0.9.0 由 Codex 完成：幂等删除/重复删除保护、整树恢复预检与断点续恢复、对账与自动清理串行化、失败重试、搜索片段/取消/缓存/解压上限/分页、撤销、保留期、MD/JSON 导出、批量进度、版本读取、更新检查、CI 与回归脚本。

0.9.3 修掉一处真缺陷：fork 的 `parentSession` 在删除时被摘掉、恢复时不写回，等于删了再恢复也会永久失去血缘。现在摘除前把原值记进 `trash/meta/<id>.json` 的 `forks` 字段，恢复时幂等写回（`forksReattached` / `forksSkipped` 如实回报）；血缘改写抽成 `patchForkLineage(mode)`，并且挪到文件搬完之后执行。恢复成功时界面也会带一句「已还原 N 个 fork 血缘」（撤销 toast 与设置页提示都有）。

## 8. 已验证 / 未验证

已验证（自动化）：
- `node scripts/verify.mjs` → **350 通过 / 0 失败**
- 覆盖：删除/恢复/彻底删除、子代理级联、fork 保留 / 血缘快照与写回（纯 JSONL 与多帧 zstd 两条路）、多轮删除→恢复、fork 已被删掉、旧快照无 `forks` 字段、撤销提示里的血缘回报、并发锁、对账、保留期、搜索片段、分页、批量失败重试、撤销接口、导出、设置读写、客户端设置页交互

已验证（真实数据，只读接口）：
- 2026-10-26 在真机 `~/.dsh` 上跑：`/archived/detail` 解析真实归档会话 → 18 轮、19 条用户消息、57 次工具调用、0 解析错误；`/session/export`（md）→ 50.6 KB，含 `## User` / `## Assistant`
- `/archived/search`（正文搜索）→ 25 个会话 / 39 MB，**约 8.5 秒**（见第 6 节第 10 条）
- 全盘血缘扫描（用插件自己的 `readSessionHeader`）：58 个会话、**0 个 subagent**、**2 个 fork**，均有一息尚存的父会话，**0 个血缘悬空**

未验证（需要真机点）：
- 0.9.0 新增界面：撤销 toast、导出下载、保留期下拉、分页按钮、正文匹配片段
- 0.9.1/0.9.2 的整行点选与行内按钮尺寸/顺序
- 0.9.3 的「已还原 N 个 fork 血缘」提示与真实删除→恢复往返
- 真实 350 项之外的多客户端并发、极端大日志（>48MB fork 不做血缘改写）
- 2026-10-26 尝试用电脑控制插件自动点界面，遇到两道坎，值得记下来免得下一个人重踩：
  1. 宿主的 CU 插件**不枚举 DSH 自己的窗口**（`cu_list_windows` 里没有），要先自己用 Win32 `EnumWindows` 拿 hwnd，再 `cu_observe(hwnd=…)` 才能拿到元素树（Chromium 的 UIA 树是可用的）
  2. 账号菜单「更多」弹层里的「设置 / 意见反馈 / 登录」**没有暴露给 UIA**，只能按坐标点；而**坐标存在约 1.02～1.03 倍的纵向缩放**——请求 y=862（截图上「设置」的位置）时光标实际落在 y≈886 的「意见反馈」上，第一次误点就是这么来的。正确姿势：先 `cu_move` 悬停、看高亮落在哪一行，再按同一个修正过的坐标点击。另外 `Ctrl+,` 这个快捷键工具发不出来（`,` 报 KEY_UNKNOWN、`Comma` 是空操作）。浏览器侧也没戏：`http://127.0.0.1:60246` 直接打开会提示 `dsh web authentication required`，令牌只在 Electron 侧
  - 结论：界面自检交给人工点，清单见 [使用手册.md](使用手册.md) 第十二节

## 9. 建议的下一步

1. 完全重启 DSH，按使用手册第十二节 8 条人工点一遍（0.9.3 只改宿主半侧，界面与 0.9.2 一致）
2. 重点验一次 fork 血缘往返：对一个有 fork 分支的会话「删除」→「恢复」，确认提示里出现「已还原 N 个 fork 血缘」，且 fork 的来源标记回来了
3. 观察保留期自动清理是否按设置执行（settings.json 与审计日志）
4. 发版：`pwsh -File scripts/release.ps1 -DryRun` 先干跑，正式发版会跑验证、打包 zip、提交打标签、推 `origin`（`iMankoppai/DSH-Chat-Delete`）并建 Release；要合并上游改动时用 `git diff upstream/main` 手动比对（`upstream` remote 指向 `jackxiao17/dsh-session-cleaner`）
5. 若宿主未来给 `settings.section` 增加 `icon` 字段，可删掉 DOM 认领逻辑
6. 想恢复“恢复并打开”可参考 `96bbd18`（后因收益低在 0.8.2 移除）

## 10. 接手检查表（新会话按顺序做）

1. `git -C "<repo>" status` / `git log -3`（应为 0.9.3）
2. `node scripts/verify.mjs`（349 全过再动代码）
3. 确认 `~/.dsh/profiles/desktop/package.json` 的 bundles 仍含 `dsh-session-cleaner`（也含 `dsh-computer-use-native`，这是对的）
4. 确认两处安装副本版本与源码一致（`package.json` 的 version）
5. 改代码 → verify → `sync-deploy` → 完全重启 DSH → 再按真机清单点
6. 出问题回滚：`git checkout <上一提交>` + `sync-deploy`；或把 0.8.3 备份目录复制回 `local/` 与 `node_modules/`
