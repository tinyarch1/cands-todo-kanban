import { getStore } from "@netlify/blobs";

const MCP = "https://ai.cands.kr/mcp/";
const H = (k, sid) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${k}`,
  ...(sid ? { "mcp-session-id": sid } : {}),
});
async function rpc(key, body, sid) {
  const r = await fetch(MCP, { method: "POST", headers: H(key, sid), body: JSON.stringify(body) });
  const t = await r.text();
  let j = null;
  const m = t.match(/data:\s*(\{.*\})/);
  try { j = JSON.parse(m ? m[1] : t); } catch {}
  return { r, j };
}
export async function mcpCall(tool, args = {}) {
  const key = (process.env.CANDS_KEY || "").trim();
  if (!key) throw new Error("CANDS_KEY not set");
  const init = await rpc(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "todo-kanban", version: "1" } } });
  const sid = init.r.headers.get("mcp-session-id") || undefined;
  await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const { j } = await rpc(key, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, sid);
  const txt = j?.result?.content?.[0]?.text;
  if (!txt) throw new Error("MCP empty: " + JSON.stringify(j).slice(0, 200));
  return JSON.parse(txt);
}

export const store = () => getStore("todo-board");
export async function loadBoard() {
  return (await store().get("board", { type: "json" })) || { items: [], lastSync: null, lastError: null };
}
export async function saveBoard(b) { await store().setJSON("board", b); }

const STATE = { plan: "계획", do: "실행", act: "조치", check: "점검" };
export async function sync() {
  const board = await loadBoard();
  const found = new Map();
  try {
    const ins = await mcpCall("platform_insights");
    for (const c of ins.cards || []) {
      for (const it of c.issues?.items || []) {
        const f = found.get(it.id) || { id: it.id, title: `${it.id}`, nodes: [], phase: STATE[it.state] || it.state, href: "https://ai.cands.kr" + it.href };
        f.nodes.push(`${c.node_id} ${c.scope}`);
        found.set(it.id, f);
      }
    }
    for (const svc of ["service-requests", "notifications"]) {
      try {
        const r = await mcpCall("platform_records", { service: svc, limit: 20 });
        for (const rec of r.records || []) {
          const id = `${svc}:${rec.id ?? rec.title}`;
          found.set(id, { id, title: rec.title || String(rec.id), nodes: [svc], phase: rec.status || "", href: "" });
        }
      } catch {}
    }
    const byId = new Map(board.items.map((i) => [i.id, i]));
    const now = new Date().toISOString();
    for (const f of found.values()) {
      const ex = byId.get(f.id);
      if (ex) Object.assign(ex, { nodes: f.nodes, phase: f.phase, href: f.href || ex.href, seen: now, stale: false });
      else board.items.push({ ...f, status: "doing", source: "cands", created: now, seen: now });
    }
    for (const i of board.items) if (i.source === "cands" && !found.has(i.id)) i.stale = true;
    board.lastSync = now; board.lastError = null;
  } catch (e) { board.lastError = String(e.message || e); }
  await saveBoard(board);
  return board;
}
