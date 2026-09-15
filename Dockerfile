# 1단계: 클라이언트 빌드
FROM node:22-bookworm-slim AS client-build
RUN corepack enable
WORKDIR /app/client
COPY client/package.json client/pnpm-lock.yaml client/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY client/ ./
RUN pnpm build

# 2단계: 서버 (TS 를 node 가 직접 실행한다. 빌드 없음)
# ffmpeg 는 AI 회의 노트가 쓴다 — 전사 서비스에 올리기 전에 녹음(webm/Opus)을 flac 으로 바꾼다 (2026-09-14 ai-meeting-notes)
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY server/ ./
COPY deploy/config.docker.json ./config.json
COPY --from=client-build /app/client/dist /app/client/dist
ENV NODE_ENV=production
# 포트는 compose 가 PORT 환경변수로 넘긴다 (COWORK_PORT, 기본 80). 아래는 compose 없이 띄울 때의 기본값
VOLUME /data
EXPOSE 80
CMD ["node", "--experimental-sqlite", "src/index.ts"]
