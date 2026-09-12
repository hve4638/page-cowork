// 배포 설정. server/config.json (또는 COWORK_CONFIG 가 가리키는 JSON) 을 읽고, 없으면 개발용 기본값을 쓴다.
// 상대 경로는 설정 파일이 있는 디렉터리 기준으로 푼다. PORT 환경변수는 워크트리 병행 검증용으로 설정 파일보다 우선한다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type RawConfig = {
    dataDir?: string;   // cowork.db·files/·recordings/·whitelist.txt·admin.txt 가 놓이는 루트. 기본 server/data
    staticDir?: string; // vite build 산출물. 기본 client/dist. 없으면 API 만 서빙한다 (개발 시 vite 가 화면 담당)
    whitelist?: string; // 가입 허용 이메일 목록. 기본 <dataDir>/whitelist.txt
    admin?: string;     // 관리자 이메일 목록. 기본 <dataDir>/admin.txt
    port?: number;
    host?: string;
};

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_PATH = resolve(process.env.COWORK_CONFIG ?? join(SERVER_ROOT, 'config.json'));

let raw: RawConfig = {};
if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RawConfig;
else if (process.env.COWORK_CONFIG) throw new Error(`COWORK_CONFIG 파일이 없습니다: ${CONFIG_PATH}`);

const rel = (p: string) => resolve(dirname(CONFIG_PATH), p);
const dataDir = raw.dataDir ? rel(raw.dataDir) : join(SERVER_ROOT, 'data');

export const config = {
    path: existsSync(CONFIG_PATH) ? CONFIG_PATH : null,
    dataDir,
    staticDir: raw.staticDir ? rel(raw.staticDir) : resolve(SERVER_ROOT, '../client/dist'),
    whitelist: raw.whitelist ? rel(raw.whitelist) : join(dataDir, 'whitelist.txt'),
    admin: raw.admin ? rel(raw.admin) : join(dataDir, 'admin.txt'),
    port: Number(process.env.PORT ?? raw.port ?? 8771),
    host: raw.host ?? '0.0.0.0',
};

// 데이터 디렉터리 아래 경로. 디렉터리 인자는 뒤에 '/' 를 붙여 `DIR + id` 꼴로 이어 쓸 수 있게 한다
export const dataPath = (...parts: string[]) => join(dataDir, ...parts);
export const DB_PATH = dataPath('cowork.db');
export const FILES_DIR = dataPath('files') + '/';
export const REC_DIR = dataPath('recordings') + '/';
