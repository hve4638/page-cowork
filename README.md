# cowork

notionlike 계보의 협업 도구. 설계 문서와 결정 기록은 워크스페이스의 `docs/` 에 있다.

- `client/` — React + Vite (react-template 기반). dev 포트 8770, `/api`·`/sync` 는 서버로 프록시된다.
- `server/` — Node 내장 http + ws + node:sqlite. 포트 8771. DB 파일은 `server/data/cowork.db`.

## 실행

```sh
pnpm -C server install
pnpm -C client install
pnpm -C server seed-admin <email> <login_id> <pw>   # 최초 1회
pnpm -C server dev
pnpm -C client dev
```

개발 중 매번 로그인하기 번거로우면 서버를 `DEV_AUTO_LOGIN=<login_id>` 로 띄운다. 세션 없는 요청이 그 사용자(active 여야 함)로 취급된다.

IP 주소로 접속해 회의 녹음(마이크)을 쓰려면 HTTPS 여야 한다. `pnpm -C client make-cert` 로 자체 서명 인증서를 만들면 vite 가 HTTPS 로 뜬다 (첫 접속 때 브라우저 경고를 한 번 통과한다).

가입을 허용할 이메일은 `server/whitelist.txt` 에 한 줄에 하나씩 적는다. 가입 신청한 계정은 admin 이 화면에서 승인해야 로그인할 수 있다.
