// OpenAI chat completions 형식으로 요약을 맡기는 구현체. 주소·키·모델만 설정으로 받으므로 같은 형식을 따르는 곳이면 어디든 붙는다
// (OpenAI, 사내에 직접 세운 에이전트, 로컬 모델 서버 등). 특정 업체의 SDK 를 쓰지 않는 이유가 그것이다.
// 응답은 JSON 하나로 받는다. 모델이 코드 울타리(```json)를 씌우거나 앞뒤에 말을 붙이는 경우가 있어 중괄호 범위만 떼어 파싱한다.
// baseUrl 은 보통 '<주소>/v1' 처럼 앞부분만 적고 '/chat/completions' 를 여기서 붙인다.
// 끝 경로까지 적어 둔 주소는 그대로 쓴다 — 경로가 다르거나 끝 슬래시를 요구하는 게이트웨이가 있기 때문이다.
// system 메시지는 코드가 아니라 <prompts>/summary.md 가 원본이다 (2026-09-15 summary-prompt-file).
// 이미지를 다시 굽지 않고 프롬프트를 다듬을 수 있어야 해서, Docker 에서 호스트와 공유되는 데이터 디렉터리 아래에 두고
// 요약 요청마다 읽는다. 그 파일이 없을 때 만들어 넣을 기본 내용은 저장소의 server/prompts/summary.md 가 원본이며,
// dataDir 쪽을 읽지 못했을 때도 이 내용으로 요약한다. 기본 문구도 마크다운으로 두어야 프롬프트를 코드와 떼어 놓고 고칠 수 있다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ai, config } from '../config.ts';
import { transcriptText, type Summarizer, type Summary } from './types.ts';

const PROMPT_PATH = join(config.prompts, 'summary.md');
const DEFAULT_PATH = fileURLToPath(new URL('../../prompts/summary.md', import.meta.url));
const DEFAULT_PROMPT = readFileSync(DEFAULT_PATH, 'utf8');

const COMMENT = /<!--[\s\S]*?-->/g; // 편집자에게 보이는 안내일 뿐이라 모델에는 보내지 않는다

// 파일을 기본 내용으로 만든다. 쓰지 못해도 요약은 기본 문구로 이어져야 하므로 던지지 않고 로그만 남긴다.
function create(): void {
    try {
        mkdirSync(config.prompts, { recursive: true });
        writeFileSync(PROMPT_PATH, DEFAULT_PROMPT);
        console.log(`[ai] 요약 프롬프트를 기본 내용으로 만들었습니다: ${PROMPT_PATH}`);
    } catch (err) {
        console.log(`[ai] 요약 프롬프트를 만들지 못했습니다: ${PROMPT_PATH} (${String(err)})`);
    }
}

if (!existsSync(PROMPT_PATH)) create(); // 기동 시 한 번. 이미 있으면 사용자가 고친 내용이므로 건드리지 않는다

// 요약 한 번마다 파일을 읽는다. 지워졌거나 비어 있어도 요약은 기본 문구로 돌아가야 한다.
// 그때 파일도 다시 만든다 — 배포 머신에서 파일을 지워 기본 문구로 되돌릴 때 서버를 다시 띄우지 않아도 되게 하기 위해서다.
// 다만 주석만 남은 파일은 사람이 쓴 내용이라 덮어쓰지 않는다.
function systemPrompt(): string {
    try {
        const raw = readFileSync(PROMPT_PATH, 'utf8');
        const text = raw.replace(COMMENT, '').trim();
        if (text) return text;
        if (raw.trim()) console.log(`[ai] 요약 프롬프트에 주석만 있어 기본 문구를 씁니다: ${PROMPT_PATH}`);
        else create();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') create();
        else console.log(`[ai] 요약 프롬프트를 읽지 못해 기본 문구를 씁니다: ${PROMPT_PATH} (${String(err)})`);
    }
    return DEFAULT_PROMPT.replace(COMMENT, '').trim();
}

const endpoint = (base: string): string =>
    (/\/chat\/completions\/?$/.test(base) ? base : `${base.replace(/\/$/, '')}/chat/completions`);

// 응답 글에서 JSON 객체만 떼어낸다.
function parse(text: string): Summary {
    const from = text.indexOf('{'), to = text.lastIndexOf('}');
    if (from < 0 || to < from) throw new Error(`요약 응답에서 JSON 을 찾지 못했습니다: ${text.slice(0, 200)}`);
    const raw = JSON.parse(text.slice(from, to + 1)) as Partial<Summary>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
    return { summary: String(raw.summary ?? ''), decisions: list(raw.decisions), actions: list(raw.actions) };
}

export const chatSummarizer: Summarizer = {
    name: 'chat',
    async summarize({ title, model, transcript, marks }): Promise<Summary> {
        if (!ai.llm.baseUrl) throw new Error('요약 서버 주소가 없습니다. 설정 파일의 ai.llm.baseUrl 또는 환경변수 LLM_BASE_URL 을 채워 주세요.');
        const noted = marks.length ? `\n\n참석자가 회의 중 남긴 메모:\n${marks.map(m => `- ${m.text}`).join('\n')}` : '';
        const res = await fetch(endpoint(ai.llm.baseUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(ai.llm.apiKey ? { authorization: `Bearer ${ai.llm.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: model || ai.llm.model,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: systemPrompt() },
                    { role: 'user', content: `회의 제목: ${title || '(없음)'}\n\n전사 원문:\n${transcriptText(transcript)}${noted}` },
                ],
            }),
        });
        if (!res.ok) throw new Error(`요약 요청 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json() as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error('요약 응답이 비어 있습니다.');
        return parse(content);
    },
};
