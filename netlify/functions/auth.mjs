// 인증: 로그인 폼 + HttpOnly 서명 쿠키, timingSafeEqual, IP당 실패 횟수 제한 (#4)
import crypto from "node:crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
export const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

export const TTL_MS = 7 * 24 * 3600 * 1000;
export function makeToken(secret, now = Date.now()) {
  const exp = now + TTL_MS;
  return `${exp}.${sign(secret, "v1." + exp)}`;
}
export function verifyToken(secret, tok, now = Date.now()) {
  if (!tok) return false;
  const [exp, sig] = String(tok).split(".");
  if (!/^\d+$/.test(exp || "") || !sig || +exp < now) return false;
  return safeEq(sig, sign(secret, "v1." + exp));
}
export function parseCookies(h) {
  const o = {};
  for (const p of String(h || "").split(";")) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return o;
}
export const sessionCookie = (tok, maxAgeSec = TTL_MS / 1000) => `sid=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;

const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
const rlKey = (ip) => "rl/" + crypto.createHash("sha1").update(String(ip)).digest("hex");
export async function isLocked(st, ip, now = Date.now()) {
  const r = await st.get(rlKey(ip), { type: "json" });
  return !!(r && now - r.first < WINDOW_MS && r.count >= MAX_FAILS);
}
export async function recordFail(st, ip, now = Date.now()) {
  const r = await st.get(rlKey(ip), { type: "json" });
  const cur = r && now - r.first < WINDOW_MS ? r : { first: now, count: 0 };
  cur.count++;
  await st.setJSON(rlKey(ip), cur);
}
export async function clearFails(st, ip) { await st.delete(rlKey(ip)); }
