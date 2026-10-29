// 순수 함수 모음: 병합 규칙 / href 검증 / 보드 조립 (#2, #3, #12)
export const ORIGIN = "https://ai.cands.kr";
export const STATE = { plan: "계획", do: "실행", act: "조치", check: "점검" };
export const STATUSES = ["doing", "done"];
export const PRIORITIES = ["", "상", "중", "하"];

/** cands 도메인(origin 일치)만 허용. 그 외는 빈 문자열. */
export function safeHref(h) {
  if (!h) return "";
  try { const u = new URL(String(h), ORIGIN); return u.origin === ORIGIN ? u.href : ""; } catch { return ""; }
}

export function groupOf(id) {
  if (String(id).startsWith("service-requests:")) return "service-requests";
  if (String(id).startsWith("notifications:")) return "notifications";
  return "insights";
}

export function extractInsights(ins, found = new Map()) {
  for (const c of ins?.cards || []) {
    for (const it of c.issues?.items || []) {
      const f = found.get(it.id) || {
        id: it.id,
        title: String(it.title || it.name || it.subject || it.summary || it.id),
        nodes: [], phase: STATE[it.state] || it.state || "", href: safeHref(it.href),
      };
      f.nodes.push(`${c.node_id} ${c.scope}`.trim());
      found.set(it.id, f);
    }
  }
  return found;
}

export function extractRecords(found, svc, r) {
  for (const rec of r?.records || []) {
    const id = `${svc}:${rec.id ?? rec.title}`;
    found.set(id, { id, title: String(rec.title || rec.id), nodes: [svc], phase: rec.status || "", href: "" });
  }
  return found;
}

/**
 * cands 쪽 데이터만 병합한다 (사용자 필드는 건드리지 않음).
 * okGroups: 이번 동기화에서 정상 조회된 그룹. 실패한 그룹의 항목은 stale 처리하지 않는다.
 */
export function mergeCands(prevItems, found, now, okGroups) {
  const byId = new Map(prevItems.map((i) => [i.id, { ...i }]));
  for (const f of found.values()) {
    const ex = byId.get(f.id);
    if (ex) Object.assign(ex, { title: f.title, nodes: f.nodes, phase: f.phase, href: f.href || ex.href || "", seen: now, stale: false });
    else byId.set(f.id, { ...f, source: "cands", created: now, seen: now, stale: false });
  }
  for (const i of byId.values()) if (!found.has(i.id) && okGroups.has(groupOf(i.id))) i.stale = true;
  return [...byId.values()];
}

/** cands 항목 + 사용자 레코드 → 화면용 보드 항목. 기본 status는 doing. */
export function assemble(candsItems, userMap) {
  const out = [];
  for (const c of candsItems) {
    const u = userMap.get(c.id) || {};
    if (u.hidden) continue;
    out.push({ ...c, href: safeHref(c.href), status: u.status || "doing", moved: u.moved, memo: u.memo || "", due: u.due || "", priority: u.priority || "", owner: u.owner || "" });
  }
  for (const u of userMap.values()) {
    if (u.source === "manual") out.push({ nodes: [], phase: "", href: "", memo: "", due: "", priority: "", owner: "", ...u, status: u.status || "doing" });
  }
  return out;
}

/** 사용자 입력 검증. 허용된 필드만 정리해 반환(잘못된 값은 null 반환). */
export function cleanPatch(p, isManual) {
  const o = {};
  if (p.status !== undefined) { if (!STATUSES.includes(p.status)) return null; o.status = p.status; }
  if (p.memo !== undefined) o.memo = String(p.memo).slice(0, 2000);
  if (p.due !== undefined) { if (p.due !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.due))) return null; o.due = String(p.due); }
  if (p.priority !== undefined) { if (!PRIORITIES.includes(p.priority)) return null; o.priority = p.priority; }
  if (p.owner !== undefined) o.owner = String(p.owner).slice(0, 50);
  if (p.hidden !== undefined) o.hidden = !!p.hidden;
  if (p.title !== undefined && isManual) { const t = String(p.title).trim().slice(0, 200); if (!t) return null; o.title = t; }
  return o;
}
