# cowork

notionlike 계보의 협업 도구. 설계 문서와 결정 기록은 워크스페이스의 `docs/` 에 있다.

- `client/` — React + Vite (react-template 기반). dev 포트 8770, `/api`·`/sync` 는 서버로 프록시된다.
- `server/` — Node 내장 http + ws + node:sqlite. 포트 8771. `client/dist` 가 있으면 화면도 함께 서빙한다.

## 설정

서버는 `server/config.json` 을 읽는다 (없으면 개발용 기본값). 다른 위치의 파일을 쓰려면 `COWORK_CONFIG=<경로>`. 상대 경로는 설정 파일이 있는 디렉터리 기준이다. 예시는 `server/config.example.json`.

| 키 | 기본값 | 설명 |
|---|---|---|
| `dataDir` | `server/data` | `cowork.db`·`files/`·`recordings/`·`whitelist.txt` 가 놓이는 루트 |
| `staticDir` | `client/dist` | 정적 서빙할 빌드 산출물. 없으면 API 만 서빙 |
| `whitelist` | `<dataDir>/whitelist.txt` | 가입 허용 이메일 목록 (한 줄에 하나) |
| `port`, `host` | `8771`, `0.0.0.0` | 환경변수 `PORT` 가 있으면 그것이 우선 |

환경변수 `DEV_AUTO_LOGIN=<login_id>` 를 주면 세션 없는 요청을 그 사용자(active 여야 함)로 취급한다. 개발·데모 전용이다.

## 개발 실행

```sh
pnpm -C server install
pnpm -C client install
pnpm -C server seed-admin <email> <login_id> <pw>   # 최초 1회
pnpm -C server dev
pnpm -C client dev
```

IP 주소로 접속해 회의 녹음(마이크)을 쓰려면 HTTPS 여야 한다. `pnpm -C client make-cert` 로 자체 서명 인증서를 만들면 vite 가 HTTPS 로 뜬다 (첫 접속 때 브라우저 경고를 한 번 통과한다).

## 배포 실행

단일 프로세스. 클라이언트를 빌드하면 서버가 같은 포트에서 화면과 API 를 함께 낸다.

```sh
pnpm -C client install && pnpm -C client build
pnpm -C server install --prod
pnpm -C server seed-admin <email> <login_id> <pw>
pnpm -C server start
```

Docker 로 띄우면 이미지 안에서 빌드하고 데이터는 볼륨 `/data` 에 둔다. 포트·`DEV_AUTO_LOGIN` 은 `compose.yaml` 에서 조정한다.

```sh
docker compose up -d --build
docker compose exec cowork pnpm seed-admin <email> <login_id> <pw>
docker compose exec cowork sh -c 'echo someone@example.com >> /data/whitelist.txt'
```

가입 신청한 계정은 admin 이 화면(`/admin`)에서 승인해야 로그인할 수 있다.

### HTTPS

서버는 HTTP 만 제공한다. 마이크 녹음에는 보안 컨텍스트가 필요하므로 앞에 리버스 프록시를 두고 TLS 를 종단한다. Caddy 예시는 `deploy/Caddyfile.example`. 도메인이 있으면 인증서가 자동 발급되고, 사설망 IP 만 있으면 `tls internal` 로 자체 서명한다. 프록시는 `/sync` 웹소켓 업그레이드를 통과시켜야 한다 (Caddy 의 `reverse_proxy` 는 기본으로 통과한다).

### 백업

```sh
pnpm -C server backup <목적지>            # <목적지>/<타임스탬프>/ 에 DB·files·recordings·whitelist 사본
docker compose exec cowork pnpm backup /data/backups
```

서버가 켜진 상태(WAL)에서도 일관된 DB 스냅샷을 만든다. 복원은 사본 디렉터리를 `dataDir` 로 지정해 띄우면 된다.
