// 저장소 + 동기화. 쓰기 영역 분리로 동시 쓰기 유실 방지 (#3):
//   cands  : sync 전용 (cands 쪽 필드)
//   u/<id> : 사용자 전용 (status, moved, memo, due, priority, owner, hidden, 수동카드) - 항목 단위 키
//   meta   : sync 결과(lastSync, lastError, warnings, lastSyncStats)
import { getStore } from "@netlify/blobs";
import { McpClient } from "./mcp.mjs";
import { extractInsights, extractRecords, mergeCands, assemble, cleanPatch } from "./merge.mjs";

export const defaultStore = () => getStore("todo-board");
const ukey = (id) => "u/" + Buffer.from(String(id)).toString("base64url");
const EMPTY_META = { lastSync: null, lastError: null, warnings: [], lastSyncStats: null };

async function loadUsers(st) {
  const { blobs } = await st.list({ prefix: "u/" });
  const recs = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
  return new Map(recs.filter(Boolean).map((r) => [r.id, r]));
}

/** v1(단일 'board' 키) → v2 분리 저장 1회 마이그레이션 */
async function migrateLegacy(st) {
  const legacy = await st.get("board", { type: "json" });
  if (!legacy) return;
  if (!(await st.get("cands", { type: "json" }))) {
    const cands = legacy.items.filter((i) => i.source === "cands").map(({ status, moved, ...c }) => c);
    await st.setJSON("cands", { items: cands });
    for (const i of legacy.items) {
      if (i.source === "manual") await st.setJSON(ukey(i.id), i);
      else if (i.status && i.status !== "doing") await st.setJSON(ukey(i.id), { id: i.id, status: i.status, moved: i.moved });
    }
    await st.setJSON("meta", { ...EMPTY_META, lastSync: legacy.lastSync || null, lastError: legacy.lastError || null });
  }
  await st.delete("board");
}

export async function getBoard(st) {
  await migrateLegacy(st);
  const [meta, cands, users] = await Promise.all([st.get("meta", { type: "json" }), st.get("cands", { type: "json" }), loadUsers(st)]);
  return { ...EMPTY_META, ...(meta || {}), items: assemble(cands?.items || [], users) };
}

/** 사용자 필드 갱신. 해당 항목 키만 읽고 쓴다. */
export async function updateItem(st, id, patch) {
  const cur = await st.get(ukey(id), { type: "json" });
  let isManual = cur?.source === "manual";
  if (!cur) {
    const cands = await st.get("cands", { type: "json" });
    if (!(cands?.items || []).some((i) => i.id === id)) return false;
  }
  const clean = cleanPatch(patch, isManual);
  if (!clean) return false;
  const next = { ...(cur || { id }), ...clean };
  if (clean.status && clean.status !== (cur?.status || "doing")) next.moved = new Date().toISOString();
  await st.setJSON(ukey(id), next);
  return true;
}

export async function addManual(st, title, now = new Date().toISOString()) {
  const t = String(title || "").trim().slice(0, 200);
  if (!t) return false;
  const id = "manual:" + Date.now() + Math.random().toString(36).slice(2, 6);
  await st.setJSON(ukey(id), { id, title: t, source: "manual", status: "doing", created: now });
  return true;
}

/** manual은 삭제, cands 카드는 숨김 처리 */
export async function removeItem(st, id) {
  const cur = await st.get(ukey(id), { type: "json" });
  if (cur?.source === "manual") { await st.delete(ukey(id)); return true; }
  return updateItem(st, id, { hidden: true });
}

export async function runSync(st, { client, now = new Date().toISOString(), limit = 50 } = {}) {
  const t0 = Date.now();
  const old = (await st.get("meta", { type: "json" })) || EMPTY_META;
  const warnings = [];
  let meta;
  try {
    const found = extractInsights(await client.callTool("platform_insights"));
    const ok = new Set(["insights"]);
    for (const svc of ["service-requests", "notifications"]) {
      try {
        const r = await client.callTool("platform_records", { service: svc, limit });
        extractRecords(found, svc, r);
        if ((r.records || []).length >= limit) warnings.push(`${svc}: 조회 한도(${limit}건)에 도달해 일부 항목이 누락됐을 수 있습니다`);
        else ok.add(svc);
      } catch (e) { warnings.push(`${svc} 조회 실패: ${e.message}`); }
    }
    // MCP 조회가 끝난 뒤, 저장 직전에 cands 블롭을 읽어 병합(경합 구간 최소화). 사용자 키는 건드리지 않는다.
    const prev = (await st.get("cands", { type: "json" })) || { items: [] };
    const items = mergeCands(prev.items, found, now, ok);
    await st.setJSON("cands", { items });
    meta = { lastSync: now, lastError: null, warnings, lastSyncStats: { ms: Date.now() - t0, found: found.size, added: items.length - prev.items.length, httpCalls: client.requests } };
  } catch (e) {
    meta = { ...old, lastError: String(e.message || e), warnings };
  }
  await st.setJSON("meta", meta);
  return meta;
}

export function makeClient() {
  const key = (process.env.CANDS_KEY || "").trim();
  if (!key) throw new Error("CANDS_KEY not set");
  return new McpClient(key);
}
export async function sync(st = defaultStore()) {
  let client;
  try { client = makeClient(); } catch (e) {
    const old = (await st.get("meta", { type: "json" })) || EMPTY_META;
    await st.setJSON("meta", { ...old, lastError: e.message });
    return;
  }
  await runSync(st, { client, limit: Number(process.env.RECORDS_LIMIT) || 50 });
}
