import { loadBoard, saveBoard, sync } from "./lib.mjs";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
export default async (req) => {
  const pw = process.env.APP_PASSWORD;
  if (pw && req.headers.get("x-app-password") !== pw) return J({ error: "unauthorized" }, 401);
  const path = new URL(req.url).pathname.replace(/^.*\/api\/?/, "");
  if (req.method === "GET" && path === "todos") return J(await loadBoard());
  if (req.method === "POST" && path === "sync") return J(await sync());
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const b = await loadBoard();
  if (path === "move") {
    const i = b.items.find((x) => x.id === body.id);
    if (i && ["doing", "done"].includes(body.status)) { i.status = body.status; i.moved = new Date().toISOString(); }
  } else if (path === "add" && body.title) {
    b.items.push({ id: "manual:" + Date.now(), title: String(body.title).slice(0, 200), nodes: [], phase: "", href: "", status: "doing", source: "manual", created: new Date().toISOString() });
  } else if (path === "delete") {
    b.items = b.items.filter((x) => !(x.id === body.id && x.source === "manual"));
  } else return J({ error: "not found" }, 404);
  await saveBoard(b);
  return J(b);
};
