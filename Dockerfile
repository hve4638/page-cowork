# 1단계: 클라이언트 빌드
FROM node:22-bookworm-slim AS client-build
RUN corepack enable
WORKDIR /app/client
COPY client/package.json client/pnpm-lock.yaml client/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY client/ ./
RUN pnpm build

# 2단계: 서버 (TS 를 node 가 직접 실행한다. 빌드 없음)
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY server/ ./
COPY deploy/config.docker.json ./config.json
COPY --from=client-build /app/client/dist /app/client/dist
ENV NODE_ENV=production
VOLUME /data
EXPOSE 8771
CMD ["node", "--experimental-sqlite", "src/index.ts"]
