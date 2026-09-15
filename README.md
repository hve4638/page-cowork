# cowork

notionlike 계보의 협업 도구. 설계 문서와 결정 기록은 워크스페이스의 `docs/` 에 있다.

- `client/` — React + Vite (react-template 기반). dev 포트 8770, `/api`·`/sync` 는 서버로 프록시된다.
- `server/` — Node 내장 http + ws + node:sqlite. 포트 8771. `client/dist` 가 있으면 화면도 함께 서빙한다.

## 설정

서버는 `server/config.json` 을 읽는다 (없으면 개발용 기본값). 다른 위치의 파일을 쓰려면 `COWORK_CONFIG=<경로>`. 상대 경로는 설정 파일이 있는 디렉터리 기준이다. 예시는 `server/config.example.json`.

| 키 | 기본값 | 설명 |
|---|---|---|
| `dataDir` | `server/data` | `cowork.db`·`files/`·`recordings/`·`whitelist.txt`·`admin.txt` 가 놓이는 루트 |
| `staticDir` | `client/dist` | 정적 서빙할 빌드 산출물. 없으면 API 만 서빙 |
| `whitelist` | `<dataDir>/whitelist.txt` | 가입 허용 이메일 목록 (한 줄에 하나) |
| `admin` | `<dataDir>/admin.txt` | 관리자 이메일 목록 (한 줄에 하나). 여기 적힌 이메일은 whitelist 없이 가입되고 승인 없이 바로 활성·관리자다 |
| `port`, `host` | `8771`, `0.0.0.0` | 환경변수 `PORT` 가 있으면 그것이 우선 |
| `ai` | 모두 `mock` | AI 회의 노트가 쓸 전사·요약 서비스. 아래 표 참조 |

두 파일은 요청 때마다 읽으므로 고쳐도 재기동이 필요 없다. 관리자 여부는 `admin.txt` 소속 여부로만 정해진다 (DB 에 역할 컬럼이 없다).

### AI 회의 노트

녹음이나 올린 소리 파일을 전사하고 요약한다. `ai.stt`(전사)와 `ai.llm`(요약)은 각각 `provider` 로 구현체를 고르고 나머지 값은 그 구현체가 읽는다. 키가 없어도 기동하도록 기본값은 `mock` 이며, 가짜 결과로 화면과 흐름만 확인할 수 있다.

| 키 | 값 | 설명 |
|---|---|---|
| `ai.stt.provider` | `mock` · `speechmatics` | 전사 서비스. `speechmatics` 는 `apiKey` 가 필요하다 |
| `ai.stt.apiKey`, `ai.stt.baseUrl`, `ai.stt.liveUrl`, `ai.stt.language` | | 키·주소(생략하면 서비스 기본)·실시간 WebSocket 주소·언어 코드 (기본 `ko`) |
| `ai.llm.provider` | `mock` · `chat` | 요약 서비스. `chat` 은 OpenAI chat completions 형식을 따르는 곳이면 어디든 붙는다 |
| `ai.llm.baseUrl`, `ai.llm.apiKey`, `ai.llm.model` | | `<baseUrl>/chat/completions` 로 요청한다. `baseUrl` 에 끝 경로까지 적으면 그대로 쓴다 |
| `ai.llm.models` | `[{ "id": "...", "label": "..." }]` | 노트에서 골라 쓸 요약 모델 목록. 비어 있으면 고르개가 나오지 않는다 |

같은 이름의 환경변수(`STT_PROVIDER`·`STT_API_KEY`·`STT_BASE_URL`·`STT_LIVE_URL`·`STT_LANGUAGE`·`LLM_PROVIDER`·`LLM_API_KEY`·`LLM_BASE_URL`·`LLM_MODEL`·`LLM_MODELS`)가 설정 파일보다 우선한다. Docker 는 이미지 안의 `config.json` 에 키를 넣지 않고 배포 디렉터리의 `.env` 를 `env_file` 로 컨테이너에 넘긴다. **키는 설정 파일이나 환경변수에만 두고 저장소에 넣지 않는다** (`server/config.json` 은 git 제외 대상이다). `LLM_MODELS` 는 `gpt-5.6-luna=Luna,gpt-5.6-terra=Terra` 처럼 쉼표로 잇는다. 전사 전에 `ffmpeg` 로 소리 형식을 바꾸므로 서버에 `ffmpeg` 가 있어야 한다.

'AI 전사' 를 켜고 녹음을 시작하면 말하는 동안 전사가 쌓인다. 브라우저가 올린 webm 조각을 서버가 ffmpeg 로 PCM 으로 바꿔 전사 서비스의 WebSocket 으로 흘려 보내고, 받은 덩어리를 노트에 적는다. 전사 덩어리는 행 하나씩이라 늘어난 것만 화면으로 나간다. 실시간이 열리지 않거나 도중에 끊기면 녹음이 끝난 뒤 완성 파일로 다시 전사한다. 올린 파일은 언제나 완성 파일로 한 번에 전사한다.

노트의 요약 탭에서 모델을 바꾸면 그 모델로 다시 요약한다. 모델마다 결과를 따로 저장하므로, 한 번 요약한 모델로 되돌아갈 때는 다시 부르지 않는다.

환경변수 `DEV_AUTO_LOGIN=<email>` 을 주면 세션 없는 요청을 그 사용자(active 여야 함)로 취급한다. `DEV_ADMIN_EMAIL`·`DEV_ADMIN_PW`(닉네임은 `DEV_ADMIN_NAME`, 없으면 이메일의 @ 앞부분)를 주면 기동 시 그 계정이 없을 때 활성 계정으로 만들고 `admin.txt` 에 없어도 관리자로 취급한다. 이미 있는 계정의 비밀번호는 바꾸지 않는다. 셋 다 개발·데모 전용이다.

## 개발 실행

```sh
pnpm -C server install
pnpm -C client install
echo me@example.com >> server/data/admin.txt   # 최초 1회. 이 이메일로 가입하면 바로 로그인된다
pnpm -C server dev
pnpm -C client dev
```

IP 주소로 접속해 회의 녹음(마이크)을 쓰려면 HTTPS 여야 한다. `pnpm -C client make-cert` 로 자체 서명 인증서를 만들면 vite 가 HTTPS 로 뜬다 (첫 접속 때 브라우저 경고를 한 번 통과한다).

## 배포 실행

단일 프로세스. 클라이언트를 빌드하면 서버가 같은 포트에서 화면과 API 를 함께 낸다.

```sh
pnpm -C client install && pnpm -C client build
pnpm -C server install --prod
echo me@example.com >> server/data/admin.txt
pnpm -C server start
```

AI 회의 노트를 쓰려면 서버에 `ffmpeg` 가 있어야 한다 (전사 서비스에 올리기 전에 녹음을 flac 으로 바꾼다). Docker 이미지에는 들어 있다.

Docker 로 띄우면 이미지 안에서 빌드한다. 배포 디렉터리를 하나 만들고 저장소를 그 안의 `source/` 에 clone 한다. `source/` 는 `git pull` 외에는 손대지 않고, 루트의 `docker-compose.yml` 은 사용자 소유다. 이 파일이 `source/deploy/partials/compose.base.yml` 을 `include` 로 끌어오고, 환경별 값은 같은 디렉터리의 `.env` 에서 받는다. `.env` 는 compose 의 `${...}` 치환에 쓰이는 동시에 `env_file` 로 통째로 컨테이너 환경변수가 되므로, AI 키처럼 서버가 읽는 값은 `.env` 에만 적으면 된다. 포트(`COWORK_PORT`, 호스트 포트이자 컨테이너 안에서 서버가 listen 하는 포트. 비우면 80)·데이터 경로(`COWORK_DATA`, `/data` 바인드 마운트)·AI 키·`DEV_*` 가 여기에 들어가며, 본보기는 `source/deploy/.env.template` 이다. `.env` 는 `docker-compose.yml` 과 같은 배포 디렉터리 루트(`source/` 밖)에 있어야 compose 가 읽는다. build context 가 `source` 로 고정되어 있으므로 clone 디렉터리 이름은 `source` 여야 한다.

```
<배포 디렉터리>/
├─ docker-compose.yml        # 사용자 소유 (템플릿 복사본)
├─ .env                      # 사용자 소유 (템플릿 복사본). 키가 들어가므로 저장소에 올리지 않는다
└─ source/                   # git clone, 손대지 않음
```

```sh
mkdir cowork && cd cowork
git clone <repo> source
cp source/deploy/docker-compose.template.yml docker-compose.yml
cp source/deploy/.env.template .env
# .env 의 COWORK_PORT · COWORK_DATA 와 AI 키를 채운다. 비워 둔 AI 값은 mock 으로 기동한다
docker compose up -d --build
docker compose exec cowork sh -c 'echo me@example.com >> /data/admin.txt'          # 관리자
docker compose exec cowork sh -c 'echo someone@example.com >> /data/whitelist.txt'  # 가입 허용
```

갱신·복원 절차는 아래 업데이트·복원 절에 있다.

가입은 이메일·닉네임·비밀번호로 신청하고, 로그인은 이메일·비밀번호다. `admin.txt` 에 있는 이메일은 가입 즉시 로그인할 수 있고, 그 밖의 가입 신청은 관리자가 화면(`/admin`)에서 승인해야 로그인할 수 있다.

### HTTPS

서버는 HTTP 만 제공한다. 마이크 녹음에는 보안 컨텍스트가 필요하므로 앞에 리버스 프록시를 두고 TLS 를 종단한다. Caddy 예시는 `deploy/Caddyfile.example`. 도메인이 있으면 인증서가 자동 발급되고, 사설망 IP 만 있으면 `tls internal` 로 자체 서명한다. 프록시는 `/sync` 웹소켓 업그레이드를 통과시켜야 한다 (Caddy 의 `reverse_proxy` 는 기본으로 통과한다).

### 백업

```sh
pnpm -C server backup <목적지>            # <목적지>/<타임스탬프>/ 에 DB·files·recordings·whitelist·admin.txt 사본
docker compose exec cowork pnpm backup /data/backups
```

서버가 켜진 상태(WAL)에서도 일관된 DB 스냅샷을 만든다. 복원은 사본 디렉터리를 `dataDir` 로 지정해 띄우면 된다.

### 업데이트

DB 에는 스키마 번호(`PRAGMA user_version`)가 있다. 서버는 기동할 때 코드가 아는 최신 번호까지 마이그레이션을 차례로 적용하고, 적용할 것이 있으면 그 전에 `<dataDir>/backups/<타임스탬프>-pre-v<번호>/` 에 사본을 자동으로 만든다. 백업이 실패하면 마이그레이션 없이 종료한다. 적용한 번호와 백업 경로는 기동 로그에 남는다.

```sh
docker compose exec cowork pnpm backup /data/backups   # 선택. 자동 백업과 별개로 직접 떠 둘 때
cd source && git pull && cd ..
docker compose up -d --build
docker compose logs cowork | grep migrate
```

`--no-cache` 는 쓰지 않는다. Docker 는 `COPY` 대상 파일의 내용으로 캐시를 판정하므로 `git pull` 로 바뀐 소스는 `--build` 만으로 새로 반영되고, `pnpm install` 단계는 `package.json`·`pnpm-lock.yaml` 이 바뀐 버전에서만 다시 돈다. 캐시가 실제로 먹는지는 `docker compose build --progress=plain` 의 `pnpm install` 단계에 `CACHED` 가 찍히는지로 확인한다. 베이스 이미지나 ffmpeg 를 새로 받고 싶을 때는 `--no-cache` 대신 `docker compose build --pull` 을 쓴다.

DB 번호가 코드보다 높으면(새 이미지로 올렸다가 옛 이미지로 돌아온 경우) 서버는 기동을 거부한다. 새 이미지로 다시 올리거나 사본을 복원한다. 오래된 사본은 자동으로 지우지 않는다.

### 복원

사본 디렉터리는 그대로 `dataDir` 로 쓸 수 있는 데이터 디렉터리다. 호스트에서 `/data` 에 마운트한 경로를 `<data>` 라고 하면:

```sh
docker compose stop cowork
mkdir <data>.old && mv <data>/cowork.db* <data>/files <data>/recordings <data>/whitelist.txt <data>/admin.txt <data>.old/
cp -a <data>/backups/<사본>/. <data>/
docker compose up -d        # 옛 이미지로 돌아갈 때는 source 를 그 커밋으로 되돌린 뒤 --build
```
