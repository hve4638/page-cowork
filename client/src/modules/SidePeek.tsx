// 사이드 뷰어. 파일 블럭(BlockDoc)에서 PDF·텍스트 파일을 열거나 서브페이지 링크를 클릭하면 Workspace 오른쪽에 패널로 떠서 보여준다.
// 서브페이지는 PagePeek(제목 + BlockDoc)이 그리고, 상단 '전체 보기' 로 그 페이지로 전환한다. Alt+클릭은 패널 없이 바로 전환한다.
// 회의 녹음 블럭을 열면 같은 자리에 녹음 상태(경과 시간·일시정지·종료 버튼·시각 메모)가 뜬다 (RecordingView).
// PDF 는 pdf.js(react-pdf) 로 패널 안에 직접 그린다(PdfViewer). 번들이 크므로 lazy import 로 PDF 를 처음 열 때만 내려받는다.
// 텍스트는 fetch 로 받아 pre 에 원문 그대로 보인다(마크다운 렌더링은 markdown-styling 티켓의 몫).
// 열린 파일은 zustand 스토어에 두어 깊이 다른 두 자리(블럭 · Workspace 레이아웃)가 공유한다.
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { create } from 'zustand';
import type { FileRow } from './BlockDoc';
import { rid } from '@/sync/store';
import { table } from '@/sync/handle';
import { elapsedMs, fmtClock, inputLevel, useRecorder, type MarkRow, type RecordingRow } from './recorder';
import { fetchMe, type Me } from '@/auth/api';

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
const RED = '#e03e3e', GREEN = '#2e9e5b';
// 패널의 버튼. 기본 브라우저 모양 대신 노션풍의 둥근 알약 모양이다. tone 으로 위험(종료)·강조(재생) 을 구분한다.
// 템플릿의 전역 리셋(bleach.css)이 레이어 밖에서 button 배경을 흰색으로 강제하므로 배경 유틸리티는 ! 로 이긴다.
const pill = (tone: 'plain' | 'danger' | 'accent' = 'plain') =>
    `inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer select-none transition-colors disabled:opacity-50 disabled:cursor-default ${
        tone === 'danger' ? 'bg-[#fbeceb]! text-[#b42318] hover:bg-[#f6d9d6]!'
        : tone === 'accent' ? 'bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95'
        : 'bg-[var(--c-graBacSec)]! text-[var(--c-texPri)] hover:bg-[#e6e5e3]!'}`;

// 마이크 입력 레벨 미터. 녹음 중인 탭에서만 의미가 있다 (다른 탭에는 스트림이 없다). 소리가 들어오는지 눈으로 확인하는 용도.
// 프레임마다 inputLevel() 을 읽어 12칸 막대를 채우고, 잠시 소리가 없으면 "소리가 들어오지 않습니다" 를 띄운다.
const SILENCE_MS = 3000, BARS = 12;
function LevelMeter({ active }: { active: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    const [silent, setSilent] = useState(false);
    useEffect(() => {
        if (!active) { setSilent(false); return; }
        let raf = 0, lastSound = Date.now();
        const tick = () => {
            const level = inputLevel();
            const lit = Math.round(level * BARS);
            box.current?.childNodes.forEach((n, i) => { (n as HTMLElement).style.opacity = i < lit ? '1' : '0.18'; });
            if (level > 0.02) lastSound = Date.now();
            setSilent(Date.now() - lastSound > SILENCE_MS);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [active]);
    const color = !active ? 'var(--c-texTer)' : silent ? RED : GREEN;
    return (
        <div className="flex items-center gap-3 text-[12px]">
            <div ref={box} className="flex items-end gap-[3px] h-4">
                {Array.from({ length: BARS }, (_, i) => (
                    <span key={i} className="w-[5px] rounded-sm transition-opacity duration-75" style={{ height: `${40 + (i / BARS) * 60}%`, background: color, opacity: 0.18 }} />
                ))}
            </div>
            <span style={{ color }}>{!active ? '일시정지 중' : silent ? '소리가 들어오지 않습니다' : '마이크 입력 중'}</span>
        </div>
    );
}

// 종료된 녹음의 플레이어. 브라우저 기본 컨트롤 대신 재생 버튼 + 진행 막대 + 시간으로 직접 그린다.
// 진행 막대 위에 메모 위치를 점으로 찍고, 막대 클릭으로 탐색한다. 부모는 api ref 로 seek 을 부른다.
// MediaRecorder 의 webm 은 헤더에 길이가 없어 브라우저가 Infinity 로 보므로, 길이 표시는 서버가 확정한 duration_ms 를 쓰고,
// 탐색이 되도록 메타데이터를 읽은 직후 끝으로 한 번 seek 했다가 되돌린다. 그 사이 들어온 seek 요청은 되돌릴 때 그 위치로 보낸다.
type PlayerApi = { seek: (ms: number) => void };
function Player({ src, duration, marks, api, onTime }: { src: string; duration: number; marks: MarkRow[]; api: RefObject<PlayerApi | null>; onTime: (ms: number) => void }) {
    const audio = useRef<HTMLAudioElement>(null);
    const fixing = useRef<{ pending: number | null } | null>(null); // 길이 계산용 seek 진행 중이면 객체, pending 은 그 사이 요청된 위치
    const [playing, setPlaying] = useState(false);
    const [pos, setPosState] = useState(0);
    const setPos = (ms: number) => { setPosState(ms); onTime(ms); };
    const total = Math.max(duration, 1);
    const seek = (ms: number, play = false) => {
        const el = audio.current;
        if (!el) return;
        if (fixing.current) { fixing.current.pending = ms; return; }
        el.currentTime = ms / 1000;
        if (play) el.play().catch(() => {});
    };
    api.current = { seek: ms => seek(ms, true) };
    const toggle = () => { const el = audio.current; if (!el) return; if (el.paused) el.play().catch(() => {}); else el.pause(); };
    const seekTo = (e: MouseEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total);
    };
    return (
        <div className="rounded-xl bg-[var(--c-bacSec)] p-3 flex items-center gap-3">
            <audio
                ref={audio} preload="metadata" src={src}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onLoadedMetadata={e => {
                    const el = e.currentTarget;
                    if (el.duration !== Infinity) return;
                    fixing.current = { pending: null };
                    el.currentTime = 1e9;
                }}
                onTimeUpdate={e => {
                    const el = e.currentTarget;
                    if (fixing.current) { // 끝으로 간 seek 이 끝났다 — 되돌린다
                        const pending = fixing.current.pending;
                        fixing.current = null;
                        el.currentTime = (pending ?? 0) / 1000;
                        if (pending !== null) el.play().catch(() => {});
                        return;
                    }
                    setPos(el.currentTime * 1000);
                }}
            />
            <button className="w-9 h-9 shrink-0 rounded-full bg-[var(--c-texPri)]! text-white flex items-center justify-center cursor-pointer hover:opacity-85" onClick={toggle} aria-label={playing ? '일시정지' : '재생'}>
                {playing
                    ? <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7.5" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>
                    : <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 1.5v9l8-4.5z" fill="currentColor" /></svg>}
            </button>
            <div className="flex-1 min-w-0">
                <div className="relative h-5 flex items-center cursor-pointer group" onClick={seekTo}>
                    <div className="w-full h-1.5 rounded-full bg-black/10 overflow-hidden">
                        <div className="h-full rounded-full bg-[var(--c-texPri)]" style={{ width: `${Math.min(100, (pos / total) * 100)}%` }} />
                    </div>
                    {marks.map(m => (
                        <span key={m.id} className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-[var(--c-bluBacAccPri)] ring-2 ring-[var(--c-bacSec)]" style={{ left: `${Math.min(100, (m.offset_ms / total) * 100)}%` }} title={m.text} />
                    ))}
                </div>
                <div className="flex justify-between text-[11px] text-[var(--c-texTer)] font-mono tabular-nums mt-0.5">
                    <span>{fmtClock(pos)}</span><span>{fmtClock(duration)}</span>
                </div>
            </div>
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
    const [playPos, setPlayPos] = useState(0); // 종료된 녹음의 재생 위치 (메모 입력란의 시각 표시용)
    const [me, setMe] = useState<Me | null>(null); // 녹음을 시작한 사용자 본인인지 판정용 (다른 탭·기기에서의 강제 종료)
    useEffect(() => { fetchMe().then(setMe); }, []);
    const player = useRef<PlayerApi>(null);
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
    const stopped = rec.status === 'stopped';
    const addMark = () => {
        const t = text.trim();
        if (!t) return;
        const offset = stopped ? Math.round(playPos) : elapsed;
        if (marks.insert({ id: rid(8), recording_id: id, offset_ms: offset, text: t })) setText('');
    };
    const doStop = async () => {
        if (!confirm('녹음을 종료할까요? 종료하면 다시 이어 녹음할 수 없습니다.')) return;
        setStopping(true);
        await stop();
        setStopping(false);
    };
    // 같은 사용자의 다른 탭·기기: 녹음기는 없지만 서버에 종료를 직접 요청할 수 있다. 녹음 중이던 탭은 다음 청크가 거절되며 스스로 접는다.
    const owner = !mine && live && !!me && me.id === rec.started_by;
    const forceStop = async () => {
        if (!confirm('이 녹음은 다른 탭이나 기기에서 진행 중입니다. 강제로 종료할까요? 그 탭이 아직 올리지 못한 마지막 몇 초는 빠질 수 있습니다.')) return;
        setStopping(true);
        const res = await fetch(`/api/recordings/${id}/stop`, { method: 'POST' }).catch(() => null);
        setStopping(false);
        if (!res?.ok) alert('종료하지 못했습니다. 연결을 확인해 주세요.');
    };
    const seek = (ms: number) => player.current?.seek(ms);
    const status = rec.status === 'recording'
        ? { label: '녹음 중', color: RED, bg: '#fbeceb', dot: true }
        : rec.status === 'paused' ? { label: '일시정지', color: '#8a6d1f', bg: '#f9f3dc', dot: false }
        : { label: '종료됨', color: 'var(--c-texSec)', bg: 'var(--c-bacSec)', dot: false };

    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate" title={rec.title}>🎙️ {rec.title}</span>
                {file && <a href={`/api/files/${file.id}?download`} className="text-[13px] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">다운로드</a>}
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            <div className="p-5 flex flex-col gap-4 text-sm">
                {/* 경과 시간 + 상태 배지 */}
                <div className="flex flex-col items-center gap-2 py-3">
                    <span className="text-[44px] leading-none font-mono tabular-nums tracking-tight">{fmtClock(elapsed)}</span>
                    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12px] font-medium" style={{ color: status.color, background: status.bg }}>
                        {status.dot && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: status.color }} />}
                        {status.label}
                    </span>
                </div>
                {stale && <div className="text-[12px] text-[var(--c-texSec)] text-center">녹음자 신호가 {fmtClock(now - lastSignal)} 동안 없습니다. 1시간 이상 이어지면 자동 종료됩니다.</div>}
                {mine && live && (
                    <div className="rounded-xl bg-[var(--c-bacSec)] p-3 flex flex-col gap-3">
                        <LevelMeter active={rec.status === 'recording'} />
                        <div className="flex gap-2">
                            {rec.status === 'recording'
                                ? <button className={pill()} onClick={pause}><svg width="10" height="10" viewBox="0 0 12 12"><rect x="1.5" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7.5" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>일시정지</button>
                                : <button className={pill('accent')} onClick={resume}><svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.5 1.5v9l8-4.5z" fill="currentColor" /></svg>재개</button>}
                            <button className={pill('danger')} onClick={doStop} disabled={stopping}><span className="w-2.5 h-2.5 rounded-[2px] bg-current" />{stopping ? '저장 중…' : '종료'}</button>
                        </div>
                    </div>
                )}
                {live && !mine && (
                    <div className="flex flex-col items-center gap-2 text-[12px] text-[var(--c-texTer)] text-center">
                        <span>{owner ? '내가 다른 탭이나 기기에서 시작한 녹음입니다. 일시정지는 그 탭에서만 할 수 있습니다.' : '녹음한 탭에서만 일시정지·종료할 수 있습니다.'}</span>
                        {owner && <button className={pill('danger')} onClick={forceStop} disabled={stopping}><span className="w-2.5 h-2.5 rounded-[2px] bg-current" />{stopping ? '종료 중…' : '강제 종료'}</button>}
                    </div>
                )}
                {stopped && (file
                    ? <Player src={`/api/files/${file.id}`} duration={rec.duration_ms} marks={markRows} api={player} onTime={setPlayPos} />
                    : <div className="text-[12px] text-[var(--c-texTer)] text-center">저장된 소리가 없습니다.</div>)}
                {/* 시각 메모 */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--c-bacSec)] focus-within:ring-2 focus-within:ring-[var(--c-bluBacAccPri)]/40">
                        <span className="font-mono tabular-nums text-[12px] text-[var(--c-texTer)]">{fmtClock(stopped ? playPos : elapsed)}</span>
                        <input
                            className="flex-1 min-w-0 bg-transparent outline-none text-[13px] placeholder:text-[var(--c-texTer)]"
                            placeholder={stopped ? '재생 위치에 메모 남기기' : '지금 시각에 메모 남기기'}
                            value={text}
                            onChange={e => setText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addMark(); }}
                        />
                        <button className="text-[12px] text-[var(--c-texSec)] bg-transparent! cursor-pointer hover:text-[var(--c-texPri)] disabled:opacity-40" onClick={addMark} disabled={!text.trim()}>추가 ↵</button>
                    </div>
                    {markRows.length > 0 && (
                        <ul className="flex flex-col">
                            {markRows.map(m => (
                                <li key={m.id} className="group flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--ca-bacIntTra)]">
                                    <button
                                        className={`shrink-0 mt-px font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded bg-[var(--c-graBacSec)]! ${stopped && file ? 'text-[var(--c-bluBacAccPri)] cursor-pointer hover:bg-[#e5f2fc]!' : 'text-[var(--c-texSec)] cursor-default'}`}
                                        onClick={() => stopped && file && seek(m.offset_ms)}
                                    >{fmtClock(m.offset_ms)}</button>
                                    <span className="flex-1 text-[13px] leading-[1.5] whitespace-pre-wrap break-words">{m.text}</span>
                                    <button className="opacity-0 group-hover:opacity-100 bg-transparent! text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer text-[13px]" title="메모 삭제" onClick={() => marks.remove(m.id)}>✕</button>
                                </li>
                            ))}
                        </ul>
                    )}
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
