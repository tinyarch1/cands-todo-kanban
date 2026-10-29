# cands Todo Kanban
cands MCP(ai.cands.kr)의 SCM 연결 이슈를 매시간 동기화해 Doing > Done 칸반으로 관리하는 웹앱.

- 매시 정각 Netlify Scheduled Function 이 cands MCP `platform_insights` / `platform_records` 를 조회해 보드에 병합
- 새 항목은 Doing 으로 들어오고, 드래그(터치 가능, 핸들 ⠿) 또는 버튼으로 Done 이동. 카드 클릭 시 메모/마감일/우선순위/담당 편집
- 상태는 Netlify Blobs 저장 (cands 데이터 `cands` / 사용자 데이터 `u/<id>` 분리 -> 동기화와 사용자 조작이 서로 덮어쓰지 않음)
- 아키텍처: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (v1 기준 분석, #1)

## 환경변수
`.env.example` 참고. `CANDS_KEY`(필수), `APP_PASSWORD`(앱 로그인 비밀번호), `RECORDS_LIMIT`.

## 로컬 개발
```
npm ci
cp .env.example .env   # 값 채우기
npx netlify dev        # http://localhost:8888
npm run lint && npm test
```

## 배포
Netlify (publish `public/`, functions `netlify/functions/`). CI(GitHub Actions)는 lint + test 만 수행하며, 배포는 Netlify 대시보드 업로드(또는 Git 연동 후 자동).
