# cands Todo Kanban - 전체 아키텍처 구성도 및 흐름도

> 기준 커밋: `main` (2026-10-28, 8개 파일) / 분석: 코드 정적 분석 기반

## 0. 한 줄 요약
cands MCP(`ai.cands.kr/mcp/`)의 SCM 연결 이슈를 **Netlify Scheduled Function이 매시 정각 조회**해 **Netlify Blobs**에 저장된 보드에 병합하고, 정적 웹페이지(`public/index.html`)에서 **Doing / Done** 2열 칸반으로 관리하는 서버리스 웹앱.

| 구분 | 기술 |
|---|---|
| Frontend | Vanilla HTML/CSS/JS 단일 파일 (`public/index.html`), 프레임워크 없음 |
| Hosting | Netlify (정적 publish: `public/`) |
| Backend | Netlify Functions (ESM `.mjs`) - `api.mjs`(REST), `sync-hourly.mjs`(Scheduled `@hourly`) |
| Storage | Netlify Blobs - store `todo-board`, key `board` (단일 JSON 문서) |
| 외부 연동 | cands MCP (JSON-RPC 2.0 over Streamable HTTP, `Bearer CANDS_KEY`) |
| 인증 | 공유 비밀번호 `APP_PASSWORD` → 요청 헤더 `x-app-password` |
| 의존성 | `@netlify/blobs ^8.1.0` |

---

## 1. 전체 아키텍처 구성도

```mermaid
flowchart TB
    subgraph Client["사용자 브라우저"]
        UI["index.html<br/>Doing / Done 칸반<br/>드래그&드롭 · 직접추가 · 지금 동기화"]
        LS[("localStorage<br/>pw")]
        UI <--> LS
    end

    subgraph Netlify["Netlify"]
        CDN["정적 호스팅<br/>publish = public/"]
        RD{{"Redirect<br/>/api/* → /.netlify/functions/api/:splat"}}
        subgraph Fn["Netlify Functions"]
            API["api.mjs<br/>REST 라우터 + 비밀번호 검사"]
            CRON["sync-hourly.mjs<br/>schedule: @hourly"]
            LIB["lib.mjs<br/>mcpCall · sync · load/saveBoard"]
        end
        BLOB[("Netlify Blobs<br/>store: todo-board<br/>key: board")]
        ENV[/"환경변수<br/>CANDS_KEY · APP_PASSWORD"/]
    end

    subgraph Cands["cands 플랫폼"]
        MCP["cands MCP<br/>https://ai.cands.kr/mcp/"]
        T1["platform_insights"]
        T2["platform_records<br/>service-requests / notifications"]
        MCP --- T1
        MCP --- T2
    end

    UI -- "GET /" --> CDN
    UI -- "fetch /api/* + x-app-password" --> RD --> API
    API --> LIB
    CRON --> LIB
    LIB <-- "get / setJSON" --> BLOB
    LIB -- "JSON-RPC (Bearer CANDS_KEY)" --> MCP
    ENV -.-> API
    ENV -.-> LIB
    UI -. "카드 '열기' 링크" .-> Cands
```

## 2. 소스 구성도 (모듈 의존 관계)

```mermaid
flowchart TB
    toml["netlify.toml<br/>build · functions 경로 · /api redirect"]
    pkg["package.json<br/>type: module · @netlify/blobs"]
    html["public/index.html<br/>render · api · mv · add · doSync · DnD"]
    api["netlify/functions/api.mjs<br/>default handler(req)"]
    cron["netlify/functions/sync-hourly.mjs<br/>config.schedule = @hourly"]
    lib["netlify/functions/lib.mjs"]
    subgraph libx["lib.mjs exports"]
        rpc["rpc() 내부 - fetch + SSE data: 파싱"]
        mcp["mcpCall(tool,args)<br/>initialize → initialized → tools/call"]
        store["store() / loadBoard() / saveBoard()"]
        sync["sync() - 수집 · 병합 · stale 표시"]
    end
    html -->|HTTP| api
    api --> lib
    cron --> lib
    lib --- libx
    mcp --> rpc
    sync --> mcp
    sync --> store
    toml -.-> api
    toml -.-> html
    pkg -.-> store
```

## 3. REST API 명세 (`api.mjs`)

모든 요청은 `APP_PASSWORD`가 설정된 경우 `x-app-password` 헤더 일치 필요 (불일치 시 `401`).

| Method | Path | Body | 동작 | 응답 |
|---|---|---|---|---|
| GET | `/api/todos` | - | 보드 조회 | Board |
| POST | `/api/sync` | - | 즉시 cands 동기화 | Board |
| POST | `/api/move` | `{id, status}` | 상태 변경 (`doing`/`done`), `moved` 시각 기록 | Board |
| POST | `/api/add` | `{title}` | 수동 카드 추가 (`manual:<ts>`, 200자 제한, Doing) | Board |
| POST | `/api/delete` | `{id}` | 수동 카드만 삭제 (UI 미노출) | Board |
| * | 그 외 | - | - | `404 {error:"not found"}` |

## 4. 데이터 모델 (Netlify Blobs `todo-board/board`)

```mermaid
classDiagram
    class Board {
        Item[] items
        string|null lastSync
        string|null lastError
    }
    class Item {
        string id
        string title
        string[] nodes
        string phase
        string href
        string status
        string source
        string created
        string seen
        boolean stale
        string moved
    }
    Board "1" o-- "*" Item
    note for Item "status = doing 또는 done / source = cands 또는 manual"
```

| id 규칙 | 출처 | title | phase |
|---|---|---|---|
| `<issue id>` | `platform_insights` cards[].issues.items[] | id 그대로 | state 매핑 plan→계획, do→실행, check→점검, act→조치 |
| `service-requests:<id or title>` | `platform_records(service-requests, limit 20)` | rec.title | rec.status |
| `notifications:<id or title>` | `platform_records(notifications, limit 20)` | rec.title | rec.status |
| `manual:<epoch ms>` | 사용자 직접 추가 | 입력값 (≤200자) | "" |

---

## 5. 흐름도

### 5-1. 정기 동기화 (매시 정각) 시퀀스

```mermaid
sequenceDiagram
    autonumber
    participant S as Netlify Scheduler
    participant C as sync-hourly.mjs
    participant L as lib.sync()
    participant B as Netlify Blobs
    participant M as cands MCP

    S->>C: @hourly 트리거
    C->>L: sync()
    L->>B: get("board")
    B-->>L: Board (없으면 빈 보드)
    Note over L,M: mcpCall은 툴 호출마다 새 세션 생성 (3회 x 3요청)
    L->>M: initialize (Bearer CANDS_KEY)
    M-->>L: mcp-session-id
    L->>M: notifications/initialized
    L->>M: tools/call platform_insights
    M-->>L: cards[].issues.items[]
    loop svc in [service-requests, notifications]
        L->>M: initialize → initialized → tools/call platform_records(svc, 20)
        M-->>L: records[] (실패 시 무시)
    end
    L->>L: found Map 구성 → 기존 items와 병합
    L->>B: setJSON("board", board)
```

### 5-2. 병합(merge) 로직 순서도

```mermaid
flowchart TD
    A([sync 시작]) --> B[loadBoard]
    B --> C{platform_insights 호출 성공?}
    C -- 아니오 --> E1["board.lastError = 에러 메시지"] --> Z
    C -- 예 --> D["insight issue 별로 found에 등록<br/>같은 id면 nodes에 node_id+scope 누적"]
    D --> F["platform_records 2종 호출<br/>(개별 실패는 무시)"]
    F --> G{found 의 각 항목이<br/>기존 보드에 있나?}
    G -- 있음 --> H["nodes · phase · href 갱신<br/>seen = now, stale = false<br/>status는 유지"]
    G -- 없음 --> I["신규 추가<br/>status = doing, source = cands"]
    H --> J
    I --> J["source = cands 인데 이번에 안 보인 항목<br/>→ stale = true (삭제하지 않음)"]
    J --> K["lastSync = now, lastError = null"]
    K --> Z([saveBoard])
```

### 5-3. 사용자 화면 흐름 시퀀스

```mermaid
sequenceDiagram
    autonumber
    actor U as 사용자
    participant P as index.html
    participant A as api.mjs
    participant L as lib.mjs
    participant B as Netlify Blobs

    U->>P: 페이지 접속
    P->>A: GET /api/todos (x-app-password=localStorage.pw)
    alt 401 Unauthorized
        A-->>P: 401
        P->>U: prompt("비밀번호")
        U-->>P: 입력 → localStorage.pw 저장 후 재요청
    end
    A->>B: loadBoard
    B-->>A: Board
    A-->>P: Board → render()
    opt lastSync 가 없으면
        P->>A: POST /api/sync → (5-1과 동일)
    end
    U->>P: 카드 드래그 or "Done ›" 버튼
    P->>A: POST /api/move {id, status}
    A->>B: load → status 변경 → save
    A-->>P: Board → render()
    U->>P: "직접 추가"
    P->>A: POST /api/add {title}
    A-->>P: Board → render()
    loop 5분마다
        P->>A: GET /api/todos → render()
    end
```

### 5-4. 카드 상태 전이도

```mermaid
stateDiagram-v2
    [*] --> Doing: cands 신규 항목 (sync)
    [*] --> Doing: 직접 추가 (manual)
    Doing --> Done: 드래그 / Done › 버튼
    Done --> Doing: 드래그 / ‹ Doing 버튼
    Doing --> Doing_stale: cands에서 사라짐 (stale=true, 반투명)
    Done --> Done_stale: cands에서 사라짐
    Doing_stale --> Doing: cands에 다시 등장
    Done_stale --> Done: cands에 다시 등장
    Doing --> [*]: 삭제 API (manual만, UI 없음)
```

---

## 6. 배포/설정 구성

```mermaid
flowchart LR
    GH["GitHub<br/>tinyarch1/cands-todo-kanban"] -- "push → 빌드" --> NB["Netlify Build<br/>(빌드 명령 없음)"]
    NB --> ST["public/ → CDN"]
    NB --> FN["netlify/functions/*.mjs<br/>→ Functions 번들"]
    ENV["Site env<br/>CANDS_KEY / APP_PASSWORD"] -.-> FN
    FN --> BL[("Blobs: todo-board")]
```

| 항목 | 값 |
|---|---|
| publish | `public` |
| functions | `netlify/functions` |
| redirect | `/api/*` → `/.netlify/functions/api/:splat` (200 rewrite) |
| schedule | `sync-hourly.mjs` → `@hourly` |
| 필수 env | `CANDS_KEY` (cands MCP 개인 키) |
| 선택 env | `APP_PASSWORD` (미설정 시 인증 없음) |

## 7. 분석 중 확인된 주요 관찰 사항 (개선 이슈로 별도 등록)
1. 카드 렌더링 `onclick="mv('${esc(i.id)}', ...)"` 에서 `esc()`가 작은따옴표(`'`)를 이스케이프하지 않음 → 깨짐/XSS 위험
2. 단일 Blob 문서 read-modify-write → 정기 동기화와 사용자 조작이 겹치면 변경 유실 가능
3. 401 시 `prompt` 취소하면 빈 비밀번호로 무한 재귀 / 비밀번호 평문 localStorage 저장
4. `mcpCall` 이 툴마다 세션 재생성(동기화 1회당 9 요청), 타임아웃·재시도 없음, `platform_records` 실패는 조용히 무시
5. insights 카드 title이 이슈 ID만 표시, 수동 카드 삭제/편집 UI 없음, stale 항목 정리 기능 없음
