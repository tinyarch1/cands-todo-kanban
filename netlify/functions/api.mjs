import { defaultStore, getBoard, updateItem, addManual, removeItem, sync } from "./lib.mjs";
import { makeToken, verifyToken, parseCookies, sessionCookie, safeEq, isLocked, recordFail, clearFails } from "./auth.mjs";

const J = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function createHandler({ store = defaultStore, doSync = sync, env = process.env } = {}) {
  return async (req, context = {}) => {
    const st = store();
    const secret = env.APP_PASSWORD;
    const path = new URL(req.url).pathname.replace(/^.*\/api\/?/, "");
    const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";

    if (req.method === "POST" && path === "login") {
      if (!secret) return J({ ok: true });
      if (await isLocked(st, ip)) return J({ error: "too_many_attempts" }, 429);
      const body = await req.json().catch(() => ({}));
      if (typeof body.password !== "string" || !safeEq(body.password, secret)) { await recordFail(st, ip); return J({ error: "unauthorized" }, 401); }
      await clearFails(st, ip);
      return J({ ok: true }, 200, { "set-cookie": sessionCookie(makeToken(secret)) });
    }
    if (req.method === "POST" && path === "logout") return J({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

    if (secret && !verifyToken(secret, parseCookies(req.headers.get("cookie")).sid)) return J({ error: "unauthorized" }, 401);

    if (req.method === "GET" && path === "me") return J({ ok: true, auth: !!secret });
    if (req.method === "GET" && path === "todos") return J(await getBoard(st));
    if (req.method !== "POST") return J({ error: "not found" }, 404);
    if (path === "sync") { await doSync(st); return J(await getBoard(st)); }

    const body = await req.json().catch(() => ({}));
    let ok;
    if (path === "move") ok = await updateItem(st, String(body.id || ""), { status: body.status });
    else if (path === "update") { const { id, ...patch } = body; ok = await updateItem(st, String(id || ""), patch); }
    else if (path === "add") ok = await addManual(st, body.title);
    else if (path === "delete") ok = await removeItem(st, String(body.id || ""));
    else return J({ error: "not found" }, 404);
    if (!ok) return J({ error: "bad_request" }, 400);
    return J(await getBoard(st));
  };
}
export default createHandler();
