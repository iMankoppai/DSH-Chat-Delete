import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Exercise the actual settings component with stateful hooks and a mock HTTP
// boundary. No host data, browser installation or third-party packages needed.
export async function runClientRegressions({ ROOT, ok, eq }) {
  console.log("\n[12] 设置页交互回归");
  const source = (await readFile(join(ROOT, "lib/client.js"), "utf8")).replace(
    "exports.apply = apply;", "exports.__test = { TrashSettingsSection, TrashToast, performTrash, zh }; exports.apply = apply;"
  );
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.children) : node == null || node === false ? "" : String(node);
  function harness(initialArchived, initialTrash = []) {
    let captured, cursor = 0, tree, dirty = true, retention = 30;
    const states = [], effects = [], timers = new Map(), listeners = new Map();
    let archived = [...initialArchived], trash = [...initialTrash], restoreCalls = 0, downloadCount = 0;
    const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
    const React = {
      createElement, Component: class {}, Fragment: "fragment",
      useState(initial) {
        const i = cursor++;
        if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
        return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; dirty = true; }];
      },
      useRef(initial) { const i = cursor++; return states[i] ?? (states[i] = { current: initial }); },
      useMemo: fn => fn(),
      useEffect(fn, deps) {
        const i = cursor++, previous = states[i];
        if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
          effects.push(() => { previous?.cleanup?.(); states[i] = { deps, cleanup: fn() }; });
        }
      },
      useSyncExternalStore: (_subscribe, snapshot) => snapshot()
    };
    const win = {
      __ModuleLoader__: { load: value => { captured = value; } },
      addEventListener: (name, fn) => { listeners.set(name, fn); },
      removeEventListener: name => listeners.delete(name),
      dispatchEvent: event => listeners.get(event.type)?.()
    };
    const doc = { body: { appendChild() {} }, createElement: () => ({ click() { downloadCount++; }, remove() {} }) };
    const fakeFetch = async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : {};
      let result = {};
      if (url.endsWith("/version")) result = { version: "0.9.0" };
      else if (url.endsWith("/archived/list")) result = { items: archived, totalBytes: 10 };
      else if (url.endsWith("/trash/list")) result = { items: trash, retentionDays: retention };
      else if (url.endsWith("/archived/search") || url.endsWith("/trash/search")) result = { matches: { a: 1 }, snippets: { a: "body-only secret" }, errors: [] };
      else if (url.endsWith("/settings")) { retention = payload.retentionDays; result = { retentionDays: retention }; }
      else if (url.endsWith("/trash/delete")) {
        result = { results: payload.sessionIds.map(sessionId => ({ sessionId, deleted: sessionId !== "b", error: sessionId === "b" ? "locked b" : undefined })) };
        trash = trash.filter(item => !result.results.some(entry => entry.sessionId === item.id && entry.deleted));
      } else if (url.endsWith("/trash/restore")) {
        restoreCalls++; trash = trash.filter(item => item.id !== payload.sessionId); result = { filesRestored: true, forksReattached: 1 };
      } else if (url.endsWith("/session/export")) result = { filename: "a.md", content: "# saved", mime: "text/markdown" };
      else if (url.endsWith("/trash")) {
        if (payload.sessionId === "b") return { json: async () => ({ ok: false, error: "locked b" }) };
        const moved = archived.find(item => item.id === payload.sessionId);
        archived = archived.filter(item => item.id !== payload.sessionId);
        if (moved) trash.push(moved);
        result = { trashed: true };
      }
      return { json: async () => ({ ok: true, result }) };
    };
    const fakeRequire = id => id === "react" ? React : {};
    const schedule = (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; };
    const urlApi = { createObjectURL: () => "blob:test", revokeObjectURL() {} };
    new Function("require", "window", "document", "fetch", "setTimeout", "clearTimeout", "URL", source)(
      fakeRequire, win, doc, fakeFetch, schedule, id => timers.delete(id), urlApi
    );
    const api = captured.factory(fakeRequire).__test;
    const props = { t: key => api.zh[key] || key };
    const render = () => { cursor = 0; dirty = false; tree = api.TrashSettingsSection(props); effects.splice(0).forEach(fn => fn()); };
    const settle = async () => {
      for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); }
    };
    const nodes = () => flatten(tree);
    const button = label => nodes().find(node => node.type === "button" && text(node) === label);
    const click = async label => {
      const target = button(label);
      if (!target) throw new Error("找不到按钮: " + label);
      if (target.props.disabled) throw new Error("按钮不可用: " + label);
      target.props.onClick(); await settle();
    };
    const fire = async delay => { for (const [id, timer] of timers) if (timer.ms === delay) { timers.delete(id); timer.fn(); } await settle(); };
    render();
    return { api, settle, nodes, click, fire, text: () => text(tree),
      rows: () => nodes().filter(node => node.props.className === "scl-pageRowTitle"),
      translate: key => props.t(key),
      get restoreCalls() { return restoreCalls; }, get downloadCount() { return downloadCount; },
      renderToast: () => api.TrashToast(),
      dispose: () => states.forEach(value => value?.cleanup?.()) };
  }
  const a = { id: "a", title: "Alpha", cwd: "project", bytes: 10 }, b = { id: "b", title: "Beta", cwd: "project", bytes: 20 };
  {
    const ui = harness([a, b]); await ui.settle();
    eq(ui.rows().length, 2, "设置页加载归档会话");
    ui.nodes().find(node => node.props.className === "scl-searchInput").props.onChange({ target: { value: "secret" } });
    await ui.settle();
    ui.nodes().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
    await ui.settle(); await ui.fire(350);
    eq(ui.rows().length, 1, "正文搜索保留仅正文命中的行");
    ok(ui.text().includes("body-only secret"), "设置页显示正文匹配片段");
    ui.nodes().find(node => node.props.className === "scl-searchInput").props.onChange({ target: { value: "" } });
    await ui.settle();
    await ui.click(ui.translate("page.batchMode"));
    await ui.click(ui.translate("trash.selectAll"));
    const moveButton = ui.nodes().find(node => node.type === "button" && text(node).startsWith(ui.translate("page.moveToTrash")));
    if (!moveButton) throw new Error("找不到批量移入按钮");
    moveButton.props.onClick(); await ui.settle();
    eq(ui.rows().length, 1, "批量移入仅移除成功项");
    ok(ui.text().includes("Beta") && ui.text().includes("locked b"), "失败行保留并显示具体原因");
    ok(ui.text().includes("已处理 2 / 2"), "批量操作显示完成进度");
    await ui.click(ui.translate("page.tabTrash"));
    ui.nodes().find(node => node.type === "select" && node.props["aria-label"] === ui.translate("page.export")).props.onChange({ target: { value: "md" } });
    await ui.settle();
    eq(ui.downloadCount, 1, "导出按钮触发文件下载");
    const retention = ui.nodes().find(node => node.type === "select" && node.props.value === 30);
    retention.props.onChange({ target: { value: "0" } }); await ui.settle();
    ok(ui.text().includes("仅手动清理"), "设置页可切换手动清理");
    await ui.api.performTrash("undo-fixture", key => ui.translate(key));
    const toast = ui.renderToast();
    const undo = flatten(toast).find(node => node.type === "button" && text(node) === "撤销");
    ok(Boolean(undo), "删除成功提示提供撤销按钮");
    await undo.props.onClick(); await ui.settle();
    eq(ui.restoreCalls, 1, "撤销调用恢复接口");
    ok(text(ui.renderToast()).includes("已还原 1 个 fork 血缘"), "撤销后提示里报告 fork 血缘已还原");
    ui.dispose();
  }
  {
    const ui = harness([], [a, b]); await ui.settle();
    await ui.click(ui.translate("page.tabTrash"));
    await ui.click(ui.translate("trash.emptyBin"));
    await ui.click(ui.translate("trash.confirm"));
    eq(ui.rows().length, 1, "清空部分失败时保留失败行");
    ok(ui.text().includes("Beta") && ui.text().includes("locked b"), "清空失败不显示虚假的空列表");
    ui.dispose();
  }
  {
    const ui = harness(Array.from({ length: 205 }, (_, i) => ({ ...a, id: "row-" + i, title: "Row " + i })));
    await ui.settle();
    eq(ui.rows().length, 100, "大量会话每页最多渲染 100 行");
    await ui.click(ui.translate("page.next"));
    eq(ui.rows().length, 100, "分页可进入第二页");
    await ui.click(ui.translate("page.next"));
    eq(ui.rows().length, 5, "末页只显示剩余会话");
    ui.dispose();
  }
}
