/**
 * dsh-session-cleaner — Client half.
 *
 * 三块能力：
 *   1. 侧栏会话 `···` 菜单里的红色「删除」项 → 确认后移入回收站；
 *   2. 设置页「会话回收站」整页（Codex「已归档的聊天」同款布局）：
 *      搜索、工作区筛选、按项目分组、逐行查看 / 恢复 / 彻底删除、全部删除；
 *      导航项用 DOM 认领的方式换成垃圾桶图标（宿主不提供 icon 字段）；
 *   3. shell.overlay 确认框与会话详情弹窗（菜单关闭后仍存活，自带深浅色主题）。
 *
 * No build step: DSH loads this file as a Cordis client bundle via the
 * dsh.client declaration in package.json.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-cleaner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const NS = "session-cleaner";
    const API = "/session-cleaner/api";

    // apply(ctx) 时挂上的宿主上下文引用，供恢复后刷新侧栏、删除后清主视图用。
    let hostCtx = undefined;

    const zh = {
      "menu.delete": "删除",
      "dialog.loading": "正在读取会话信息…",
      "dialog.retention": "回收站保留 30 天，之后自动清除。",
      "trash.nextPurge": "下次自动清理 {time}",
      "dialog.cancel": "取消",
      "dialog.error": "操作失败：{message}",
      "dialog.close": "关闭",
      "toast.trashed": "会话已删除至回收站",
      "toast.trashedKeptForks": "已移入回收站；保留了 {n} 个分支会话",
      "toast.trashFailed": "移入回收站失败：{message}",
      "info.title": "会话名称",
      "info.cwd": "工作目录",
      "info.turns": "对话轮次",
      "info.userMessages": "用户消息",
      "info.toolCalls": "工具调用",
      "info.size": "大小",
      "info.lastActive": "最后活动",
      "unit.turns": "轮",
      "unit.messages": "条",
      "unit.calls": "次",
      "unit.items": "项",
      "trash.title": "会话回收站",
      "trash.count": "共 {n} 项 · 占用 {size}",
      "trash.search": "搜索标题，或勾选后搜正文内容",
      "trash.searchContent": "搜正文",
      "trash.searching": "正在搜索正文…",
      "trash.workspaceAll": "全部工作区",
      "trash.sortDeleted": "删除时间",
      "trash.sortTitle": "标题",
      "trash.sortSize": "大小",
      "trash.sortTurns": "轮次",
      "trash.restore": "恢复",
      "trash.purge": "彻底删除",
      "trash.selectAll": "全选",
      "trash.deselectAll": "全不选",
      "trash.selected": "已选 {n} 项",
      "trash.restoreSelected": "恢复所选",
      "trash.purgeSelected": "彻底删除所选",
      "trash.emptyBin": "清空回收站",
      "trash.confirmPurge": "确认彻底删除所选 {n} 项？此操作不可恢复。",
      "trash.confirmEmpty": "确认清空回收站（共 {n} 项）？此操作不可恢复。",
      "trash.confirm": "确认",
      "trash.restored": "已恢复到侧栏",
      "trash.restoredArchived": "已恢复到归档列表",
      "trash.restoredMixed": "已恢复（部分回到归档列表）",
      "trash.forksReattached": "已还原 {n} 个 fork 血缘",
      "trash.purged": "已彻底删除",
      "trash.emptyDone": "回收站已清空",
      "trash.deletedAt": "删除于",
      "trash.emptyState": "回收站是空的",
      "trash.searchHit": "{n} 处匹配",
      "trash.searchNone": "没有匹配的内容",
      "trash.restoreWarning": "恢复后原工作区可能已变化，若侧栏未出现请稍候或刷新。",
      "trash.viewLog": "查看对话记录",
      "page.search": "搜索会话",
      "page.countLine": "{n} 项 · {size}",
      "page.allDelete": "全部删除",
      "page.view": "查看",
      "page.noProject": "无项目",
      "page.count": "{n} 个会话",
      "page.empty": "回收站是空的",
      "page.loading": "加载中…",
      "page.confirmOne": "彻底删除「{title}」？此操作不可撤销。",
      "page.confirmAll": "彻底删除回收站里的全部 {n} 个会话？此操作不可撤销。",
      "page.restored": "已恢复",
      "page.purged": "已彻底删除",
      "page.restoreFailed": "恢复失败：{message}",
      "page.purgeFailed": "删除失败：{message}",
      "page.tabTrash": "回收站",
      "page.tabArchived": "已归档",
      "page.archivedSub": "已归档的会话仍在磁盘上，可取消归档或移入回收站",
      "page.archivedEmpty": "没有已归档的会话",
      "page.unarchive": "取消归档",
      "page.unarchived": "已取消归档",
      "page.failed": "操作失败：{message}",
      "page.moveToTrash": "移入回收站",
      "page.movedToTrash": "已移入回收站",
      "page.trashAll": "全部移入回收站",
      "page.trashAllWorking": "正在移入回收站…",
      "page.confirmTrashAll": "把已归档的 {n} 个会话全部移入回收站？之后可以在回收站里恢复。",
      "page.trashAllDone": "已移入回收站 {n} 个会话",
      "page.trashAllPartial": "已移入 {moved} 个，失败 {failed} 个",
      "page.checkUpdate": "检查更新",
      "page.checking": "检查中…",
      "page.batchPartial": "完成 {ok} 个，失败 {fail} 个",
      "page.batchUnarchived": "已取消归档 {n} 个",
      "page.batchMoved": "已移入回收站 {n} 个",
      "page.batchRestored": "已恢复 {n} 个",
      "page.batchPurged": "已彻底删除 {n} 个",
      "page.batchMode": "批量选择",
      "page.exitBatch": "退出批量",
      "page.upToDate": "已是最新版本",
      "page.updateAvailable": "上游有 v{latest}，可手动合并更新",
      "page.updateCheckFailed": "检查更新失败：{message}",
      "sort.asc": "升序",
      "sort.desc": "降序",
      "detail.back": "返回",
      "detail.title": "对话记录",
      "detail.questions": "提问记录（共 {n} 条）",
      "detail.turn": "第 {n} 轮",
      "detail.tools": "工具 {n} 次",
      "detail.noQuestions": "这个会话没有提问记录（可能是空白会话或子代理会话）。",
      "detail.loading": "正在读取对话记录…"
    };
    const en = {
      "menu.delete": "Delete",
      "dialog.loading": "Loading session info…",
      "dialog.retention": "The recycle bin keeps sessions for 30 days, then clears them automatically.",
      "trash.nextPurge": "next auto-purge {time}",
      "dialog.cancel": "Cancel",
      "dialog.error": "Operation failed: {message}",
      "dialog.close": "Close",
      "toast.trashed": "Session moved to recycle bin",
      "toast.trashedKeptForks": "Moved to recycle bin; kept {n} branch session(s)",
      "toast.trashFailed": "Failed to move to recycle bin: {message}",
      "info.title": "Session",
      "info.cwd": "Workspace",
      "info.turns": "Turns",
      "info.userMessages": "User messages",
      "info.toolCalls": "Tool calls",
      "info.size": "Size",
      "info.lastActive": "Last activity",
      "unit.turns": "turns",
      "unit.messages": "messages",
      "unit.calls": "calls",
      "unit.items": "items",
      "trash.title": "Recycle bin",
      "trash.count": "{n} items · {size}",
      "trash.search": "Search titles, or check the box to search content",
      "trash.searchContent": "Search content",
      "trash.searching": "Searching content…",
      "trash.workspaceAll": "All workspaces",
      "trash.sortDeleted": "Deleted time",
      "trash.sortTitle": "Title",
      "trash.sortSize": "Size",
      "trash.sortTurns": "Turns",
      "trash.restore": "Restore",
      "trash.purge": "Delete forever",
      "trash.selectAll": "Select all",
      "trash.deselectAll": "Deselect all",
      "trash.selected": "{n} selected",
      "trash.restoreSelected": "Restore selected",
      "trash.purgeSelected": "Delete selected forever",
      "trash.emptyBin": "Empty recycle bin",
      "trash.confirmPurge": "Permanently delete the selected {n} item(s)? This cannot be undone.",
      "trash.confirmEmpty": "Empty the recycle bin ({n} items)? This cannot be undone.",
      "trash.confirm": "Confirm",
      "trash.restored": "Restored to sidebar",
      "trash.restoredArchived": "Restored to the archive",
      "trash.restoredMixed": "Restored (some into the archive)",
      "trash.forksReattached": "restored lineage for {n} fork branch(es)",
      "trash.purged": "Deleted forever",
      "trash.emptyDone": "Recycle bin emptied",
      "trash.deletedAt": "Deleted",
      "trash.emptyState": "The recycle bin is empty",
      "trash.searchHit": "{n} hits",
      "trash.searchNone": "No matching content",
      "trash.restoreWarning": "The original workspace may have changed; if the session does not appear, wait or refresh.",
      "trash.viewLog": "View conversation",
      "page.search": "Search sessions",
      "page.countLine": "{n} items · {size}",
      "page.allDelete": "Delete all",
      "page.view": "View",
      "page.noProject": "No project",
      "page.count": "{n} sessions",
      "page.empty": "The recycle bin is empty",
      "page.loading": "Loading…",
      "page.confirmOne": "Permanently delete \"{title}\"? This cannot be undone.",
      "page.confirmAll": "Permanently delete all {n} sessions in the recycle bin? This cannot be undone.",
      "page.restored": "Restored",
      "page.purged": "Deleted forever",
      "page.restoreFailed": "Restore failed: {message}",
      "page.purgeFailed": "Delete failed: {message}",
      "page.tabTrash": "Recycle bin",
      "page.tabArchived": "Archived",
      "page.archivedSub": "Archived sessions stay on disk; unarchive them or move them to the recycle bin",
      "page.archivedEmpty": "No archived sessions",
      "page.unarchive": "Unarchive",
      "page.unarchived": "Unarchived",
      "page.failed": "Operation failed: {message}",
      "page.moveToTrash": "Move to recycle bin",
      "page.movedToTrash": "Moved to recycle bin",
      "page.trashAll": "Move all to recycle bin",
      "page.trashAllWorking": "Moving to the recycle bin…",
      "page.confirmTrashAll": "Move all {n} archived sessions to the recycle bin? You can restore them later.",
      "page.trashAllDone": "Moved {n} sessions to the recycle bin",
      "page.trashAllPartial": "Moved {moved}, failed {failed}",
      "page.checkUpdate": "Check for updates",
      "page.checking": "Checking…",
      "page.batchPartial": "Done {ok}, failed {fail}",
      "page.batchUnarchived": "Unarchived {n}",
      "page.batchMoved": "Moved {n} to the recycle bin",
      "page.batchRestored": "Restored {n}",
      "page.batchPurged": "Deleted {n} forever",
      "page.batchMode": "Select multiple",
      "page.exitBatch": "Exit selection",
      "page.upToDate": "Up to date",
      "page.updateAvailable": "Upstream has v{latest}; merge it manually",
      "page.updateCheckFailed": "Update check failed: {message}",
      "sort.asc": "Ascending",
      "sort.desc": "Descending",
      "detail.back": "Back",
      "detail.title": "Conversation log",
      "detail.questions": "Questions ({n})",
      "detail.turn": "Turn {n}",
      "detail.tools": "{n} tool calls",
      "detail.noQuestions": "No questions recorded (this may be a blank or subagent session).",
      "detail.loading": "Loading conversation…"
    };

    const formatBytes = (bytes) => {
      if (!Number.isFinite(bytes) || bytes < 0) return "?";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    };

    const formatTime = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      try {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch { return "—"; }
    };

    Object.assign(zh, {
      "toast.undo": "撤销", "toast.undoing": "正在恢复…",
      "page.retention": "回收站保留期", "page.days": "{n} 天", "page.manual": "仅手动清理",
      "page.retentionNote": "到期项会在下次自动清理时彻底删除。", "page.expires": "预计清理：{time}",
      "page.progress": "已处理 {done} / {total}", "page.exportMd": "导出 Markdown", "page.exportJson": "导出 JSON",
      "page.previous": "上一页", "page.next": "下一页", "page.pagination": "第 {page} / {pages} 页 · 共 {n} 项",
      "page.searchErrors": "有 {n} 个会话未能搜索，请缩小范围或检查日志。", "trash.selectAll": "全选筛选结果",
      "page.export": "导出…", "page.cleanupPending": "日志已删除，可重试清理残留", "page.restorePending": "恢复未完成，可继续恢复"
    });
    Object.assign(en, {
      "toast.undo": "Undo", "toast.undoing": "Restoring…",
      "page.retention": "Recycle bin retention", "page.days": "{n} days", "page.manual": "Manual cleanup only",
      "page.retentionNote": "Expired items are permanently deleted at the next automatic cleanup.", "page.expires": "Cleanup: {time}",
      "page.progress": "Processed {done} / {total}", "page.exportMd": "Export Markdown", "page.exportJson": "Export JSON",
      "page.previous": "Previous", "page.next": "Next", "page.pagination": "Page {page} / {pages} · {n} items",
      "page.searchErrors": "Could not search {n} sessions. Narrow the search or check their logs.", "trash.selectAll": "Select all matching",
      "page.export": "Export…", "page.cleanupPending": "Log deleted; retry to clean remaining records", "page.restorePending": "Restore interrupted; retry to continue"
    });

    const callApi = (path, payload, signal) => fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}), signal
    }).then((r) => r.json());

    const requireSuccess = (response, predicate = () => true) => {
      if (!response?.ok || !predicate(response.result)) throw new Error(response?.error || response?.result?.reason || "Operation failed");
      return response.result;
    };
    const failedResults = response => {
      const result = requireSuccess(response);
      return (result.results || []).filter(item => item.deleted !== true);
    };
    /** 「已还原 N 个 fork 血缘」的附加说明：没有就不占位。 */
    const forksNote = (result, t) => {
      const n = Number(result && result.forksReattached) || 0;
      return n > 0 ? " · " + t("trash.forksReattached").replace("{n}", String(n)) : "";
    };

    const refreshSidebar = async () => {
      try { if (hostCtx?.sessions?.refresh) await hostCtx.sessions.refresh(); } catch { /* best-effort */ }
      try { if (hostCtx?.workspaces?.refresh) await hostCtx.workspaces.refresh(); } catch { /* best-effort */ }
    };

    // ───────────────────────── 主题探测（不依赖 DSH 变量） ─────────────────────────

    function detectTheme() {
      try {
        // DSH 的主题呈现器把当前配色写在 body[data-ds-dark-theme] 上
        // （设置里 light/dark/system 三选一，只有 system 才跟随系统），
        // 属性在不在就是权威信号；先看它，避免"系统深色 + 应用内浅色"被误判。
        const body = document.body;
        if (body) {
          if (body.hasAttribute("data-ds-dark-theme")) return "dark";
          // 主题已投影（内联了 --dsw-alias-* 令牌）但属性缺席 ⇒ 明确是浅色，
          // 不必再猜；否则继续用下面的兜底判断。
          if (body.style.getPropertyValue("--dsw-alias-label-primary") !== "") return "light";
        }
      } catch { /* fall through */ }
      try {
        const color = getComputedStyle(document.body).color || "";
        const parts = color.match(/\d+(?:\.\d+)?/g);
        if (parts && parts.length >= 3) {
          const luminance = 0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2]);
          if (luminance > 160) return "dark";
          if (luminance < 96) return "light";
        }
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) return mq.matches ? "dark" : "light";
      } catch { /* fall through */ }
      return "light";
    }

    function useTheme() {
      const [theme, setTheme] = useState(() => detectTheme());
      useEffect(() => {
        const listener = () => setTheme(detectTheme());
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) {
          if (typeof mq.addEventListener === "function") mq.addEventListener("change", listener);
          else if (typeof mq.addListener === "function") mq.addListener(listener);
        }
        // 设置里手动切换主题时，DSH 只改 body 上的属性，不会触发媒体查询
        const observer = typeof MutationObserver === "function" && document.body
          ? new MutationObserver(listener)
          : null;
        if (observer) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "style"] });
        return () => {
          if (mq) {
            if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", listener);
            else if (typeof mq.removeListener === "function") mq.removeListener(listener);
          }
          if (observer) observer.disconnect();
        };
      }, []);
      return theme;
    }

    const paletteFor = (theme) => theme === "dark" ? {
      layer: "rgba(0,0,0,.55)",
      panel: "#232326",
      panelBorder: "rgba(255,255,255,.14)",
      shadow: "0 8px 28px rgba(0,0,0,.5)",
      text: "#f1f1f3",
      secondary: "#a9a9b2",
      danger: "#f0616d",
      success: "#5ad197",
      btnBorder: "rgba(255,255,255,.2)",
      rowBorder: "rgba(255,255,255,.1)",
      inputBg: "#1b1b1e",
      user: "#7ab0ff",
      model: "#5ad197",
      turn: "#b99cf5"
    } : {
      layer: "rgba(0,0,0,.4)",
      panel: "#ffffff",
      panelBorder: "rgba(0,0,0,.12)",
      shadow: "0 8px 28px rgba(0,0,0,.18)",
      text: "#1f2328",
      secondary: "#67707c",
      danger: "#d92d20",
      success: "#1a7f37",
      btnBorder: "rgba(0,0,0,.16)",
      rowBorder: "rgba(0,0,0,.08)",
      inputBg: "#ffffff",
      user: "#1a6bed",
      model: "#1a7f37",
      turn: "#7c4ddb"
    };

    /** 极简 Markdown 渲染（无构建环境，手写常用子集）：
     *  代码块/行内代码/标题/加粗/无序与有序列表/引用/链接。
     */
    function renderMarkdown(src, palette) {
      const inline = (text, keyPrefix) => {
        const nodes = [];
        const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g;
        let last = 0;
        let m;
        let n = 0;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) nodes.push(text.slice(last, m.index));
          const tok = m[0];
          if (tok.startsWith("`")) {
            nodes.push(h("code", { key: keyPrefix + "-i" + n++ }, tok.slice(1, -1)));
          } else if (tok.startsWith("**")) {
            nodes.push(h("strong", { key: keyPrefix + "-b" + n++ }, tok.slice(2, -2)));
          } else {
            const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            nodes.push(h("span", { key: keyPrefix + "-l" + n++, style: { textDecoration: "underline", wordBreak: "break-all" } }, mm[1] + "（" + mm[2] + "）"));
          }
          last = m.index + tok.length;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
      };
      const blocks = [];
      const lines = String(src).split("\n");
      const isBlockStart = (line) => /^\s*(```|#{1,4}\s|[-*]\s+|\d+[.)]\s+|>\s?)/.test(line);
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") { i++; continue; }
        if (/^\s*```/.test(line)) {
          const code = [];
          i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
          if (i < lines.length) i++;
          blocks.push(h("pre", { key: "k" + key++ }, h("code", null, code.join("\n"))));
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          blocks.push(h("div", { key: "k" + key++, style: { fontWeight: 700, fontSize: level <= 2 ? 15 : 13.5, margin: "8px 0 4px" } }, inline(heading[2], "h" + key)));
          i++;
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, "•"),
              h("span", { style: { flex: 1 } }, inline(item, "li" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, String(j + 1) + "."),
              h("span", { style: { flex: 1 } }, inline(item, "ol" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
          blocks.push(h("blockquote", { key: "k" + key++, style: { margin: "6px 0", padding: "2px 10px", borderLeft: "3px solid " + palette.rowBorder } }, inline(quote.join("\n"), "q" + key)));
          continue;
        }
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
        blocks.push(h("p", { key: "k" + key++, style: { margin: "4px 0" } }, inline(para.join("\n"), "p" + key)));
      }
      return blocks;
    }

    // ───────────────────────── 轻提示（toast）与直接移入回收站 ─────────────────────────
    // 「删除」不再有二次确认弹窗：点菜单即移入回收站（可恢复），成功/失败用
    // 顶部轻提示反馈。toast 状态走模块级 store，Toast 组件常驻 shell.overlay。

    let toastState = null; // { text, kind, at }
    const toastListeners = new Set();
    let toastTimer = null;
    const toastStore = {
      show(text, kind, action = null) {
        toastState = { text, kind, action, at: Date.now() };
        toastListeners.forEach(l => l());
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastState = null;
          toastListeners.forEach(l => l());
        }, action ? 8000 : 4000);
      },
      subscribe(listener) { toastListeners.add(listener); return () => toastListeners.delete(listener); },
      getSnapshot: () => toastState
    };
    const useToastState = () => useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

    const showUndo = (sessionId, text, t) => {
      let used = false;
      toastStore.show(text, "success", {
      label: t("toast.undo"),
      run: async () => {
        if (used) return;
        used = true;
        toastStore.show(t("toast.undoing"), "success");
        try {
          const result = requireSuccess(await callApi("/trash/restore", { sessionId }));
          await refreshSidebar();
          window.dispatchEvent(new Event("session-cleaner:changed"));
          const base = result.warning || t(result.archived ? "trash.restoredArchived" : "trash.restored");
          toastStore.show(base + (result.warning ? "" : forksNote(result, t)), result.warning ? "error" : "success");
        } catch (error) { toastStore.show(String(error.message || error), "error"); }
      }
      });
    };

    async function performTrash(sessionId, t) {
      try {
        const r = await callApi("/trash", { sessionId });
        if (r && r.ok) {
          // 若删的是当前打开的会话，清掉聊天主视图（和恢复/移动同款处理）
          try {
            const sessions = hostCtx && hostCtx.sessions;
            const snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
            if (snapshot && snapshot.current === sessionId && typeof sessions.clear === "function") sessions.clear();
          } catch { /* best-effort */ }
          const keptForks = Number(r.result && r.result.forkBranchesKept) || 0;
          if (keptForks > 0) {
            showUndo(sessionId, t("toast.trashedKeptForks").replace("{n}", String(keptForks)), t);
          } else {
            showUndo(sessionId, t("toast.trashed"), t);
          }
        } else {
          toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", (r && r.error) || "unknown"), "error");
        }
      } catch (error) {
        toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", String(error)), "error");
      }
    }

    // ───────────────────────── 样式（结构层，颜色走内联） ─────────────────────────

    const CSS = `
.scl-layer{position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center}
.scl-panel{position:relative;width:480px;max-width:92vw;max-height:82vh;overflow:auto;border-radius:10px;padding:18px 20px;font-size:13px;line-height:18px}
.scl-panelSmall{width:380px}
.scl-close{position:absolute;top:8px;right:8px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;cursor:pointer;font-size:16px;line-height:1;padding:0}
.scl-close:hover{background:rgba(127,127,127,.18)}
.scl-close:disabled{opacity:.45;cursor:default}
.scl-title{margin:0 30px 12px 0;font-size:15px;font-weight:600}
.scl-info{display:flex;flex-direction:column;gap:5px;margin:2px 0 4px}
.scl-infoRow{display:flex;gap:12px}
.scl-infoLabel{flex:0 0 66px}
.scl-infoValue{flex:1;word-break:break-all}
.scl-reminders{margin-top:12px;padding-top:10px}
.scl-warn,.scl-error{margin:5px 0 0;word-break:break-all}
.scl-ok{margin:10px 0 0}
.scl-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.scl-btn{min-width:76px;min-height:30px;padding:4px 14px;border-radius:7px;border:1px solid transparent;cursor:pointer;font-size:13px}
.scl-btn:disabled{opacity:.55;cursor:default}
.scl-footerSlot{position:relative;width:100%;display:flex}
.scl-footerBtn{flex:1 1 auto;min-width:0;min-height:36px;padding:8px 10px;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;gap:8px;justify-content:center;align-items:center;text-align:center;display:flex}
.scl-themeLight .scl-footerBtn{background:#ffffff;border:1px solid rgba(0,0,0,.12);color:#1f2328}
.scl-themeLight .scl-footerBtn:hover{background:#f1f3f5;border-color:rgba(0,0,0,.18)}
.scl-themeDark .scl-footerBtn{background:#43454a;border:1px solid rgba(255,255,255,.09);color:#f2f2f4}
.scl-themeDark .scl-footerBtn:hover{background:#353638;border-color:rgba(255,255,255,.14)}
.scl-footerBtnRail{flex:0 0 36px;width:36px;min-width:36px;min-height:36px;padding:0}
/* 侧栏收起（rail）时对齐原生「新会话」图标态：无底色，仅悬停着色 */
.scl-railOnly .scl-footerBtn{background:transparent;border:1px solid transparent}
.scl-themeLight .scl-railOnly .scl-footerBtn:hover{background:rgba(38,49,72,.06)}
.scl-themeDark .scl-railOnly .scl-footerBtn:hover{background:rgba(255,255,255,.08)}
.scl-modalWide{width:640px;max-width:94vw;max-height:82vh;overflow:auto;border-radius:10px;padding:16px 18px;font-size:13px;line-height:18px;display:flex;flex-direction:column}
.scl-modalHeader{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;padding-bottom:12px}
.scl-headLeft{flex:1;min-width:0}
.scl-headTitle{margin:0;font-size:15px;font-weight:600}
.scl-headSub{font-size:12px;margin-top:3px}
.scl-count{font-size:12px}
.scl-controls{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap;align-items:center}
.scl-input{flex:1;min-width:130px;height:28px;box-sizing:border-box;padding:0 8px;border-radius:7px;border:1px solid transparent;font-size:13px;outline:none}
.scl-select{height:28px;box-sizing:border-box;padding:0 6px;border-radius:7px;border:1px solid transparent;font-size:12px;outline:none;cursor:pointer}
.scl-check{display:flex;align-items:center;gap:4px;height:28px;font-size:12px;cursor:pointer;white-space:nowrap}
.scl-tList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;min-height:120px}
.scl-tRow{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid transparent;border-radius:8px}
.scl-tMain{flex:1;min-width:0}
.scl-tTitle{font-weight:600;word-break:break-all;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.scl-tMeta{font-size:12px;margin-top:3px;word-break:break-all}
.scl-tBadge{font-size:11px;font-weight:500;padding:1px 6px;border-radius:8px;background:rgba(127,127,127,.2)}
.scl-tBtns{display:flex;flex-direction:row;gap:6px}
.scl-miniBtn{min-width:56px;min-height:26px;padding:3px 10px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center}
.scl-miniBtn:disabled{opacity:.5;cursor:default}
.scl-batchBar{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;flex-wrap:wrap}
.scl-spacer{flex:1}
.scl-tNotice{font-size:12px;margin:0 0 8px;word-break:break-all}
.scl-notice{font-size:12px;margin:6px 0 0}
.scl-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;min-height:120px}
.scl-sortBtn{height:28px;box-sizing:border-box;min-width:28px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px}
.scl-turn{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.scl-turn:hover{background:rgba(127,127,127,.07)}
.scl-turnHead{display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap}
.scl-turnBadge{padding:1px 8px;border-radius:999px;font-weight:600;font-size:11px;background:rgba(127,127,127,.16)}
.scl-turnArrow{margin-left:auto;font-size:11px}
.scl-collapsedRow{display:flex;gap:4px;align-items:baseline;min-width:0}
.scl-fade{flex:1;min-width:0;white-space:nowrap;overflow:hidden;-webkit-mask-image:linear-gradient(to right,#000 78%,transparent);mask-image:linear-gradient(to right,#000 78%,transparent)}
.scl-md{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px}
.scl-md pre{margin:6px 0;padding:8px 10px;border-radius:6px;overflow-x:auto;background:rgba(127,127,127,.14);white-space:pre;font-size:12px;line-height:17px}
.scl-md code{font-family:Consolas,"Courier New",monospace;font-size:12px;background:rgba(127,127,127,.16);padding:0 4px;border-radius:4px}
.scl-md pre code{background:transparent;padding:0}
.scl-page{max-width:920px;margin:0 auto;padding:4px 2px 48px;font-size:13px;line-height:18px}
.scl-pageHead{display:block;margin:0 0 18px}
.scl-pageHeadText{flex:1;min-width:0}
.scl-pageTitle{margin:0 0 10px;font-size:24px;font-weight:600;letter-spacing:-.01em}
.scl-pageSub{margin-top:4px;font-size:12px}
.scl-pageMeta{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.scl-pageMetaText{min-width:0}
.scl-pageCount{font-size:16px;font-weight:600}
.scl-outlineBtn{height:32px;padding:0 14px;border-radius:8px;cursor:pointer;font-size:13px;background:transparent;white-space:nowrap}
.scl-outlineBtn:disabled{opacity:.5;cursor:default}
.scl-dangerBtn{height:34px;padding:0 14px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap}
.scl-dangerBtn:disabled{opacity:.5;cursor:default}
.scl-pageTools{display:flex;gap:10px;margin:0 0 18px;flex-wrap:nowrap;align-items:center}
.scl-batch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.scl-batchActions{display:flex;align-items:center;gap:8px}
.scl-rowBtn{height:28px;min-width:72px;padding:0 10px;border:1px solid transparent;border-radius:7px;background:transparent;font-size:12px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
select.scl-rowBtn{padding:0 6px;appearance:auto}
.scl-rowBtn:disabled{opacity:.5;cursor:default}
.scl-searchBox{flex:1 1 auto;min-width:140px;height:34px;display:flex;align-items:center;gap:8px;padding:0 12px;border-radius:10px;box-sizing:border-box}
.scl-searchInput{flex:1;min-width:0;border:0;outline:none;background:transparent;font-size:13px}
.scl-pageSelect{flex:0 0 auto;width:auto;max-width:200px;min-width:120px;height:34px;padding:0 10px;border-radius:10px;font-size:13px;outline:none;cursor:pointer;box-sizing:border-box}
.scl-pageNotice{font-size:12px;margin:0 0 10px;word-break:break-all}
.scl-pageGroup{margin:0 0 20px}
.scl-pageGroupHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px}
.scl-pageGroupName{font-weight:600;display:flex;align-items:center;gap:6px;min-width:0;word-break:break-all}
.scl-pageGroupCount{font-size:12px;white-space:nowrap}
.scl-pageList{border:1px solid transparent;border-radius:12px;overflow:hidden}
.scl-pageRow{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid transparent}
.scl-pageRow:last-child{border-bottom:0}
.scl-pageRow:hover{background:rgba(127,127,127,.06)}
.scl-pageRowMain{flex:1;min-width:0}
.scl-pageRowTitle{font-weight:600;font-size:14px;word-break:break-all}
.scl-pageRowMeta{font-size:12px;margin-top:4px}
.scl-pageRowActions{display:flex;align-items:center;gap:8px}
.scl-iconBtn{width:30px;height:30px;border:0;border-radius:8px;background:transparent;cursor:pointer;font-size:14px;line-height:1}
.scl-iconBtn:hover{background:rgba(127,127,127,.16)}
.scl-iconBtn:disabled{opacity:.45;cursor:default}
.scl-restoreBtn{height:28px;padding:0 14px;border:0;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500}
.scl-restoreBtn:disabled{opacity:.5;cursor:default}
.scl-pageEmpty{padding:64px 0;text-align:center}
.scl-inlineDetail{padding:12px 16px;border-top:1px solid transparent;max-height:420px;overflow:auto;font-size:12px}
.scl-inlineHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.scl-inlineTurn{margin:0 0 10px}
.scl-inlineQ{font-weight:600;white-space:pre-wrap;word-break:break-word}
.scl-inlineA{margin-top:4px;white-space:pre-wrap;word-break:break-word;line-height:18px}
.scl-pageFoot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:18px 0 0;padding-top:12px;border-top:1px solid rgba(127,127,127,.14);font-size:12px}
.scl-linkBtn{border:0;background:transparent;cursor:pointer;font-size:12px;padding:0}
.scl-linkBtn:disabled{opacity:.5;cursor:default}
.scl-tabs{display:flex;gap:24px;border-bottom:1px solid rgba(127,127,127,.18);margin:0 0 16px}
.scl-tab{height:38px;padding:0 2px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;cursor:pointer;font-size:14px}
`;

    function injectStyle() {
      try {
        if (document.getElementById("dsh-session-cleaner-style")) return () => {};
        const tag = document.createElement("style");
        tag.id = "dsh-session-cleaner-style";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { try { tag.remove(); } catch { /* ignore */ } };
      } catch { return () => {}; }
    }

    // ───────────────────────── ··· 菜单里的删除项 ─────────────────────────

    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, t } = props;
      if (typeof P.MenuItemButton !== "function" || !P.IconTrashOutlineRegular) return null;
      try {
        const [, setMenuOpen] = useMenuOpenState();
        return h(P.MenuItemButton, {
          danger: true, // 原生红色菜单项样式：字号/颜色与官方条目完全一致
          icon: h(P.IconTrashOutlineRegular, {}),
          onSelect: () => {
            try { setMenuOpen(false); } catch { /* menu already closing */ }
            performTrash(sessionId, t);
          },
          children: t("menu.delete")
        });
      } catch { return null; }
    }

    // 顶部轻提示：移入回收站的成败反馈（自动消失）
    function TrashToast() {
      const theme = useTheme();
      const palette = paletteFor(theme);
      const toast = useToastState();
      if (!toast) return null;
      return h("div", {
        style: {
          position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 11100,
          background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow,
          color: palette.text, borderRadius: 8, padding: "8px 16px", fontSize: 13,
          display: "flex", alignItems: "center", gap: 8
        },
        role: "status"
      },
        h("span", { style: { color: toast.kind === "error" ? palette.danger : palette.success, fontWeight: 600 } }, toast.kind === "error" ? "✕" : "✓"),
        h("span", null, toast.text),
        toast.action ? h("button", { type: "button", className: "scl-linkBtn", style: { color: palette.text }, onClick: toast.action.run }, toast.action.label) : null
      );
    }

    // ───────────────────────── 回收站面板（会话详情用） ─────────────────────────

    // 回收站弹窗开关：模块级 store。设置页「查看」按钮调 openTrashUi(id) 打开
    // 弹窗并直接落到该会话的详情；弹窗本体渲染在 shell.overlay 里。
    let trashUiOpen = false;
    let pendingDetailId = null;
    let pendingDetailSource = "trash";
    const trashUiListeners = new Set();
    const trashUiStore = {
      subscribe(listener) { trashUiListeners.add(listener); return () => trashUiListeners.delete(listener); },
      getSnapshot: () => trashUiOpen,
      open(detailId, source) {
        pendingDetailId = typeof detailId === "string" ? detailId : null;
        pendingDetailSource = source === "archived" ? "archived" : "trash";
        if (!trashUiOpen) { trashUiOpen = true; trashUiListeners.forEach(l => l()); }
      },
      close() { if (trashUiOpen) { trashUiOpen = false; trashUiListeners.forEach(l => l()); } },
      takeDetail() {
        const request = pendingDetailId === null ? null : { id: pendingDetailId, source: pendingDetailSource };
        pendingDetailId = null;
        return request;
      }
    };
    const useTrashUiOpen = () => useSyncExternalStore(trashUiStore.subscribe, trashUiStore.getSnapshot, trashUiStore.getSnapshot);
    const openTrashUi = (detailId, source) => trashUiStore.open(detailId, source);
    const closeTrashUi = () => trashUiStore.close();
    const takeTrashDetailRequest = () => trashUiStore.takeDetail();

    // 面板渲染的错误边界：面板内部出错时只收起弹窗，不拖垮整个界面
    class SclErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.error("session-cleaner:", error); } catch { /* ignore */ } }
      render() { return this.state.failed ? null : this.props.children; }
    }

    function RecycleBinOverlay({ useTrashUiOpen, closeTrashUi, t, takeDetailRequest }) {
      const open = useTrashUiOpen();
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [items, setItems] = useState(null);
      const [totalBytes, setTotalBytes] = useState(0);
      const [nextPurgeAt, setNextPurgeAt] = useState(null);
      const [keyword, setKeyword] = useState("");
      const [searchContent, setSearchContent] = useState(false);
      const [contentMatches, setContentMatches] = useState(null);
      const [searching, setSearching] = useState(false);
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [sortKey, setSortKey] = useState("deletedAt");
      const [sortAsc, setSortAsc] = useState(false);
      const [checked, setChecked] = useState(() => new Set());
      const [notice, setNotice] = useState("");
      const [errorText, setErrorText] = useState("");
      const [busy, setBusy] = useState(false);
      const [confirmState, setConfirmState] = useState(null); // {message, run}
      const [detail, setDetail] = useState(null); // null | {loading,id} | {loading:false,.../trash/detail 结果}
      const [expandedTurns, setExpandedTurns] = useState(() => new Set()); // 默认全部折叠
      const busyRef = useRef(false);
      busyRef.current = busy;
      const detailRef = useRef(null);
      detailRef.current = detail;

      useEffect(() => {
        if (!open) return;
        const handler = (event) => {
          if (event.key !== "Escape" || busyRef.current) return;
          event.preventDefault();
          if (detailRef.current) setDetail(null); // 详情页 Esc 先返回列表
          else closeTrashUi();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);

      useEffect(() => {
        // 弹窗常驻（关闭只是返回 null），列表必须每次打开时重新拉取，
        // 否则删除后新进回收站的会话要重启 DSH 才能看到
        if (!open) return;
        let cancelled = false;
        callApi("/trash/list").then((r) => {
          if (cancelled) return;
          if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); setNextPurgeAt(r.result.nextPurgeAt); }
          else setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "list failed"));
        }).catch((error) => { if (!cancelled) setErrorText(t("dialog.error").replace("{message}", String(error))); });
        return () => { cancelled = true; };
      }, [open]);

      // 设置页「查看」直接把弹窗落到指定会话的详情（openDetail 在本函数尾部定义，
      // 副作用在渲染完成后才执行，此时已初始化）。
      useEffect(() => {
        if (!open) return;
        const requested = typeof takeDetailRequest === "function" ? takeDetailRequest() : undefined;
        if (requested && requested.id) void openDetail(requested.id, requested.source);
      }, [open]);

      useEffect(() => {
        if (!notice) return;
        const id = setTimeout(() => setNotice(""), 3000);
        return () => clearTimeout(id);
      }, [notice]);

      const refreshList = async () => {
        const r = await callApi("/trash/list");
        if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); setNextPurgeAt(r.result.nextPurgeAt); }
        setChecked(new Set());
      };

      const workspaces = useMemo(() => {
        const set = new Map();
        for (const item of (items || [])) {
          if (typeof item.cwd === "string" && item.cwd !== "" && !set.has(item.cwd)) set.set(item.cwd, item.cwd);
        }
        return [...set.values()];
      }, [items]);

      const visibleItems = useMemo(() => {
        let list = items || [];
        if (workspaceFilter) list = list.filter(item => item.cwd === workspaceFilter);
        if (contentMatches !== null) {
          list = list.filter(item => contentMatches[item.id] !== undefined);
        } else if (keyword.trim() !== "") {
          const needle = keyword.trim().toLowerCase();
          list = list.filter(item =>
            (typeof item.title === "string" && item.title.toLowerCase().includes(needle)) ||
            (typeof item.cwd === "string" && item.cwd.toLowerCase().includes(needle)));
        }
        const direction = sortAsc ? 1 : -1;
        return [...list].sort((a, b) => {
          if (sortKey === "title") return String(a.title || "").localeCompare(String(b.title || "")) * direction;
          const va = Number(a[sortKey]) || 0;
          const vb = Number(b[sortKey]) || 0;
          return (va - vb) * direction;
        });
      }, [items, workspaceFilter, keyword, contentMatches, sortKey, sortAsc]);

      // 勾选「搜正文」后，输入关键词自动防抖搜索（不再需要额外按钮）
      useEffect(() => {
        if (!searchContent) { setContentMatches(null); return; }
        const kw = keyword.trim();
        if (kw === "") { setContentMatches(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          setSearching(true);
          callApi("/trash/search", { keyword: kw }).then((r) => {
            if (!cancelled && r && r.ok) setContentMatches(r.result.matches || {});
          }).catch(() => { /* 静默：保留上一次结果 */ }).finally(() => {
            if (!cancelled) setSearching(false);
          });
        }, 350);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [keyword, searchContent]);

      const doRestore = async (ids) => {
        // 兼容单条（字符串）与批量（数组）两种入参；接口只收单个 sessionId
        const list = Array.isArray(ids) ? ids : [ids];
        setBusy(true);
        setErrorText("");
        let restoredCount = 0;
        // 删除前处于归档状态的会话，恢复后回到归档列表（不回到侧栏），提示要说准
        let archivedCount = 0;
        let forksRestored = 0;
        try {
          for (const id of list) {
            const r = await callApi("/trash/restore", { sessionId: id });
            if (r && r.ok) {
              restoredCount++;
              if (r.result && r.result.archived === true) archivedCount++;
              forksRestored += Number(r.result && r.result.forksReattached) || 0;
            } else {
              setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "restore failed"));
              break;
            }
          }
          if (restoredCount > 0) {
            const what = archivedCount === restoredCount ? t("trash.restoredArchived")
              : archivedCount > 0 ? t("trash.restoredMixed")
              : t("trash.restored");
            setNotice(what + (restoredCount > 1 ? " ×" + restoredCount : "") + forksNote({ forksReattached: forksRestored }, t));
            await refreshList();
            await refreshSidebar();
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doPurge = async (ids) => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/delete", { sessionIds: ids });
          if (r && r.ok) {
            const failures = failedResults(r);
            setNotice(failures.length ? t("page.batchPartial").replace("{ok}", String(ids.length - failures.length)).replace("{fail}", String(failures.length)) : t("trash.purged"));
            if (failures.length) setErrorText(failures.map(item => item.error || item.reason).join("；"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "purge failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doEmpty = async () => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/empty");
          if (r && r.ok) {
            const failures = failedResults(r);
            setNotice(failures.length ? t("page.batchPartial").replace("{ok}", String(r.result.results.length - failures.length)).replace("{fail}", String(failures.length)) : t("trash.emptyDone"));
            if (failures.length) setErrorText(failures.map(item => item.error || item.reason).join("；"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "empty failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const toggleChecked = (id) => {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const openDetail = async (id, source = "trash") => {
        setDetail({ loading: true, id });
        setExpandedTurns(new Set()); // 每次打开默认全部折叠
        try {
          const r = await callApi(source === "archived" ? "/archived/detail" : "/trash/detail", { sessionId: id });
          if (r && r.ok) setDetail({ loading: false, ...r.result });
          else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "detail failed"));
            setDetail(null);
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
          setDetail(null);
        }
      };

      const toggleSelectAllVisible = () => setChecked(visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? new Set() : new Set(visibleItems.map(i => i.id)));

      const themeInput = { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder };

      if (!open) return null;

      if (detail) {
        const d = detail;
        return h("div", {
          className: "scl-layer",
          style: { background: palette.layer },
          role: "presentation",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) setDetail(null);
          }
        },
          h("section", {
            className: "scl-panel scl-modalWide",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "scl-detail-title"
          },
            h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
              h("button", {
                type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text, flex: "0 0 auto" },
                disabled: busy, onClick: () => setDetail(null)
              }, "← " + t("detail.back")),
              h("div", { className: "scl-headLeft" },
                h("h2", { id: "scl-detail-title", className: "scl-headTitle", style: { color: palette.text } }, t("detail.title")),
                h("div", { className: "scl-headSub", style: { color: palette.secondary } }, d.title || d.id)
              ),
              h("button", {
                type: "button", className: "scl-close", style: { color: palette.secondary },
                "aria-label": t("dialog.close"), title: t("dialog.close"),
                onClick: closeTrashUi
              }, "\u00d7")
            ),
            d.loading
              ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.loading"))
              : [
                  h("div", { key: "info", className: "scl-info", style: { margin: "0 0 10px" } },
                    [
                      typeof d.cwd === "string" && d.cwd ? ["info.cwd", d.cwd] : null,
                      Number.isFinite(d.turns) ? ["info.turns", d.turns + " " + t("unit.turns")] : null,
                      Number.isFinite(d.userMessages) ? ["info.userMessages", d.userMessages + " " + t("unit.messages")] : null,
                      Number.isFinite(d.toolCalls) ? ["info.toolCalls", d.toolCalls + " " + t("unit.calls")] : null,
                      ["info.size", formatBytes(d.bytes)],
                      Number.isFinite(d.deletedAt) ? ["trash.deletedAt", formatTime(d.deletedAt)] : null
                    ].filter(Boolean).map(([labelKey, value]) => h("div", { className: "scl-infoRow", key: labelKey },
                      h("span", { className: "scl-infoLabel", style: { color: palette.secondary } }, t(labelKey)),
                      h("span", { className: "scl-infoValue", style: { color: palette.text } }, value)
                    ))
                  ),
                  d.parseError ? h("div", { key: "perr", className: "scl-tNotice", style: { color: palette.danger } }, t("dialog.error").replace("{message}", d.parseError)) : null,
                  h("div", { key: "qhead", style: { color: palette.text, fontWeight: 600, margin: "0 0 6px" } }, t("detail.questions").replace("{n}", String((d.questions || []).length))),
                  h("div", { key: "qlist", className: "scl-tList" },
                    (d.questions || []).length === 0
                      ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.noQuestions"))
                      : d.questions.map((q, i) => {
                          const expanded = expandedTurns.has(i);
                          return h("div", {
                            className: "scl-turn", key: i,
                            style: { borderColor: palette.rowBorder },
                            onClick: () => setExpandedTurns((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i); else next.add(i);
                              return next;
                            })
                          },
                            h("div", { className: "scl-turnHead" },
                              h("span", { className: "scl-turnBadge", style: { color: palette.turn } }, t("detail.turn").replace("{n}", String(q.turn ?? i + 1))),
                              h("span", { style: { color: palette.secondary } }, formatTime(q.time)),
                              h("span", { style: { color: palette.secondary } }, t("detail.tools").replace("{n}", String(q.toolCalls || 0))),
                              h("span", { className: "scl-turnArrow", style: { color: palette.secondary } }, expanded ? "▾" : "▸")
                            ),
                            expanded
                              ? [
                                  h("div", { key: "q", className: "scl-md", style: { color: palette.user } }, q.question || "（无文本内容）"),
                                  q.assistantReply ? h("div", { key: "a", className: "scl-md", style: { color: palette.model } }, renderMarkdown(q.assistantReply, palette)) : null
                                ]
                              : h("div", { className: "scl-collapsedRow" },
                                  h("span", { className: "scl-fade", style: { color: palette.user } }, q.question || "（无文本内容）")
                                )
                          );
                        })
                  )
                ]
          )
        );
      }

      return h("div", {
        className: "scl-layer",
        style: { background: palette.layer },
        role: "presentation",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !busy) closeTrashUi();
        }
      },
        h("section", {
          className: "scl-panel scl-modalWide",
          style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "scl-trash-title"
        },
        h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
          h("div", { className: "scl-headLeft" },
            h("h2", { id: "scl-trash-title", className: "scl-headTitle", style: { color: palette.text } }, t("trash.title")),
            items ? h("div", { className: "scl-headSub", style: { color: palette.secondary } },
              t("trash.count").replace("{n}", String(visibleItems.length)).replace("{size}", formatBytes(totalBytes))
                + " · " + t("dialog.retention")
                + (typeof nextPurgeAt === "number" && Number.isFinite(nextPurgeAt)
                  ? " · " + t("trash.nextPurge").replace("{time}", formatTime(nextPurgeAt))
                  : "")) : null
          ),
          h("button", {
            type: "button", className: "scl-close", style: { color: palette.secondary },
            "aria-label": t("dialog.close"), title: t("dialog.close"),
            disabled: busy, onClick: () => { if (!busy) closeTrashUi(); }
          }, "\u00d7")
        ),
        h("div", { className: "scl-controls" },
          h("input", {
            className: "scl-input", style: themeInput, type: "text",
            placeholder: t("trash.search"), value: keyword,
            onChange: (e) => { setKeyword(e.target.value); if (contentMatches !== null) setContentMatches(null); }
          }),
          h("label", { className: "scl-check", style: { color: palette.secondary } },
            h("input", {
              type: "checkbox", checked: searchContent,
              onChange: (e) => { setSearchContent(e.target.checked); if (!e.target.checked) setContentMatches(null); }
            }),
            t("trash.searchContent")
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: workspaceFilter,
            onChange: (e) => setWorkspaceFilter(e.target.value)
          },
            h("option", { value: "" }, t("trash.workspaceAll")),
            workspaces.map((cwd) => h("option", { key: cwd, value: cwd }, cwd))
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: sortKey,
            onChange: (e) => setSortKey(e.target.value)
          },
            h("option", { value: "deletedAt" }, t("trash.sortDeleted")),
            h("option", { value: "title" }, t("trash.sortTitle")),
            h("option", { value: "bytes" }, t("trash.sortSize")),
            h("option", { value: "turns" }, t("trash.sortTurns"))
          ),
          h("button", {
            type: "button", className: "scl-sortBtn", style: { ...themeInput, color: palette.text },
            title: sortAsc ? t("sort.asc") : t("sort.desc"), onClick: () => setSortAsc(!sortAsc)
          }, sortAsc ? "↑" : "↓")
        ),
        notice ? h("div", { className: "scl-tNotice", style: { color: palette.success } }, notice) : null,
        errorText ? h("div", { className: "scl-tNotice", style: { color: palette.danger } }, errorText) : null,
        items === null
          ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("dialog.loading"))
          : h("div", { className: "scl-tList" },
              visibleItems.length === 0
                ? h("div", { className: "scl-empty", style: { color: palette.secondary } },
                    searching ? t("trash.searching")
                      : contentMatches !== null && keyword.trim() !== "" ? t("trash.searchNone")
                        : t("trash.emptyState"))
                : visibleItems.map((item) => {
                    const hits = contentMatches ? contentMatches[item.id] : undefined;
                    const metaBits = [];
                    if (typeof item.cwd === "string" && item.cwd) metaBits.push(item.cwd);
                    if (Number.isFinite(item.turns)) metaBits.push(item.turns + " " + t("unit.turns"));
                    if (Number.isFinite(item.bytes)) metaBits.push(formatBytes(item.bytes));
                    if (Number.isFinite(item.deletedAt)) metaBits.push(t("trash.deletedAt") + " " + formatTime(item.deletedAt));
                    return h("div", { className: "scl-tRow", key: item.id, style: { borderColor: palette.rowBorder } },
                      h("input", {
                        type: "checkbox", checked: checked.has(item.id),
                        onChange: () => toggleChecked(item.id)
                      }),
                      h("div", { className: "scl-tMain" },
                        h("div", { className: "scl-tTitle", style: { color: palette.text } },
                          item.title || item.id,
                          hits !== undefined ? h("span", { className: "scl-tBadge", style: { color: palette.secondary } }, t("trash.searchHit").replace("{n}", String(hits))) : null
                        ),
                        metaBits.length ? h("div", { className: "scl-tMeta", style: { color: palette.secondary } }, metaBits.join(" · ")) : null
                      ),
                      h("div", { className: "scl-tBtns" },
                        h("button", {
                          type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
                          disabled: busy, onClick: () => openDetail(item.id)
                        }, t("trash.viewLog"))
                      )
                    );
                  })
            ),
        h("div", { className: "scl-batchBar", style: { borderTop: "1px solid " + palette.panelBorder } },
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: !items || visibleItems.length === 0,
            onClick: toggleSelectAllVisible
          }, visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? t("trash.deselectAll") : t("trash.selectAll")),
          checked.size > 0 ? h("span", { className: "scl-tNotice", style: { color: palette.secondary, margin: 0 } }, t("trash.selected").replace("{n}", String(checked.size))) : null,
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: busy || checked.size === 0,
            onClick: () => doRestore([...checked])
          }, t("trash.restoreSelected")),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || checked.size === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmPurge").replace("{n}", String(checked.size)), run: () => doPurge([...checked]) })
          }, t("trash.purgeSelected")),
          h("div", { className: "scl-spacer" }),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || !items || items.length === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmEmpty").replace("{n}", String(items.length)), run: doEmpty })
          }, t("trash.emptyBin"))
        )
        ),
        confirmState ? h("div", {
          className: "scl-layer", style: { background: palette.layer, zIndex: 11050 },
          role: "presentation",
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setConfirmState(null); }
        },
          h("section", {
            className: "scl-panel scl-panelSmall",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog", "aria-modal": "true"
          },
            h("div", { style: { color: palette.text } }, confirmState.message),
            h("div", { className: "scl-footer" },
              h("button", {
                type: "button", className: "scl-btn",
                style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
                disabled: busy,
                onClick: () => setConfirmState(null)
              }, t("dialog.cancel")),
              h("button", {
                type: "button", className: "scl-btn scl-btnDanger",
                style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
                disabled: busy,
                onClick: () => { const run = confirmState.run; setConfirmState(null); run(); }
              }, t("trash.confirm"))
            )
          )
        ) : null
      );
    }

    // ───────────────────────── 设置页 · 会话回收站 ─────────────────────────
    // 与 Codex「已归档的聊天」同款整页布局：大标题 + 全部删除、搜索、工作区
    // 筛选、按项目分组，每行「恢复 / 彻底删除」。数据与弹窗共用同一套 API。

    function TrashSettingsSection({ t, openTrashUi }) {
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [items, setItems] = useState(null);
      const [totalBytes, setTotalBytes] = useState(0);
      const [tab, setTab] = useState("archived");
      const [archivedItems, setArchivedItems] = useState(null);
      const [archivedTotal, setArchivedTotal] = useState(0);
      const [keyword, setKeyword] = useState("");
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [sortKey, setSortKey] = useState("lastTime");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");
      const [errorText, setErrorText] = useState("");
      const [confirmState, setConfirmState] = useState(null);
      const [inlineDetail, setInlineDetail] = useState(null);
      const [expandedTurns, setExpandedTurns] = useState(() => new Set());
      const [checked, setChecked] = useState(() => new Set());
      const [selectionMode, setSelectionMode] = useState(false);
      const [searchContent, setSearchContent] = useState(false);
      const [contentMatches, setContentMatches] = useState(null);
      const [searching, setSearching] = useState(false);
      const [retentionDays, setRetentionDays] = useState(30);
      const [progress, setProgress] = useState(null);
      const [page, setPage] = useState(0);
      const [version, setVersion] = useState("");
      const [updateState, setUpdateState] = useState(null);
      const busyRef = useRef(false);
      busyRef.current = busy;

      useEffect(() => {
        let cancelled = false;
        fetch(API + "/version").then((r) => r.json()).then((r) => {
          if (!cancelled && r && r.ok && r.result && typeof r.result.version === "string") setVersion(r.result.version);
        }).catch(() => {});
        return () => { cancelled = true; };
      }, []);

      const load = async () => {
        try {
          const r = await callApi("/trash/list");
          if (r && r.ok) {
            setItems(r.result.items || []);
            setRetentionDays(r.result.retentionDays ?? 30);
            setTotalBytes(r.result.totalBytes || 0);
          } else {
            setItems([]);
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "list failed"));
          }
        } catch (error) {
          setItems([]);
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        }
      };

      const loadArchived = async () => {
        try {
          const r = await callApi("/archived/list");
          if (r && r.ok) {
            setArchivedItems(r.result.items || []);
            setArchivedTotal(r.result.totalBytes || 0);
          } else {
            setArchivedItems([]);
            setErrorText(t("page.failed").replace("{message}", (r && r.error) || "list failed"));
          }
        } catch (error) {
          setArchivedItems([]);
          setErrorText(t("page.failed").replace("{message}", String(error)));
        }
      };
      useEffect(() => {
        if (tab === "trash" && items === null) void load();
        if (tab === "archived" && archivedItems === null) void loadArchived();
      }, [tab, items === null, archivedItems === null]);

      useEffect(() => {
        const refresh = () => { setItems(null); setArchivedItems(null); };
        window.addEventListener("session-cleaner:changed", refresh);
        return () => window.removeEventListener("session-cleaner:changed", refresh);
      }, []);
      useEffect(() => {
        setContentMatches(null); setSearching(false);
        const needle = keyword.trim();
        if (!searchContent || !needle) return;
        const controller = new AbortController();
        const query = tab + "\0" + needle.toLowerCase();
        const timer = setTimeout(() => {
          setSearching(true);
          callApi(tab === "archived" ? "/archived/search" : "/trash/search", { keyword: needle }, controller.signal).then(r => {
            const result = requireSuccess(r);
            if (!controller.signal.aborted) {
              setContentMatches({ query, matches: result.matches || {}, snippets: result.snippets || {} });
              if (result.errors?.length) setErrorText(t("page.searchErrors").replace("{n}", String(result.errors.length)));
            }
          }).catch(error => {
            if (!controller.signal.aborted) setErrorText(String(error.message || error));
          }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
        }, 350);
        return () => { controller.abort(); clearTimeout(timer); };
      }, [tab, searchContent, keyword, items, archivedItems]);
      useEffect(() => { setPage(0); }, [tab, keyword, workspaceFilter, sortKey, searchContent]);

      const switchTab = (next) => {
        if (busyRef.current) return;
        setTab(next);
        setProgress(null);
        setSortKey(next === "trash" ? "deletedAt" : "lastTime");
        setWorkspaceFilter("");
        setChecked(new Set());
        setSelectionMode(false);
      };
      useEffect(() => {
        if (!notice) return;
        const id = setTimeout(() => setNotice(""), 3000);
        return () => clearTimeout(id);
      }, [notice]);
      useEffect(() => {
        if (!confirmState) return;
        const handler = (event) => { if (event.key === "Escape" && !busyRef.current) setConfirmState(null); };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [confirmState]);

      const source = tab === "trash" ? items : archivedItems;
      // 计数与占用直接从当前列表算：批量操作后不会残留旧的总量
      const trashBytes = useMemo(() => (items || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0), [items]);
      const archivedBytes = useMemo(() => (archivedItems || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0), [archivedItems]);

      const workspaces = useMemo(() => {
        const set = new Set();
        for (const item of (source || [])) {
          if (typeof item.cwd === "string" && item.cwd !== "") set.add(item.cwd);
        }
        return [...set].sort((a, b) => a.localeCompare(b));
      }, [source]);

      const activeWorkspaceFilter = workspaceFilter && workspaces.includes(workspaceFilter) ? workspaceFilter : "";

      const visible = useMemo(() => {
        let list = [...(source || [])];
        if (activeWorkspaceFilter) list = list.filter(item => (item.cwd || "") === activeWorkspaceFilter);
        const needle = keyword.trim().toLowerCase();
        if (needle !== "") {
          const matches = searchContent && contentMatches?.query === tab + "\0" + needle ? contentMatches.matches : {};
          list = list.filter(item => String(item.title || "").toLowerCase().includes(needle)
            || String(item.cwd || "").toLowerCase().includes(needle)
            || String(item.id).toLowerCase().includes(needle)
            || matches[item.id] !== undefined);
        }
        list.sort((a, b) => {
          if (sortKey === "title") return String(a.title || "").localeCompare(String(b.title || ""));
          return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
        });
        return list;
      }, [source, activeWorkspaceFilter, keyword, sortKey, contentMatches, searchContent, tab]);

      const toggleChecked = (id) => setChecked((prev) => {
        if (busyRef.current) return prev;
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      const selectAllVisible = () => setChecked((prev) =>
        visible.length > 0 && visible.every(item => prev.has(item.id))
          ? new Set()
          : new Set(visible.map(item => item.id)));

      const pageCount = Math.max(1, Math.ceil(visible.length / 100));
      const currentPage = Math.min(page, pageCount - 1);
      const pagedItems = visible.slice(currentPage * 100, (currentPage + 1) * 100);
      const groups = useMemo(() => {
        const map = new Map();
        for (const item of pagedItems) {
          const key = typeof item.cwd === "string" ? item.cwd : "";
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(item);
        }
        return [...map.entries()];
      }, [visible, currentPage]);

      const removeRow = (id) => {
        if (tab === "trash") setItems(prev => (prev || []).filter(item => item.id !== id));
        else setArchivedItems(prev => (prev || []).filter(item => item.id !== id));
      };

      const doRestore = async (item) => {
        if (busy) return false;
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/restore", { sessionId: item.id });
          if (r && r.ok) {
            removeRow(item.id);
            const wentToArchive = r.result && r.result.archived === true;
            setNotice((wentToArchive ? t("trash.restoredArchived") : t("trash.restored")) + forksNote(r.result, t));
            if (r.result?.warning) setErrorText(r.result.warning);
            if (wentToArchive) setArchivedItems(null); // 归档页签下次打开时重拉
            void refreshSidebar();
            return true;
          }
          setErrorText(t("page.restoreFailed").replace("{message}", (r && r.error) || "unknown"));
          return false;
        } catch (error) {
          setErrorText(t("page.restoreFailed").replace("{message}", String(error)));
          return false;
        } finally {
          setBusy(false);
        }
      };

      const doPurge = async (item) => {
        if (busy) return;
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/delete", { sessionIds: [item.id] });
          const result = r && r.ok && r.result && r.result.results && r.result.results[0];
          if (result && result.deleted) {
            removeRow(item.id);
            setNotice(t("page.purged"));
          } else {
            setErrorText(t("page.purgeFailed").replace("{message}", (result && (result.error || result.reason)) || (r && r.error) || "unknown"));
          }
        } catch (error) {
          setErrorText(t("page.purgeFailed").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doEmpty = () => purgeItems((items || []).map(item => item.id));

      const doUnarchive = async (item) => {
        if (busy) return;
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/archived/unarchive", { sessionId: item.id });
          if (r && r.ok && r.result && r.result.unarchived) {
            removeRow(item.id);
            setNotice(t("page.unarchived"));
            void refreshSidebar();
          } else {
            setErrorText(t("page.failed").replace("{message}", (r && (r.error || (r.result && r.result.reason))) || "unknown"));
          }
        } catch (error) {
          setErrorText(t("page.failed").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doMoveToTrash = async (item) => {
        if (busy) return;
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash", { sessionId: item.id });
          if (r && r.ok) {
            removeRow(item.id);
            setNotice(t("page.movedToTrash"));
            showUndo(item.id, t("toast.trashed"), t);
            setItems(null); // 回收站下次打开时重拉
            void refreshSidebar();
          } else {
            setErrorText(t("page.failed").replace("{message}", (r && r.error) || "unknown"));
          }
        } catch (error) {
          setErrorText(t("page.failed").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doTrashAllArchived = () => moveItems((archivedItems || []).map(item => item.id));

      const toggleDetail = async (item) => {
        if (inlineDetail && inlineDetail.id === item.id) { setInlineDetail(null); return; }
        const source = tab === "trash" ? "trash" : "archived";
        setInlineDetail({ id: item.id, loading: true, source });
        setExpandedTurns(new Set());
        try {
          const r = await callApi(source === "archived" ? "/archived/detail" : "/trash/detail", { sessionId: item.id });
          if (r && r.ok) setInlineDetail({ id: item.id, loading: false, source, data: r.result });
          else {
            setInlineDetail(null);
            setErrorText(t("page.failed").replace("{message}", (r && r.error) || "detail failed"));
          }
        } catch (error) {
          setInlineDetail(null);
          setErrorText(t("page.failed").replace("{message}", String(error)));
        }
      };

      const checkUpdate = async () => {
        if (updateState === "checking") return;
        setUpdateState("checking");
        try {
          const r = await callApi("/update-check");
          if (r && r.ok && r.result) {
            if (!r.result.checked) {
              setNotice(t("page.updateCheckFailed").replace("{message}", r.result.error || "unknown"));
            } else {
              setNotice(r.result.hasUpdate
                ? t("page.updateAvailable").replace("{latest}", String(r.result.latest || ""))
                : t("page.upToDate"));
            }
          } else {
            setNotice(t("page.updateCheckFailed").replace("{message}", (r && r.error) || "unknown"));
          }
        } catch (error) {
          setNotice(t("page.updateCheckFailed").replace("{message}", String(error)));
        } finally {
          setUpdateState("idle");
        }
      };

      const runBatch = async (ids, action) => {
        let ok = 0;
        const failed = [], errors = [];
        setProgress({ done: 0, total: ids.length });
        for (const id of ids) {
          try { await action(id); ok++; }
          catch (error) { failed.push(id); errors.push(id + ": " + String(error.message || error)); }
          setProgress({ done: ok + failed.length, total: ids.length });
        }
        setChecked(new Set(failed));
        if (failed.length) {
          setSelectionMode(true);
          setErrorText(errors.slice(0, 5).join("\n"));
        }
        return { ok, fail: failed.length };
      };
      const batchNotice = (result, key) => setNotice(result.fail
        ? t("page.batchPartial").replace("{ok}", String(result.ok)).replace("{fail}", String(result.fail))
        : t(key).replace("{n}", String(result.ok)));
      const doBatchUnarchive = async () => {
        if (busy || checked.size === 0) return;
        setBusy(true); setErrorText("");
        try {
          const result = await runBatch([...checked], async id => {
            requireSuccess(await callApi("/archived/unarchive", { sessionId: id }), result => result?.unarchived);
            setArchivedItems(prev => (prev || []).filter(item => item.id !== id));
          });
          batchNotice(result, "page.batchUnarchived");
          await refreshSidebar();
        } finally { setBusy(false); }
      };
      const moveItems = async ids => {
        if (busy || ids.length === 0) return;
        setBusy(true); setErrorText("");
        try {
          const result = await runBatch(ids, async id => {
            requireSuccess(await callApi("/trash", { sessionId: id }), result => result?.trashed);
            setArchivedItems(prev => (prev || []).filter(item => item.id !== id));
          });
          setItems(null);
          batchNotice(result, "page.batchMoved");
          await refreshSidebar();
        } finally { setBusy(false); }
      };
      const doBatchMoveToTrash = () => moveItems([...checked]);
      const doBatchRestore = async () => {
        if (busy || checked.size === 0) return;
        setBusy(true); setErrorText("");
        try {
          const result = await runBatch([...checked], async id => {
            const result = requireSuccess(await callApi("/trash/restore", { sessionId: id }));
            setItems(prev => (prev || []).filter(item => item.id !== id));
            if (result.warning) setErrorText(result.warning);
          });
          setArchivedItems(null);
          batchNotice(result, "page.batchRestored");
          await refreshSidebar();
        } finally { setBusy(false); }
      };
      const purgeItems = async ids => {
        if (busy || ids.length === 0) return;
        setBusy(true); setErrorText("");
        try {
          const result = await runBatch(ids, async id => {
            const response = await callApi("/trash/delete", { sessionIds: [id] });
            const failures = failedResults(response);
            if (failures.length || response.result.results?.length !== 1) throw new Error(failures[0]?.error || failures[0]?.reason || "Delete failed");
            setItems(prev => (prev || []).filter(item => item.id !== id));
          });
          batchNotice(result, "page.batchPurged");
        } finally { setBusy(false); }
      };
      const doBatchPurge = () => purgeItems([...checked]);
      const saveRetention = async value => {
        setBusy(true); setErrorText("");
        try {
          requireSuccess(await callApi("/settings", { retentionDays: value }));
          setRetentionDays(value);
          await load();
        } catch (error) { setErrorText(String(error.message || error)); }
        finally { setBusy(false); }
      };
      const downloadSession = async (item, format) => {
        setBusy(true); setErrorText("");
        try {
          const result = requireSuccess(await callApi("/session/export", { sessionId: item.id, source: tab, format }));
          const url = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
          const link = document.createElement("a");
          link.href = url; link.download = result.filename;
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { setErrorText(String(error.message || error)); }
        finally { setBusy(false); }
      };

      const fieldStyle = { background: palette.inputBg, border: "1px solid " + palette.panelBorder, color: palette.text };
      const countSuffix = checked.size > 0 ? " (" + checked.size + ")" : "";
      const exportSelectFor = (item) => h("select", {
        value: "",
        "aria-label": t("page.export"),
        className: "scl-rowBtn",
        style: { ...fieldStyle, padding: "0 6px" },
        disabled: busy || item.stage === "purging",
        onChange: (event) => {
          const format = event.target.value;
          if (format) void downloadSession(item, format);
        }
      },
        h("option", { value: "" }, t("page.export")),
        ["md", "json"].map(format => h("option", { key: format, value: format }, t(format === "md" ? "page.exportMd" : "page.exportJson"))));
      const SearchIcon = P.IconSearchOutline16;
      const FolderIcon = P.IconFolderOpen16;

      return h("div", { className: "scl-page" },
        h("div", { className: "scl-pageHead" },
          h("h1", { className: "scl-pageTitle", style: { color: palette.text } }, t("trash.title")),
          h("div", { className: "scl-tabs" },
            h("button", {
              type: "button",
              className: "scl-tab",
              style: tab === "archived"
                ? { color: palette.text, borderBottomColor: palette.text }
                : { color: palette.secondary, borderBottomColor: "transparent" },
              onClick: () => switchTab("archived")
            }, t("page.tabArchived")),
            h("button", {
              type: "button",
              className: "scl-tab",
              style: tab === "trash"
                ? { color: palette.text, borderBottomColor: palette.text }
                : { color: palette.secondary, borderBottomColor: "transparent" },
              onClick: () => switchTab("trash")
            }, t("page.tabTrash"))
          ),
          h("div", { className: "scl-pageMeta" },
            h("div", { className: "scl-pageMetaText" },
              h("div", { className: "scl-pageCount", style: { color: palette.text } },
                t("page.countLine")
                  .replace("{n}", String(tab === "trash" ? (items ? items.length : 0) : (archivedItems ? archivedItems.length : 0)))
                  .replace("{size}", formatBytes(tab === "trash" ? trashBytes : archivedBytes))),
              h("div", { className: "scl-pageSub", style: { color: palette.secondary } },
                tab === "trash" ? (retentionDays === 0 ? t("page.manual") : t("page.days").replace("{n}", String(retentionDays)) + " · " + t("page.retentionNote")) : t("page.archivedSub"))
            ),
            tab === "trash" ? h("button", {
              type: "button",
              className: "scl-outlineBtn",
              style: { color: palette.danger, border: "1px solid " + palette.danger, background: "transparent" },
              disabled: busy || !items || items.length === 0,
              onClick: () => setConfirmState({
                message: t("page.confirmAll").replace("{n}", String(items ? items.length : 0)),
                run: doEmpty
              })
            }, t("trash.emptyBin")) : h("button", {
              type: "button",
              className: "scl-outlineBtn",
              style: { color: palette.text, border: "1px solid " + palette.panelBorder, background: "transparent" },
              disabled: busy || !archivedItems || archivedItems.length === 0,
              onClick: () => setConfirmState({
                message: t("page.confirmTrashAll").replace("{n}", String(archivedItems ? archivedItems.length : 0)),
                run: doTrashAllArchived
              })
            }, t("page.trashAll"))
          )
        ),
        h("div", { className: "scl-pageTools" },
          h("div", { className: "scl-searchBox", style: fieldStyle },
            SearchIcon && typeof SearchIcon === "function" ? h(SearchIcon, { size: 15 }) : null,
            h("input", {
              type: "text",
              className: "scl-searchInput",
              style: { color: palette.text },
              placeholder: t("page.search"),
              value: keyword,
              onChange: (e) => setKeyword(e.target.value)
            })
          ),
          h("select", {
            className: "scl-pageSelect",
            style: fieldStyle,
            value: activeWorkspaceFilter,
            onChange: (e) => setWorkspaceFilter(e.target.value)
          },
            h("option", { value: "" }, t("trash.workspaceAll")),
            workspaces.map(cwd => h("option", { key: cwd, value: cwd }, cwd))
          ),
          h("select", {
            className: "scl-pageSelect",
            style: fieldStyle,
            value: sortKey,
            onChange: (e) => setSortKey(e.target.value)
          },
            tab === "trash"
              ? h("option", { value: "deletedAt" }, t("trash.sortDeleted"))
              : h("option", { value: "lastTime" }, t("info.lastActive")),
            h("option", { value: "title" }, t("trash.sortTitle")),
            h("option", { value: "bytes" }, t("trash.sortSize")),
            h("option", { value: "turns" }, t("trash.sortTurns"))
          )
        ),
        h("div", { className: "scl-batch" },
          !selectionMode
            ? h("button", {
                type: "button",
                className: "scl-miniBtn",
                style: { color: palette.text, borderColor: palette.rowBorder },
                disabled: visible.length === 0,
                onClick: () => { setSelectionMode(true); setChecked(new Set()); }
              }, t("page.batchMode"))
            : [
                h("button", {
                  key: "select-all",
                  type: "button",
                  className: "scl-miniBtn",
                  style: { color: palette.text, borderColor: palette.rowBorder },
                  disabled: visible.length === 0,
                  onClick: selectAllVisible
                }, visible.length > 0 && visible.every(item => checked.has(item.id)) ? t("trash.deselectAll") : t("trash.selectAll")),
                checked.size > 0
                  ? h("span", { key: "count", style: { color: palette.secondary, fontSize: 12 } }, t("trash.selected").replace("{n}", String(checked.size)))
                  : null
              ],
          h("div", { className: "scl-spacer" }),
          h("label", { className: "scl-check", style: { color: palette.secondary } },
            h("input", {
              type: "checkbox",
              checked: searchContent,
              onChange: (e) => setSearchContent(e.target.checked)
            }),
            searching ? t("trash.searching") : t("trash.searchContent")
          ),
          selectionMode
            ? h("div", { className: "scl-batchActions" },
                checked.size > 0
                  ? (tab === "archived"
                      ? [
                          h("button", {
                            key: "batch-unarchive",
                            type: "button",
                            className: "scl-miniBtn",
                            style: { color: palette.text, borderColor: palette.rowBorder },
                            disabled: busy,
                            onClick: doBatchUnarchive
                          }, t("page.unarchive") + countSuffix),
                          h("button", {
                            key: "batch-trash",
                            type: "button",
                            className: "scl-miniBtn",
                            style: { color: palette.danger, borderColor: palette.rowBorder },
                            disabled: busy,
                            onClick: doBatchMoveToTrash
                          }, t("page.moveToTrash") + countSuffix)
                        ]
                      : [
                          h("button", {
                            key: "batch-restore",
                            type: "button",
                            className: "scl-miniBtn",
                            style: { color: palette.text, borderColor: palette.rowBorder },
                            disabled: busy,
                            onClick: doBatchRestore
                          }, t("trash.restore") + countSuffix),
                          h("button", {
                            key: "batch-purge",
                            type: "button",
                            className: "scl-miniBtn",
                            style: { color: palette.danger, borderColor: palette.rowBorder },
                            disabled: busy,
                            onClick: () => setConfirmState({
                              message: t("trash.confirmPurge").replace("{n}", String(checked.size)),
                              run: doBatchPurge
                            })
                          }, t("trash.purge") + countSuffix)
                        ])
                  : null,
                h("button", {
                  key: "exit",
                  type: "button",
                  className: "scl-miniBtn",
                  style: { color: palette.secondary, borderColor: palette.rowBorder },
                  onClick: () => { setSelectionMode(false); setChecked(new Set()); }
                }, t("page.exitBatch"))
              )
            : null
        ),
        tab === "trash" ? h("label", { className: "scl-batch", style: { color: palette.secondary } },
          t("page.retention"), h("select", { value: retentionDays, disabled: busy, style: fieldStyle,
            onChange: event => saveRetention(Number(event.target.value)) },
            [7, 30, 90, 0].map(days => h("option", { key: days, value: days }, days === 0 ? t("page.manual") : t("page.days").replace("{n}", String(days)))))
        ) : null,
        progress ? h("div", { role: "status", className: "scl-pageNotice", style: { color: palette.secondary } },
          t("page.progress").replace("{done}", String(progress.done)).replace("{total}", String(progress.total))) : null,
        notice ? h("div", { className: "scl-pageNotice", style: { color: palette.success } }, notice) : null,
        errorText ? h("div", { className: "scl-pageNotice", style: { color: palette.danger, whiteSpace: "pre-wrap" } }, errorText) : null,
        source === null
          ? h("div", { className: "scl-pageEmpty", style: { color: palette.secondary } }, t("page.loading"))
          : visible.length === 0
            ? h("div", { className: "scl-pageEmpty", style: { color: palette.secondary } },
                tab === "trash" ? t("page.empty") : t("page.archivedEmpty"))
            : groups.map(([cwd, list]) => h("section", { className: "scl-pageGroup", key: cwd || "__none__" },
                h("div", { className: "scl-pageGroupHead" },
                  h("div", { className: "scl-pageGroupName", style: { color: palette.text } },
                    FolderIcon && typeof FolderIcon === "function" ? h(FolderIcon, { size: 15 }) : null,
                    h("span", null, cwd || t("page.noProject"))
                  ),
                  h("div", { className: "scl-pageGroupCount", style: { color: palette.secondary } },
                    t("page.count").replace("{n}", String(list.length)))
                ),
                h("div", { className: "scl-pageList", style: { borderColor: palette.rowBorder } },
                  list.map(item => h(React.Fragment, { key: item.id },
                    h("div", {
                      className: "scl-pageRow",
                      style: { borderColor: palette.rowBorder, cursor: selectionMode ? "pointer" : undefined },
                      onClick: (event) => {
                        if (!selectionMode) return;
                        const target = event.target;
                        // 点到按钮/勾选框/下拉/链接时不切换，避免和它们抢点击
                        if (target && typeof target.closest === "function"
                          && target.closest("button, input, select, a, textarea, label")) return;
                        toggleChecked(item.id);
                      }
                    },
                      selectionMode ? h("input", {
                        type: "checkbox",
                        checked: checked.has(item.id),
                        onChange: () => toggleChecked(item.id)
                      }) : null,
                      h("div", { className: "scl-pageRowMain" },
                        h("div", { className: "scl-pageRowTitle", style: { color: palette.text } },
                          item.title || item.id,
                          searchContent && contentMatches?.query === tab + "\0" + keyword.trim().toLowerCase() && contentMatches.matches[item.id] !== undefined
                            ? h("span", { className: "scl-tBadge", style: { color: palette.secondary } },
                                t("trash.searchHit").replace("{n}", String(contentMatches.matches[item.id])))
                            : null),
                        h("div", { className: "scl-pageRowMeta", style: { color: palette.secondary } },
                          [
                            formatTime(tab === "trash" ? item.deletedAt : item.lastTime),
                            Number.isFinite(item.turns) ? item.turns + " " + t("unit.turns") : null,
                            Number.isFinite(item.bytes) ? formatBytes(item.bytes) : null,
                            item.stage === "purging" ? t("page.cleanupPending") : item.stage === "restoring" ? t("page.restorePending") : null,
                            tab === "trash" && item.expiresAt ? t("page.expires").replace("{time}", formatTime(item.expiresAt)) : null
                          ].filter(Boolean).join(" · ")),
                        searchContent && contentMatches?.query === tab + "\0" + keyword.trim().toLowerCase() && contentMatches.snippets[item.id]
                          ? h("div", { className: "scl-pageRowMeta", style: { color: palette.secondary } }, contentMatches.snippets[item.id]) : null
                      ),
                      tab === "archived"
                        ? h("div", { className: "scl-pageRowActions" },
                            h("button", {
                              type: "button",
                              className: "scl-rowBtn",
                              title: t("trash.viewLog"),
                              style: { color: palette.secondary, borderColor: palette.rowBorder },
                              disabled: busy,
                              onClick: () => toggleDetail(item)
                            }, t("page.view")),
                            exportSelectFor(item),
                            h("button", {
                              type: "button",
                              className: "scl-rowBtn",
                              style: { color: palette.text, borderColor: palette.rowBorder },
                              disabled: busy,
                              onClick: () => doUnarchive(item)
                            }, t("page.unarchive")),
                            h("button", {
                              type: "button",
                              className: "scl-iconBtn",
                              title: t("page.moveToTrash"),
                              "aria-label": t("page.moveToTrash"),
                              style: { color: palette.danger },
                              disabled: busy,
                              onClick: () => doMoveToTrash(item)
                            }, "🗑")
                          )
                        : h("div", { className: "scl-pageRowActions" },
                            h("button", {
                              type: "button",
                              className: "scl-rowBtn",
                              title: t("trash.viewLog"),
                              style: { color: palette.secondary, borderColor: palette.rowBorder },
                              disabled: busy,
                              onClick: () => toggleDetail(item)
                            }, t("page.view")),
                            exportSelectFor(item),
                            h("button", {
                              type: "button",
                              className: "scl-iconBtn",
                              title: t("trash.purge"),
                              "aria-label": t("trash.purge"),
                              style: { color: palette.danger },
                              disabled: busy,
                              onClick: () => setConfirmState({
                                message: t("page.confirmOne").replace("{title}", item.title || item.id),
                                run: () => doPurge(item)
                              })
                            }, "🗑"),
                            h("button", {
                              type: "button",
                              className: "scl-restoreBtn",
                              style: { color: palette.text, background: "rgba(127,127,127,.14)" },
                              disabled: busy || item.stage === "purging" || item.stage === "incomplete",
                              onClick: () => doRestore(item)
                            }, t("trash.restore"))
                          )
                    ),
                    inlineDetail && inlineDetail.id === item.id
                      ? h("div", {
                          className: "scl-inlineDetail",
                          style: { borderColor: palette.rowBorder, background: "rgba(127,127,127,.05)" }
                        },
                          h("div", { className: "scl-inlineHead" },
                            h("span", { style: { color: palette.secondary } },
                              inlineDetail.loading
                                ? t("detail.loading")
                                : t("detail.questions").replace("{n}", String(
                                    inlineDetail.data && Array.isArray(inlineDetail.data.questions) ? inlineDetail.data.questions.length : 0))),
                            h("button", {
                              type: "button",
                              className: "scl-miniBtn",
                              style: { color: palette.secondary },
                              onClick: () => setInlineDetail(null)
                            }, t("dialog.close"))
                          ),
                          inlineDetail.loading ? null
                            : inlineDetail.data && Array.isArray(inlineDetail.data.questions) && inlineDetail.data.questions.length > 0
                              ? h("div", null, inlineDetail.data.questions.map((q, index) => {
                                  const expanded = expandedTurns.has(index);
                                  return h("div", {
                                    className: "scl-turn",
                                    key: index,
                                    style: { borderColor: palette.rowBorder },
                                    onClick: () => setExpandedTurns((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(index)) next.delete(index); else next.add(index);
                                      return next;
                                    })
                                  },
                                    h("div", { className: "scl-turnHead" },
                                      h("span", { className: "scl-turnBadge", style: { color: palette.turn } },
                                        t("detail.turn").replace("{n}", String(q.turn ?? index + 1))),
                                      h("span", { style: { color: palette.secondary } }, formatTime(q.time)),
                                      h("span", { style: { color: palette.secondary } },
                                        t("detail.tools").replace("{n}", String(q.toolCalls || 0))),
                                      h("span", { className: "scl-turnArrow", style: { color: palette.secondary } }, expanded ? "▾" : "▸")
                                    ),
                                    expanded
                                      ? h("div", null,
                                          h("div", { className: "scl-md", style: { color: palette.user } }, q.question || "（无文本内容）"),
                                          q.assistantReply
                                            ? h("div", { className: "scl-md", style: { color: palette.model } }, renderMarkdown(q.assistantReply, palette))
                                            : null
                                        )
                                      : h("div", { className: "scl-collapsedRow" },
                                          h("span", { className: "scl-fade", style: { color: palette.user } }, q.question || "（无文本内容）")
                                        )
                                  );
                                }))
                              : h("div", { style: { color: palette.secondary } }, t("detail.noQuestions"))
                        )
                      : null
                  ))
                )
              )),
        pageCount > 1 ? h("div", { className: "scl-batch", style: { color: palette.secondary } },
          h("button", { type: "button", className: "scl-miniBtn", style: fieldStyle, disabled: busy || currentPage === 0,
            onClick: () => setPage(currentPage - 1) }, t("page.previous")),
          t("page.pagination").replace("{page}", String(currentPage + 1)).replace("{pages}", String(pageCount)).replace("{n}", String(visible.length)),
          h("button", { type: "button", className: "scl-miniBtn", style: fieldStyle, disabled: busy || currentPage >= pageCount - 1,
            onClick: () => setPage(currentPage + 1) }, t("page.next"))) : null,
        h("div", { className: "scl-pageFoot", style: { color: palette.secondary } },
          h("span", null, "dsh-session-cleaner" + (version ? " v" + version : "")),
          h("button", {
            type: "button",
            className: "scl-linkBtn",
            style: { color: palette.secondary },
            disabled: updateState === "checking",
            onClick: checkUpdate
          }, updateState === "checking" ? t("page.checking") : t("page.checkUpdate"))
        ),
        confirmState ? h("div", {
          className: "scl-layer",
          style: { background: palette.layer, zIndex: 11050 },
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setConfirmState(null); }
        },
          h("section", {
            className: "scl-panel scl-panelSmall",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog",
            "aria-modal": "true"
          },
            h("div", { style: { color: palette.text } }, confirmState.message),
            h("div", { className: "scl-footer" },
              h("button", {
                type: "button",
                className: "scl-btn",
                style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
                disabled: busy,
                onClick: () => setConfirmState(null)
              }, t("dialog.cancel")),
              h("button", {
                type: "button",
                className: "scl-btn",
                style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
                disabled: busy,
                onClick: () => { const run = confirmState.run; setConfirmState(null); void run(); }
              }, t("trash.confirm"))
            )
          )
        ) : null
      );
    }

    // ───────────────────────── 设置页导航图标 ─────────────────────────
    // 宿主的 settings.section 只投影 id/order/label，第三方分区只能显示默认
    // 齿轮（插件市场也是这么处理的）。这里认领自己那一行，把齿轮换成垃圾桶。

    const NAV_ICON_MARKER = "data-dsh-session-cleaner-nav-icon";
    const NAV_ROW_SELECTOR = '[role="dialog"] nav button';

    function trashNavMaskUrl() {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">'
        + '<rect x="6" y="1" width="4" height="1.6" rx="0.8"/>'
        + '<rect x="2" y="3" width="12" height="1.8" rx="0.9"/>'
        + '<path fill-rule="evenodd" d="M3.2 5.5h9.6l-.7 7.9a1.4 1.4 0 0 1-1.4 1.3H5.3a1.4 1.4 0 0 1-1.4-1.3l-.7-7.9zM6 7h1.1v5H6V7zM8.9 7H10v5H8.9V7z"/>'
        + '</svg>';
      return "data:image/svg+xml," + encodeURIComponent(svg);
    }

    function trashNavCss(maskUrl) {
      return [
        "[" + NAV_ICON_MARKER + "] > svg { display: none; }",
        "[" + NAV_ICON_MARKER + "]::before {",
        "  content: '';",
        "  flex: none;",
        "  width: 16px;",
        "  height: 16px;",
        "  background-color: currentColor;",
        '  -webkit-mask-image: url("' + maskUrl + '");',
        '  mask-image: url("' + maskUrl + '");',
        "  -webkit-mask-repeat: no-repeat;",
        "  mask-repeat: no-repeat;",
        "  -webkit-mask-position: center;",
        "  mask-position: center;",
        "  -webkit-mask-size: 16px 16px;",
        "  mask-size: 16px 16px;",
        "}"
      ].join("\n");
    }

    function installSettingsNavIcon(ctx, resolveLabel) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-session-cleaner";
        tag.dataset.pluginCss = "dsh-session-cleaner/settings-nav-icon";
        tag.textContent = trashNavCss(trashNavMaskUrl());
        document.head.appendChild(tag);
        let disposed = false;
        let scheduled = false;
        const sync = () => {
          scheduled = false;
          if (disposed) return;
          const wanted = String((typeof resolveLabel === "function" ? resolveLabel() : "") || "").trim();
          if (wanted === "") return;
          for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
            if (String(row.textContent || "").trim() === wanted) row.setAttribute(NAV_ICON_MARKER, "");
            else row.removeAttribute(NAV_ICON_MARKER);
          }
        };
        const schedule = () => {
          if (scheduled || disposed) return;
          scheduled = true;
          queueMicrotask(sync);
        };
        sync();
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return () => {
          disposed = true;
          observer.disconnect();
          for (const row of document.querySelectorAll("[" + NAV_ICON_MARKER + "]")) row.removeAttribute(NAV_ICON_MARKER);
          tag.remove();
        };
      }, "session-cleaner: settings nav icon");
    }

    // ───────────────────────── 插件入口 ─────────────────────────

    function apply(ctx) {
      hostCtx = ctx;

      ctx.effect(() => injectStyle(), "session-cleaner: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-cleaner: dictionaries");

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "session-cleaner-delete",
          order: 500,
          locale: NS,
          inject: () => ({})
        }, DeleteSessionMenuItem);
      });

      // 设置页分区：与会话管理/插件市场并列的整页「会话回收站」
      const tBind = (key) => {
        try {
          if (ctx.locale && typeof ctx.locale.bind === "function") return ctx.locale.bind(NS)(key);
        } catch { /* fall through */ }
        return key;
      };
      ctx.slots.inject("settings.section", function* () {
        yield ctx.slots.register({
          name: "settings.section",
          id: "session-cleaner-trash",
          order: 45, // 插件市场（40）之后
          label: () => tBind("trash.title"),
          locale: NS,
          inject: () => ({ t: tBind, openTrashUi })
        }, TrashSettingsSection);
      });

      // 设置页导航图标：宿主的 settings.section 只认 id/order/label，第三方分区
      // 一律显示默认齿轮；这里学插件市场的做法，认领自己那一行并换成垃圾桶。
      installSettingsNavIcon(ctx, () => tBind("trash.title"));

      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-toast",
          locale: NS,
          inject: () => ({})
        }, TrashToast);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-trash-ui",
          locale: NS,
          inject: () => ({ useTrashUiOpen, closeTrashUi, takeDetailRequest: takeTrashDetailRequest })
        }, RecycleBinOverlay);
      });
    }

    const inject = ["slots", "locale", "sessions", "workspaces"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
