// 가짜 전사·요약. 외부 서비스 키 없이 화면과 흐름(진행 표시·실패·다시 하기·다른 사용자 반영)을 확인하려고 둔다.
// 실제 서비스와 같은 인터페이스를 지키고, 단계마다 잠깐 쉬어 진행 표시가 보이게 한다. 소리 파일의 내용은 보지 않는다.
import { statSync } from 'node:fs';
import { segmentsFromWords, type LiveStream, type StreamingStt, type Summarizer, type Summary, type Transcript, type Word } from './types.ts';

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const STEP_MS = 1200;

// 회의처럼 보이는 대본. 낱말 단위로 쪼개 시각을 매긴다 (한 낱말 0.4초, 화자 바뀔 때 1초 쉼).
const SCRIPT: { speaker: string; text: string }[] = [
    { speaker: '화자 1', text: '자, 그럼 이번 주 회의 시작하겠습니다. 먼저 배포 일정부터 정리하죠.' },
    { speaker: '화자 2', text: '지난주에 미뤘던 인증 개편이 아직 검토 중입니다. 목요일까지는 초안을 올리겠습니다.' },
    { speaker: '화자 1', text: '그러면 금요일 오전에 같이 보고, 문제가 없으면 다음 주 화요일에 배포하는 걸로 하죠.' },
    { speaker: '화자 3', text: '녹음 파일 용량이 생각보다 커서 보관 정책도 정해야 할 것 같습니다.' },
    { speaker: '화자 1', text: '보관 기간은 30일로 하죠. 더 필요하면 그때 늘리면 됩니다.' },
    { speaker: '화자 2', text: '전사 결과를 회의록에 자동으로 넣는 것도 생각해 봐야 합니다. 지금은 블럭 안에서만 보이니까요.' },
    { speaker: '화자 1', text: '그건 다음 주에 따로 이야기하죠. 이번에는 보고 확인하는 것까지만 합니다.' },
    { speaker: '화자 3', text: '외부 서비스 비용은 어느 정도로 잡아야 할까요. 회의가 많아지면 무시할 수 없을 텐데요.' },
    { speaker: '화자 2', text: '시간당 요금이라 한 달에 스무 시간 정도면 크지 않습니다. 다만 긴 회의가 몰리면 대기가 생길 수 있습니다.' },
    { speaker: '화자 1', text: '한 번에 하나씩만 처리하도록 해 두었으니 순서대로 기다리게 됩니다. 급한 건이 있으면 그때 늘리죠.' },
    { speaker: '화자 3', text: '실패했을 때 사용자가 무엇을 해야 하는지도 화면에 보여야 합니다.' },
    { speaker: '화자 2', text: '실패하면 이유가 블럭에 뜨고 다시 만들기 버튼이 나옵니다. 서버가 재시작돼 끊긴 것도 같은 방식으로 보입니다.' },
    { speaker: '화자 1', text: '좋습니다. 그럼 정리하겠습니다. 배포는 다음 주 화요일, 보관은 30일, 비용은 다시 보기로 합니다.' },
    { speaker: '화자 3', text: '회의록 자동 삽입은 다음 회의 안건으로 올려 두겠습니다.' },
    { speaker: '화자 1', text: '네, 오늘은 여기까지 하겠습니다. 수고하셨습니다.' },
];

function script(): { words: Word[]; durationMs: number } {
    const words: Word[] = [];
    let at = 800, prev = '';
    for (const line of SCRIPT) {
        if (prev && prev !== line.speaker) at += 1000;
        prev = line.speaker;
        for (const w of line.text.split(' ')) {
            words.push({ speaker: line.speaker, startMs: at, endMs: at + 400, text: w });
            at += 450;
        }
    }
    return { words, durationMs: at + 500 };
}

export const mockStt: StreamingStt = {
    name: 'mock',
    async transcribe(input, onStage): Promise<Transcript> {
        onStage('소리 파일 준비');
        await wait(STEP_MS);
        // 파일이 실제로 있는지는 확인한다 — 경로가 어긋나는 실수는 가짜 제공자에서도 잡는 편이 낫다
        statSync(input.path);
        onStage('전사');
        await wait(STEP_MS * 2);
        const { words, durationMs } = script();
        return { provider: 'mock', language: input.language || 'ko', durationMs, segments: segmentsFromWords(words), words };
    },

    // 가짜 실시간 전사. 들어오는 소리는 보지 않고 대본을 낱말 한 개씩 흘려 보낸다.
    // 대본의 시각이 낱말마다 450ms 씩이라 실제 시간과 대체로 맞는다 — 진행 속도가 실제와 비슷해 보인다.
    async openStream(language, onUpdate): Promise<LiveStream> {
        const all = script().words;
        const said: Word[] = [];
        let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
            if (said.length >= all.length) { stop(); return; }
            said.push(all[said.length]);
            onUpdate(segmentsFromWords(said));
        }, 450);
        const stop = () => { if (timer) clearInterval(timer); timer = null; };
        const result = (): Transcript => ({
            provider: 'mock', language: language || 'ko',
            durationMs: said.at(-1)?.endMs ?? 0,
            segments: segmentsFromWords(said), words: said,
        });
        return {
            push() { /* 소리는 버린다 */ },
            async end(): Promise<Transcript> { stop(); await wait(STEP_MS); return result(); },
            abort() { stop(); },
        };
    },
};


export const mockSummarizer: Summarizer = {
    name: 'mock',
    async summarize({ title, model, marks }): Promise<Summary> {
        await wait(STEP_MS);
        return {
            summary: `${model ? `(${model} 요약) ` : ''}${title || '회의'}에서는 인증 개편의 배포 일정과 녹음 파일 보관 정책을 다루었습니다. 인증 개편 초안을 목요일까지 올리고 금요일 오전에 함께 검토한 뒤, 문제가 없으면 다음 주 화요일에 배포하기로 했습니다. 녹음 파일은 30일간 보관하고 필요하면 나중에 기간을 늘리기로 했습니다.`,
            decisions: [
                '인증 개편은 다음 주 화요일에 배포한다.',
                '녹음 파일은 30일간 보관하고, 부족하면 그때 기간을 늘린다.',
                ...marks.map(m => `회의 중 메모: ${m.text}`),
            ],
            actions: [
                '화자 2: 목요일까지 인증 개편 초안을 올린다.',
                '화자 1: 금요일 오전에 초안을 검토한다.',
                '화자 3: 녹음 보관 정책을 문서에 반영한다.',
            ],
        };
    },
};
