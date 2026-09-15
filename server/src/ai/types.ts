// AI 회의 노트가 쓰는 두 외부 작업의 경계: 소리를 글로 바꾸는 전사(SttProvider)와 그 글을 줄이는 요약(Summarizer).
// 어느 서비스를 쓰든 이 형태로 주고받으므로, 서비스를 바꿀 때 구현체 하나만 갈아 끼우면 된다 (ai/index.ts 가 고른다).
// 시각은 모두 밀리초 정수다 — 서비스마다 초·밀리초가 달라 여기서 통일한다. recording_marks.offset_ms 와 같은 기준이라 메모와 맞춰 보일 수 있다.

// 화자 하나가 이어서 말한 덩어리. 화면에 보이는 단위다.
export type Segment = { speaker: string | null; startMs: number; endMs: number; text: string };
// 낱말 하나. 특정 시각으로 되감을 때 쓴다.
export type Word = { speaker: string | null; startMs: number; endMs: number; text: string };
export type Transcript = {
    provider: string;
    language: string;
    durationMs: number;
    segments: Segment[];
    words: Word[];
};

export type TranscribeInput = {
    path: string;     // 전사할 소리 파일의 실제 경로
    mime: string;     // 원본 형식 (audio/webm 등). 변환이 필요한지 판단하는 데 쓴다
    language: string; // 'ko' 처럼 언어 코드. 빈 값이면 서비스가 알아서 고른다
};
export interface SttProvider {
    readonly name: string;
    // onStage 는 오래 걸리는 단계를 화면에 알리는 통로다 ('변환 중'·'전사 중' 등).
    transcribe(input: TranscribeInput, onStage: (stage: string) => void): Promise<Transcript>;
}

// 실시간 전사. 녹음이 도는 동안 결과가 조금씩 나온다 (2026-09-14 ai-meeting-notes).
// 구현체는 16kHz 모노 s16le PCM 만 받는다 — 브라우저가 보내는 webm 을 PCM 으로 바꾸는 일은 부르는 쪽(ai/live.ts)이
// ffmpeg 로 한 번만 하고, 서비스마다 다시 하지 않는다.
export type LiveStream = {
    push(pcm: Buffer): void;
    end(): Promise<Transcript>; // 남은 결과까지 받고 최종 전사를 돌려준다
    abort(): void;              // 결과를 버리고 연결을 끊는다
};
export interface StreamingStt extends SttProvider {
    // onUpdate 는 지금까지 확정된 덩어리 전부를 준다. 확정 전의 임시 글은 보내지 않는다 — 글자가 흔들려 읽기 어렵고,
    // 바뀔 때마다 모든 화면으로 전사 전체가 다시 나가기 때문이다.
    openStream(language: string, onUpdate: (segments: Segment[]) => void): Promise<LiveStream>;
}
export const canStream = (p: SttProvider): p is StreamingStt => typeof (p as StreamingStt).openStream === 'function';

// 요약 결과. 내장 회의록 템플릿의 '결정 사항'·'다음 할 일' 과 같은 뼈대다.
export type Summary = { summary: string; decisions: string[]; actions: string[] };
export type SummarizeInput = {
    title: string;
    model: string;   // 이 요약에 쓸 모델. 사용자가 노트에서 고른 값이고, 비어 있으면 구현체의 기본 모델을 쓴다
    transcript: Transcript;
    marks: { offsetMs: number; text: string }[]; // 회의 중 남긴 시각 메모. 요약이 놓치기 쉬운 강조점이다
};
export interface Summarizer {
    readonly name: string;
    summarize(input: SummarizeInput): Promise<Summary>;
}

// 전사 결과를 요약 프롬프트에 넣을 글로 편다. '[12:34 화자1] 내용' 한 줄이 덩어리 하나다.
export function transcriptText(t: Transcript): string {
    const clock = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    return t.segments.map(s => `[${clock(s.startMs)}${s.speaker ? ` ${s.speaker}` : ''}] ${s.text}`).join('\n');
}

// 낱말 목록을 덩어리로 묶는다. 서비스가 낱말만 줄 때 쓴다.
// 화자 전환과 말이 끊기는 자리만 보면, 한 사람이 쉬지 않고 말할 때 녹음 전체가 한 덩어리로 뭉쳐 시각 표시가 무의미해진다.
// 그래서 덩어리가 길어지면 길이로도 나눈다 (2026-09-15 transcript-chunking).
const GAP_MS = 1500;   // 이만큼 말이 비면 같은 화자여도 덩어리를 나눈다
const SENT_MS = 12000; // 덩어리가 이보다 길어졌으면 다음으로 문장이 끝나는 자리에서 나눈다
const MAX_MS = 30000;  // 문장부호가 계속 나오지 않아도 이 길이에서는 문장 도중이라도 나눈다

const SENTENCE_END = /[.?!]$/;   // 문장이 끝난 자리
const JOINS_LEFT = /^[,.?!…]/;   // 앞말에 붙여 쓰는 문장부호

// 지금 덩어리를 여기서 끝내고 다음 낱말부터 새로 시작할지 정한다.
// 판단에 쓰는 것은 지금까지 쌓인 덩어리와 바로 다음 낱말뿐이라, 뒤에 낱말이 더 붙어도 이미 나뉘어 나간 앞쪽 덩어리는 다시 바뀌지 않는다.
// 실시간 전사에서 ainotes.ts 의 syncSegments 가 덩어리를 차례 번호로 짝지으므로, 이 성질이 깨지면 이미 보낸 행이 어긋난다.
function breakBefore(seg: Segment, next: Word): boolean {
    if (seg.speaker !== next.speaker) return true;
    if (next.startMs - seg.endMs >= GAP_MS) return true;
    if (JOINS_LEFT.test(next.text)) return false; // 문장부호 하나로 새 덩어리를 시작하지는 않는다
    const ms = seg.endMs - seg.startMs;
    if (ms >= MAX_MS) return true;
    return ms >= SENT_MS && SENTENCE_END.test(seg.text);
}

export function segmentsFromWords(words: Word[]): Segment[] {
    const out: Segment[] = [];
    for (const w of words) {
        const last = out[out.length - 1];
        if (last && !breakBefore(last, w)) {
            // 문장부호는 앞말에 붙이고 나머지는 띄어 쓴다
            last.text += JOINS_LEFT.test(w.text) ? w.text : ` ${w.text}`;
            last.endMs = w.endMs;
        } else {
            out.push({ speaker: w.speaker, startMs: w.startMs, endMs: w.endMs, text: w.text });
        }
    }
    return out;
}
