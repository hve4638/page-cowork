// 녹음 블럭. 녹음·파일 올리기·AI 전사를 한 자리에 모은다 (2026-09-14 ai-meeting-notes).
// '/녹음' 은 블럭과 idle 녹음 행만 만든다. 마이크를 여는 것은 사용자가 '녹음 시작' 을 눌렀을 때다 — 명령을 고르자마자
// 권한 대화상자가 뜨던 이전 동작이 부담스러웠기 때문이다 (사용자 결정 2026-09-14).
// 소리 파일을 올리면 그 녹음이 '끝난 녹음' 이 된다. 그래서 올린 파일도 재생·시각 메모·전사가 모두 같은 자리에서 된다.
// 'AI 전사' 토글을 켜 두면 녹음이 끝나는 순간(사용자 종료·자동 종료·파일 올리기) 서버가 전사를 건다. 꺼져 있으면 아무 일도 없다.
// 패널(SidePeek 의 RecordingView)과 본문 블럭이 같은 동작을 써야 해서 조작 함수는 여기에 모아 두고 양쪽이 부른다.
// 패널을 여는 함수는 넘겨받는다 — SidePeek 을 직접 import 하면 두 파일이 서로를 부르게 된다.
import { useEffect, useState, type DragEvent } from 'react';
import { table } from '@/sync/handle';
import { group } from '@/sync/history';
import { elapsedMs, fmtClock, useRecorder, type RecordingRow } from './recorder';
import { AiNoteBlock, type AiNoteRow } from './ainote';

const recordings = () => table<RecordingRow>('recordings', 'rw');

// ── 조작 ───────────────────────────────────────────────
export const startRecording = (rec: RecordingRow) => useRecorder.getState().start(rec.id, !!rec.transcribe);

// 토글을 켜고 끈다. 이미 끝난 녹음에서 켜면(전사를 안 하기로 했다가 마음이 바뀐 경우) 그 자리에서 전사를 건다.
export function setTranscribe(rec: RecordingRow, on: boolean, hasNote: boolean): void {
    group(() => recordings().update({ id: rec.id, transcribe: on ? 1 : 0 }));
    if (on && rec.status === 'stopped' && rec.file_id && !hasNote) void transcribeNow(rec);
}

// 소리 파일을 골라 올리고 이 녹음에 붙인다. 서버가 길이를 재고 '끝난 녹음' 으로 바꾼다.
export async function uploadToRecording(id: string): Promise<boolean> {
    const file = await new Promise<File | null>(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
    });
    if (!file) return false;
    const up = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': file.type || 'audio/mpeg', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
    }).catch(() => null);
    const upBody = await up?.json().catch(() => null) as { file?: { id: string }; error?: string } | null;
    if (!up?.ok || !upBody?.file) { alert(upBody?.error ?? '파일을 올리지 못했습니다.'); return false; }

    const res = await fetch(`/api/recordings/${id}/attach`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: upBody.file.id }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null) as { error?: string } | null;
    if (!res?.ok) { alert(body?.error ?? '파일을 녹음에 붙이지 못했습니다.'); return false; }
    return true;
}

// ── 조각 ───────────────────────────────────────────────
export function TranscribeToggle({ rec, hasNote }: { rec: RecordingRow; hasNote: boolean }) {
    const on = !!rec.transcribe;
    return (
        <button
            className="flex items-center gap-2 text-[12px] cursor-pointer bg-transparent! text-[var(--c-texSec)]"
            onClick={() => setTranscribe(rec, !on, hasNote)}
            title={on ? '녹음이 끝나면 전사와 요약을 자동으로 만듭니다' : '켜 두면 녹음이 끝날 때 전사와 요약을 만듭니다'}
        >
            <span
                className="relative w-8 h-[18px] rounded-full transition-colors"
                style={{ background: on ? 'var(--c-bluBacAccPri)' : 'var(--c-graBacSec)' }}
            >
                <span
                    className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-[left] shadow"
                    style={{ left: on ? 16 : 2 }}
                />
            </span>
            AI 전사
        </button>
    );
}

const PILL = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer select-none disabled:opacity-60';

// 녹음 중·일시정지 중에는 경과 시간이 흐른다. 500ms 마다 다시 그린다.
function useTick(active: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!active) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
    }, [active]);
    return now;
}

// ── 블럭 ───────────────────────────────────────────────
export function RecordingBlock({ rec, note, openPanel, openNote }: {
    rec: RecordingRow | undefined;
    note: AiNoteRow | undefined;
    openPanel: () => void;
    openNote: (noteId: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const live = !!rec && (rec.status === 'recording' || rec.status === 'paused');
    const now = useTick(live);
    const stop = (e: DragEvent) => e.stopPropagation();
    if (!rec) return <span className="text-[var(--c-texTer)] cursor-default">🎙️ 삭제된 녹음</span>;

    const idle = rec.status === 'idle';
    const stopped = rec.status === 'stopped';
    const begin = async () => { setBusy(true); await startRecording(rec); setBusy(false); openPanel(); };
    const upload = async () => { setBusy(true); await uploadToRecording(rec.id); setBusy(false); };

    return (
        <div className="rounded-xl border border-[var(--c-borPri)] overflow-hidden" onDragStart={stop} onDragOver={stop} onDrop={stop}>
            <header className="flex items-center gap-2 h-10 px-3 bg-[var(--c-bacSec)] border-b border-[var(--c-borPri)]">
                <button className="truncate text-[13px] font-medium cursor-pointer bg-transparent! text-left" onClick={openPanel} title="패널에서 열기">
                    🎙️ {rec.title || '회의 녹음'}
                </button>
                {rec.status === 'recording' && <span className="shrink-0 w-2 h-2 rounded-full bg-[#e03e3e] animate-pulse" title="녹음 중" />}
                {rec.status === 'paused' && <span className="shrink-0 text-[12px] text-[var(--c-texTer)]">일시정지</span>}
                {(live || stopped) && <span className="shrink-0 text-[12px] font-mono tabular-nums text-[var(--c-texTer)]">{fmtClock(elapsedMs(rec, now))}</span>}
                <span className="flex-1" />
                {!live && <TranscribeToggle rec={rec} hasNote={!!note} />}
            </header>

            {idle && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                    <button className={`${PILL} bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95`} onClick={() => void begin()} disabled={busy}>
                        <span className="w-2.5 h-2.5 rounded-full bg-current" />녹음 시작
                    </button>
                    <button className={`${PILL} bg-[var(--c-graBacSec)]! text-[var(--c-texPri)] hover:brightness-95`} onClick={() => void upload()} disabled={busy}>
                        📎 파일 올리기
                    </button>
                    <span className="text-[12px] text-[var(--c-texTer)]">{busy ? '처리 중…' : 'AI 전사를 켜 두면 끝난 뒤 자동으로 전사·요약합니다.'}</span>
                </div>
            )}
            {live && (
                <>
                    <div className="px-3 pt-3 pb-2 text-[13px] text-[var(--c-texSec)]">
                        녹음 중입니다. 일시정지와 종료는 <button className="underline cursor-pointer bg-transparent! text-[var(--c-texSec)]" onClick={openPanel}>패널</button>에서 합니다.
                    </div>
                    {/* 'AI 전사' 를 켜고 시작했으면 말하는 동안 전사가 여기에 쌓인다 (2026-09-14 실시간 전사) */}
                    {note && <AiNoteBlock note={note} nested expand={() => openNote(note.id)} />}
                </>
            )}
            {stopped && (note
                ? <AiNoteBlock note={note} nested expand={() => openNote(note.id)} />
                : (
                    <div className="px-3 py-3 text-[12px] text-[var(--c-texTer)]">
                        {rec.file_id ? 'AI 전사를 켜면 전사와 요약을 만듭니다.' : '저장된 소리가 없습니다.'}
                    </div>
                ))}
        </div>
    );
}

// 녹음이 끝났는데 전사 토글이 켜져 있고 아직 노트가 없으면 서버에 전사를 요청한다.
// 토글은 녹음이 끝난 뒤에도 켤 수 있어야 해서, 그 경우에는 이 함수가 곧바로 작업을 건다 (패널·블럭 공용).
export async function transcribeNow(rec: RecordingRow): Promise<void> {
    const res = await fetch('/api/ai-notes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recording_id: rec.id }),
    }).catch(() => null);
    if (!res?.ok) {
        const body = await res?.json().catch(() => null) as { error?: string } | null;
        alert(body?.error ?? '전사를 시작하지 못했습니다.');
    }
}
