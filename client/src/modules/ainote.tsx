// AI 회의 노트 블럭. 소리 파일 하나를 전사·요약한 결과(ai_notes 행)를 요약·전사 두 탭으로 보여 준다.
// 행은 서버만 만들고 고친다 (server/src/ainotes.ts). 클라이언트는 읽기 전용으로 구독하고, 작업을 걸거나 다시 하는 것만 HTTP 로 부른다.
// 그래서 진행 상태(status·stage)가 다른 사용자 화면에도 그대로 흘러가고, undo 묶음과도 얽히지 않는다.
// 같은 컴포넌트가 두 자리에 쓰인다: 본문 블럭(테두리 상자, 전사는 높이를 제한하고 그 안에서 스크롤)과
// 오른쪽 패널(close 를 주면 패널 모양. 헤더가 탑바 높이에 맞고 전사가 패널 높이를 채운다).
// 긴 회의의 전사가 본문을 끝없이 밀어내지 않도록, 본문에서는 상자 안 스크롤로 두고 '전체 보기' 로 패널을 연다.
// 패널을 여는 함수는 넘겨받는다 (expand) — SidePeek 을 직접 import 하면 두 파일이 서로를 부르게 된다.
import { useEffect, useState, type DragEvent } from 'react';
import { table } from '@/sync/handle';
import { fmtClock } from './recorder';

// 전사 덩어리 하나. 노트 행이 아니라 자기 행으로 온다 — 녹음 중에는 새 덩어리(insert)와
// 말이 이어지는 마지막 덩어리(update)만 오므로, 전사가 길어져도 오가는 양이 늘지 않는다.
export type AiSegmentRow = { id: string; note_id: string; speaker: string | null; start_ms: number; end_ms: number; text: string };
export type Summary = { summary: string; decisions: string[]; actions: string[] };
export type AiNoteRow = {
    id: string;
    title: string;
    recording_id: string | null;
    file_id: string | null;
    status: 'pending' | 'running' | 'done' | 'error';
    stage: string; // 진행 중인 단계 이름 ('전사'·'요약' 등). 서버가 단계마다 갱신한다
    provider: string;
    language: string;
    duration_ms: number;
    model: string;                        // 지금 고른 요약 모델. 이 모델의 요약을 보인다
    summaries: Record<string, Summary>;   // 모델마다 만들어 둔 요약. 한 번 만든 모델은 다시 부르지 않는다
    error: string | null;
    created_by?: string | null;
    created_at?: number;
    updated_at?: number;
};

export type AiModel = { id: string; label: string };

export const aiNotes = () => table<AiNoteRow>('ai_notes', 'ro');
export const aiSegments = () => table<AiSegmentRow>('ai_note_segments', 'ro');
export const noteOfRecording = (rows: AiNoteRow[], recordingId: string) =>
    rows.filter(n => n.recording_id === recordingId).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

// 작업 걸기. 녹음에서 만들면 recording_id 만 주면 되고(서버가 파일·제목을 찾는다), 올린 파일이면 file_id 와 제목을 준다.
export async function createNote(body: { recording_id?: string; file_id?: string; title?: string }): Promise<AiNoteRow | null> {
    const res = await fetch('/api/ai-notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const out = await res?.json().catch(() => null) as { note?: AiNoteRow; error?: string } | null;
    if (!res?.ok || !out?.note) { alert(out?.error ?? '노트를 만들지 못했습니다.'); return null; }
    return out.note;
}
// 고를 수 있는 요약 모델 목록. 서버 설정에서 오고 세션 동안 바뀌지 않으므로 한 번만 받아 둔다.
let modelCache: AiModel[] | null = null;
export function useAiModels(): AiModel[] {
    const [models, setModels] = useState<AiModel[]>(modelCache ?? []);
    useEffect(() => {
        if (modelCache) return;
        void fetch('/api/ai-notes/models')
            .then(r => r.json() as Promise<{ models?: AiModel[] }>)
            .then(b => { modelCache = b.models ?? []; setModels(modelCache); })
            .catch(() => { modelCache = []; });
    }, []);
    return models;
}

// 요약 모델을 바꾼다. 그 모델로 이미 요약해 두었으면 서버가 곧바로 바꾸고, 없으면 요약만 다시 돌린다.
export async function setNoteModel(id: string, model: string): Promise<void> {
    const res = await fetch(`/api/ai-notes/${id}/model`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
    }).catch(() => null);
    if (!res?.ok) {
        const body = await res?.json().catch(() => null) as { error?: string } | null;
        alert(body?.error ?? '모델을 바꾸지 못했습니다.');
    }
}

export async function retryNote(id: string): Promise<void> {
    const res = await fetch(`/api/ai-notes/${id}/retry`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) alert('다시 시도하지 못했습니다.');
}

const TAB = 'px-3 h-8 text-[13px] cursor-pointer bg-transparent! border-b-2';
const HEAD_BTN = 'shrink-0 whitespace-nowrap text-[12px] px-2 py-1 rounded-md cursor-pointer bg-transparent! text-[var(--c-texSec)] hover:bg-[var(--ca-bacIntTra)]';
const TRANSCRIPT_MAX = 'max-h-[280px]'; // 본문 블럭에서 전사가 차지할 최대 높이. 넘으면 상자 안에서 스크롤한다

function Bullets({ title, items, icon }: { title: string; items: string[]; icon: string }) {
    if (!items.length) return null;
    return (
        <div className="flex flex-col gap-1">
            <div className="text-[12px] font-medium text-[var(--c-texTer)]">{title}</div>
            <ul className="flex flex-col gap-1">
                {items.map((t, i) => (
                    <li key={i} className="flex gap-2 text-[14px] leading-[1.6]">
                        <span className="shrink-0 text-[var(--c-texTer)]">{icon}</span>
                        <span className="flex-1 whitespace-pre-wrap break-words">{t}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// close 를 주면 패널 모양, 아니면 본문 블럭 모양. expand 를 주면 헤더에 '전체 보기' 가 생긴다.
// nested 는 녹음 상자 안에 들어갈 때다 — 제목·길이는 녹음 쪽 헤더에 이미 있으므로 빼고 테두리도 두르지 않는다.
export function AiNoteBlock({ note, expand, close, nested }: { note: AiNoteRow | undefined; expand?: () => void; close?: () => void; nested?: boolean }) {
    const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
    const models = useAiModels();
    const segments = aiSegments().useRows()
        .filter(g => g.note_id === note?.id)
        .sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
    const stop = (e: DragEvent) => e.stopPropagation();
    if (!note) return <span className="text-[var(--c-texTer)] cursor-default">🪄 삭제된 회의 노트</span>;

    const panel = !!close;
    const working = note.status === 'pending' || note.status === 'running';
    const hasText = segments.length > 0;
    const summary = note.summaries[note.model] ?? null;
    // 설정에서 빠진 모델로 만들어 둔 요약이 있으면 그 모델도 목록에 남겨, 고르개가 빈 값으로 보이지 않게 한다
    const choices = note.model && !models.some(m => m.id === note.model)
        ? [...models, { id: note.model, label: note.model }]
        : models;

    return (
        <div
            className={panel ? 'h-full flex flex-col' : nested ? '' : 'rounded-xl border border-[var(--c-borPri)] overflow-hidden'}
            onDragStart={stop}
            onDragOver={stop}
            onDrop={stop}
        >
            <header className={`flex items-center gap-2 shrink-0 border-b border-[var(--c-borPri)] ${panel ? 'h-11 px-3' : nested ? 'h-9 px-3' : 'h-10 px-3 bg-[var(--c-bacSec)]'}`}>
                {/* 녹음 상자 안에서는 제목 줄이 바로 위에 있으므로 이름표를 두지 않는다 */}
                {!nested && <span className="truncate text-[13px] font-medium">🪄 {note.title || 'AI 회의 노트'}</span>}
                {!nested && note.duration_ms > 0 && <span className="text-[12px] text-[var(--c-texTer)] font-mono tabular-nums">{fmtClock(note.duration_ms)}</span>}
                <span className="flex-1" />
                {note.status === 'done' && note.provider && <span className="text-[11px] text-[var(--c-texTer)]">{note.provider}</span>}
                {expand && <button className={HEAD_BTN} onClick={expand}>전체 보기</button>}
                {!working && <button className={HEAD_BTN} onClick={() => void retryNote(note.id)}>다시 만들기</button>}
                {close && <button className={`${HEAD_BTN} text-[13px]`} onClick={close} aria-label="닫기">✕</button>}
            </header>

            {working && (
                <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
                    <div className="flex items-center gap-2 text-[13px] text-[var(--c-texSec)]">
                        <span className="shrink-0 w-2 h-2 rounded-full bg-[var(--c-bluBacAccPri)] animate-pulse" />
                        <span>{note.stage || '진행 중'}…</span>
                    </div>
                    <div className="text-[12px] text-[var(--c-texTer)]">전사와 요약에는 몇 분이 걸립니다. 창을 닫아도 계속됩니다.</div>
                </div>
            )}
            {note.status === 'error' && (
                <div className="px-3 py-3 text-[13px] text-[#b3261e] whitespace-pre-wrap break-words shrink-0">{note.error || '알 수 없는 이유로 실패했습니다.'}</div>
            )}

            {hasText && (
                <>
                    <div className="flex items-center gap-1 px-2 shrink-0 border-b border-[var(--c-borPri)]">
                        {([['summary', '요약'], ['transcript', '전사']] as const).map(([k, label]) => (
                            <button
                                key={k}
                                className={`${TAB} ${tab === k ? 'border-[var(--c-texPri)] text-[var(--c-texPri)]' : 'border-transparent text-[var(--c-texTer)] hover:text-[var(--c-texSec)]'}`}
                                onClick={() => setTab(k)}
                            >{label}</button>
                        ))}
                        <span className="flex-1" />
                        {tab === 'summary' && choices.length > 0 && (
                            <select
                                className="h-6 mr-1 px-1 text-[12px] rounded-md cursor-pointer bg-transparent text-[var(--c-texSec)] border border-[var(--c-borPri)]"
                                value={note.model}
                                disabled={working}
                                onChange={e => void setNoteModel(note.id, e.target.value)}
                                title="요약에 쓸 모델. 바꾸면 그 모델로 다시 요약합니다 (이미 만든 모델은 그대로 보여 줍니다)"
                            >
                                {/* 모델을 고른 적이 없는 노트(설정에 목록이 없던 때 만든 것)는 빈 항목을 먼저 보여, 무엇이든 고르면 바뀌게 한다 */}
                                {!note.model && <option value="">모델 고르기</option>}
                                {choices.map(m => (
                                    <option key={m.id} value={m.id}>{note.summaries[m.id] ? m.label : `${m.label} (새로 요약)`}</option>
                                ))}
                            </select>
                        )}
                    </div>
                    <div className={`p-3 ${panel ? 'flex-1 min-h-0 overflow-y-auto' : ''}`}>
                        {tab === 'summary' ? (
                            summary ? (
                                <div className="flex flex-col gap-3">
                                    {summary.summary && <p className="text-[14px] leading-[1.7] whitespace-pre-wrap break-words">{summary.summary}</p>}
                                    <Bullets title="결정 사항" items={summary.decisions} icon="•" />
                                    <Bullets title="다음 할 일" items={summary.actions} icon="☐" />
                                </div>
                            ) : (
                                <div className="text-[13px] text-[var(--c-texTer)]">아직 요약이 없습니다. 전사 탭에서 원문을 볼 수 있습니다.</div>
                            )
                        ) : (
                            // 본문 블럭에서는 긴 전사가 페이지를 밀어내지 않도록 높이를 막고 그 안에서 스크롤한다. 패널에서는 패널 높이를 쓴다.
                            <ul className={`flex flex-col gap-2 ${panel ? '' : `${TRANSCRIPT_MAX} overflow-y-auto`}`}>
                                {segments.map(s => (
                                    <li key={s.id} className="flex gap-2.5">
                                        <span className="shrink-0 font-mono tabular-nums text-[11px] text-[var(--c-texTer)] mt-px">{fmtClock(s.start_ms)}</span>
                                        <span className="flex-1 text-[14px] leading-[1.6] whitespace-pre-wrap break-words">
                                            {s.speaker && <span className="text-[12px] text-[var(--c-texTer)] mr-1.5">{s.speaker}</span>}
                                            {s.text}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
