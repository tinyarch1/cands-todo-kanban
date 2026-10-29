"use strict";
// innerHTML을 쓰지 않고 DOM API + 이벤트 위임만 사용 -> 제목/ID에 ' " < > 가 있어도 안전 (#2)
const $ = (id) => document.getElementById(id);
const COLS = ["doing", "done"];
let board = { items: [] };
let busy = false;

function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = "none"), 3500); }

class AuthError extends Error {}
async function api(p, body) {
  const r = await fetch("/api/" + p, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && p !== "login") { showLogin(); throw new AuthError("auth"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "HTTP " + r.status), { status: r.status });
  return j;
}

// ---- 로그인 (prompt 제거, 1회 시도 후 폼으로 안내) (#4)
function showLogin() { $("login").style.display = "flex"; $("pw").focus(); }
$("lform").addEventListener("submit", async (e) => {
  e.preventDefault(); $("lerr").textContent = "";
  try { await api("login", { password: $("pw").value }); $("pw").value = ""; $("login").style.display = "none"; await refresh(); }
  catch (err) { $("lerr").textContent = err.status === 429 ? "시도 횟수 초과. 잠시 후 다시 시도하세요." : "비밀번호가 올바르지 않습니다."; }
});
$("logoutBtn").addEventListener("click", async () => { await api("logout", {}).catch(() => {}); showLogin(); });

// ---- 렌더링
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function dueInfo(due) {
  if (!due) return null;
  const d = Math.floor((new Date(due + "T00:00:00") - new Date(new Date().toDateString())) / 864e5);
  if (d < 0) return { cls: "late", text: `기한 ${-d}일 지남` };
  if (d <= 1) return { cls: "soon", text: d === 0 ? "D-day" : "D-1" };
  return { cls: "", text: `D-${d}` };
}
function card(i, s) {
  const c = el("div", "card" + (i.stale ? " stale" : ""));
  c.dataset.id = i.id; c.dataset.status = s;
  const act = el("span", "act");
  const mvb = el("button", "", s === "doing" ? "Done ›" : "‹ Doing"); mvb.dataset.act = "move"; mvb.dataset.to = s === "doing" ? "done" : "doing"; mvb.type = "button";
  act.append(mvb);
  const h = el("span", "handle", "⠿"); h.dataset.act = "drag"; h.title = "드래그해서 이동";
  const b = el("b"); b.append(h, document.createTextNode(i.title));
  const sm = el("small", "", `${i.phase || ""} ${(i.nodes || []).join(", ")}`.trim());
  c.append(act, b, sm);
  if (i.stale) c.append(el("span", "badge", "cands에서 종료됨"));
  if (i.priority) c.append(el("span", "badge pri", i.priority));
  if (i.owner) c.append(el("span", "badge", i.owner));
  const di = s === "doing" ? dueInfo(i.due) : null;
  if (di) c.append(el("span", "badge " + di.cls, di.text));
  if (i.href) { const a = el("a", "", " 열기"); a.href = i.href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.dataset.act = "link"; c.append(a); }
  return c;
}
function render() {
  const b = board;
  $("sync").textContent = "마지막 동기화: " + (b.lastSync ? new Date(b.lastSync).toLocaleString("ko-KR") : "없음");
  const lines = [];
  if (b.lastError) lines.push("동기화 오류: " + b.lastError);
  for (const w of b.warnings || []) lines.push("주의: " + w);
  $("err").style.display = lines.length ? "block" : "none"; $("err").textContent = lines.join("\n");
  for (const s of COLS) {
    const items = b.items.filter((i) => i.status === s);
    $(s === "doing" ? "n1" : "n2").textContent = `(${items.length})`;
    document.querySelector(`#${s} .list`).replaceChildren(...items.map((i) => card(i, s)));
  }
}

// ---- 낙관적 업데이트 + 롤백 (#13)
async function mutate(path, body, optimistic) {
  const snap = structuredClone(board);
  if (optimistic) { optimistic(board); render(); }
  try { board = await api(path, body); render(); }
  catch (e) { if (e instanceof AuthError) return; board = snap; render(); toast("저장 실패: 변경을 되돌렸습니다"); }
}
function mv(id, status) {
  const it = board.items.find((x) => x.id === id);
  if (!it || it.status === status || !COLS.includes(status)) return; // 같은 컬럼/빈 id 무시
  return mutate("move", { id, status }, (b) => { it.status = status; });
}

// ---- 클릭 이벤트 위임
document.querySelector("main").addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]"), c = e.target.closest(".card");
  if (!c) return;
  if (t?.dataset.act === "link") return;
  if (t?.dataset.act === "move") return void mv(c.dataset.id, t.dataset.to);
  if (t?.dataset.act === "drag") return;
  openDetail(c.dataset.id);
});

// ---- Pointer Events 드래그 (터치/마우스 공용, 핸들에서만 시작) (#13)
let drag = null;
document.querySelector("main").addEventListener("pointerdown", (e) => {
  const h = e.target.closest('[data-act="drag"]'); if (!h) return;
  const c = h.closest(".card"); e.preventDefault(); h.setPointerCapture(e.pointerId);
  const g = c.cloneNode(true); g.classList.add("ghost"); document.body.append(g);
  drag = { id: c.dataset.id, g, h, pid: e.pointerId }; moveGhost(e);
});
function moveGhost(e) { drag.g.style.left = e.clientX - 20 + "px"; drag.g.style.top = e.clientY - 20 + "px"; }
function colAt(x, y) { return document.elementsFromPoint(x, y).find((n) => n.classList?.contains("col")); }
document.addEventListener("pointermove", (e) => {
  if (!drag) return; moveGhost(e);
  document.querySelectorAll(".col").forEach((c) => c.classList.remove("over")); colAt(e.clientX, e.clientY)?.classList.add("over");
});
function endDrag(e, drop) {
  if (!drag) return;
  const col = drop ? colAt(e.clientX, e.clientY) : null;
  drag.g.remove(); document.querySelectorAll(".col").forEach((c) => c.classList.remove("over"));
  const id = drag.id; drag = null; if (col) mv(id, col.id);
}
document.addEventListener("pointerup", (e) => endDrag(e, true));
document.addEventListener("pointercancel", (e) => endDrag(e, false));

// ---- 상세/편집 (#6)
let cur = null;
function openDetail(id) {
  const i = board.items.find((x) => x.id === id); if (!i) return; cur = i;
  const manual = i.source === "manual";
  $("dtitle").textContent = i.title;
  const fmt = (v) => (v ? new Date(v).toLocaleString("ko-KR") : "-");
  $("dinfo").textContent = `출처: ${manual ? "직접 추가" : "cands"} · ID: ${i.id}\n단계: ${i.phase || "-"} · 노드: ${(i.nodes || []).join(", ") || "-"}\n생성: ${fmt(i.created)} · 이동: ${fmt(i.moved)}`;
  $("dinfo").style.whiteSpace = "pre-line";
  $("f_title").value = i.title; $("f_title").disabled = !manual;
  $("f_memo").value = i.memo || ""; $("f_due").value = i.due || ""; $("f_pri").value = i.priority || ""; $("f_owner").value = i.owner || "";
  $("ddel").textContent = manual ? "삭제" : "숨김";
  $("dlg").showModal();
}
$("dclose").addEventListener("click", () => $("dlg").close());
$("dform").addEventListener("submit", (e) => {
  e.preventDefault(); if (!cur) return;
  const patch = { id: cur.id, memo: $("f_memo").value, due: $("f_due").value, priority: $("f_pri").value, owner: $("f_owner").value };
  if (cur.source === "manual") patch.title = $("f_title").value;
  $("dlg").close(); mutate("update", patch, (b) => { Object.assign(b.items.find((x) => x.id === cur.id), patch); });
});
$("ddel").addEventListener("click", () => {
  if (!cur) return; const id = cur.id;
  if (!confirm(cur.source === "manual" ? "이 카드를 삭제할까요?" : "이 카드를 보드에서 숨길까요? (cands 원본은 그대로)")) return;
  $("dlg").close(); mutate("delete", { id }, (b) => { b.items = b.items.filter((x) => x.id !== id); });
});

// ---- 추가 / 동기화 / 폴링 / 단축키
$("add").addEventListener("submit", async (e) => {
  e.preventDefault(); const t = $("t"), v = t.value.trim(); if (!v) return; t.value = "";
  try { board = await api("add", { title: v }); render(); } catch (err) { if (!(err instanceof AuthError)) { t.value = v; toast("추가 실패"); } }
});
async function doSync() {
  if (busy) return; busy = true; const btn = $("syncBtn"); btn.disabled = true; btn.textContent = "동기화 중…";
  try { board = await api("sync", {}); render(); } catch (e) { if (!(e instanceof AuthError)) toast("동기화 실패"); }
  finally { busy = false; btn.disabled = false; btn.textContent = "지금 동기화"; }
}
$("syncBtn").addEventListener("click", doSync);
async function refresh() { try { board = await api("todos"); render(); $("logoutBtn").hidden = false; if (!board.lastSync && !board.lastError) doSync(); } catch {} }
setInterval(() => { if (document.visibilityState === "visible" && !drag) api("todos").then((b) => { board = b; render(); }).catch(() => {}); }, 300000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") api("todos").then((b) => { board = b; render(); }).catch(() => {}); });
document.addEventListener("keydown", (e) => {
  if (e.key === "n" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$("dlg").open) { e.preventDefault(); $("t").focus(); }
});
refresh();
