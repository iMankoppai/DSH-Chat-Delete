/**
 * dsh-session-cleaner — Host half.
 *
 * Cordis plugin that adds a true "delete" for DSH sessions, reachable from
 * the sidebar session "..." menu via the client half (lib/client.js).
 *
 * Two-step lifecycle (the client uses both; nothing disappears irreversibly
 * without a second, explicit action):
 *   delete → move the session into this plugin's own recycle bin (reversible)
 *   purge  → permanently remove a binned session and everything it left behind
 *
 * A session's subagent descendants move with it. DSH cascades agent disposal
 * from a parent to its children, but a child session's log directory, workspace
 * accounting and projection-cache row survive the parent on their own, so the
 * plugin discovers them the way the host does — a stored header carrying
 * `origin: 'subagent'` and `parentSession: <id>` — and takes the whole family
 * to the bin, back again, or out for good together.
 *
 * Fork branches are NOT descendants. A fork copies its parent's event log into
 * an independent session and only records `parentSession` as lineage metadata
 * (`isSeeded: true`), so deleting the parent must leave the fork alone. The
 * trash response reports them back as `forkBranchesKept`.
 *
 * Live-session policy (v0.2.0 and later): a session whose agent is running a
 * turn is NOT refused. The running turn is cancelled, the agent fiber is
 * disposed with a bounded wait, and the session entry is flushed and detached
 * so every connected client drops its row (session/disposed). Deleting a live
 * session therefore ends an in-flight answer; the conversation stays
 * recoverable from the bin.
 *
 * What moving one session to the bin removes:
 *   1. the session artifact directory  <dshHome>/sessions/<proj>/<id>/
 *      renamed into <dshHome>/dsh-session-cleaner/trash/items/<id>/ (same-volume
 *      rename, atomic), never copied.
 *   2. workspace accounting   workspaceRegistry: the owning record's ordered
 *      sessionIds slot is detached, the id is dropped from the global
 *      archivedSessionIds set AND from pinnedSessionIds — a dangling pin would
 *      otherwise outlive the session it names.
 *   3. the projection cache row   <dshHome>/storages/session_projcache/
 *      sessions/<id>.json, plus any <id>.json.bak.* left behind by the host's
 *      backup-and-skip path. Removed through the host's own cache service when
 *      it exposes one, then verified on disk.
 *   4. schedules are snapshotted and kept while the session is in the bin;
 *      only permanent deletion removes them through the host schedule service.
 *
 * Every one of 1-4 is snapshotted into trash/meta/<id>.json (artifact
 * directory, workspace id/path + slot index, projection-cache row verbatim,
 * pin state, bound schedule records) so a restore puts the session back where
 * it was: same directory, same sidebar position, same cache row, same pin,
 * same timers. A session's descendants are snapshotted inside the same record
 * and their directories live under the bin item's `.children/`.
 *
 * Purging a binned session deletes the artifact directory and the snapshot,
 * re-checks the projection cache and the schedule service, and removes the
 * session's project directory once it is empty.
 *
 * Every delete, restore and purge appends one JSONL line to
 * <dshHome>/dsh-session-cleaner/audit.log (best-effort: a failed write never
 * blocks the operation it describes).
 *
 * Crash safety: the bin writes its metadata record BEFORE moving files and
 * rewrites it afterwards, so a crash can never leave an invisible directory in
 * the bin; startup reconciliation repairs either half of that pair.
 *
 * File mutations are restricted to verified session directories; every
 * destructive step re-validates the path shape immediately before acting.
 */
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export const name = "dsh-session-cleaner";
export const version = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

export function isNewerVersion(candidate, current) {
  const parse = value => typeof value === "string" && value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  if (!a[4] || !b[4]) return Boolean(!a[4] && b[4]);
  const aa = a[4].split("."), bb = b[4].split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined || bb[i] === undefined) return bb[i] === undefined;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) > BigInt(bb[i]);
    if (an !== bn) return !an;
    return aa[i] > bb[i];
  }
  return false;
}

export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "dshHomePath"
];

const API_PREFIX = "/session-cleaner/api";
const zstdDecompressAsync = promisify(zstdDecompress);
const zstdCompressAsync = promisify(zstdCompress);

function safeErrorMessage(error) {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** Pull one service out of the Cordis ctx, tolerating direct property fallbacks. */
function getService(ctx, name) {
  try {
    const value = typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    if (value !== undefined) return value;
  } catch { /* fall through to the legacy direct property */ }
  return ctx && ctx[name];
}

// ───────────────────────── 会话标识与目录校验 ─────────────────────────

export function assertSessionId(id) {
  if (typeof id !== "string" || id.trim() === "" || id === "." || id === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error("sessionId 必须是合法的会话标识，不能包含路径或特殊目录名"), { code: "bad-request" });
  }
  return id;
}

/** Mirror of DSH's session-segment encoding: the host writes one session
 * directory per id under <sessions>/<projectKey(cwd)>/ using `encodeSegment`
 * (dsh-session-persistence-jsonl). Safe code units stay literal — so a normal
 * `session-<uuid>` id is its own directory name — while `/`, `\`, `:`, `~`,
 * control units and the whole segments `.` / `..` become `~XXXX`. The project
 * level uses a DIFFERENT encoder (`projectKey`, the `--…--` form); this one is
 * for the session level only.
 */
export function encodeSessionSegment(id) {
  assertSessionId(id);
  if (id === ".") return "~002E";
  if (id === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + id.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Only an actual <sessions>/<project>/<session> directory may be mutated.
 * Neither level may be a symlink/junction. Re-checked immediately before
 * every destructive step.
 */
export async function assertSessionDirectory(root, directory, id, { allowMissing = false } = {}) {
  assertSessionId(id);
  if (typeof root !== "string" || typeof directory !== "string") {
    throw new Error("无法验证会话目录，已停止文件操作");
  }
  const base = resolve(root);
  const target = resolve(directory);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.length !== 2 || parts.some(p => p === ".." || p === "." || p === "")
    || ![id, encodeSessionSegment(id)].includes(parts[1])) {
    throw new Error("会话目录超出允许范围，已停止文件操作");
  }
  const canonicalRoot = await realpath(base);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return target;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("会话目录不能是符号链接、junction 或普通文件");
    }
    const canonical = await realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (isAbsolute(child) || child === "" || child.split(sep).includes("..")) {
      throw new Error("会话目录解析到了允许范围之外");
    }
  }
  return target;
}

// ───────────────────────── Zstd 帧扫描（只读头帧） ─────────────────────────
// Direct port of DSH's frame layout contract: concatenated checksummed frames,
// boundaries computed from the frame header itself (never a magic-byte guess).

const ZSTD_MAGIC = 0xfd2fb528;

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUint32LE(offset) != ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUint8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Filenames tried in order to locate a session's durable artifact. */
export const ARTIFACT_NAMES = [
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl"
];
const MAX_HEADER_BYTES = 1024 * 1024;

function parseHeader(content) {
  const newline = content.indexOf("\n");
  if (newline < 0) throw new Error("会话工件缺少完整头行");
  const header = JSON.parse(content.slice(0, newline));
  assertSessionId(header?.id);
  return header;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("会话工件必须是普通文件，不能是符号链接");
}

/** Header-only read: first zstd frame (or first line for plain JSONL). */
export async function readSessionHeader(path) {
  await assertRegularFile(path);
  const handle = await open(path, "r");
  try {
    let buffer = Buffer.alloc(0);
    while (buffer.length < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      if (path.endsWith(".zstd")) {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length) {
          const frame = frames[0];
          const decoded = await zstdDecompressAsync(buffer.subarray(frame.start, frame.end), { maxOutputLength: MAX_HEADER_BYTES });
          return parseHeader(decoded.toString("utf8"));
        }
      } else if (buffer.includes(10)) {
        return parseHeader(buffer.toString("utf8"));
      }
    }
    throw new Error("会话头行不完整或超过大小限制");
  } finally {
    await handle.close();
  }
}

// ───────────────────────── 会话信息统计（弹窗展示用） ─────────────────────────

/** 解出整个日志（多帧 zstd 或纯 JSONL），供轮次/消息统计。 */
async function decompressArtifact(path, { maxOutputLength = 512 * 1024 * 1024 } = {}) {
  await assertRegularFile(path);
  if ((await lstat(path)).size > maxOutputLength) throw new Error("会话日志超过读取大小限制");
  const bytes = await readFile(path);
  if (!path.toLowerCase().endsWith(".zstd")) {
    return { text: bytes.toString("utf8") };
  }
  const { frames } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error("会话日志没有可读的 Zstd 帧");
  const parts = [];
  let remaining = maxOutputLength;
  for (const frame of frames) {
    if (remaining <= 0) throw new Error("会话日志解压总量超过限制");
    const part = await zstdDecompressAsync(bytes.subarray(frame.start, frame.end), { maxOutputLength: remaining });
    remaining -= part.length;
    parts.push(part);
  }
  return { text: Buffer.concat(parts).toString("utf8") };
}

/** Read bounded UTF-8 lines without retaining the complete decoded log. */
export async function* readArtifactLines(path, { maxOutputLength = 256 * 1024 * 1024, signal } = {}) {
  await assertRegularFile(path);
  const source = createReadStream(path, { signal });
  const decoder = new StringDecoder("utf8");
  let pending = "", total = 0;
  // Node's Zstd stream stops at the first frame. DSH stores concatenated
  // independent frames, so find each boundary and decompress it separately.
  async function* chunks() {
    if (!path.toLowerCase().endsWith(".zstd")) { yield* source; return; }
    let compressed = Buffer.alloc(0);
    for await (const chunk of source) {
      compressed = Buffer.concat([compressed, chunk]);
      if (compressed.length > maxOutputLength) throw new Error("压缩帧超过读取大小限制");
      for (;;) {
        const { frames } = scanZstdFrames(compressed, 1);
        if (!frames.length) break;
        signal?.throwIfAborted();
        if (total >= maxOutputLength) throw new Error("会话日志解压总量超过限制");
        const frame = frames[0];
        yield await zstdDecompressAsync(compressed.subarray(frame.start, frame.end), { maxOutputLength: maxOutputLength - total });
        compressed = compressed.subarray(frame.end);
        if (!compressed.length) break;
      }
    }
    if (compressed.length) throw new Error("会话日志末帧不完整");
  }
  try {
    for await (const chunk of chunks()) {
      signal?.throwIfAborted();
      total += chunk.length;
      if (total > maxOutputLength) throw new Error("会话日志解压总量超过限制");
      pending += decoder.write(chunk);
      let start = 0, end;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        const line = pending.slice(start, end);
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("会话日志单行超过 8 MiB 限制");
        yield line;
        start = end + 1;
      }
      pending = pending.slice(start);
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) throw new Error("会话日志单行超过 8 MiB 限制");
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    source.destroy();
  }
}

async function findArtifactPath(dir) {
  for (const filename of ARTIFACT_NAMES) {
    const path = join(dir, filename);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** 从日志统计弹窗要展示的信息：cwd/轮次/用户消息/工具调用/最后活动。
 * 单行解析失败就跳过该行（尽力而为，不影响删除主流程）。
 */
async function sessionInfo(artifactPath) {
  let header;
  let title;
  let turns = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let firstTime;
  let lastTime;
  for await (const line of readArtifactLines(artifactPath, { maxOutputLength: 512 * 1024 * 1024 })) {
    if (line === "") continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj === null || typeof obj !== "object") continue;
    if (header === undefined && obj.type === "session") { header = obj; continue; }
    if (typeof obj.time === "number") {
      if (firstTime === undefined) firstTime = obj.time;
      lastTime = obj.time;
    }
    switch (obj.type) {
      case "session/title":
        if (obj.data && typeof obj.data.title === "string" && obj.data.title.trim() !== "") title = obj.data.title.trim();
        break;
      case "turn/start":
        turns += 1;
        break;
      case "user/message":
        if (obj.data && obj.data.source && obj.data.source.kind === "user") userMessages += 1;
        break;
      case "tool/call":
        toolCalls += 1;
        break;
      default:
        break;
    }
  }
  return {
    cwd: header && typeof header.cwd === "string" ? header.cwd : undefined,
    createdAt: header && typeof header.createdAt === "number" ? header.createdAt : undefined,
    title: title || undefined,
    turns,
    userMessages,
    toolCalls,
    firstTime,
    lastTime
  };
}

/** 取文本块的纯文本（与 session-lib.mjs 的 textFromContent 同一约定）。 */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out.join("\n").trim();
}

function collapseText(text, max = 500) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 长回复中间省略：保留开头与结尾，切点尽量落在换行边界上（Markdown 结构不被切碎）。 */
function elideMiddle(text, max = 1200, head = 700, tail = 300) {
  const t = String(text).trim();
  if (t.length <= max) return t;
  let h = t.slice(0, head);
  const hCut = h.lastIndexOf("\n");
  if (hCut > head * 0.5) h = h.slice(0, hCut);
  let tl = t.slice(-tail);
  const tCut = tl.indexOf("\n");
  if (tCut !== -1 && tCut < tail * 0.5) tl = tl.slice(tCut + 1);
  return h + "\n\n……（中间内容省略）……\n\n" + tl;
}

// ───────────────────────── 通用小工具 ─────────────────────────

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx) {
  try {
    const buildId = `${name} v${version}`;
    if (typeof ctx?.logger?.info === "function") ctx.logger.info(buildId);
    else if (typeof console !== "undefined" && console?.info) console.info(buildId);
  } catch (_) { /* ignore logging failures */ }

  const service = name => getService(ctx, name);
  const homePath = service("dshHomePath");
  if (typeof homePath !== "function") {
    ctx?.logger?.warn?.("session-cleaner: dshHomePath 服务不可用，插件功能停用");
    return;
  }

  /** Per-id operation queue so a double-click cannot start two deletions.
   * Every path that touches one session (delete / trash / restore / detail /
   * permanent delete) goes through the SAME key, so a restore can never
   * interleave with the permanent delete of the same session.
   */
  const operations = new Map();
  const mutate = (id, operation) => {
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}).finally(() => {
      if (operations.get(id) === settled) operations.delete(id);
    });
    operations.set(id, settled);
    return pending;
  };

  /** Batch slot: a batch takes this key first and each id's key second. A
   * single-session operation never takes the batch key, so the order
   * batch → id cannot deadlock. The key cannot collide with a session id:
   * assertSessionId rejects colons. */
  const BATCH_KEY = "::batch::";

  const mutateBatch = (operation) => mutate(BATCH_KEY, operation);

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) throw Object.assign(new Error("请求体超过 64 KiB"), { code: "body-too-large" });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  /** Every header-verified artifact directory for one session id.
   *
   * Discovery mirrors the host's own path computation exactly
   * (`sessionDir()` = <sessions>/<projectKey(cwd)>/<encodeSegment(id)>,
   * `generationLogFilename()` = the ARTIFACT_NAMES list), so no host service is
   * consulted: `resolveLog` no longer exists in current builds, and `locate()`
   * needs the stored header's `cwd` to name the project segment — passing an
   * id alone resolves to `_no-cwd` and points at a directory that is not there.
   * The disk pass also sees a second copy of one id, which the host's own
   * resolver refuses to disambiguate.
   */
  const scanSessionDirs = async (sessionId) => {
    assertSessionId(sessionId);
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const found = new Set();
    const tryRead = async (dir) => {
      try { await assertSessionDirectory(root, dir, sessionId); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      for (const filename of ARTIFACT_NAMES) {
        try {
          const header = await readSessionHeader(join(dir, filename));
          if (header.id !== sessionId) throw new Error("会话工件 header id 与请求不一致");
          return resolve(dir);
        } catch (error) {
          // 没有这个工件文件就试下一个名字；其余错误（损坏帧、JSON 非法、
          // id 不一致）立即抛出，绝不把读不动的目录交给 rm
          if (error.code === "ENOENT") continue;
          throw error;
        }
      }
      return undefined;
    };
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      for (const candidate of [encodeSessionSegment(sessionId), sessionId]) {
        const dir = await tryRead(join(root, proj.name, candidate));
        if (dir !== undefined) found.add(dir);
      }
    }
    return [...found];
  };

  /** Every session on disk as { id, dir, parentSession }, header-verified.
   *
   * One pass feeds both "where is this session" and "which sessions descend
   * from it": each log header is read once and yields the id together with the
   * `parentSession` the host stamps on a subagent's header.
   */
  const listAllSessionDirs = async () => {
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const out = [];
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return out; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      let entries;
      try { entries = await readdir(join(root, proj.name), { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = join(root, proj.name, entry.name);
        let header;
        try {
          for (const filename of ARTIFACT_NAMES) {
            try { header = await readSessionHeader(join(dir, filename)); break; }
            catch (error) { if (error.code === "ENOENT") continue; throw error; }
          }
        } catch { continue; } // 读不动的目录不当成会话，也不阻断整个扫描
        if (header === undefined || typeof header.id !== "string") continue;
        out.push({
          id: header.id,
          dir: resolve(dir),
          parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
          origin: typeof header.origin === "string" ? header.origin : undefined,
          isSeeded: header.isSeeded === true
        });
      }
    }
    return out;
  };

  /** Every session related to one root: its subagent descendants and its fork
   * branches (kept apart — only the former travel with it).
   *
   * The host decides parentage the same way: a session whose stored header
   * carries `origin: 'subagent'` and `parentSession: <id>` is that session's
   * child (dsh-session-persistence-jsonl's own children query filters exactly
   * those two fields). Subagents nest, so the walk is transitive with a depth
   * cap; a session already in the bin has no directory on disk and is therefore
   * not re-discovered.
   *
   * A forked session carries `parentSession` too, but only as lineage metadata
   * (`isSeeded: true`, no `origin`) — its event log is an independent copy, so
   * deleting the parent must not cascade into it. Those are returned as `forks`
   * so the caller can report how many were left untouched.
   */
  const collectRelatives = async (rootId, { maxDepth = 10000 } = {}) => {
    const all = await listAllSessionDirs();
    const directoriesById = new Map();
    for (const item of all) {
      const dirs = directoriesById.get(item.id) ?? new Set();
      dirs.add(item.dir); directoriesById.set(item.id, dirs);
    }
    const childrenByParent = new Map();
    const forksByParent = new Map();
    for (const item of all) {
      if (typeof item.parentSession !== "string" || item.parentSession === "") continue;
      if (item.origin !== "subagent") {
        const list = forksByParent.get(item.parentSession) ?? [];
        list.push(item);
        forksByParent.set(item.parentSession, list);
        continue;
      }
      const list = childrenByParent.get(item.parentSession) ?? [];
      list.push(item);
      childrenByParent.set(item.parentSession, list);
    }
    const out = [];
    const forks = [];
    const seen = new Set([rootId]);
    const seenForks = new Set();
    let frontier = [rootId];
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      for (const parent of frontier) {
        for (const fork of forksByParent.get(parent) ?? []) {
          if (seenForks.has(fork.id)) continue;
          seenForks.add(fork.id);
          forks.push(fork);
        }
      }
      if (depth === maxDepth) throw new Error("子会话层级超过安全限制，已停止操作");
      const next = [];
      for (const parent of frontier) {
        for (const child of childrenByParent.get(parent) ?? []) {
          if (directoriesById.get(child.id)?.size > 1) throw Object.assign(new Error("子会话存在重复日志目录，已停止操作：" + child.id), { code: "duplicate-session-dirs" });
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push(child);
          next.push(child.id);
        }
      }
      frontier = next;
    }
    return { descendants: out, forks };
  };

  /** The session's artifact directory, or undefined when it has none.
   *
   * Two verified copies of one id is a corrupt layout the host itself refuses
   * to resolve (`duplicate JSONL session id appears in multiple project
   * directories`). Refuse as well: deleting the first copy would leave the
   * other behind and report success.
   */
  const sessionDirOf = async (sessionId) => {
    const dirs = await scanSessionDirs(sessionId);
    if (dirs.length === 0) return undefined;
    if (dirs.length > 1) {
      throw Object.assign(
        new Error("发现同一会话的多个日志目录，已停止操作。请先清理多余的目录再重试：\n" + dirs.join("\n")),
        { code: "duplicate-session-dirs", dirs }
      );
    }
    return dirs[0];
  };

  const dirSize = async (dir) => {
    let total = 0;
    const walk = async (current) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const child = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else {
          try { total += (await lstat(child)).size; } catch { /* racing file: ignore */ }
        }
      }
    };
    try { await walk(dir); } catch { /* unreadable dir: report what we got */ }
    return total;
  };

  /** Refuse-active gate removed in v0.2.0: a live agent is now torn down
   * (see teardownLive) after the user confirms in the UI — the dialog warns
   * that the in-flight answer will be ended. */

  const detachFromWorkspaces = async (sessionId) => {
    const registry = service("workspaceRegistry");
    let detached = 0;
    if (!registry || typeof registry.list !== "function") return detached;
    for (const entity of registry.list()) {
      const ids = entity?.sessionIds;
      if (Array.isArray(ids) && ids.includes(sessionId) && typeof entity.detachSession === "function") {
        await entity.detachSession(sessionId);
        detached++;
      }
    }
    return detached;
  };

  /** Registry-global state mutation, serialized on the host's own operation
   * queue so a concurrent host write cannot interleave with ours. The mutator
   * returns the next state, or undefined to leave it alone.
   */
  const mutateGlobalState = async (mutator) => {
    const registry = service("workspaceRegistry");
    if (!registry || typeof registry.enqueueOperation !== "function"
      || typeof registry.requireState !== "function" || typeof registry.setState !== "function") return false;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!isRecord(state)) return;
      const next = mutator(state);
      if (next !== undefined && next !== state) await registry.setState(next);
    });
    return true;
  };

  /** Drop the id from the registry-global archived set (durable, serialized). */
  const unarchiveSession = async (sessionId) => mutateGlobalState((state) => {
    if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId) };
  });

  /** Where the id sits in the registry-global pin order, or undefined. */
  const pinnedIndexOf = (sessionId) => {
    try {
      const pinned = service("workspaceRegistry")?.pinnedSessionIds;
      if (pinned === undefined || pinned === null) return undefined;
      const index = Array.from(pinned).indexOf(sessionId);
      return index === -1 ? undefined : index;
    } catch { return undefined; }
  };

  /** Unpin one session. The pin set is registry-global, so a deleted session
   * must not keep a pin: it would outlive the session it names. */
  const clearPinnedSession = async (sessionId) => {
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.unpinSession === "function") {
      try { await registry.unpinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === undefined) return true;
    }
    return mutateGlobalState((state) => {
      if (!Array.isArray(state.pinnedSessionIds) || !state.pinnedSessionIds.includes(sessionId)) return undefined;
      return { ...state, pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) };
    });
  };

  /** Put a pin back where it was: the host prepends new pins, so simply
   * re-pinning would move a restored session to the front of the pin list. */
  const restorePinnedSession = async (sessionId, index) => {
    const at = Number.isInteger(index) && index >= 0 ? index : 0;
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.pinSession === "function") {
      try { await registry.pinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === at) return true;
    }
    return mutateGlobalState((state) => {
      const list = Array.isArray(state.pinnedSessionIds)
        ? state.pinnedSessionIds.filter(id => id !== sessionId)
        : [];
      list.splice(Math.min(at, list.length), 0, sessionId);
      return { ...state, pinnedSessionIds: list };
    });
  };

  /** The workspace record that owns this session, plus the anchor needed to
   * put it back later.
   *
   * `entity.sessionIds` is a filtered projection rebuilt on every access (it
   * drops ids the host's header index cannot resolve), so its index is not a
   * durable position. The id of the session that followed is: it stays stable
   * and `insertSessionBefore(id, anchor)` can relocate by anchor.
   */
  const captureWorkspaceSlot = async (sessionId) => {
    const slot = { workspaceId: undefined, workspacePath: undefined, index: undefined, anchorId: null, wasLast: false };
    try {
      for (const entity of (service("workspaceRegistry")?.list?.() ?? [])) {
        const ids = entity?.sessionIds;
        if (!Array.isArray(ids)) continue;
        const index = ids.indexOf(sessionId);
        if (index === -1) continue;
        slot.workspaceId = entity.id;
        slot.workspacePath = entity.path;
        slot.index = index;
        const anchor = ids[index + 1];
        slot.anchorId = typeof anchor === "string" && anchor !== sessionId ? anchor : null;
        slot.wasLast = slot.anchorId === null;
        break;
      }
    } catch { /* best-effort */ }
    return slot;
  };

  /** Put a restored session back into its workspace, at the slot it occupied.
   *
   * `attachSession` prepends, so the anchor session that used to follow it is
   * re-inserted in front of; a session that was last goes back to the end.
   * If the anchor is gone (deleted meanwhile) the session simply stays at the
   * head — the position is reported as not restored rather than guessed.
   */
  const restoreWorkspaceSlot = async (meta, sessionId) => {
    const result = { attached: false, positionRestored: false, error: undefined };
    const registry = service("workspaceRegistry");
    if (!registry) { result.error = "workspaceRegistry 服务不可用"; return result; }

    let entity;
    try {
      if (typeof meta.workspaceId === "string" && typeof registry.get === "function") {
        try { entity = registry.get(meta.workspaceId); } catch { entity = undefined; }
      }
      if (entity === undefined && typeof meta.workspacePath === "string") {
        for (const candidate of (registry.list?.() ?? [])) {
          if (candidate?.path === meta.workspacePath) { entity = candidate; break; }
        }
      }
    } catch (error) { result.error = safeErrorMessage(error); return result; }

    if (entity === undefined || typeof entity.attachSession !== "function") {
      result.error = "找不到原工作区";
      return result;
    }
    try {
      await entity.attachSession(sessionId);
      result.attached = true;
    } catch (error) {
      result.error = safeErrorMessage(error);
      return result;
    }

    if (typeof entity.insertSessionBefore !== "function") return result;
    const anchor = typeof meta.workspaceAnchorId === "string" && meta.workspaceAnchorId !== sessionId
      ? meta.workspaceAnchorId
      : undefined;
    if (anchor === undefined && meta.workspaceWasLast !== true) return result;
    try {
      // anchor 省略 = 追加到末尾（删除前它就是该工作区最后一条）
      await entity.insertSessionBefore(sessionId, anchor);
      result.positionRestored = true;
    } catch (error) {
      // 锚点会话可能已被删掉：停在头部即可，不再猜位置
      ctx?.logger?.warn?.("session-cleaner: 槽位还原失败，会话停在侧栏顶部: " + safeErrorMessage(error));
    }
    return result;
  };

  /** Whether the id currently sits in the registry-global archived set. */
  const isArchivedSession = (sessionId) => {
    try {
      const registry = service("workspaceRegistry");
      const archived = registry?.archivedSessionIds;
      if (archived !== undefined && archived !== null) return Array.from(archived).includes(sessionId);
      const state = typeof registry?.requireState === "function" ? registry.requireState() : undefined;
      return Array.isArray(state?.archivedSessionIds) && state.archivedSessionIds.includes(sessionId);
    } catch { return false; }
  };

  /** Put a restored session back into the archived set (the host appends). */
  const archiveSessionFlag = async (sessionId) => mutateGlobalState((state) => {
    const list = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
    if (list.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: [...list, sessionId] };
  });

  // ───────────────────── 绑定该会话的定时任务 ─────────────────────
  // 宿主 schedule 服务：catalog() 列全部（含已结束），list({sessionId}) 只列进行中，
  // delete({sessionId, id}) 删单条，stopSessionTasks(sessionId) 停掉该会话全部进行中。
  // 注意：任务**不能**原样重建（create 只接受选择器、强制新 id、清空发送历史），
  // 所以回收站这一步只抄录不删除——删除不可逆，而"移入回收站"必须可逆。
  // 宿主对"会话已不存在"的到期任务只记一条 warn，不会重建会话。

  const scheduleService = () => {
    try { return service("schedule"); } catch { return undefined; }
  };

  /** 该会话当前的定时任务（含已结束的历史行），只读。 */
  const listSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { supported: false, records: [] };
    try {
      if (typeof schedule.catalog === "function") {
        const all = await schedule.catalog();
        return { supported: true, records: (all ?? []).filter(entry => entry?.sessionId === sessionId) };
      }
      if (typeof schedule.list === "function") {
        const active = await schedule.list({ sessionId });
        return { supported: true, records: (active ?? []).map(record => ({ ...record, sessionId, status: "active" })) };
      }
    } catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 读取定时任务失败: " + safeErrorMessage(error));
    }
    return { supported: false, records: [] };
  };

  /** 彻底删除该会话时清掉它的定时任务：进行中的交给宿主自己的
   * stopSessionTasks（宿主归档会话时走的就是它），已结束的历史行逐条 delete。
   */
  const purgeSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { removed: 0, supported: false, error: undefined };
    let removed = 0;
    let supported = false;
    let error;

    if (typeof schedule.stopSessionTasks === "function") {
      supported = true;
      const before = await listSessionSchedules(sessionId);
      const active = before.records.filter(record => record.status === "active").length;
      try {
        await schedule.stopSessionTasks(sessionId);
        removed += active;
      } catch (cause) { error = safeErrorMessage(cause); }
    }

    if (typeof schedule.delete === "function") {
      supported = true;
      const left = await listSessionSchedules(sessionId);
      for (const record of left.records) {
        if (typeof record?.id !== "string" || record.id === "") continue;
        try {
          const result = await schedule.delete({ sessionId, id: record.id });
          if (result?.deleted === true) removed++;
        } catch (cause) { error ??= safeErrorMessage(cause); }
      }
    }
    return { removed, supported, error };
  };

  /** The projection-cache document path for one session, shape-checked. */
  const projcachePaths = (sessionId) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    if (typeof storages !== "string") return undefined;
    const sessionsRoot = resolve(storages, "session_projcache", "sessions");
    const target = resolve(sessionsRoot, `${sessionId}.json`);
    const rel = relative(sessionsRoot, target);
    if (isAbsolute(rel) || rel.split(sep).length !== 1 || rel !== `${sessionId}.json`) {
      throw new Error("投影缓存路径超出允许范围，已停止清理");
    }
    return { sessionsRoot, target };
  };

  /** The host's already-open projection-cache domain table, if reachable.
   * The domain stores one document per session (`per-record` layout), so
   * `table.delete(key)` really removes
   * <dshHome>/storages/session_projcache/sessions/<id>.json — and it keeps the
   * host's in-memory table in step with the disk. `ctx.storageDomain.get(name)`
   * returns the instance the host service already opened (it is not opened
   * again here: `open()` would throw `already-open`).
   */
  const projcacheDomainTable = () => {
    try {
      const domain = service("storageDomain")?.get?.("session_projcache");
      if (domain && typeof domain.table === "function") {
        const table = domain.table("sessions");
        if (table && typeof table.delete === "function") return table;
      }
    } catch { /* domain closed / not mounted */ }
    return undefined;
  };

  /** Ask the host's projection-cache service to drop one record, so its
   * in-memory table and the durable document agree instead of only the file
   * disappearing under a table that still holds the record.
   *
   * Three faces are tried in order of how directly the host owns the record:
   * the storage domain table, a public `remove` (no current build has one),
   * then the cache service's own table. Whatever happens, the caller removes
   * the file afterwards — that is the part that survives a restart.
   *
   * A domain `delete` answers `false` when the record is not in the table it
   * loaded, which means it did NOT touch the disk: that is not a success, so
   * the walk continues. (A record written by another process after boot is
   * exactly that case — the file removal below is what actually clears it.)
   *
   * `markClean` cancels a pending write-behind checkpoint of the live session,
   * which would otherwise re-create the record moments after we drop it.
   */
  const dropProjectionCacheRecord = async (sessionId, liveSession) => {
    const cache = service("sessionProjectionCache");
    if (liveSession !== undefined && liveSession !== null && typeof cache?.markClean === "function") {
      try { cache.markClean(liveSession); } catch { /* best-effort */ }
    }
    const table = projcacheDomainTable();
    if (table !== undefined) {
      try {
        const removed = await table.delete(sessionId);
        if (removed !== false) return true;
      } catch { /* fall through */ }
    }
    if (!cache || typeof cache !== "object") return false;
    if (typeof cache.remove === "function") {
      try { await cache.remove(sessionId); return true; } catch { /* fall through to the service table */ }
    }
    if (typeof cache.requireTable === "function") {
      try {
        const own = cache.requireTable();
        if (own && typeof own.delete === "function") {
          const removed = await own.delete(sessionId);
          if (removed !== false) return true;
        }
      } catch { /* fall through to the file */ }
    }
    return false;
  };

  /** Remove the projection-cache document for one session, plus any
   * `<id>.json.bak.<stamp>` copy the host's backup-and-skip path left behind.
   * The service call comes first (memory stays coherent); the file removal is
   * the authority, so a build without a usable removal API still ends clean.
   * The domain path deletes the file itself, so "did anything go away" is the
   * union of both attempts — not just whether we personally ran a rm.
   */
  const removeProjectionCacheRow = async (sessionId, liveSession) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return { removed: false, backups: 0, viaService: false };
    const viaService = await dropProjectionCacheRecord(sessionId, liveSession);

    let fileRemoved = false;
    let existedOnDisk = false;
    try {
      const info = await lstat(paths.target);
      if (!info.isSymbolicLink() && info.isFile()) {
        existedOnDisk = true;
        await rm(paths.target, { force: true });
        fileRemoved = true;
      }
    } catch (error) {
      // ENOENT 有两种情况：本来就没有，或者域表那一步已经把它删掉了
      if (error.code !== "ENOENT") throw error;
    }

    let backups = 0;
    try {
      for (const entry of await readdir(paths.sessionsRoot)) {
        if (!entry.startsWith(`${sessionId}.json.bak.`)) continue;
        if (relative(paths.sessionsRoot, resolve(paths.sessionsRoot, entry)).split(sep).length !== 1) continue;
        const info = await lstat(join(paths.sessionsRoot, entry)).catch(() => undefined);
        if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue;
        await rm(join(paths.sessionsRoot, entry), { force: true });
        backups++;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { removed: viaService || fileRemoved, backups, viaService, existedOnDisk };
  };

  /** End-of-life for in-memory state: cancel a running turn, dispose the
   * agent fiber (bounded in case teardown stalls), flush and detach the
   * session entry so every connected client drops the row. Every step is
   * best-effort with bounded waits.
   */
  const teardownLive = async (sessionId) => {
    const agents = service("agents");
    const sessions = service("sessions");
    let agent = undefined;
    try { agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined; } catch { agent = undefined; }
    let session = undefined;
    try { session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined; } catch { session = undefined; }

    if (agent !== undefined && agent !== null) {
      // Stop any running turn (disposed-kind suppresses re-wake), then quiesce
      // the agent's own fiber with a hard 3s bound.
      try { if (typeof agent.cancel === "function") agent.cancel({ kind: "disposed" }); } catch { /* best-effort */ }
      if (typeof agent.scope?.dispose === "function") {
        await Promise.race([agent.scope.dispose(), delay(3000)]);
      }
      // Drop the zombie from the registry so a later session.create/open with
      // the same id cannot resurrect it.
      try { agents?.store?.delete?.(sessionId); } catch { /* best-effort */ }
    }

    let detached = false;
    if (session !== undefined && session !== null) {
      // Flush buffered events to disk first so the retirement drain is a no-op.
      try { if (typeof sessions.flush === "function") await sessions.flush(session); } catch { /* best-effort */ }
      try {
        const entry = sessions?.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === "function") {
          entry.detach();
          await delay(200); // let the write-behind retirement settle
          detached = true;
        }
      } catch { /* best-effort */ }
    }
    if (!detached) {
      // Cold or already-detached session: emit explicitly so every connected
      // client drops the row.
      try { ctx.emit("session/disposed", { id: sessionId }); } catch { /* best-effort */ }
    }
    return {
      wasLiveAgent: agent !== undefined && agent !== null,
      wasLiveSession: session !== undefined && session !== null,
      // handed to the projection-cache cleanup: markClean() needs the session
      // object itself (the host keys its dirty map by object, not by id)
      liveSession: session
    };
  };

  // 旧版有一个"不进回收站直接物理删除"的 /delete 端点与一个 /status 查询端点：
  // 客户端从来不调用它们，而 /delete 是唯一会删投影缓存行的路径，读代码的人
  // 很容易据此以为"删除"覆盖了缓存行。两者已移除：删除只走回收站，
  // 彻底删除在回收站里做，缓存/记账/置顶/定时任务的清理也就都在同一条链上。

  // ───────────────────────── 回收站 ─────────────────────────
  // 「删除」把会话目录整体搬进 <dshHome>/dsh-session-cleaner/trash/items/<id>/，
  // 快照写在 trash/meta/<id>.json：原目录、工作区与槽位序号、投影缓存行原文、
  // 置顶状态、绑定该会话的定时任务。恢复时逐项还原，彻底删除才物理清除。
  // 保留期 30 天：启动跑一次，之后每 6 小时跑一次（DSH 长期不重启也会过期）。

  let retentionDays = 30;
  const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** A record written before the move: files may not be in the bin yet. */
  const META_STAGE_PREPARED = "prepared";
  /** A record whose files are in the bin and complete. */
  const META_STAGE_TRASHED = "trashed";
  /** A record repaired by startup reconciliation: the directory is in the bin
   * but its snapshot (original path and friends) is gone. */
  const META_STAGE_INCOMPLETE = "incomplete";

  const trashRoots = () => ({
    items: join(homePath("dsh-session-cleaner"), "trash", "items"),
    meta: join(homePath("dsh-session-cleaner"), "trash", "meta")
  });

  const itemDirOf = (sessionId) => join(trashRoots().items, sessionId);
  const metaPathOf = (sessionId) => join(trashRoots().meta, `${sessionId}.json`);
  const auditLogOf = () => join(homePath("dsh-session-cleaner"), "audit.log");
  const settingsPath = () => join(homePath("dsh-session-cleaner"), "settings.json");
  const writeJsonAtomic = async (target, value) => {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, target);
    } catch (error) { await rm(temp, { force: true }); throw error; }
  };
  const loadSettings = async () => {
    try {
      const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
      if (![0, 7, 30, 90].includes(settings.retentionDays)) throw new Error("无效的保留期设置");
      retentionDays = settings.retentionDays;
    } catch (error) {
      if (error.code !== "ENOENT") {
        retentionDays = 0; // A damaged setting must never enable destructive cleanup.
        ctx?.logger?.warn?.("session-cleaner: 保留期设置读取失败，已暂停自动清理: " + safeErrorMessage(error));
      }
    }
  };

  /** Append one operation record to the plugin's JSONL audit log. Never throws:
   * a failed audit write must not undo or block the deletion it describes. */
  const appendAudit = async (entry) => {
    try {
      await mkdir(homePath("dsh-session-cleaner"), { recursive: true });
      const line = JSON.stringify({ time: new Date().toISOString(), plugin: name, ...entry });
      await appendFile(auditLogOf(), line + "\n", "utf8");
    } catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 审计日志写入失败: " + safeErrorMessage(error));
    }
  };

  const readMeta = async (sessionId) => {
    try {
      const parsed = JSON.parse(await readFile(metaPathOf(sessionId), "utf8"));
      if (!isRecord(parsed) || parsed.id !== sessionId) return undefined;
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };

  const writeMeta = async (meta) => {
    const { meta: metaRoot } = trashRoots();
    await mkdir(metaRoot, { recursive: true });
    const temp = join(metaRoot, `${meta.id}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(meta, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, metaPathOf(meta.id));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const removeMeta = async (sessionId) => {
    await rm(metaPathOf(sessionId), { force: true });
  };

  const readProjcacheRow = async (sessionId) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return null;
    try {
      const info = await lstat(paths.target);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      return await readFile(paths.target, "utf8");
    } catch { return null; }
  };

  /** Write a snapshot of the projection-cache document back. The file is the
   * authority (it survives a restart); the host's own table is updated too
   * when it exposes one, so the running process agrees with the disk. */
  const writeProjcacheRow = async (sessionId, content) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) throw new Error("无法定位投影缓存目录");
    await mkdir(paths.sessionsRoot, { recursive: true });
    const temp = `${paths.target}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, paths.target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    // 内存侧同步：优先走宿主存储域的表（同一个实例），拿不到再用缓存服务自己的表
    const record = (() => { try { return JSON.parse(content)?.record; } catch { return undefined; } })();
    if (isRecord(record)) {
      const table = projcacheDomainTable();
      if (table !== undefined && typeof table.put === "function") {
        try { await table.put(sessionId, record); return; } catch { /* fall through */ }
      }
      const cache = service("sessionProjectionCache");
      if (cache && typeof cache.requireTable === "function") {
        try {
          const own = cache.requireTable();
          if (own && typeof own.put === "function") await own.put(sessionId, record);
        } catch (error) {
          ctx?.logger?.warn?.("session-cleaner: 投影缓存内存回写失败（文件已还原）: " + safeErrorMessage(error));
        }
      }
    }
  };

  const listTrash = async () => {
    const { meta: metaRoot } = trashRoots();
    let files;
    try { files = await readdir(metaRoot); }
    catch (error) { if (error.code === "ENOENT") return { items: [], totalBytes: 0 }; throw error; }
    const items = [];
    let totalBytes = 0;
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(metaRoot, file), "utf8"));
        if (!isRecord(parsed) || typeof parsed.id !== "string") continue;
        const ownBytes = Number(parsed.ownBytes ?? parsed.bytes) || 0;
        const bytes = parsed.filesPurged ? 0 : parsed.ownBytes === undefined
          ? ownBytes + (Array.isArray(parsed.descendants) ? parsed.descendants : []).reduce((sum, child) => sum + (Number(child?.bytes) || 0), 0)
          : Number(parsed.bytes) || 0;
        totalBytes += bytes;
        // 列表只回展示用的字段：子会话的回溯快照（含投影缓存行原文）很占体积，
        // 恢复/彻底删除都直接读 meta，不走这里。
        const descendants = Array.isArray(parsed.descendants)
          ? parsed.descendants.filter(isRecord).map(child => ({
            id: child.id,
            title: child.title,
            bytes: child.bytes,
            cwd: child.cwd
          }))
          : [];
        // 列表只回展示字段：投影缓存行原文（projcacheRow）可能很大，恢复/彻底
        // 删除都直接从 meta 文件读，不经这里。去掉它，避免条目一多响应就膨胀。
        const { projcacheRow: _droppedProjcacheRow, ...display } = parsed;
        items.push({ ...display, bytes, ownBytes, descendants,
          expiresAt: retentionDays > 0 && typeof parsed.deletedAt === "number" ? parsed.deletedAt + retentionDays * 86400000 : null });
      } catch { /* 跳过损坏的 meta */ }
    }
    return { items, totalBytes };
  };

  /** Archived sessions still on disk, as lightweight rows for the settings page.
   * Archived is not deleted: the files are intact, the id just sits in the
   * workspace registry's archived set, so this only reads headers and sizes. */
  // 归档列表缓存：设置页每次打开都会拉一次，全量扫描很贵；60 秒内复用。
  let archivedListCache = null;
  const invalidateArchivedList = () => { archivedListCache = null; };

  /** 从解压后的会话日志里提取「提问 + 助手回复」轮次（与回收站详情同一套解析）。 */
  const parseQuestions = async (artifact) => {
    let turnCounter = 0;
    const questions = [];
    let pendingTools = 0;
    let openQuestion;
    let lastAssistant;
    let lastAssistantModel;
    let userMessages = 0;
    let toolCalls = 0;
    const flushTurn = () => {
      if (openQuestion !== undefined) {
        openQuestion.toolCalls = pendingTools;
        openQuestion.assistantReply = lastAssistant ? elideMiddle(lastAssistant, 1200) : "";
        if (lastAssistantModel !== undefined) openQuestion.model = lastAssistantModel;
        questions.push(openQuestion);
        openQuestion = undefined;
      }
      pendingTools = 0;
      lastAssistant = undefined;
      lastAssistantModel = undefined;
    };
    for await (const line of readArtifactLines(artifact)) {
      if (line === "") continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e === null || typeof e !== "object") continue;
      switch (e.type) {
        case "turn/start":
          flushTurn();
          turnCounter += 1;
          break;
        case "user/message": {
          if (!e.data || !e.data.source || e.data.source.kind !== "user") break;
          const questionText = textFromContent(e.data.content);
          if (questionText === "") break;
          userMessages += 1;
          openQuestion = {
            turn: typeof e.data.turn === "number" ? e.data.turn : (turnCounter || undefined),
            time: typeof e.time === "number" ? e.time : undefined,
            question: collapseText(questionText, 500),
            toolCalls: 0,
            assistantReply: ""
          };
          break;
        }
        case "assistant/message": {
          const msg = e.data && e.data.message;
          const reply = textFromContent(msg ? msg.content : undefined);
          if (reply !== "") {
            lastAssistant = reply;
            if (msg && msg.source && typeof msg.source.model === "string" && msg.source.model !== "") {
              lastAssistantModel = msg.source.model;
            }
            if (openQuestion !== undefined && typeof e.data.turn === "number" && openQuestion.turn === undefined) {
              openQuestion.turn = e.data.turn;
            }
          }
          break;
        }
        case "tool/call":
          pendingTools += 1;
          toolCalls += 1;
          break;
        default:
          break;
      }
    }
    flushTurn();
    return { questions, turns: turnCounter, userMessages, toolCalls };
  };

  /** 已归档会话的详情（只读；归档不会删日志，所以能直接解析）。 */
  const archivedDetail = async (sessionId) => {
    assertSessionId(sessionId);
    if (!(await isArchivedSession(sessionId))) {
      throw Object.assign(new Error("该会话不在已归档列表"), { code: "session-not-found" });
    }
    const dir = await sessionDirOf(sessionId);
    const result = { sessionId, archived: true, questions: [] };
    if (dir === undefined) return result;
    let info = {};
    const artifact = await findArtifactPath(dir);
    if (artifact !== undefined) {
      try { info = await sessionInfo(artifact); } catch { /* keep defaults */ }
    }
    result.title = info.title;
    result.cwd = info.cwd;
    result.turns = info.turns ?? 0;
    result.userMessages = info.userMessages ?? 0;
    result.toolCalls = info.toolCalls ?? 0;
    result.lastTime = info.lastTime;
    try { result.bytes = await dirSize(dir); } catch { /* keep undefined */ }
    if (artifact !== undefined) {
      try {
        const parsed = await parseQuestions(artifact);
        result.questions = parsed.questions;
        if (!result.turns) result.turns = parsed.turns;
        if (!result.userMessages) result.userMessages = parsed.userMessages;
        if (!result.toolCalls) result.toolCalls = parsed.toolCalls;
      } catch (error) {
        result.parseError = safeErrorMessage(error);
        ctx?.logger?.warn?.("session-cleaner: 归档会话记录解析失败: " + safeErrorMessage(error));
      }
    }
    return result;
  };

  /** 目录名 → 绝对路径，一次扫描完成；不读会话头，避免为上百个会话解压日志。 */
  const sessionDirsByName = async () => {
    const root = homePath("sessions");
    const map = new Map();
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return map; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      let entries;
      try { entries = await readdir(join(root, proj.name), { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const list = map.get(entry.name) ?? [];
        list.push(join(root, proj.name, entry.name));
        map.set(entry.name, list);
      }
    }
    return map;
  };

  /** 标题与工作目录优先取投影缓存行（纯文件读，不解压日志）。 */
  const archivedRowMeta = async (sessionId) => {
    try {
      const content = await readProjcacheRow(sessionId);
      if (typeof content !== "string") return {};
      const record = JSON.parse(content)?.record;
      if (!isRecord(record)) return {};
      const title = record.rows && record.rows.title && typeof record.rows.title.val === "string"
        ? record.rows.title.val : undefined;
      const cwd = record.identity && typeof record.identity.cwd === "string"
        ? record.identity.cwd : undefined;
      return { title, cwd };
    } catch { return {}; }
  };

  const listArchivedSessions = async () => {
    if (archivedListCache !== null && Date.now() - archivedListCache.at < 60_000) {
      return archivedListCache.result;
    }
    const ids = new Set();
    try {
      const registry = service("workspaceRegistry");
      const archived = registry?.archivedSessionIds;
      if (archived !== undefined && archived !== null) {
        for (const id of archived) if (typeof id === "string") ids.add(id);
      } else {
        const state = typeof registry?.requireState === "function" ? registry.requireState() : undefined;
        if (Array.isArray(state?.archivedSessionIds)) for (const id of state.archivedSessionIds) ids.add(id);
      }
    } catch { /* registry unavailable: report nothing rather than fail the page */ }
    const dirsByName = await sessionDirsByName();
    const items = [];
    let totalBytes = 0;
    for (const id of ids) {
      try {
        assertSessionId(id);
        const dirs = dirsByName.get(encodeSessionSegment(id));
        if (dirs === undefined || dirs.length === 0) continue;
        const dir = dirs[0];
        const meta = await archivedRowMeta(id);
        let bytes = 0;
        let lastTime;
        try { bytes = await dirSize(dir); } catch { /* keep 0 */ }
        try { lastTime = (await lstat(dir)).mtimeMs; } catch { /* keep undefined */ }
        totalBytes += bytes;
        items.push({ id, title: meta.title, cwd: meta.cwd, bytes, lastTime });
      } catch (error) {
        ctx?.logger?.warn?.("session-cleaner: 归档会话读取失败（跳过）: " + safeErrorMessage(error));
      }
    }
    items.sort((a, b) => (Number(b.lastTime) || 0) - (Number(a.lastTime) || 0));
    const result = { items, totalBytes };
    archivedListCache = { at: Date.now(), result };
    return result;
  };

  /** Take one session out of the archived set (the host's own unarchive). */
  const unarchiveArchivedSession = async (sessionId) => {
    assertSessionId(sessionId);
    if (!(await isArchivedSession(sessionId))) {
      return { sessionId, unarchived: false, reason: "该会话不在已归档列表" };
    }
    await unarchiveSession(sessionId);
    if (await isArchivedSession(sessionId)) {
      throw Object.assign(new Error("取消归档失败：宿主没有更新归档状态"), { code: "unarchive-failed" });
    }
    invalidateArchivedList();
    return { sessionId, unarchived: true };
  };

  /** fork 血缘的读改写：删除父会话时摘掉 fork 的 `parentSession`，恢复父会话
   * 时再按快照写回去（`mode` = "detach" | "attach"）。
   *
   * 只改 header 那一行，事件日志原样保留；写入走"临时文件 + rename"，中途
   * 崩溃最坏是这次血缘没改到，不会留下半个日志。日志过大、不是 fork、读失败
   * 都返回原因而不抛错：血缘是附带信息，绝不能挡住删除或恢复本身。
   *
   * `changed` 才是"确实改写了"，`reason` 说明为什么没改（already-detached /
   * already-attached / too-large / missing 等），调用方据此如实回报。
   */
  const DETACH_MAX_BYTES = 48 * 1024 * 1024;
  const patchForkLineage = async (childId, parentId, mode, knownDir) => {
    let dir = knownDir;
    if (dir === undefined) {
      try { dir = await sessionDirOf(childId); }
      catch (error) { return { changed: false, reason: safeErrorMessage(error) }; }
    }
    if (dir === undefined) return { changed: false, reason: "missing" };
    let artifact;
    try { artifact = await findArtifactPath(dir); }
    catch (error) { return { changed: false, reason: safeErrorMessage(error) }; }
    if (artifact === undefined) return { changed: false, reason: "no-artifact" };
    let info;
    try { info = await lstat(artifact); }
    catch (error) { return { changed: false, reason: safeErrorMessage(error) }; }
    if (info.size > DETACH_MAX_BYTES) return { changed: false, reason: "too-large" };
    let text;
    try { ({ text } = await decompressArtifact(artifact, { maxOutputLength: 256 * 1024 * 1024 })); }
    catch (error) { return { changed: false, reason: safeErrorMessage(error) }; }
    const lines = text.split("\n");
    const index = lines.findIndex(line => line.trim() !== "");
    if (index === -1) return { changed: false, reason: "empty" };
    let header;
    try { header = JSON.parse(lines[index]); } catch { return { changed: false, reason: "bad-header" }; }
    if (!isRecord(header) || header.id !== childId) return { changed: false, reason: "not-a-fork" };
    if (mode === "detach") {
      if (header.parentSession === undefined) return { changed: false, reason: "already-detached" };
      if (header.parentSession !== parentId) return { changed: false, reason: "not-a-fork" };
      delete header.parentSession;
    } else {
      if (header.parentSession === parentId) return { changed: false, reason: "already-attached" };
      header.parentSession = parentId;
    }
    lines[index] = JSON.stringify(header);
    const next = lines.join("\n");
    const temp = `${artifact}.${randomBytes(6).toString("hex")}.${mode}.tmp`;
    try {
      if (artifact.toLowerCase().endsWith(".zstd")) {
        const CHUNK = 4 * 1024 * 1024;
        const frames = [];
        for (let offset = 0; offset < next.length; offset += CHUNK) {
          frames.push(await zstdCompressAsync(Buffer.from(next.slice(offset, offset + CHUNK), "utf8")));
        }
        await writeFile(temp, Buffer.concat(frames));
      } else {
        await writeFile(temp, next, "utf8");
      }
      await rename(temp, artifact);
      return { changed: true };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      return { changed: false, reason: safeErrorMessage(error) };
    }
  };

  /** 在已归档会话的正文里搜关键词（提问 + 助手回复），返回每条的命中数。 */
  // Cache only compact results, never full conversation text. Stat changes invalidate entries.
  const searchCache = new Map();
  const searchArtifact = async (artifact, needle, signal) => {
    signal?.throwIfAborted();
    const info = await lstat(artifact);
    const key = JSON.stringify([artifact, info.size, info.mtimeMs, needle]);
    if (searchCache.has(key)) return searchCache.get(key);
    let hits = 0, snippet = "";
    for await (const line of readArtifactLines(artifact, { signal })) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      let spoken = "";
      if (event?.type === "user/message" && event.data?.source?.kind === "user") spoken = textFromContent(event.data.content);
      else if (event?.type === "assistant/message") spoken = textFromContent(event.data?.message?.content);
      const lower = spoken.toLowerCase();
      let at = 0, found;
      while (hits < 10000 && (found = lower.indexOf(needle, at)) !== -1) {
        if (!snippet) snippet = spoken.slice(Math.max(0, found - 45), found + needle.length + 100);
        hits++; at = found + needle.length;
      }
    }
    const result = { hits, snippet };
    searchCache.set(key, result);
    if (searchCache.size > 256) searchCache.delete(searchCache.keys().next().value);
    return result;
  };
  const searchSessions = async (items, locate, keyword, signal) => {
    const needle = keyword.toLowerCase(), matches = {}, snippets = {}, errors = [];
    let scanned = 0;
    for (const item of items) {
      signal?.throwIfAborted();
      let hits = String(item.title || "").toLowerCase().includes(needle) ? 1 : 0;
      try {
        const dir = await locate(item);
        const artifact = dir ? await findArtifactPath(dir) : undefined;
        if (artifact) {
          const result = await searchArtifact(artifact, needle, signal);
          hits += result.hits;
          if (result.snippet) snippets[item.id] = result.snippet;
        }
        scanned++;
      } catch (error) {
        signal?.throwIfAborted();
        errors.push({ sessionId: item.id, error: safeErrorMessage(error) });
      }
      if (hits > 0) matches[item.id] = hits;
    }
    return { keyword, scanned, matches, snippets, errors };
  };
  const searchArchived = async (keyword, signal) => {
    const { items } = await listArchivedSessions();
    const dirs = await sessionDirsByName();
    return searchSessions(items, item => dirs.get(encodeSessionSegment(item.id))?.[0], keyword, signal);
  };

  const checkUpdate = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(
        "https://api.github.com/repos/iMankoppai/DSH-Chat-Delete/releases/latest",
        { signal: controller.signal, headers: { Accept: "application/vnd.github+json" } }
      );
      if (!response.ok) return { checked: false, error: "HTTP " + response.status };
      const pkg = await response.json();
      const latest = typeof pkg.tag_name === "string" ? pkg.tag_name.replace(/^v/, "") : undefined;
      if (!latest || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latest)) return { checked: false, error: "无效的发行版本号" };
      return {
        checked: true,
        current: version,
        latest,
        hasUpdate: isNewerVersion(latest, version),
        url: "https://github.com/iMankoppai/DSH-Chat-Delete/releases"
      };
    } catch (error) {
      return { checked: false, error: safeErrorMessage(error) };
    } finally { clearTimeout(timer); }
  };

  /** Move every archived session into the recycle bin (reversible). */
  const trashAllArchived = async () => {
    const { items } = await listArchivedSessions();
    const results = [];
    let moved = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const r = await trashSession(item.id);
        if (r && r.trashed === true) {
          moved++;
          results.push({ id: item.id, ok: true });
        } else {
          failed++;
          results.push({ id: item.id, ok: false, reason: "未移入" });
        }
      } catch (error) {
        failed++;
        results.push({ id: item.id, ok: false, error: safeErrorMessage(error) });
      }
    }
    invalidateArchivedList();
    return { total: items.length, moved, failed, results: results.slice(0, 50) };
  };

  /** Everything one session leaves behind, captured before anything moves.
   *
   * The same shape is used for the session being deleted and for every
   * descendant discovered under it, so a restore can put each one back and a
   * permanent delete can finish each one off.
   */
  const captureSession = async (sessionId, knownDir) => {
    // 已知目录（后代扫描刚验证过）就不必再全盘找一遍
    const dir = knownDir !== undefined ? knownDir : await sessionDirOf(sessionId);
    const bytes = dir !== undefined ? await dirSize(dir) : 0;
    let info = {};
    let projcacheRow = null;
    if (dir !== undefined) {
      try {
        const artifactPath = await findArtifactPath(dir);
        if (artifactPath !== undefined) info = await sessionInfo(artifactPath);
      } catch (error) { ctx?.logger?.warn?.("session-cleaner: 会话信息解析失败: " + safeErrorMessage(error)); }
      try { projcacheRow = await readProjcacheRow(sessionId); } catch { /* best-effort */ }
    }
    const slot = await captureWorkspaceSlot(sessionId);
    const wasArchived = await isArchivedSession(sessionId);
    const pinIndex = pinnedIndexOf(sessionId);
    const schedules = await listSessionSchedules(sessionId);
    return {
      id: sessionId,
      originalDir: dir !== undefined ? resolve(dir) : undefined,
      workspaceId: slot.workspaceId,
      workspacePath: slot.workspacePath,
      workspaceIndex: slot.index,
      workspaceAnchorId: slot.anchorId,
      workspaceWasLast: slot.wasLast,
      bytes,
      cwd: info.cwd,
      title: info.title,
      turns: info.turns ?? 0,
      userMessages: info.userMessages ?? 0,
      toolCalls: info.toolCalls ?? 0,
      lastTime: info.lastTime,
      projcacheRow,
      wasArchived,
      wasPinned: pinIndex !== undefined,
      pinIndex,
      schedules: schedules.records,
      schedulesSupported: schedules.supported
    };
  };

  /** Take one captured session out of DSH: drop its accounting traces and move
   * its directory into the bin. `targetDir` is where the directory goes.
   * Returns what actually happened so the caller can report it.
   */
  const extractSession = async (snapshot, targetDir, liveSession) => {
    const { id } = snapshot;
    const workspacesDetached = await detachFromWorkspaces(id);
    await unarchiveSession(id);
    await clearPinnedSession(id);
    let filesMoved = false;
    if (typeof snapshot.originalDir === "string") {
      await assertSessionDirectory(homePath("sessions"), snapshot.originalDir, id);
      await mkdir(dirname(targetDir), { recursive: true });
      if (await existsDir(targetDir)) throw Object.assign(new Error("回收站目标目录已存在，已停止搬移"), { code: "target-exists" });
      await rename(snapshot.originalDir, targetDir);
      filesMoved = true;
    }
    const cache = await removeProjectionCacheRow(id, liveSession);
    return { filesMoved, workspacesDetached, cache };
  };

  /** Put one captured session back: directory, projection cache, workspace slot
   * at its original position, pin and archive flag. `fromDir` is where the
   * session's directory currently sits (the bin item, or the parent item's
   * `.children/` folder for a descendant).
   */
  const reinstateSession = async (snapshot, fromDir, { resume = false } = {}) => {
    const { id } = snapshot;
    const warnings = [];
    let filesRestored = false;
    let restoredTo;
    if (typeof snapshot.originalDir === "string") {
      const root = homePath("sessions");
      const target = resolve(snapshot.originalDir);
      await assertSessionDirectory(root, target, id, { allowMissing: true });
      let alreadyHome = false;
      try {
        await lstat(target);
        if (resume && !(await existsDir(fromDir))) {
          await assertSessionDirectory(root, target, id);
          const artifact = await findArtifactPath(target);
          if (!artifact || (await readSessionHeader(artifact)).id !== id) throw new Error("已恢复目录的会话标识不匹配");
          alreadyHome = true;
        } else throw Object.assign(new Error("目标位置已存在同名会话目录，无法恢复: " + target), { code: "target-exists" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!alreadyHome) {
        await mkdir(dirname(target), { recursive: true });
        await rename(fromDir, target);
      }
      filesRestored = true;
      restoredTo = target;
    }
    let cacheRestored = false;
    if (typeof snapshot.projcacheRow === "string") {
      try { await writeProjcacheRow(id, snapshot.projcacheRow); cacheRestored = true; }
      catch (error) {
        warnings.push("会话日志已恢复，但投影缓存写回失败: " + safeErrorMessage(error));
        ctx?.logger?.warn?.("session-cleaner: 投影缓存行写回失败: " + safeErrorMessage(error));
      }
    }
    const slot = await restoreWorkspaceSlot(snapshot, id);
    if (!slot.attached) {
      ctx?.logger?.warn?.("session-cleaner: 记账挂回失败: " + (slot.error ?? "未知原因"));
      warnings.push(typeof restoredTo === "string" ? "会话已恢复到磁盘，但未能挂回侧栏。文件位置: " + restoredTo : "未能恢复会话侧栏记账。");
    } else if (!slot.positionRestored) {
      warnings.push("会话已恢复，但侧栏原位置未能还原。");
    }
    let archivedRestored = false;
    let pinRestored = false;
    if (snapshot.wasArchived === true) archivedRestored = await archiveSessionFlag(id);
    else if (snapshot.wasPinned === true) pinRestored = await restorePinnedSession(id, snapshot.pinIndex);
    if (snapshot.wasArchived && !archivedRestored) warnings.push("归档状态未能还原。");
    else if (snapshot.wasPinned && !pinRestored) warnings.push("置顶状态未能还原。");
    return {
      sessionId: id,
      attached: slot.attached,
      positionRestored: slot.positionRestored,
      filesRestored,
      cacheRestored,
      archivedRestored,
      pinRestored,
      restoredTo,
      ...(warnings.length ? { warning: warnings.join("；") } : {})
    };
  };

  /** Finish one captured session off for good: its bin directory (handled by
   * the caller), plus every trace it left — cache row and backups, schedules,
   * and the project directory once it is empty. */
  const finishOffSession = async (snapshot) => {
    const { id } = snapshot;
    const notes = [];
    let complete = true;
    try {
      const cache = await removeProjectionCacheRow(id);
      if (cache.removed || cache.backups > 0) {
        notes.push(`补清投影缓存${cache.backups > 0 ? `（含 ${cache.backups} 个备份）` : ""}`);
      }
    } catch (error) { complete = false; notes.push("投影缓存清理失败: " + safeErrorMessage(error)); }
    try {
      const schedules = await purgeSessionSchedules(id);
      if (schedules.removed > 0) notes.push(`清除 ${schedules.removed} 个定时任务`);
      if (schedules.error !== undefined) { complete = false; notes.push("定时任务部分失败: " + schedules.error); }
    } catch (error) { complete = false; notes.push("定时任务清理失败: " + safeErrorMessage(error)); }
    if (await removeEmptyProjectDir(snapshot.originalDir)) notes.push("已删空的工程目录");
    return { notes, complete };
  };

  const trashSession = async (sessionId) => {
    assertSessionId(sessionId);
    const existing = await readMeta(sessionId);
    if (existing?.stage === META_STAGE_TRASHED) {
      return { sessionId, trashed: true, alreadyTrashed: true, filesMoved: existing.filesMoved === true };
    }
    if (existing || await existsDir(itemDirOf(sessionId))) {
      throw Object.assign(new Error("该会话存在未完成的回收站操作，请先恢复或检查数据"), { code: "operation-incomplete" });
    }
    invalidateArchivedList();
    const live = await teardownLive(sessionId);

    const snapshot = await captureSession(sessionId);
    // 子会话一起处理：宿主的父 agent 销毁会级联 dispose 子 agent，但子会话的
    // 日志、记账、缓存行不会自己消失。发现顺序即快照顺序，恢复时按同序还原。
    const { descendants, forks } = await collectRelatives(sessionId);
    const descendantsSnapshots = [];
    for (const child of descendants) {
      descendantsSnapshots.push(await captureSession(child.id, child.dir));
    }
    // fork 分支原地保留，但要把指向被删父会话的血缘摘掉，避免以后指向不存在
    // 的 id。摘之前先把「它的 parentSession 是谁」记进快照——恢复父会话时就靠
    // 这份记录写回去。摘除动作放到文件搬完之后再做：搬移失败就不必动血缘。
    const forkRecords = forks
      .filter(fork => typeof fork.parentSession === "string")
      .map(fork => ({
        id: fork.id,
        parentSession: fork.parentSession,
        originalDir: typeof fork.dir === "string" ? fork.dir : undefined,
        detached: false
      }));

    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    await mkdir(itemsRoot, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    const childrenRoot = join(itemsRoot, sessionId, ".children");
    const baseMeta = {
      version: 3,
      id: sessionId,
      originalDir: snapshot.originalDir,
      workspaceId: snapshot.workspaceId,
      workspacePath: snapshot.workspacePath,
      workspaceIndex: snapshot.workspaceIndex,
      workspaceAnchorId: snapshot.workspaceAnchorId,
      workspaceWasLast: snapshot.workspaceWasLast,
      deletedAt: Date.now(),
      ownBytes: snapshot.bytes,
      bytes: snapshot.bytes + descendantsSnapshots.reduce((sum, child) => sum + child.bytes, 0),
      cwd: snapshot.cwd,
      title: snapshot.title,
      turns: snapshot.turns,
      userMessages: snapshot.userMessages,
      toolCalls: snapshot.toolCalls,
      lastTime: snapshot.lastTime,
      projcacheRow: snapshot.projcacheRow,
      wasArchived: snapshot.wasArchived,
      wasPinned: snapshot.wasPinned,
      pinIndex: snapshot.pinIndex,
      schedules: snapshot.schedules,
      schedulesSupported: snapshot.schedulesSupported,
      descendants: descendantsSnapshots,
      // fork 血缘快照：删除时摘掉的 parentSession 在恢复时要写回去
      forks: forkRecords
    };

    // 先写快照再搬文件：中途崩溃只会留下"快照说文件该在回收站但还在原位"，
    // 启动对账能认出来并回滚；反过来（先搬后写）会留下看不见的孤儿目录。
    await writeMeta({ ...baseMeta, stage: META_STAGE_PREPARED, filesMoved: false });

    const extracted = await extractSession(snapshot, join(itemsRoot, sessionId), live.liveSession);
    const childResults = [];
    for (const child of descendantsSnapshots) {
      const targetDir = typeof child.originalDir === "string"
        ? join(childrenRoot, child.id)
        : join(childrenRoot, `${child.id}.nofiles`);
      childResults.push({ id: child.id, ...(await extractSession(child, targetDir)) });
    }
    // 文件都进回收站之后才动 fork 血缘：这一步失败也不影响删除本身，
    // 只是那个 fork 的来源标记留着了（恢复时再处理也无害）。
    const detachedForks = [];
    for (const record of forkRecords) {
      const outcome = await patchForkLineage(record.id, record.parentSession, "detach", record.originalDir);
      record.detached = outcome.changed === true;
      if (outcome.reason !== undefined) record.reason = outcome.reason;
      detachedForks.push({ id: record.id, ...outcome });
    }
    await writeMeta({ ...baseMeta, stage: META_STAGE_TRASHED, filesMoved: extracted.filesMoved });
    await appendAudit({
      action: "trash",
      sessionId,
      title: snapshot.title,
      bytes: baseMeta.bytes,
      descendants: childResults.length,
      forksKept: forks.length,
      forksDetached: detachedForks.filter(entry => entry.changed === true).length,
      wasLive: live.wasLiveAgent
    });

    return {
      sessionId,
      trashed: true,
      filesMoved: extracted.filesMoved,
      bytes: baseMeta.bytes,
      workspacesDetached: extracted.workspacesDetached,
      cacheRemoved: extracted.cache.removed,
      cacheBackupsRemoved: extracted.cache.backups,
      cacheViaService: extracted.cache.viaService,
      schedulesKept: snapshot.schedules.length,
      schedulesSupported: snapshot.schedulesSupported,
      descendants: childResults.map(r => ({ sessionId: r.id, filesMoved: r.filesMoved })),
      descendantsCount: childResults.length,
      forkBranchesKept: forks.length,
      forkBranchesDetached: detachedForks.filter(entry => entry.changed === true).length,
      ...(forkRecords.length ? { forkBranchIds: forkRecords.map(f => f.id) } : {}),
      wasPinned: snapshot.wasPinned,
      wasArchived: snapshot.wasArchived,
      wasLiveAgent: live.wasLiveAgent,
      wasLiveSession: live.wasLiveSession
    };
  };

  const restoreSession = async (sessionId) => {
    assertSessionId(sessionId);
    invalidateArchivedList();
    let meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
    if (meta.stage === "purging") throw Object.assign(new Error("该项已开始彻底删除，只能重试清理剩余记录"), { code: "operation-incomplete" });
    if (meta.stage === META_STAGE_PREPARED) {
      await reconcileTrash();
      meta = await readMeta(sessionId);
      if (!meta) return { sessionId, recovered: true, filesRestored: true };
      if (meta.stage === META_STAGE_PREPARED) throw Object.assign(new Error("搬移回滚尚未完成，已保留快照，请排除目录冲突后重试"), { code: "operation-incomplete" });
    }

    // 启动对账收编的孤儿：目录在回收站里，但删除时的快照没了，原路径不可知
    if (meta.stage === META_STAGE_INCOMPLETE) {
      throw Object.assign(
        new Error("这一项缺少删除时的快照，无法确定原路径，只能彻底删除：" + (meta.incomplete ?? "")),
        { code: "incomplete-item" }
      );
    }

    const itemDir = itemDirOf(sessionId);

    // 崩溃窗口：快照写了但文件还没搬走（stage=prepared）。原位仍在就说明
    // 这次删除其实没发生，撤掉残留快照即可，不算一次恢复。
    if (meta.stage !== "restoring" && (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true)) {
      const stillThere = typeof meta.originalDir === "string" && await existsDir(resolve(meta.originalDir));
      if (stillThere && !(await existsDir(itemDir))) {
        await removeMeta(sessionId);
        return {
          sessionId,
          restored: false,
          recovered: true,
          message: "该会话从未离开原位，已清除回收站里的残留记录。"
        };
      }
    }

    const descendants = (Array.isArray(meta.descendants) ? meta.descendants : []).filter(isRecord);
    const members = [...descendants, meta]; // Empty the container before moving its parent.
    const fromDir = member => member.id === sessionId ? itemDir : join(itemDir, ".children", assertSessionId(member.id));
    const started = new Set(meta.restoreStarted ?? []);
    // Check every destination before moving even one member. Resume only moves
    // journaled by this restore, and verify their on-disk identity on replay.
    for (const member of members) {
      assertSessionId(member.id);
      if (typeof member.originalDir !== "string") continue;
      const target = await assertSessionDirectory(homePath("sessions"), member.originalDir, member.id, { allowMissing: true });
      const inBin = await existsDir(fromDir(member));
      const atHome = await existsDir(target);
      if (atHome && !(meta.stage === "restoring" && started.has(member.id) && !inBin)) {
        throw Object.assign(new Error("目标位置已存在同名会话目录，无法恢复: " + target), { code: "target-exists" });
      }
      if (!inBin && !atHome) throw Object.assign(new Error("回收站数据不完整：会话目录缺失（" + member.id + "）"), { code: "session-not-found" });
      if (!inBin && atHome) {
        const artifact = await findArtifactPath(target);
        if (!artifact || (await readSessionHeader(artifact)).id !== member.id) throw new Error("恢复进度与磁盘会话不匹配");
      }
    }
    meta = { ...meta, stage: "restoring", restoreStarted: [...started] };
    await writeMeta(meta);
    const memberResults = [];
    for (const member of members) {
      started.add(member.id);
      meta.restoreStarted = [...started];
      await writeMeta(meta); // Persist intent before rename, including a crash between rename and bookkeeping.
      memberResults.push(await reinstateSession(member, fromDir(member), { resume: true }));
    }
    const main = memberResults.pop();
    const childResults = memberResults;
    await rm(itemDirOf(sessionId), { recursive: true, force: true });

    // 定时任务从未被搬动，这里只回报它们仍在（宿主不允许原样重建任务）
    const schedules = await listSessionSchedules(sessionId);

    // fork 血缘还原：删除时摘掉的 parentSession 按快照写回去。写回是幂等的
    // （header 里已经有了就跳过），所以即使快照里的 detached 标记因崩溃窗口
    // 没更新到，也不会重复写入。fork 已被删掉、日志过大或读失败时跳过并如实
    // 回报，绝不影响恢复本身。
    const forkResults = [];
    for (const fork of (Array.isArray(meta.forks) ? meta.forks : [])) {
      if (!isRecord(fork) || typeof fork.id !== "string" || typeof fork.parentSession !== "string") continue;
      const outcome = await patchForkLineage(fork.id, fork.parentSession, "attach",
        typeof fork.originalDir === "string" ? fork.originalDir : undefined);
      forkResults.push({ id: fork.id, ...outcome });
    }
    const forksReattached = forkResults.filter(entry => entry.changed === true).length;
    const forksSkipped = forkResults.filter(entry => entry.changed !== true).length;
    const tooLargeForks = forkResults.filter(entry => entry.reason === "too-large").length;

    await removeMeta(sessionId);
    await appendAudit({
      action: "restore",
      sessionId,
      title: meta.title,
      descendants: childResults.length,
      forksReattached
    });

    const warnings = [...childResults, main].filter(result => result.warning)
      .map(result => result.sessionId + ": " + result.warning);
    if (tooLargeForks > 0) {
      warnings.push(`${tooLargeForks} 个 fork 分支的日志超过 48MB，来源标记未能还原`);
    }

    return {
      ...main,
      schedulesKept: schedules.records.length,
      archived: main.archivedRestored === true,
      pinned: main.pinRestored === true,
      forksReattached,
      forksSkipped,
      ...(warnings.length ? { warning: warnings.join("；") } : {}),
      descendants: childResults.map(r => ({ sessionId: r.sessionId, filesRestored: r.filesRestored })),
      descendantsCount: childResults.length
    };
  };

  /** Permanently remove binned sessions: the artifact directory, the snapshot,
   * any surviving projection-cache document (plus its backups), any schedule
   * still bound to the session, and the project directory once it is empty.
   * A binned session that carried descendants takes every one of them with it.
   */
  const deleteFromTrash = async (ids) => {
    const { items: itemsRoot } = trashRoots();
    const itemsRootResolved = resolve(itemsRoot);
    const results = [];
    let freedBytes = 0;
    for (const id of ids) {
      assertSessionId(id);
      const itemDir = resolve(itemsRoot, id);
      const rel = relative(itemsRootResolved, itemDir);
      if (rel.split(sep).length !== 1 || rel !== id) {
        throw new Error("回收站路径超出允许范围，已停止删除");
      }
      // 快照与存在性都放在锁内重新读：读锁外的话，"刚被恢复的那一项"会被
      // 当成还在回收站里，于是它的投影缓存行与定时任务被误清。
      try {
        const entry = await mutate(id, async () => {
          const meta = await readMeta(id);
          const itemExists = await existsDir(itemDir);
          if (meta && ![META_STAGE_TRASHED, META_STAGE_INCOMPLETE, "purging"].includes(meta.stage)) {
            throw Object.assign(new Error("存在未完成的搬移或恢复，请先完成恢复后再彻底删除"), { code: "operation-incomplete" });
          }
          if (!itemExists && meta === undefined) {
            return {
              sessionId: id,
              deleted: false,
              skipped: true,
              reason: "回收站里已经没有这一项（可能已被恢复或已被删除）"
            };
          }
          const notes = [];
          const snapshot = meta ?? { id };
          await writeMeta({ ...snapshot, stage: "purging" });
          await rm(itemDir, { recursive: true, force: true });
          await writeMeta({ ...snapshot, stage: "purging", filesPurged: true });
          if (itemExists) freedBytes += (Number(meta?.bytes) || 0) + (meta?.ownBytes === undefined
            ? (meta?.descendants ?? []).reduce((sum, child) => sum + (Number(child?.bytes) || 0), 0) : 0);
          // 主会话：缓存行 / 定时任务 / 空工程目录
          const mainCleanup = await finishOffSession(snapshot);
          notes.push(...mainCleanup.notes);
          let complete = mainCleanup.complete;
          // 子会话逐个收尾（目录已随主项一起 rm 掉）
          let descendantsPurged = 0;
          for (const child of Array.isArray(meta?.descendants) ? meta.descendants : []) {
            if (!isRecord(child) || typeof child.id !== "string") continue;
            const childCleanup = await finishOffSession(child);
            complete &&= childCleanup.complete;
            if (childCleanup.notes.length > 0) notes.push(`${child.id}: ${childCleanup.notes.join("；")}`);
            descendantsPurged++;
          }

          if (!complete) return { sessionId: id, deleted: false, filesDeleted: true, notes, error: notes.join("；") };
          await removeMeta(id);
          await appendAudit({
            action: "purge",
            sessionId: id,
            title: meta?.title,
            bytes: Number(meta?.bytes) || 0,
            descendantsPurged
          });

          return {
            sessionId: id,
            deleted: true,
            descendantsPurged,
            ...(notes.length ? { notes } : {})
          };
        });
        results.push(entry);
      } catch (error) {
        results.push({ sessionId: id, deleted: false, error: safeErrorMessage(error) });
      }
    }
    return { results, freedBytes };
  };

  const emptyTrash = async () => {
    const { items } = await listTrash();
    return deleteFromTrash(items.map(item => item.id));
  };

  const searchTrash = async (keyword, signal) => {
    const { items } = await listTrash();
    return searchSessions(items, item => itemDirOf(item.id), keyword, signal);
  };

  const exportSession = async (sessionId, source, format) => {
    assertSessionId(sessionId);
    if (!["trash", "archived"].includes(source) || !["json", "md"].includes(format)) {
      throw Object.assign(new Error("无效的导出来源或格式"), { code: "bad-request" });
    }
    let dir, title = sessionId;
    if (source === "trash") {
      const meta = await readMeta(sessionId);
      if (!meta) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
      dir = itemDirOf(sessionId); title = meta.title || title;
    } else {
      if (!(await isArchivedSession(sessionId))) throw Object.assign(new Error("该会话不在归档列表"), { code: "session-not-found" });
      dir = await sessionDirOf(sessionId);
    }
    const artifact = dir ? await findArtifactPath(dir) : undefined;
    if (!artifact) throw Object.assign(new Error("没有可导出的日志"), { code: "session-not-found" });
    const records = [], markdown = ["# " + title, ""];
    for await (const line of readArtifactLines(artifact, { maxOutputLength: 64 * 1024 * 1024 })) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (format === "json") records.push(event);
      else {
        let role, content;
        if (event?.type === "user/message" && event.data?.source?.kind === "user") { role = "User"; content = textFromContent(event.data.content); }
        else if (event?.type === "assistant/message") { role = "Assistant"; content = textFromContent(event.data?.message?.content); }
        if (content) markdown.push("## " + role, "", content, "");
      }
    }
    return { filename: encodeSessionSegment(sessionId) + "." + format,
      mime: format === "json" ? "application/json" : "text/markdown;charset=utf-8",
      content: format === "json" ? JSON.stringify({ version: 1, sessionId, events: records }, null, 2) : markdown.join("\n") };
  };

  /** 会话的工程目录（<sessions>/<项目段>/）在最后一个会话离开后一并删掉。 */
  const removeEmptyProjectDir = async (originalDir) => {
    if (typeof originalDir !== "string" || originalDir === "") return false;
    const root = homePath("sessions");
    if (typeof root !== "string") return false;
    const projectDir = dirname(resolve(originalDir));
    const rel = relative(resolve(root), projectDir);
    if (isAbsolute(rel) || rel === "" || rel.includes("..") || rel.split(sep).length !== 1) return false;
    try {
      if ((await readdir(projectDir)).length > 0) return false;
      await rmdir(projectDir);
      return true;
    } catch { return false; }
  };

  const purgeExpiredTrash = async () => {
    if (retentionDays === 0) return { removed: 0 };
    const { items } = await listTrash();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const expired = items.filter(item => item.stage === META_STAGE_TRASHED && typeof item.deletedAt === "number" && item.deletedAt < cutoff);
    if (expired.length === 0) return { removed: 0 };
    const result = await deleteFromTrash(expired.map(item => item.id));
    const removed = result.results.filter(r => r.deleted).length;
    ctx?.logger?.info?.(`session-cleaner: 回收站自动清理 ${removed} 条超过 ${retentionDays} 天的会话`);
    return { removed };
  };

  /** 下次自动清理的时刻，供面板展示（启动跑一次，之后按间隔跑）。 */
  let nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;

  const runRetentionPurge = async () => {
    try { return await purgeExpiredTrash(); }
    catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 回收站过期清理失败: " + safeErrorMessage(error));
      return { removed: 0 };
    } finally {
      nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;
    }
  };

  function existsDir(path) {
    return lstat(path).then(info => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
  }

  /** 回收站内查看对话记录：解压日志按事件流还原每轮提问（与黑窗口 d N 同源）。 */
  const trashDetail = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
    const { items: itemsRoot } = trashRoots();
    const result = {
      sessionId,
      title: meta.title,
      cwd: meta.cwd,
      turns: meta.turns ?? 0,
      userMessages: meta.userMessages ?? 0,
      toolCalls: meta.toolCalls ?? 0,
      bytes: meta.bytes ?? 0,
      lastTime: meta.lastTime,
      deletedAt: meta.deletedAt,
      questions: []
    };
    if (typeof meta.originalDir !== "string") return result; // 无磁盘文件的空白会话
    const artifact = await findArtifactPath(join(itemsRoot, sessionId));
    if (artifact === undefined) return result;
    try {
      const parsed = await parseQuestions(artifact);
      result.questions = parsed.questions;
    } catch (error) {
      result.parseError = safeErrorMessage(error);
      ctx?.logger?.warn?.("session-cleaner: 回收站对话记录解析失败: " + safeErrorMessage(error));
    }
    return result;
  };

  /** 启动对账：把回收站的两半（items/ 与 meta/）对齐，修掉崩溃留下的中间态。
   *
   *  - stage=prepared（快照已写、文件还没搬完）按"全有或全无"处理：
   *    该会话连同它的子会话，每一个都进了回收站 → 升级为 trashed；
   *    只要还有一个留在原位 → 整次删除没发生，把已搬走的逐个搬回原位并撤掉快照
   *  - trashed 但原位又出现（恢复的最后一步崩溃）→ 撤掉快照
   *  - 有目录、没有快照（旧版本或异常中断的孤儿）→ 造一条 stage=incomplete 的快照，
   *    让它至少可见、可彻底删除，而不是永远占着磁盘又显示不出来
   *  - 残留的 .tmp 快照 → 删掉
   */
  const reconcileTrash = async () => {
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    const report = { repaired: 0, rolledBack: 0, adopted: 0, tempRemoved: 0 };

    let metaFiles = [];
    try { metaFiles = await readdir(metaRoot); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const file of metaFiles) {
      if (file.endsWith(".tmp")) {
        await rm(join(metaRoot, file), { force: true }).catch(() => {});
        report.tempRemoved++;
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      let meta;
      try { meta = JSON.parse(await readFile(join(metaRoot, file), "utf8")); }
      catch { continue; }
      if (!isRecord(meta) || typeof meta.id !== "string") continue;

      const descendants = Array.isArray(meta.descendants) ? meta.descendants.filter(isRecord) : [];
      const itemDir = itemDirOf(id);
      const binDirOf = (childId) => join(itemDir, ".children", childId);

      // 每个成员各自"在回收站里"还是"还在原位"
      const members = [
        { id, originalDir: meta.originalDir, binDir: itemDir },
        ...descendants.map(child => ({
          id: child.id,
          originalDir: child.originalDir,
          binDir: binDirOf(child.id)
        }))
      ].filter(m => typeof m.id === "string");
      const state = [];
      for (const m of members) {
        state.push({
          ...m,
          inBin: await existsDir(m.binDir),
          atHome: typeof m.originalDir === "string" && await existsDir(resolve(m.originalDir))
        });
      }

      if (meta.stage === "restoring" || meta.stage === "purging") {
        // Keep the journal until the user retries; never purge a partial restore.
        continue;
      }
      if (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true) {
        const allInBin = state.every(m => m.inBin || typeof m.originalDir !== "string");
        if (allInBin) {
          await writeMeta({ ...meta, stage: META_STAGE_TRASHED, filesMoved: true });
          report.repaired++;
        } else {
          // 整次删除没发生：把已搬进回收站的逐个搬回原位。复用恢复逻辑，
          // 连同投影缓存行、侧栏记账、置顶/归档一起还原——否则会留下
          // "文件回来了、却从侧栏消失且标题丢失"的半坏状态。
          let failed = false;
          for (const m of [...state.slice(1), state[0]]) {
            if (!m.inBin && !m.atHome) continue;
            const snapshot = m.id === id ? meta : descendants.find(d => d.id === m.id);
            if (!isRecord(snapshot)) continue;
            try { await reinstateSession(snapshot, m.binDir, { resume: true }); }
            catch (error) {
              failed = true;
              ctx?.logger?.warn?.("session-cleaner: 对账回滚未完成，已保留快照: " + safeErrorMessage(error));
              break;
            }
          }
          if (!failed) { await removeMeta(id); report.rolledBack++; }
        }
      } else if (!(await existsDir(itemDir)) && typeof meta.originalDir === "string"
        && await existsDir(resolve(meta.originalDir))) {
        // 文件已经搬回原位，快照却没删掉（恢复的最后一步崩溃）
        await removeMeta(id);
        report.rolledBack++;
      }
    }

    let itemDirs = [];
    try {
      itemDirs = (await readdir(itemsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => entry.name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const id of itemDirs) {
      try { assertSessionId(id); } catch { continue; }
      if (await readMeta(id) !== undefined) continue;
      const bytes = await dirSize(itemDirOf(id)).catch(() => 0);
      await writeMeta({
        version: 3,
        id,
        stage: META_STAGE_INCOMPLETE,
        filesMoved: true,
        deletedAt: Date.now(),
        bytes,
        incomplete: "缺少删除时的快照（异常中断留下的），无法确定原路径，只能彻底删除"
      });
      report.adopted++;
    }

    if (report.repaired + report.rolledBack + report.adopted + report.tempRemoved > 0) {
      ctx?.logger?.info?.("session-cleaner: 回收站对账 → 修复 " + report.repaired
        + " / 回滚 " + report.rolledBack + " / 收编孤儿 " + report.adopted
        + " / 清临时 " + report.tempRemoved);
    }
    return report;
  };

  // 启动：先对账再清过期；之后每 6 小时清一次（DSH 长期不重启也会过期）
  let ready;
  ctx.effect(() => {
    ready = (async () => {
      await loadSettings();
      await reconcileTrash();
      await mutateBatch(() => runRetentionPurge());
    })();
    ready.catch(error => ctx?.logger?.warn?.("session-cleaner: 初始化失败: " + safeErrorMessage(error)));
    const timer = setInterval(() => ready.then(() => mutateBatch(() => runRetentionPurge())).catch(error => {
      ctx?.logger?.warn?.("session-cleaner: 自动清理失败: " + safeErrorMessage(error));
    }), TRASH_PURGE_INTERVAL_MS);
    if (typeof timer?.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "session-cleaner: trash reconciliation and retention");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once?.("aborted", abort);
      res.once?.("close", abort);
      try {
        await ready;
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (req.method === "POST" && path === "/session/export") {
          const result = await mutateBatch(() => mutate(sessionId, () => exportSession(sessionId, body.source, body.format)));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "GET" && path === "/health") {
          return send(res, 200, { ok: true, result: { plugin: name } });
        }
        if (req.method === "GET" && path === "/version") {
          return send(res, 200, { ok: true, result: { version } });
        }
        if (req.method === "GET" && path === "/settings") {
          return send(res, 200, { ok: true, result: { retentionDays } });
        }
        if (req.method === "POST" && path === "/settings") {
          if (![0, 7, 30, 90].includes(body.retentionDays)) return send(res, 400, { ok: false, error: "retentionDays 必须是 0、7、30 或 90" });
          await mutateBatch(async () => {
            await writeJsonAtomic(settingsPath(), { retentionDays: body.retentionDays });
            retentionDays = body.retentionDays;
          });
          return send(res, 200, { ok: true, result: { retentionDays } });
        }
        if (req.method === "POST" && path === "/update-check") {
          const result = await checkUpdate();
          return send(res, 200, { ok: true, result });
        }
        // 单会话操作：全部走同一个会话锁（同一 id 的"恢复"与"彻底删除"不会交错）
        if (req.method === "POST" && path === "/trash") {
          assertSessionId(sessionId);
          const result = await mutateBatch(() => mutate(sessionId, () => trashSession(sessionId)));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/list") {
          const result = await listTrash();
          return send(res, 200, {
            ok: true,
            result: {
              ...result,
              retentionDays,
              nextPurgeAt: retentionDays > 0 ? nextPurgeAt : null,
              schedulesSupported: scheduleService() !== undefined
            }
          });
        }
        if (req.method === "POST" && path === "/archived/list") {
          const result = await listArchivedSessions();
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/archived/search") {
          const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
          if (keyword === "") return send(res, 400, { ok: false, error: "keyword 必填", code: "bad-request" });
          if (keyword.length > 256) return send(res, 400, { ok: false, error: "搜索词不能超过 256 字符" });
          const result = await searchArchived(keyword, controller.signal);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/archived/unarchive") {
          assertSessionId(sessionId);
          const result = await mutateBatch(() => mutate(sessionId, () => unarchiveArchivedSession(sessionId)));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/archived/detail") {
          assertSessionId(sessionId);
          const result = await mutateBatch(() => mutate(sessionId, () => archivedDetail(sessionId)));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/archived/trash-all") {
          const result = await mutateBatch(() => trashAllArchived());
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/search") {
          const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
          if (keyword === "") return send(res, 400, { ok: false, error: "keyword 必填", code: "bad-request" });
          if (keyword.length > 256) return send(res, 400, { ok: false, error: "搜索词不能超过 256 字符" });
          const result = await searchTrash(keyword, controller.signal);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/detail") {
          assertSessionId(sessionId);
          const result = await mutateBatch(() => mutate(sessionId, () => trashDetail(sessionId)));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/restore") {
          assertSessionId(sessionId);
          const result = await mutateBatch(() => mutate(sessionId, () => restoreSession(sessionId)));
          return send(res, 200, { ok: true, result });
        }
        // 批量操作：先占批量位，再逐条占各自的会话位（batch → id，无死锁）
        if (req.method === "POST" && path === "/trash/delete") {
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [sessionId];
          const ids = Array.from(new Set(rawIds.filter(id => typeof id === "string" && id.trim() !== "").map(id => id.trim())));
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          for (const id of ids) assertSessionId(id);
          const result = await mutateBatch(() => deleteFromTrash(ids));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/empty") {
          const result = await mutateBatch(() => emptyTrash());
          return send(res, 200, { ok: true, result });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx?.logger?.warn?.("session-cleaner: api error: " + safeErrorMessage(error));
        const status = error?.code === "bad-request" || error?.code === "body-too-large" ? 400
          : error?.code === "session-not-found" ? 404
          : ["session-active", "duplicate-session-dirs", "incomplete-item", "target-exists", "operation-incomplete"].includes(error?.code) ? 409
          : 500;
        return send(res, status, { ok: false, error: safeErrorMessage(error), ...(typeof error?.code === "string" ? { code: error.code } : {}) });
      } finally {
        req.removeListener?.("aborted", abort);
        res.removeListener?.("close", abort);
      }
    }
  }), "session-cleaner: http api");
}
