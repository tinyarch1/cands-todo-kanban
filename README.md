# cands Todo Kanban
cands MCP(ai.cands.kr)의 SCM 연결 이슈를 매시간 동기화해 Doing > Done 칸반으로 관리하는 웹앱.

- 매시 정각 Netlify Scheduled Function 이 cands MCP `platform_insights` / `platform_records` 를 조회해 보드에 병합
- 새 항목은 Doing 으로 들어오고, 드래그(또는 버튼)로 Done 이동. 상태는 Netlify Blobs 저장
- 환경변수: `CANDS_KEY`(cands MCP 개인 키), `APP_PASSWORD`(앱 접속 비밀번호)
