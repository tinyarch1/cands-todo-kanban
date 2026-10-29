import test from "node:test";
import assert from "node:assert/strict";
import { parseRpc, McpClient } from "../netlify/functions/mcp.mjs";
import { safeHref, mergeCands, extractInsights, assemble, cleanPatch } from "../netlify/functions/merge.mjs";
import { runSync, getBoard, updateItem, addManual, removeItem } from "../netlify/functions/lib.mjs";
import { createHandler } from "../netlify/functions/api.mjs";
import { makeToken, verifyToken } from "../netlify/functions/auth.mjs";

function fakeStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const INS = { cards: [{ node_id: "N1", scope: "S", issues: { items: [{ id: "SCM-1", state: "plan", href: "/x/1", title: "제목1" }] } }] };
const NOW = "2026-10-29T00:00:00.000Z";

test("parseRpc: JSON / SSE(여러 이벤트) / id 선택", () => {
  assert.equal(parseRpc('{"id":2,"result":1}', 2).result, 1);
  const sse = 'event: message\ndata: {"id":1,"result":"a"}\n\nevent: message\ndata: {"id":2,"result":"b"}\n';
  assert.equal(parseRpc(sse, 2).result, "b");
  assert.equal(parseRpc("garbage", 1), null);
});

test("safeHref: 외부 도메인 차단", () => {
  assert.equal(safeHref("/a/b"), "https://ai.cands.kr/a/b");
  assert.equal(safeHref("@evil.com/x"), "https://ai.cands.kr/@evil.com/x");
  assert.equal(safeHref("https://evil.com/x"), "");
  assert.equal(safeHref("javascript:alert(1)"), "");
});

test("mergeCands: 신규 / 갱신 / stale / 실패 그룹은 stale 제외", () => {
  const found = extractInsights(INS);
  let items = mergeCands([], found, NOW, new Set(["insights"]));
  assert.equal(items[0].title, "제목1"); assert.equal(items[0].phase, "계획"); assert.equal(items[0].stale, false);
  items.push({ id: "notifications:a", source: "cands", title: "a", nodes: [], phase: "", href: "" });
  items = mergeCands(items, new Map(), NOW, new Set(["insights"]));
  assert.equal(items.find((i) => i.id === "SCM-1").stale, true);
  assert.equal(items.find((i) => i.id === "notifications:a").stale, undefined); // notifications 조회 실패 -> 유지
});

test("cleanPatch 검증", () => {
  assert.equal(cleanPatch({ status: "x" }), null);
  assert.equal(cleanPatch({ due: "내일" }), null);
  assert.deepEqual(cleanPatch({ title: "t", memo: "m" }, false), { memo: "m" });
  assert.equal(cleanPatch({ title: "t" }, true).title, "t");
});

test("McpClient: 동기화 1회 HTTP 5회, 5xx 재시도", async () => {
  let n = 0;
  const fetchImpl = async (u, o) => {
    n++; const b = JSON.parse(o.body);
    if (b.method === "initialize") return new Response('{"id":1,"result":{}}', { headers: { "mcp-session-id": "S" } });
    if (b.method === "notifications/initialized") return new Response("", { status: 202 });
    return new Response("event: message\ndata: " + JSON.stringify({ id: b.id, result: { content: [{ text: JSON.stringify(INS) }] } }));
  };
  const c = new McpClient("k", { fetchImpl, baseDelay: 1 });
  const st = fakeStore();
  const meta = await runSync(st, { client: c, now: NOW });
  assert.equal(meta.lastError, null); assert.equal(c.requests, 5); assert.equal(n, 5);
  let k = 0;
  const flaky = new McpClient("k", { baseDelay: 1, fetchImpl: async () => (++k < 3 ? new Response("", { status: 503 }) : new Response('{"id":1,"result":{}}')) });
  await flaky.post({ id: 1 }, 1); assert.equal(k, 3);
});

test("MCP 장애: lastError 기록 후 정상 종료, 일부 실패는 warnings", async () => {
  const st = fakeStore();
  const down = { requests: 0, async callTool() { throw new Error("boom"); } };
  assert.equal((await runSync(st, { client: down, now: NOW })).lastError, "boom");
  const part = { requests: 1, async callTool(n) { if (n === "platform_insights") return INS; throw new Error("x"); } };
  const meta = await runSync(st, { client: part, now: NOW });
  assert.equal(meta.warnings.length, 2); assert.equal(meta.lastError, null);
});

test("sync 실행 중 사용자가 카드를 이동해도 유지 (#3)", async () => {
  const st = fakeStore();
  await runSync(st, { client: { requests: 0, callTool: async (n) => (n === "platform_insights" ? INS : { records: [] }) }, now: NOW });
  let release; const gate = new Promise((r) => (release = r));
  const slow = { requests: 0, async callTool(n) { await gate; return n === "platform_insights" ? INS : { records: [] }; } };
  const p = runSync(st, { client: slow, now: "2026-10-29T01:00:00.000Z" });
  assert.equal(await updateItem(st, "SCM-1", { status: "done" }), true);
  release(); await p;
  const b = await getBoard(st);
  assert.equal(b.items.find((i) => i.id === "SCM-1").status, "done");
  assert.equal(b.items.find((i) => i.id === "SCM-1").seen, "2026-10-29T01:00:00.000Z");
});

test("수동 카드 추가/수정/삭제, cands 카드는 숨김", async () => {
  const st = fakeStore();
  await runSync(st, { client: { requests: 0, callTool: async (n) => (n === "platform_insights" ? INS : { records: [] }) }, now: NOW });
  await addManual(st, "It's <b>\"x\"</b>");
  let b = await getBoard(st); const man = b.items.find((i) => i.source === "manual");
  assert.equal(man.title, "It's <b>\"x\"</b>");
  assert.equal(await updateItem(st, man.id, { status: "done", memo: "m", title: "새 제목" }), true);
  b = await getBoard(st); assert.equal(b.items.find((i) => i.id === man.id).title, "새 제목");
  await removeItem(st, man.id); await removeItem(st, "SCM-1");
  b = await getBoard(st); assert.equal(b.items.length, 0);
  assert.equal(await updateItem(st, "nope", { status: "done" }), false);
});

test("v1 단일 board 마이그레이션", async () => {
  const st = fakeStore();
  await st.setJSON("board", { lastSync: NOW, lastError: null, items: [{ id: "SCM-1", title: "t", source: "cands", status: "done", nodes: [], phase: "", href: "" }, { id: "manual:1", title: "m", source: "manual", status: "doing" }] });
  const b = await getBoard(st);
  assert.equal(b.items.find((i) => i.id === "SCM-1").status, "done"); assert.ok(b.items.find((i) => i.id === "manual:1")); assert.equal(st.m.has("board"), false);
});

test("API: 인증 / 로그인 / 쿠키 / 제한 / 라우팅", async () => {
  const st = fakeStore(); const env = { APP_PASSWORD: "pw1" };
  const h = createHandler({ store: () => st, doSync: async () => {}, env });
  const rq = (path, method = "GET", body, cookie) => new Request("https://x.test/api/" + path, { method, body: body && JSON.stringify(body), headers: cookie ? { cookie } : {} });
  assert.equal((await h(rq("todos"))).status, 401);
  assert.equal((await h(rq("login", "POST", { password: "bad" }), { ip: "1.1.1.1" })).status, 401);
  const ok = await h(rq("login", "POST", { password: "pw1" }), { ip: "1.1.1.1" });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie"); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  const ck = sc.split(";")[0];
  assert.equal((await h(rq("todos", "GET", null, ck))).status, 200);
  assert.equal((await h(rq("todos", "GET", null, "sid=1.bad"))).status, 401);
  assert.equal((await h(rq("nope", "POST", {}, ck))).status, 404);
  assert.equal((await h(rq("move", "POST", { id: "x", status: "done" }, ck))).status, 400);
  for (let i = 0; i < 10; i++) await h(rq("login", "POST", { password: "bad" }), { ip: "2.2.2.2" });
  assert.equal((await h(rq("login", "POST", { password: "pw1" }), { ip: "2.2.2.2" })).status, 429);
});

test("토큰 만료/위조", () => {
  const t = makeToken("s", 1000);
  assert.equal(verifyToken("s", t, 2000), true);
  assert.equal(verifyToken("other", t, 2000), false);
  assert.equal(verifyToken("s", t, 1000 + 8 * 24 * 3600 * 1000), false);
});
