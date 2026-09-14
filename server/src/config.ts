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
    ai?: { stt?: AiProvider; llm?: AiProvider }; // AI 회의 노트의 전사·요약 제공자
    port?: number;
    host?: string;
};
// 전사·요약을 맡길 서비스 하나의 설정. provider 가 어느 구현체를 쓸지 고르고 나머지는 그 구현체가 읽는다 (ai/index.ts).
type AiProvider = { provider?: string; apiKey?: string; baseUrl?: string; liveUrl?: string; model?: string; models?: AiModel[]; language?: string };
// 화면의 모델 고르개에 올릴 항목. id 는 서비스가 받는 모델 이름이고 label 은 사람이 읽을 이름이다.
export type AiModel = { id: string; label: string };

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

// AI 회의 노트 설정. 환경변수가 설정 파일보다 우선한다 — 키를 파일에 적지 않고 기동할 수 있어야 하기 때문이다.
// 어느 쪽이든 저장소에는 넣지 않는다 (server/config.json 은 git 제외 대상이다).
// 환경변수로 모델 목록을 줄 때의 형식: 'gpt-5.6-luna=Luna,gpt-5.6-terra=Terra'. 이름을 생략하면 id 를 그대로 쓴다.
function parseModels(v: string | undefined): AiModel[] | null {
    if (!v) return null;
    return v.split(',').map(part => {
        const [id, label] = part.split('=');
        return { id: id.trim(), label: (label ?? id).trim() };
    }).filter(m => m.id);
}

export const ai = {
    stt: {
        provider: process.env.STT_PROVIDER ?? raw.ai?.stt?.provider ?? 'mock',
        apiKey: process.env.STT_API_KEY ?? raw.ai?.stt?.apiKey ?? '',
        baseUrl: process.env.STT_BASE_URL ?? raw.ai?.stt?.baseUrl ?? '',
        liveUrl: process.env.STT_LIVE_URL ?? raw.ai?.stt?.liveUrl ?? '', // 실시간 전사의 WebSocket 주소. 비우면 구현체 기본값
        language: process.env.STT_LANGUAGE ?? raw.ai?.stt?.language ?? 'ko',
    },
    llm: {
        provider: process.env.LLM_PROVIDER ?? raw.ai?.llm?.provider ?? 'mock',
        apiKey: process.env.LLM_API_KEY ?? raw.ai?.llm?.apiKey ?? '',
        baseUrl: process.env.LLM_BASE_URL ?? raw.ai?.llm?.baseUrl ?? '',
        model: process.env.LLM_MODEL ?? raw.ai?.llm?.model ?? '',
        // 사용자가 노트에서 바꿔 가며 쓸 수 있는 모델들. 비어 있으면 화면에 고르개가 나오지 않는다.
        models: parseModels(process.env.LLM_MODELS) ?? raw.ai?.llm?.models ?? [],
    },
};
// 노트에 고른 모델이 없을 때 쓸 기본값. 목록의 첫 항목을 쓴다.
if (!ai.llm.model && ai.llm.models.length) ai.llm.model = ai.llm.models[0].id;

// 데이터 디렉터리 아래 경로. 디렉터리 인자는 뒤에 '/' 를 붙여 `DIR + id` 꼴로 이어 쓸 수 있게 한다
export const dataPath = (...parts: string[]) => join(dataDir, ...parts);
export const DB_PATH = dataPath('cowork.db');
export const FILES_DIR = dataPath('files') + '/';
export const REC_DIR = dataPath('recordings') + '/';
