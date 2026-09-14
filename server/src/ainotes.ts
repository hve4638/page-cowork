// AI 회의 노트의 서버 쪽: 노트 행을 만들고, 전사·요약 작업을 차례로 돌리고, 진행 상태를 모두에게 알린다.
// 작업이 몇 분씩 걸리므로 HTTP 응답은 행을 만들자마자 돌려주고, 그 뒤 진행은 ai_notes 행의 status·stage 갱신을 WS 로 내보내 화면이 따라오게 한다.
// 행을 만들고 고치는 것은 이 파일뿐이다 (sync.ts 에서 ai_notes 는 읽기 전용). 그래서 클라이언트의 undo 묶음과 얽히지 않는다.
// 어느 서비스로 전사·요약할지는 ai/index.ts 가 설정을 보고 고른다 — 이 파일은 인터페이스만 쓴다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { rid } from './auth.ts';
import { ai, FILES_DIR } from './config.ts';
import { stt, summarizer } from './ai/index.ts';
import { abortLive, closeLive, liveReady, openLive, pushLive } from './ai/live.ts';
import type { Segment, Summary, Transcript } from './ai/types.ts';
import type { Mutation } from './sync.ts';

type NoteRow = {
    id: string; title: string; recording_id: string | null; file_id: string | null;
    status: 'pending' | 'running' | 'done' | 'error'; stage: string;
    provider: string; language: string; duration_ms: number;
    model: string; summaries: string; error: string | null;
    created_by: string | null; created_at: number; updated_at: number;
};
// 화면으로 나가는 모양: summaries 는 문자열이 아니라 값이다 (sync.ts 의 jsonCols 규약과 같다).
// summaries 는 모델 id 마다 요약 하나를 담는다. 한 번 요약한 모델로 되돌아갈 때 다시 부르지 않으려는 것이다.
// 전사 덩어리는 이 행에 없다 — ai_note_segments 에 행으로 들어간다 (녹음 중에 늘어난 것만 내보내려는 것이다).
type NoteOut = Omit<NoteRow, 'summaries'> & { summaries: Record<string, Summary> };

const JSON_COLS = ['summaries'] as const;
const BODY_LIMIT = 8 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
        size += (c as Buffer).length;
        if (size > BODY_LIMIT) return {};
        chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

const decode = (row: NoteRow): NoteOut => ({
    ...row,
    summaries: JSON.parse(row.summaries || '{}') as Record<string, Summary>,
});
const getNote = (id: string): NoteRow | undefined => db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(id) as NoteRow | undefined;

let publish: (m: Mutation) => void = () => {};

// 행의 일부를 고치고 그 변경만 내보낸다. 값은 디코드된 형태로 받고, JSON 컬럼만 문자열로 바꿔 넣는다.
type Patch = Partial<Omit<NoteOut, 'id'>>;
function patch(id: string, p: Patch): void {
    const row: Patch & { updated_at: number } = { ...p, updated_at: Date.now() };
    const cols = Object.keys(row) as (keyof typeof row)[];
    const value = (c: string, v: unknown) => ((JSON_COLS as readonly string[]).includes(c) ? JSON.stringify(v ?? null) : v as string | number | null);
    const { changes } = db.prepare(`UPDATE ai_notes SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map(c => value(c, row[c])), id);
    if (!changes) return; // 녹음이 지워지며 노트도 사라진 뒤다
    publish({ action: 'update', table: 'ai_notes', row: { id, ...row } });
}

// ── 전사 덩어리 ────────────────────────────────────────
// 덩어리를 행으로 두는 이유: 녹음 중에는 새로 생긴 덩어리 하나(insert)와 말이 이어지는 마지막 덩어리(update)만 나가면 된다.
// 노트 행의 JSON 컬럼에 두면 덩어리 하나가 늘어도 전사 전체가 모든 화면으로 다시 나간다 (사용자 지적 2026-09-14).
type SegRow = { id: string; note_id: string; speaker: string | null; start_ms: number; end_ms: number; text: string };

const segmentsOf = (noteId: string): Segment[] =>
    (db.prepare('SELECT speaker, start_ms, end_ms, text FROM ai_note_segments WHERE note_id = ? ORDER BY start_ms, id').all(noteId) as SegRow[])
        .map(r => ({ speaker: r.speaker, startMs: r.start_ms, endMs: r.end_ms, text: r.text }));

function insertSegment(noteId: string, seg: Segment): string {
    const row: SegRow = { id: rid(8), note_id: noteId, speaker: seg.speaker, start_ms: seg.startMs, end_ms: seg.endMs, text: seg.text };
    db.prepare('INSERT INTO ai_note_segments (id, note_id, speaker, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.note_id, row.speaker, row.start_ms, row.end_ms, row.text);
    publish({ action: 'insert', table: 'ai_note_segments', row });
    return row.id;
}

function clearSegments(noteId: string): void {
    const ids = (db.prepare('SELECT id FROM ai_note_segments WHERE note_id = ?').all(noteId) as { id: string }[]).map(r => r.id);
    if (!ids.length) return;
    db.prepare('DELETE FROM ai_note_segments WHERE note_id = ?').run(noteId);
    for (const id of ids) publish({ action: 'delete', table: 'ai_note_segments', id });
}

// 이미 내보낸 덩어리와 견주어 달라진 것만 내보낸다. 앞쪽은 확정되어 바뀌지 않으므로 사실상 마지막 하나와 새로 생긴 것뿐이다.
type SentSeg = { id: string; text: string; endMs: number };
function syncSegments(noteId: string, sent: SentSeg[], segments: Segment[]): void {
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i], was = sent[i];
        if (!was) { sent[i] = { id: insertSegment(noteId, seg), text: seg.text, endMs: seg.endMs }; continue; }
        if (was.text === seg.text && was.endMs === seg.endMs) continue;
        db.prepare('UPDATE ai_note_segments SET text = ?, end_ms = ? WHERE id = ?').run(seg.text, seg.endMs, was.id);
        publish({ action: 'update', table: 'ai_note_segments', row: { id: was.id, text: seg.text, end_ms: seg.endMs } });
        was.text = seg.text; was.endMs = seg.endMs;
    }
}

// ── 작업 대기열 ────────────────────────────────────────
// 한 번에 하나만 돌린다. 전사는 외부 서비스가 오래 물고 있고 요약도 무거워, 여러 개를 동시에 보내면 한도에 걸리기 쉽다.
// summaryOnly 는 전사를 건너뛰고 요약만 다시 하는 작업이다 (사용자가 모델을 바꾼 경우).
type Job = { id: string; summaryOnly: boolean };
const queue: Job[] = [];
let busy = false;

function enqueue(job: Job): void {
    if (!queue.some(q => q.id === job.id)) queue.push(job);
    void pump();
}
async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
        for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
    } finally {
        busy = false;
    }
}

// 회의 중 남긴 시각 메모. 요약이 놓치기 쉬운 강조점이라 함께 넘긴다.
const marksOf = (recordingId: string | null) => (recordingId
    ? (db.prepare('SELECT offset_ms, text FROM recording_marks WHERE recording_id = ? ORDER BY offset_ms').all(recordingId) as { offset_ms: number; text: string }[])
        .map(m => ({ offsetMs: m.offset_ms, text: m.text }))
    : []);

// 저장해 둔 전사를 요약에 다시 넣을 형태로 만든다. 낱말 단위는 요약 프롬프트에 쓰지 않으므로 비운다.
const storedTranscript = (note: NoteRow): Transcript => ({
    provider: note.provider,
    language: note.language,
    durationMs: note.duration_ms,
    segments: segmentsOf(note.id),
    words: [],
});

async function runJob({ id, summaryOnly }: Job): Promise<void> {
    const note = getNote(id);
    if (!note) return;
    const model = note.model || ai.llm.model;

    try {
        let transcript: Transcript;
        if (summaryOnly) {
            patch(id, { status: 'running', stage: '요약', error: null });
            transcript = storedTranscript(note);
        } else {
            const file = note.file_id
                ? db.prepare('SELECT id, mime FROM files WHERE id = ?').get(note.file_id) as { id: string; mime: string } | undefined
                : undefined;
            if (!file) { patch(id, { status: 'error', stage: '', error: '전사할 소리 파일이 없습니다.' }); return; }
            patch(id, { status: 'running', stage: '준비', error: null });
            transcript = await stt().transcribe(
                { path: FILES_DIR + file.id, mime: file.mime, language: ai.stt.language },
                stage => patch(id, { stage }),
            );
            // 전사가 끝나면 먼저 보여 준다 — 요약이 실패해도 원문은 남는다
            clearSegments(id);
            for (const seg of transcript.segments) insertSegment(id, seg);
            patch(id, {
                stage: '요약', provider: transcript.provider, language: transcript.language,
                duration_ms: transcript.durationMs,
            });
        }

        const summary = await summarizer().summarize({ title: note.title, model, transcript, marks: marksOf(note.recording_id) });
        // 모델마다 따로 쌓는다. 앞서 다른 모델로 만든 요약은 그대로 두어, 그 모델로 되돌아가면 다시 부르지 않는다.
        const kept = JSON.parse(getNote(id)?.summaries ?? '{}') as Record<string, Summary>;
        patch(id, { status: 'done', stage: '', model, summaries: { ...kept, [model]: summary } });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ainote] ${id} 실패`, err);
        patch(id, { status: 'error', stage: '', error: message.slice(0, 500) });
    }
}

// 노트 행 하나를 만들어 내보낸다. 작업을 거는 것은 부르는 쪽이 정한다 (배치는 바로 걸고, 실시간은 녹음이 끝난 뒤에 건다).
function insertNote(title: string, fileId: string | null, recordingId: string | null, userId: string | null, status: NoteRow['status'], stage: string): NoteOut {
    const now = Date.now();
    const row: NoteRow = {
        id: rid(8), title, recording_id: recordingId, file_id: fileId, status, stage,
        provider: '', language: '', duration_ms: 0, model: ai.llm.model, summaries: '{}', error: null,
        created_by: userId, created_at: now, updated_at: now,
    };
    const cols = Object.keys(row) as (keyof NoteRow)[];
    db.prepare(`INSERT INTO ai_notes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(c => row[c]));
    const out = decode(row);
    publish({ action: 'insert', table: 'ai_notes', row: out });
    return out;
}

// 소리 파일 하나를 처음부터 전사·요약한다 (배치). HTTP 요청과 녹음 종료 시 자동 전사가 함께 쓴다.
export function createNote(title: string, fileId: string, recordingId: string | null, userId: string | null): NoteOut {
    const out = insertNote(title, fileId, recordingId, userId, 'pending', '차례 기다리는 중');
    enqueue({ id: out.id, summaryOnly: false });
    return out;
}

// ── 실시간 전사 ────────────────────────────────────────
// 녹음이 도는 동안 전사가 조금씩 쌓이게 한다. 노트를 먼저 만들고 ai_notes.segments 를 갱신하면,
// 읽기 전용 테이블의 기존 통로를 그대로 타고 녹음자와 다른 사용자 화면 모두에 흘러간다.
// sent 는 이미 내보낸 덩어리다. 서비스가 줄 때마다 이것과 견주어 달라진 것만 내보낸다.
type LiveNote = { noteId: string; sent: SentSeg[] };
const liveNotes = new Map<string, LiveNote>();

// 녹음의 첫 소리가 올라올 때 부른다. 노트를 미리 만들고 실시간 전사를 연다.
// 전사 서비스가 실시간을 지원하지 않으면 아무 일도 하지 않는다 — 그 경우는 녹음이 끝난 뒤 배치로 한다.
export function startLiveNote(rec: { id: string; title: string; started_by: string | null }): void {
    if (liveNotes.has(rec.id) || hasNoteFor(rec.id) || !liveReady()) return;
    const note = insertNote(rec.title || '회의 녹음', null, rec.id, rec.started_by, 'running', '실시간 전사 중');
    const live: LiveNote = { noteId: note.id, sent: [] };
    liveNotes.set(rec.id, live);
    openLive(
        rec.id,
        segments => syncSegments(live.noteId, live.sent, segments),
        // 실시간이 안 되어도 녹음은 그대로 간다. 끝난 뒤 배치로 전사한다는 것만 화면에 알린다.
        () => patch(live.noteId, { stage: '녹음이 끝난 뒤 전사합니다' }),
    );
}

export const pushLiveAudio = (recordingId: string, webm: Buffer): void => pushLive(recordingId, webm);

// 녹음이 끝날 때 부른다. 실시간 노트가 있었으면 true — 부른 쪽은 배치 전사를 걸지 않는다.
// 마무리(남은 소리 보내기·최종 결과 받기·요약)는 시간이 걸리므로 여기서 기다리지 않고 이어서 돌린다.
export function finishLiveNote(rec: { id: string }, fileId: string | null): boolean {
    const live = liveNotes.get(rec.id);
    if (!live) return false;
    liveNotes.delete(rec.id);
    patch(live.noteId, { file_id: fileId, stage: '전사 마무리' });

    void (async () => {
        const transcript = await closeLive(rec.id);
        // 실시간이 열리지 않았거나 도중에 끊겼다. 완성된 파일이 있으면 배치로 다시 한다.
        if (!transcript?.segments.length) {
            if (!fileId) { patch(live.noteId, { status: 'error', stage: '', error: '전사할 소리가 없습니다.' }); return; }
            console.log(`[live] ${rec.id} 실시간 결과가 없어 배치로 전사한다`);
            patch(live.noteId, { status: 'pending', stage: '차례 기다리는 중' });
            enqueue({ id: live.noteId, summaryOnly: false });
            return;
        }
        // 마지막으로 온 결과까지 맞춘다. 이미 내보낸 것과 견주므로 보통 마지막 덩어리 하나만 나간다.
        syncSegments(live.noteId, live.sent, transcript.segments);
        patch(live.noteId, {
            stage: '요약', provider: transcript.provider, language: transcript.language,
            duration_ms: transcript.durationMs,
        });
        enqueue({ id: live.noteId, summaryOnly: true });
    })();
    return true;
}

// 녹음 행이 지워질 때. 결과를 버리고 접는다 (노트 행은 삭제 연쇄가 함께 지운다).
export function dropLiveNote(recordingId: string): void {
    liveNotes.delete(recordingId);
    abortLive(recordingId);
}

// 녹음 하나에 이미 노트가 있는지. 종료가 두 번 불려도(재시도·강제 종료) 노트가 겹쳐 생기지 않게 한다.
export const hasNoteFor = (recordingId: string): boolean =>
    !!db.prepare('SELECT 1 FROM ai_notes WHERE recording_id = ? LIMIT 1').get(recordingId);

// 기동 시 한 번. publish 를 받아 두고, 서버가 내려가며 끊긴 작업을 실패로 표시한다 (화면에서 다시 시도할 수 있다).
export function startAiNotes(fn: (m: Mutation) => void): void {
    publish = fn;
    const stuck = db.prepare("SELECT id FROM ai_notes WHERE status IN ('pending', 'running')").all() as { id: string }[];
    for (const s of stuck) patch(s.id, { status: 'error', stage: '', error: '서버가 다시 시작되어 작업이 끊겼습니다. 다시 시도해 주세요.' });
    if (stuck.length) console.log(`[ainote] 끊긴 작업 ${stuck.length}건을 실패로 표시`);
}

// GET  /api/ai-notes/models — 화면의 모델 고르개에 올릴 목록과 기본값
// POST /api/ai-notes  { recording_id } 또는 { file_id, title }  — 노트를 만들고 작업을 걸어 행을 돌려준다
// POST /api/ai-notes/<id>/retry — 실패했거나 끝난 노트를 전사부터 다시 돌린다
// POST /api/ai-notes/<id>/model { model } — 요약 모델을 바꾼다. 그 모델의 요약이 이미 있으면 바로 바꾸고, 없으면 요약만 다시 돌린다
export async function handleAiNoteApi(req: IncomingMessage, res: ServerResponse, url: URL, userId: string): Promise<boolean> {
    if (req.method === 'GET' && url.pathname === '/api/ai-notes/models') {
        json(res, 200, { models: ai.llm.models, model: ai.llm.model });
        return true;
    }
    if (req.method !== 'POST') return false;

    if (url.pathname === '/api/ai-notes') {
        const body = await readJson(req);
        const recordingId = typeof body.recording_id === 'string' ? body.recording_id : null;
        let fileId = typeof body.file_id === 'string' ? body.file_id : null;
        let title = typeof body.title === 'string' ? body.title.slice(0, 200).trim() : '';

        if (recordingId) {
            const rec = db.prepare('SELECT title, status, file_id FROM recordings WHERE id = ?').get(recordingId) as
                { title: string; status: string; file_id: string | null } | undefined;
            if (!rec) { json(res, 404, { error: '녹음이 없습니다.' }); return true; }
            if (rec.status !== 'stopped') { json(res, 409, { error: '녹음이 끝난 뒤에 전사할 수 있습니다.' }); return true; }
            if (!rec.file_id) { json(res, 409, { error: '이 녹음에는 저장된 소리가 없습니다.' }); return true; }
            fileId = rec.file_id;
            title = title || rec.title;
        }
        if (!fileId || !db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId)) {
            json(res, 400, { error: '전사할 소리 파일을 찾지 못했습니다.' });
            return true;
        }

        json(res, 200, { note: createNote(title, fileId, recordingId, userId) });
        return true;
    }

    const m = /^\/api\/ai-notes\/([0-9a-f]+)\/retry$/.exec(url.pathname);
    if (m) {
        const note = getNote(m[1]);
        if (!note) { json(res, 404, { error: '노트가 없습니다.' }); return true; }
        if (note.status === 'running' || note.status === 'pending') { json(res, 409, { error: '이미 진행 중입니다.' }); return true; }
        clearSegments(note.id);
        patch(note.id, { status: 'pending', stage: '차례 기다리는 중', error: null, summaries: {} });
        enqueue({ id: note.id, summaryOnly: false });
        json(res, 200, { note: decode(getNote(note.id)!) });
        return true;
    }

    const mm = /^\/api\/ai-notes\/([0-9a-f]+)\/model$/.exec(url.pathname);
    if (mm) {
        const note = getNote(mm[1]);
        if (!note) { json(res, 404, { error: '노트가 없습니다.' }); return true; }
        if (note.status === 'running' || note.status === 'pending') { json(res, 409, { error: '이미 진행 중입니다.' }); return true; }

        const body = await readJson(req);
        const model = typeof body.model === 'string' ? body.model : '';
        if (!ai.llm.models.some(m => m.id === model)) { json(res, 400, { error: '고를 수 없는 모델입니다.' }); return true; }

        // 이 모델로 이미 요약해 두었으면 고른 값만 바꾼다. 같은 모델로 두 번 부르지 않으려는 것이다.
        const done = JSON.parse(note.summaries || '{}') as Record<string, Summary>;
        if (done[model]) {
            patch(note.id, { model });
            json(res, 200, { note: decode(getNote(note.id)!), reused: true });
            return true;
        }
        if (!segmentsOf(note.id).length) { json(res, 409, { error: '전사가 없어 요약할 수 없습니다.' }); return true; }

        patch(note.id, { model, status: 'pending', stage: '차례 기다리는 중', error: null });
        enqueue({ id: note.id, summaryOnly: true });
        json(res, 200, { note: decode(getNote(note.id)!), reused: false });
        return true;
    }

    return false;
}
