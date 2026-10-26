import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

export async function runRegressions({ mod, makeHome, makeHost, call, ok, eq, SID, PROJ, ROOT }) {
  console.log("\n[11] 0.9.0 可靠性、搜索、导出与设置回归");
  const createChild = async (home, id) => {
    const dir = join(home, "sessions", PROJ, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.jsonl"), JSON.stringify({ type: "session", id, origin: "subagent", parentSession: SID, cwd: "F:\\work\\demo" }) + "\n");
    return dir;
  };
  {
    const { home } = await makeHome();
    const host = makeHost(home); mod.apply(host.ctx);
    const original = await readFile(join(home, "sessions", PROJ, SID, "session.jsonl"), "utf8");
    const results = await Promise.all([call(host, "POST", "/trash", { sessionId: SID }), call(host, "POST", "/trash", { sessionId: SID })]);
    ok(results.every(result => result.status === 200), "并发重复删除安全成功");
    eq(results[1].body.result.alreadyTrashed, true, "重复删除返回已在回收站");
    eq(await readFile(join(home, "dsh-session-cleaner", "trash", "items", SID, "session.jsonl"), "utf8"), original, "重复删除不覆盖已有日志");
    await call(host, "POST", "/trash/restore", { sessionId: SID });
    eq(await readFile(join(home, "sessions", PROJ, SID, "session.jsonl"), "utf8"), original, "重复删除后可完整恢复");
    ok(host.log.infos.some(line => line.endsWith("v" + mod.version)), "启动日志版本来自 package.json");
    await rm(home, { recursive: true, force: true });
  }
  {
    const { home } = await makeHome();
    const children = ["session-child-a", "session-child-b"];
    const targets = await Promise.all(children.map(id => createChild(home, id)));
    const sizes = await Promise.all([SID, ...children].map(id => stat(join(home, "sessions", PROJ, id, "session.jsonl"))));
    const host = makeHost(home); mod.apply(host.ctx);
    await call(host, "POST", "/trash", { sessionId: SID });
    const list = await call(host, "POST", "/trash/list");
    eq(list.body.result.totalBytes, sizes.reduce((sum, info) => sum + info.size, 0), "回收站占用累计整棵会话树");
    await mkdir(targets[1], { recursive: true });
    const conflict = await call(host, "POST", "/trash/restore", { sessionId: SID });
    eq(conflict.status, 409, "整树恢复在搬移前拒绝目标冲突");
    ok(!existsSync(targets[0]), "后续成员冲突时第一个成员也不搬动");
    await rm(targets[1], { recursive: true });
    // Simulate a crash after child rename but before bookkeeping finishes.
    const metaPath = join(home, "dsh-session-cleaner", "trash", "meta", SID + ".json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.stage = "restoring"; meta.restoreStarted = [children[0]];
    await writeFile(metaPath, JSON.stringify(meta));
    await rename(join(home, "dsh-session-cleaner", "trash", "items", SID, ".children", children[0]), targets[0]);
    const refusedPurge = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    eq(refusedPurge.body.result.results[0].deleted, false, "部分恢复期间禁止彻底删除");
    ok(host.schedules.some(item => item.sessionId === SID), "部分恢复期间不误清定时任务");
    const restarted = makeHost(home); mod.apply(restarted.ctx);
    const restored = await call(restarted, "POST", "/trash/restore", { sessionId: SID });
    eq(restored.status, 200, "跨重启继续部分恢复");
    for (const id of [SID, ...children]) ok(existsSync(join(home, "sessions", PROJ, id, "session.jsonl")), "恢复完成：" + id);
    ok(!existsSync(metaPath), "整树恢复完成后清除进度快照");
    await rm(home, { recursive: true, force: true });
  }
  {
    const { home } = await makeHome(); const host = makeHost(home); mod.apply(host.ctx);
    await call(host, "POST", "/trash", { sessionId: SID });
    const metaPath = join(home, "dsh-session-cleaner", "trash", "meta", SID + ".json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.stage = "prepared"; meta.deletedAt = Date.now() - 100 * 86400000;
    await rename(join(home, "dsh-session-cleaner", "trash", "items", SID), join(home, "sessions", PROJ, SID));
    await writeFile(metaPath, JSON.stringify(meta));
    const restarted = makeHost(home); mod.apply(restarted.ctx);
    await call(restarted, "POST", "/trash/list"); // No arbitrary sleep: API waits for initialization.
    ok(existsSync(join(home, "sessions", PROJ, SID, "session.jsonl")), "启动先回滚 prepared，再处理过期项");
    ok(restarted.schedules.some(item => item.sessionId === SID), "启动清理不误删已回滚会话的任务");
    ok(restarted.slots.includes(SID), "未搬走的 prepared 会话也修复侧栏记账");
    await rm(home, { recursive: true, force: true });
  }
  {
    const { home } = await makeHome(); const host = makeHost(home); mod.apply(host.ctx);
    host.global.archivedSessionIds.push(SID);
    const keyword = "好的";
    const search = await call(host, "POST", "/archived/search", { keyword });
    ok(search.body.result.matches[SID] > 0, "标题不含关键词时正文仍能命中");
    ok(search.body.result.snippets[SID].includes(keyword), "正文搜索返回匹配片段");
    const json = await call(host, "POST", "/session/export", { sessionId: SID, source: "archived", format: "json" });
    ok(JSON.parse(json.body.result.content).events.some(event => event.type === "assistant/message"), "JSON 导出保留原始事件");
    const logPath = join(home, "sessions", PROJ, SID, "session.jsonl");
    await writeFile(logPath, (await readFile(logPath, "utf8")) + JSON.stringify({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "新增缓存失效关键词 好的" }] } } }) + "\n");
    const sameKeyword = await call(host, "POST", "/archived/search", { keyword });
    ok(sameKeyword.body.result.matches[SID] > search.body.result.matches[SID], "相同关键词在日志变化后也会重新搜索");
    const fresh = await call(host, "POST", "/archived/search", { keyword: "新增缓存失效关键词" });
    ok(fresh.body.result.matches[SID] > 0, "日志变化后搜索缓存失效");
    await call(host, "POST", "/trash", { sessionId: SID });
    const md = await call(host, "POST", "/session/export", { sessionId: SID, source: "trash", format: "md" });
    ok(md.body.result.content.includes("## Assistant") && md.body.result.content.includes(keyword), "回收站可导出完整 Markdown 对话");
    const manual = await call(host, "POST", "/settings", { retentionDays: 0 }); eq(manual.status, 200, "支持仅手动清理");
    const manualList = await call(host, "POST", "/trash/list");
    eq(manualList.body.result.items[0].expiresAt, null, "手动清理时不显示清理日期");
    eq(manualList.body.result.nextPurgeAt, null, "手动清理时无下次自动清理时刻");
    const restarted = makeHost(home); mod.apply(restarted.ctx);
    eq((await call(restarted, "GET", "/settings")).body.result.retentionDays, 0, "保留期跨重启持久化");
    eq((await call(restarted, "POST", "/settings", { retentionDays: -1 })).status, 400, "拒绝非法保留期");
    await call(restarted, "POST", "/settings", { retentionDays: 7 });
    const listed = (await call(restarted, "POST", "/trash/list")).body.result;
    eq(listed.items[0].expiresAt, listed.items[0].deletedAt + 7 * 86400000, "按设置计算逐条清理日期");
    await rm(home, { recursive: true, force: true });
  }
  {
    const { home } = await makeHome();
    const plain = join(home, "bounded.jsonl"), compressed = plain + ".zstd";
    const first = '中文😀\n', second = '第二帧\n';
    await writeFile(compressed, Buffer.concat([zstdCompressSync(first), zstdCompressSync(second)]));
    const decoded = []; for await (const line of mod.readArtifactLines(compressed)) decoded.push(line);
    eq(decoded.join("\n"), '中文😀\n第二帧', "流式解压支持多帧与 Unicode");
    let bounded = false;
    try { for await (const _ of mod.readArtifactLines(compressed, { maxOutputLength: Buffer.byteLength(first) })) {} }
    catch { bounded = true; }
    ok(bounded, "多帧解压限制作用于累计总量");
    const controller = new AbortController(); controller.abort();
    let cancelled = false;
    try { for await (const _ of mod.readArtifactLines(compressed, { signal: controller.signal })) {} }
    catch { cancelled = true; }
    ok(cancelled, "过时搜索可取消流式读取");
    await rm(home, { recursive: true, force: true });
  }
  {
    // fork 血缘改写要重写整个日志：zstd 多帧格式必须仍可解析，事件不能丢。
    const { home } = await makeHome();
    const FORK = "session-fork-zstd";
    const dir = join(home, "sessions", PROJ, FORK);
    const logPath = join(dir, "session.v4.jsonl.zstd");
    await mkdir(dir, { recursive: true });
    const headerLine = JSON.stringify({ type: "session", id: FORK, cwd: "F:\\work\\demo", createdAt: 1, isSeeded: true, parentSession: SID }) + "\n";
    const bodyLine = JSON.stringify({ type: "turn/start", time: 2 }) + "\n";
    await writeFile(logPath, Buffer.concat([zstdCompressSync(headerLine), zstdCompressSync(bodyLine)]));
    const host = makeHost(home); mod.apply(host.ctx);

    const trashed = await call(host, "POST", "/trash", { sessionId: SID });
    eq(trashed.body.result.forkBranchesDetached, 1, "zstd 日志的 fork 也能摘掉血缘");
    const afterDetach = [];
    for await (const line of mod.readArtifactLines(logPath)) afterDetach.push(line);
    eq(afterDetach.length, 2, "改写后日志行数不变（事件没丢）");
    ok(!("parentSession" in JSON.parse(afterDetach[0])), "zstd 头行里的 parentSession 已移除");
    ok(afterDetach[1].includes("turn/start"), "zstd 事件行原样保留");

    const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
    eq(restored.body.result.forksReattached, 1, "zstd 日志的 fork 血缘可还原");
    const afterAttach = [];
    for await (const line of mod.readArtifactLines(logPath)) afterAttach.push(line);
    eq(JSON.parse(afterAttach[0]).parentSession, SID, "写回后头行带上原父会话");
    ok(afterAttach[1].includes("turn/start"), "写回后事件行仍在");
    await rm(home, { recursive: true, force: true });
  }
  for (const [candidate, current, expected] of [
    ["0.10.0", "0.9.9", true], ["0.8.3", "0.9.0", false], ["0.9.0", "0.9.0", false],
    ["1.0.0-rc.10", "1.0.0-rc.2", true], ["1.0.0-rc.1", "1.0.0", false], ["1.0.0", "1.0.0-rc.9", true],
    ["garbage", "0.9.0", false], ["1.0.0+build.2", "1.0.0+build.1", false]
  ]) eq(mod.isNewerVersion(candidate, current), expected, "版本比较：" + candidate + " / " + current);
  {
    const { home } = await makeHome(); const host = makeHost(home); mod.apply(host.ctx);
    await call(host, "POST", "/trash", { sessionId: SID });
    const schedules = host.ctx.get("schedule");
    const stop = schedules.stopSessionTasks, remove = schedules.delete;
    schedules.stopSessionTasks = schedules.delete = async () => { throw new Error("schedule temporarily unavailable"); };
    const partial = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    eq(partial.body.result.results[0].deleted, false, "定时任务清理失败不报告彻底删除成功");
    eq(partial.body.result.results[0].filesDeleted, true, "明确回报日志已物理删除");
    const pending = await call(host, "POST", "/trash/list");
    eq(pending.body.result.items[0].stage, "purging", "保留失败清理的重试记录");
    eq(pending.body.result.totalBytes, 0, "日志已删除后的占用不重复统计");
    schedules.stopSessionTasks = stop; schedules.delete = remove;
    const retried = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    eq(retried.body.result.results[0].deleted, true, "可重试完成剩余记录清理");
    eq((await call(host, "POST", "/trash/list")).body.result.items.length, 0, "清理完成才撤销回收站记录");
    await rm(home, { recursive: true, force: true });
  }
  {
    const { home } = await makeHome(); const host = makeHost(home); mod.apply(host.ctx);
    await call(host, "POST", "/trash", { sessionId: SID });
    const metaPath = join(home, "dsh-session-cleaner", "trash", "meta", SID + ".json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")); meta.deletedAt = 1;
    await writeFile(metaPath, JSON.stringify(meta));
    await writeFile(join(home, "dsh-session-cleaner", "settings.json"), "{broken");
    const restarted = makeHost(home); mod.apply(restarted.ctx);
    const list = await call(restarted, "POST", "/trash/list");
    eq(list.body.result.retentionDays, 0, "配置损坏时暂停自动清理");
    eq(list.body.result.items.length, 1, "配置损坏不误删过期数据");
    await rm(home, { recursive: true, force: true });
  }
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  ok(pkg.scripts.test.includes("verify.mjs"), "npm test 接入回归验证");
}
