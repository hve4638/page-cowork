// 사이드 뷰어. 파일 블럭(BlockDoc)에서 PDF·텍스트 파일을 열거나 서브페이지 링크를 클릭하면 Workspace 오른쪽에 패널로 떠서 보여준다.
// 서브페이지는 PagePeek(제목 + BlockDoc)이 그리고, 상단 '전체 보기' 로 그 페이지로 전환한다. Alt+클릭은 패널 없이 바로 전환한다.
// 회의 녹음 블럭을 열면 같은 자리에 녹음 상태(경과 시간·일시정지·종료 버튼·시각 메모)가 뜬다 (RecordingView).
// PDF 는 pdf.js(react-pdf) 로 패널 안에 직접 그린다(PdfViewer). 번들이 크므로 lazy import 로 PDF 를 처음 열 때만 내려받는다.
// 텍스트는 fetch 로 받아 pre 에 원문 그대로 보인다(마크다운 렌더링은 markdown-styling 티켓의 몫).
// 열린 파일은 zustand 스토어에 두어 깊이 다른 두 자리(블럭 · Workspace 레이아웃)가 공유한다.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { FileRow } from './BlockDoc';
import { rid } from '@/sync/store';
import { table } from '@/sync/handle';
import { elapsedMs, fmtClock, inputLevel, useRecorder, type MarkRow, type RecordingRow } from './recorder';

const PdfViewer = lazy(() => import('./PdfViewer'));
const PagePeek = lazy(() => import('./PagePeek'));

// 패널에서 열 수 있는 텍스트 형식. mime 이 text/* 이거나 json 이면 통과, 그 외엔 흔한 확장자로 판정한다
// (업로드 시 브라우저가 .md·.log 등에 application/octet-stream 을 붙이는 경우가 있어 확장자도 본다).
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'xml', 'ini', 'toml']);
const TEXT_LIMIT = 2 * 1024 * 1024; // 이보다 크면 pre 에 올리지 않고 다운로드로 안내한다

export function peekKind(f: FileRow): 'pdf' | 'text' | null {
    if (f.mime === 'application/pdf') return 'pdf';
    if (f.mime.startsWith('text/') || f.mime === 'application/json') return 'text';
    const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase();
    return f.name.includes('.') && TEXT_EXTS.has(ext) ? 'text' : null;
}

// 패널에 열린 것: 파일(PDF·텍스트)·서브페이지·회의 녹음. 한 번에 하나만 열린다.
type PeekItem = { kind: 'file'; file: FileRow } | { kind: 'page'; id: string } | { kind: 'recording'; id: string };
export const useSidePeek = create<{ item: PeekItem | null; open: (file: FileRow) => void; openPage: (id: string) => void; openRecording: (id: string) => void; close: () => void }>(set => ({
    item: null,
    open: file => set({ item: { kind: 'file', file } }),
    openPage: id => set({ item: { kind: 'page', id } }),
    openRecording: id => set({ item: { kind: 'recording', id } }),
    close: () => set({ item: null }),
}));

function TextView({ file }: { file: FileRow }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setText(null); setError(null);
        if (file.size > TEXT_LIMIT) { setError('2MB 를 넘는 텍스트는 미리보기 대신 다운로드해서 여세요.'); return; }
        let alive = true;
        fetch(`/api/files/${file.id}`)
            .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then(t => { if (alive) setText(t); })
            .catch(e => { if (alive) setError(`불러오지 못했습니다: ${e.message}`); });
        return () => { alive = false; };
    }, [file.id, file.size]);
    if (error) return <div className="p-4 text-sm text-[var(--c-texSec)]">{error}</div>;
    if (text === null) return <div className="p-4 text-sm text-[var(--c-texTer)]">불러오는 중…</div>;
    return <pre className="flex-1 overflow-auto p-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words font-mono">{text}</pre>;
}

const STALE_HINT_MS = 30 * 1000; // 녹음자 신호가 이만큼 없으면 "신호 없음" 을 보인다 (서버의 자동 종료는 1시간)
const btn = 'text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)] border border-[var(--c-borPri)]';

// 마이크 입력 레벨 미터. 녹음 중인 탭에서만 의미가 있다 (다른 탭에는 스트림이 없다). 소리가 들어오는지 눈으로 확인하는 용도.
// 프레임마다 inputLevel() 을 읽어 막대 폭을 바꾸고, 잠시 소리가 없으면 "소리가 들어오지 않습니다" 를 띄운다.
const SILENCE_MS = 3000;
function LevelMeter({ active }: { active: boolean }) {
    const bar = useRef<HTMLDivElement>(null);
    const [silent, setSilent] = useState(false);
    useEffect(() => {
        if (!active) { setSilent(false); return; }
        let raf = 0, lastSound = Date.now();
        const tick = () => {
            const level = inputLevel();
            if (bar.current) bar.current.style.width = `${Math.round(level * 100)}%`;
            if (level > 0.02) lastSound = Date.now();
            setSilent(Date.now() - lastSound > SILENCE_MS);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [active]);
    return (
        <div className="flex items-center gap-2 text-[13px]">
            <span className="text-[var(--c-texSec)]">🎤</span>
            <div className="flex-1 h-2 rounded-full bg-[var(--ca-bacIntTra)] overflow-hidden">
                <div ref={bar} className={`h-full rounded-full transition-[width] duration-75 ${silent ? 'bg-[#e03e3e]' : 'bg-[#2e9e5b]'}`} style={{ width: 0 }} />
            </div>
            <span className={silent ? 'text-[#e03e3e]' : 'text-[var(--c-texTer)]'}>{!active ? '일시정지' : silent ? '소리가 들어오지 않습니다' : '입력 중'}</span>
        </div>
    );
}

// 녹음 패널. 상태는 recordings 행에서 읽고, 녹음 중이면 0.5초마다 다시 그려 경과 시간이 흐르게 한다.
// 조작 버튼은 이 탭이 녹음기를 들고 있을 때(useRecorder.id 일치)만 보인다. 다른 사용자·같은 사용자의 다른 탭은 읽기 전용이다.
// 시각 메모는 누구나 남긴다: 진행 중이면 지금 경과 시각, 종료 후면 재생 위치가 기준이다.
function RecordingView({ id, close }: { id: string; close: () => void }) {
    const rec = table<RecordingRow>('recordings', 'ro').useRows().find(r => r.id === id);
    const marks = table<MarkRow>('recording_marks', 'rw');
    const markRows = marks.useRows().filter(m => m.recording_id === id).sort((a, b) => a.offset_ms - b.offset_ms);
    const file = table<FileRow>('files', 'ro').useRows().find(f => f.id === rec?.file_id);
    const mine = useRecorder(s => s.id) === id;
    const { pause, resume, stop } = useRecorder();
    const [now, setNow] = useState(Date.now());
    const [text, setText] = useState('');
    const [stopping, setStopping] = useState(false);
    const audio = useRef<HTMLAudioElement>(null);
    const live = !!rec && rec.status !== 'stopped';
    useEffect(() => {
        if (!live) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
    }, [live]);
    if (!rec) return <div className="p-4 text-sm text-[var(--c-texTer)]">삭제된 녹음입니다.</div>;

    const elapsed = elapsedMs(rec, now);
    const lastSignal = rec.last_chunk_at ?? rec.updated_at ?? rec.started_at;
    const stale = live && !mine && now - lastSignal > STALE_HINT_MS;
    const addMark = () => {
        const t = text.trim();
        if (!t) return;
        const offset = rec.status === 'stopped' ? Math.round((audio.current?.currentTime ?? 0) * 1000) : elapsed;
        if (marks.insert({ id: rid(8), recording_id: id, offset_ms: offset, text: t })) setText('');
    };
    const doStop = async () => {
        if (!confirm('녹음을 종료할까요? 종료하면 다시 이어 녹음할 수 없습니다.')) return;
        setStopping(true);
        await stop();
        setStopping(false);
    };
    const seek = (ms: number) => { if (audio.current) { audio.current.currentTime = ms / 1000; audio.current.play().catch(() => {}); } };

    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate" title={rec.title}>🎙️ {rec.title}</span>
                {file && <a href={`/api/files/${file.id}?download`} className="text-[13px] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">다운로드</a>}
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            <div className="p-4 flex flex-col gap-3 text-sm">
                <div className="flex items-center gap-3">
                    <span className="text-3xl font-mono tabular-nums">{fmtClock(elapsed)}</span>
                    <span className="text-[var(--c-texSec)]">
                        {rec.status === 'recording' && <><span className="inline-block w-2 h-2 rounded-full bg-[#e03e3e] animate-pulse mr-1 align-middle" />녹음 중</>}
                        {rec.status === 'paused' && '일시정지'}
                        {rec.status === 'stopped' && '종료됨'}
                    </span>
                </div>
                {stale && <div className="text-[13px] text-[var(--c-texSec)]">녹음자 신호가 {fmtClock(now - lastSignal)} 동안 없습니다. 1시간 이상 이어지면 자동 종료됩니다.</div>}
                {mine && live && <LevelMeter active={rec.status === 'recording'} />}
                {mine && live && (
                    <div className="flex gap-2">
                        {rec.status === 'recording'
                            ? <button className={btn} onClick={pause}>⏸ 일시정지</button>
                            : <button className={btn} onClick={resume}>▶ 재개</button>}
                        <button className={btn} onClick={doStop} disabled={stopping}>{stopping ? '저장 중…' : '■ 종료'}</button>
                    </div>
                )}
                {live && !mine && <div className="text-[13px] text-[var(--c-texTer)]">녹음한 탭에서만 일시정지·종료할 수 있습니다.</div>}
                {rec.status === 'stopped' && (file
                    ? <audio
                        ref={audio} controls preload="metadata" src={`/api/files/${file.id}`} className="w-full"
                        // MediaRecorder 의 webm 은 헤더에 길이가 없어 브라우저가 Infinity 로 본다. 끝으로 한 번 seek 하면 실제 길이를 계산해 탐색이 된다
                        onLoadedMetadata={e => {
                            const el = e.currentTarget;
                            if (el.duration !== Infinity) return;
                            el.currentTime = 1e9;
                            el.addEventListener('timeupdate', () => { el.currentTime = 0; }, { once: true });
                        }}
                    />
                    : <div className="text-[13px] text-[var(--c-texTer)]">저장된 소리가 없습니다.</div>)}
                <div className="border-t border-[var(--c-borPri)] pt-3">
                    <div className="flex gap-2">
                        <input
                            className="flex-1 min-w-0 px-2 py-1 rounded-md border border-[var(--c-borPri)] bg-transparent"
                            placeholder={rec.status === 'stopped' ? '재생 위치에 메모' : '지금 시각에 메모'}
                            value={text}
                            onChange={e => setText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addMark(); }}
                        />
                        <button className={btn} onClick={addMark}>메모</button>
                    </div>
                    <ul className="mt-2 flex flex-col gap-1">
                        {markRows.map(m => (
                            <li key={m.id} className="flex gap-2 items-start group">
                                <button
                                    className={`font-mono tabular-nums text-[var(--c-texSec)] ${rec.status === 'stopped' && file ? 'cursor-pointer hover:underline' : 'cursor-default'}`}
                                    onClick={() => rec.status === 'stopped' && file && seek(m.offset_ms)}
                                >{fmtClock(m.offset_ms)}</button>
                                <span className="flex-1 whitespace-pre-wrap break-words">{m.text}</span>
                                <button className="opacity-0 group-hover:opacity-100 text-[var(--c-texTer)] cursor-pointer" title="메모 삭제" onClick={() => marks.remove(m.id)}>×</button>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </>
    );
}
// 패널 상자. 넓은 화면에서는 본문 오른쪽에 나란히, 좁은 화면(768px 미만)에서는 전체 화면 오버레이로 뜨고 닫기 버튼으로 돌아온다.
const PANEL = 'h-full flex flex-col bg-[var(--c-bacPri)] fixed inset-0 z-50 md:static md:z-auto md:min-w-[360px] md:border-l md:border-[var(--c-borPri)]';

export function SidePeek() {
    const { item, close } = useSidePeek();
    if (!item) return null;
    const loading = <div className="p-4 text-sm text-[var(--c-texTer)]">불러오는 중…</div>;
    if (item.kind === 'page') {
        return ( // 페이지는 본문과 반반
            <aside className={`${PANEL} md:w-1/2`}>
                <Suspense fallback={loading}><PagePeek key={item.id} id={item.id} close={close} /></Suspense>
            </aside>
        );
    }
    if (item.kind === 'recording') {
        return (
            <aside className={`${PANEL} md:w-[45%] overflow-y-auto`}>
                <RecordingView key={item.id} id={item.id} close={close} />
            </aside>
        );
    }
    const { file } = item;
    return (
        <aside className={`${PANEL} md:w-[45%]`}>
            {/* 탑바와 같은 44px 높이로 맞춘다 */}
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate" title={file.name}>📎 {file.name}</span>
                <a href={`/api/files/${file.id}?download`} className="text-[13px] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">다운로드</a>
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            {peekKind(file) === 'pdf'
                ? <Suspense fallback={loading}><PdfViewer key={file.id} file={file} /></Suspense>
                : <TextView key={file.id} file={file} />}
        </aside>
    );
}
