// cands MCP 클라이언트: 세션 1회 초기화 후 재사용, 타임아웃 + 지수 백오프 재시도, SSE 줄 단위 파싱 (#5)
export const MCP_URL = "https://ai.cands.kr/mcp/";

/** JSON 본문 또는 SSE(data: 줄) 본문에서 JSON-RPC 메시지를 찾는다. id가 주어지면 id 일치 메시지만 반환. */
export function parseRpc(text, id) {
  const t = String(text || "").trim();
  const msgs = [];
  if (t.startsWith("{")) { try { msgs.push(JSON.parse(t)); } catch {} }
  for (const line of t.split(/\r?\n/)) {
    if (line.startsWith("data:")) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {} }
  }
  if (id == null) return msgs[0] ?? null;
  return msgs.find((m) => m && m.id === id) ?? null;
}

export class McpClient {
  constructor(key, opts = {}) {
    this.key = key;
    this.url = opts.url || MCP_URL;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.baseDelay = opts.baseDelay ?? 300;
    this.deadline = opts.deadline ?? Date.now() + 22_000; // 스케줄 함수 제한 전에 스스로 종료
    this.requests = 0;
    this.sid = undefined;
    this.nextId = 1;
  }
  headers() {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.key}`,
      ...(this.sid ? { "mcp-session-id": this.sid } : {}),
    };
  }
  async post(body, expectId) {
    let last;
    for (let a = 0; a <= this.retries; a++) {
      try {
        const remain = this.deadline - Date.now();
        if (remain <= 0) { const e = new Error("MCP 시간 예산 초과"); e.fatal = true; throw e; }
        this.requests++;
        const r = await this.fetchImpl(this.url, {
          method: "POST", headers: this.headers(), body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, remain)),
        });
        if (r.status === 401 || r.status === 403) { const e = new Error(`MCP 인증 실패(HTTP ${r.status}) - CANDS_KEY 확인`); e.fatal = true; throw e; }
        if (r.status >= 500 || r.status === 429) throw new Error(`MCP HTTP ${r.status}`);
        const text = await r.text();
        return { r, msg: expectId == null ? null : parseRpc(text, expectId) };
      } catch (e) {
        last = e;
        if (e.fatal || a === this.retries) break;
        await new Promise((res) => setTimeout(res, this.baseDelay * 2 ** a));
      }
    }
    throw last;
  }
  async init() {
    if (this.ready) return;
    const id = this.nextId++;
    const { r } = await this.post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "todo-kanban", version: "2" } } }, id);
    this.sid = r.headers.get("mcp-session-id") || undefined;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.ready = true;
  }
  async callTool(name, args = {}) {
    await this.init();
    const id = this.nextId++;
    const { msg } = await this.post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, id);
    if (!msg) throw new Error(`MCP 응답 없음(${name})`);
    if (msg.error) throw new Error(`MCP 오류(${name}): ${msg.error.message || JSON.stringify(msg.error)}`.slice(0, 200));
    const txt = msg.result?.content?.[0]?.text;
    if (!txt) throw new Error(`MCP 빈 응답(${name}): ${JSON.stringify(msg).slice(0, 150)}`);
    return JSON.parse(txt);
  }
}
