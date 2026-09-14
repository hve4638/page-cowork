// OpenAI chat completions 형식으로 요약을 맡기는 구현체. 주소·키·모델만 설정으로 받으므로 같은 형식을 따르는 곳이면 어디든 붙는다
// (OpenAI, 사내에 직접 세운 에이전트, 로컬 모델 서버 등). 특정 업체의 SDK 를 쓰지 않는 이유가 그것이다.
// 응답은 JSON 하나로 받는다. 모델이 코드 울타리(```json)를 씌우거나 앞뒤에 말을 붙이는 경우가 있어 중괄호 범위만 떼어 파싱한다.
// baseUrl 은 보통 '<주소>/v1' 처럼 앞부분만 적고 '/chat/completions' 를 여기서 붙인다.
// 끝 경로까지 적어 둔 주소는 그대로 쓴다 — 경로가 다르거나 끝 슬래시를 요구하는 게이트웨이가 있기 때문이다.
import { ai } from '../config.ts';
import { transcriptText, type Summarizer, type Summary } from './types.ts';

const SYSTEM = `당신은 한국어 회의록 정리 담당자입니다. 회의 전사 원문을 읽고 아래 JSON 하나만 출력하세요. 설명이나 코드 울타리를 붙이지 마세요.
{"summary": "회의 전체를 3~5문장으로 요약한 글", "decisions": ["회의에서 확정된 사항"], "actions": ["담당자: 할 일"]}
규칙: 전사에 없는 내용을 지어내지 않습니다. 확정되지 않은 것은 decisions 에 넣지 않습니다. 담당자를 알 수 없으면 이름 없이 할 일만 적습니다. 해당 항목이 없으면 빈 배열로 둡니다.`;

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
                    { role: 'system', content: SYSTEM },
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
