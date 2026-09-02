// 블럭 문서 모듈. 편집 UX 결정 기록: docs/2026-08-31-cowork-block-editing.md
// 지도 원칙: "일반 텍스트처럼". 본문 텍스트는 하나의 흐름이고 사용자가 텍스트 블럭을 직접 나누거나 붙이지 않는다.
// 텍스트가 나뉘는 것은 그 사이에 특수 블럭(서브페이지 링크 등)이 '/' 명령으로 끼어들 때뿐이고, 특수 블럭이 사라지면 다시 붙는다.
// 쓰기가 본질인 모듈이라 rw 핸들을 요구한다 — ro 핸들을 꽂으면 컴파일 에러가 난다.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { v4 as uuid } from 'uuid';
import { rid } from '@/sync/store';
import type { RwTable } from '@/sync/handle';
import { ModuleFrame } from './ModuleFrame';

export type BlockStyle = { bg?: string }; // 블럭 단위 스타일은 배경색만 — 굵게 등 텍스트 서식은 블럭 단위가 아니다
export type BlockRow = {
    id: string;
    doc_id: string;
    parent_id?: string | null; // 중첩 조립품용 (MVP 에서는 항상 NULL)
    text: string;
    pos: number;
    type?: 'text' | 'subpage';
    ref?: string;
    style?: BlockStyle;
    updated_at?: number; // 서버가 찍는다
};
// 서브페이지 본체. 링크 블럭(type='subpage')이 ref 로 가리키고, 제목은 페이지 화면의 h1 과 링크 블럭·브레드크럼이 함께 쓴다.
export type SubpageRow = {
    id: string;
    title: string;
    pos: number;
    created_by?: string; // 이하 서버가 찍는다
    created_at?: number;
    updated_at?: number;
};
export const pageTitle = (p: SubpageRow | undefined) => (p ? p.title || '제목 없음' : '삭제된 페이지');

// 텍스트 블럭은 흐름의 일부라 개별 조작(손잡이·이동·삭제) 대상이 아니다. 그 밖의 type 은 전부 특수 블럭이다.
const isText = (r?: BlockRow) => !!r && (r.type ?? 'text') === 'text';
// 병합은 화면상 내용이 유지되도록 개행으로 잇는다. 한쪽이 비어 있으면 개행을 덧붙이지 않는다.
const joinText = (a: string, b: string) => (a && b ? `${a}\n${b}` : a || b);

// 노션 라이트 테마의 블럭 배경 팔레트 (회·노랑·파랑·초록·보라)
const BG_COLORS = ['', '#f0efed', '#f9f3dc', '#e5f2fc', '#e8f1ec', '#f3ebf9'];
const SEND_THROTTLE_MS = 400; // 편집 중 텍스트는 blur 가 아니라 스로틀로 내보낸다
const TYPING_CHUNK_MS = 1000; // 이만큼 입력이 멈추면 타이핑 undo 덩어리를 닫는다

// ── '/' 명령 ─────────────────────────────────────────
// 특수 블럭은 텍스트 편집 중 '/' 를 쳐서 캐럿 위치에 넣는다. 이미지·파일 같은 항목은 이 배열에 추가하면 된다 (file-upload 티켓).
// run 은 부속 행(서브페이지 본체 등)을 만든 뒤 ctx.insert 로 블럭을 꽂는다. extra 는 그 부속 행의 undo/redo 로,
// 링크 블럭 삭제는 서버가 페이지까지 연쇄하므로 페이지 명령의 undo 는 비어 있다.
type SlashContext = {
    pages: SubpageRow[];
    subpages: RwTable<SubpageRow>;
    navigate: (to: string) => void;
    insert: (block: Pick<BlockRow, 'type' | 'ref' | 'text'>, extra?: { undo?: () => void; redo?: () => void }) => boolean;
};
type SlashCommand = { label: string; icon: string; keywords: string[]; run: (ctx: SlashContext) => void };
const SLASH_COMMANDS: SlashCommand[] = [
    {
        label: '페이지', icon: '📄', keywords: ['page', 'subpage', '서브페이지'],
        // 서브페이지 행을 만들고 캐럿 자리에 링크 블럭을 꽂은 뒤, 노션처럼 바로 그 페이지로 들어간다 (제목부터 적게).
        run: ({ pages, subpages, navigate, insert }) => {
            const page: SubpageRow = { id: uuid(), title: '', pos: Math.max(0, ...pages.map(p => p.pos)) + 1 };
            if (!subpages.insert(page)) return;
            if (insert({ type: 'subpage', ref: page.id, text: '' }, { redo: () => subpages.insert(page) })) navigate(`/p/cowork/${page.id}`);
        },
    },
];
const matchCommands = (filter: string) => {
    const f = filter.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.label.startsWith(f) || c.keywords.some(k => k.startsWith(f)));
};
// textarea 안 캐럿의 픽셀 위치(블럭 박스 기준). 같은 서식의 거울 div 에 캐럿까지의 텍스트를 넣고 표식 span 의 자리를 잰다.
function caretBottomLeft(ta: HTMLTextAreaElement, at: number) {
    const m = document.createElement('div');
    const cs = getComputedStyle(ta);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing'] as const) m.style[p] = cs[p];
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', width: `${ta.clientWidth}px`, top: '0', left: '0' });
    m.textContent = ta.value.slice(0, at);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    m.appendChild(mark);
    ta.parentElement!.appendChild(m);
    const r = { top: ta.offsetTop + mark.offsetTop + mark.offsetHeight, left: ta.offsetLeft + mark.offsetLeft };
    m.remove();
    return r;
}

export function BlockDoc({ title, docId, db, subpages }: {
    title: string; docId: string; db: RwTable<BlockRow>; subpages: RwTable<SubpageRow>;
}) {
    const rows = db.useRows().filter(r => r.doc_id === docId); // 핸들은 테이블 단위, 모듈은 문서 하나를 맡는다
    const sorted = [...rows].sort((a, b) => a.pos - b.pos);
    const pages = subpages.useRows(); // 링크 블럭의 제목 표시용
    const navigate = useNavigate();
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    const dragId = useRef<string | null>(null);
    const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null); // 드래그 중 안내선 위치
    const [menuFor, setMenuFor] = useState<string | null>(null); // 손잡이 클릭으로 열린 컨텍스트 메뉴의 대상 블럭
    // 열려 있는 '/' 명령 메뉴. start 는 '/' 의 오프셋, filter 는 그 뒤에 이어 친 글자, sel 은 강조된 항목 번호
    const [slash, setSlash] = useState<{ id: string; start: number; filter: string; sel: number; top: number; left: number } | null>(null);
    const lastSentAt = useRef(0);
    const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 다음에 열리는 textarea 에 캐럿을 놓을 위치. 화살표 진입은 줄 기준(dir 1: 아래로 → 첫 줄, -1: 위로 → 마지막 줄, col 유지),
    // 삽입·병합은 절대 오프셋(at) 기준이다.
    const pendingCaret = useRef<{ id: string; dir: -1 | 1; col: number } | { id: string; at: number } | null>(null);

    // 타이핑과 구조 조작(삽입·삭제·이동·배경색)이 하나의 undo/redo 스택에 들어간다.
    // undo 는 역연산 op 를 새로 보내는 방식이라, 다른 사람이 그 사이 지운 블럭 대상이면 서버가 조용히 버린다.
    type HistoryEntry = { undo: () => void; redo: () => void };
    const undoStack = useRef<HistoryEntry[]>([]);
    const redoStack = useRef<HistoryEntry[]>([]);

    // 타이핑은 키 입력을 덩어리로 뭉쳤다가
    // 입력 멈춤·블럭 이동·구조 조작·undo 실행 시점에 하나의 항목으로 닫는다.
    const typingChunk = useRef<{ id: string; before: string; after: string } | null>(null);
    const chunkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyText = (id: string, text: string) => {
        if (sendTimer.current) { clearTimeout(sendTimer.current); sendTimer.current = null; }
        db.update({ id, text });
        setEditing(ed => (ed && ed.id === id ? { id, draft: text } : ed));
        pendingCaret.current = { id, dir: -1, col: Number.MAX_SAFE_INTEGER }; // 캐럿은 텍스트 끝으로
    };
    const closeTypingChunk = () => {
        if (chunkTimer.current) { clearTimeout(chunkTimer.current); chunkTimer.current = null; }
        const c = typingChunk.current;
        typingChunk.current = null;
        if (!c || c.before === c.after) return;
        undoStack.current.push({
            undo: () => applyText(c.id, c.before),
            redo: () => applyText(c.id, c.after),
        });
    };
    const record = (entry: HistoryEntry) => {
        closeTypingChunk(); // 구조 조작은 열려 있는 타이핑 덩어리를 먼저 닫는다
        undoStack.current.push(entry);
        redoStack.current = [];
    };
    const doUndo = () => {
        closeTypingChunk();
        const a = undoStack.current.pop();
        if (a) { a.undo(); redoStack.current.push(a); }
    };
    const doRedo = () => {
        closeTypingChunk();
        const a = redoStack.current.pop();
        if (a) { a.redo(); undoStack.current.push(a); }
    };
    const histRef = useRef({ doUndo, doRedo });
    histRef.current = { doUndo, doRedo };
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
            if (e.isComposing) return; // 한글 조합 중에는 undo 를 건드리지 않는다
            if (e.target instanceof HTMLInputElement) return; // 다른 모듈의 입력 필드는 건드리지 않는다
            e.preventDefault();
            if (e.shiftKey) histRef.current.doRedo(); else histRef.current.doUndo();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, []);

    // 편집 중이던 블럭이 원격에서 삭제되면 편집 종료
    useEffect(() => {
        if (editing && !rows.some(r => r.id === editing.id)) setEditing(null);
    }, [rows, editing]);

    const sendText = (id: string, text: string) => {
        db.update({ id, text });
        lastSentAt.current = Date.now();
    };
    const onDraft = (id: string, text: string) => {
        if (typingChunk.current?.id === id) {
            typingChunk.current.after = text; // 열린 덩어리 연장
        } else {
            closeTypingChunk();
            const before = editing?.id === id ? editing.draft : (rows.find(x => x.id === id)?.text ?? '');
            typingChunk.current = { id, before, after: text };
            redoStack.current = []; // 새 편집이 시작되면 redo 는 무효
        }
        if (chunkTimer.current) clearTimeout(chunkTimer.current);
        chunkTimer.current = setTimeout(closeTypingChunk, TYPING_CHUNK_MS);
        setEditing({ id, draft: text });
        if (sendTimer.current) clearTimeout(sendTimer.current);
        const elapsed = Date.now() - lastSentAt.current;
        if (elapsed >= SEND_THROTTLE_MS) sendText(id, text);
        else sendTimer.current = setTimeout(() => sendText(id, text), SEND_THROTTLE_MS - elapsed);
    };
    const closeEdit = () => {
        setSlash(null);
        if (!editing) return;
        if (sendTimer.current) { clearTimeout(sendTimer.current); sendTimer.current = null; }
        const r = rows.find(x => x.id === editing.id);
        if (r && r.text !== editing.draft) sendText(editing.id, editing.draft); // 남은 초안 최종 반영
        closeTypingChunk(); // 블럭을 떠나면 타이핑 덩어리도 닫는다
        setEditing(null);
    };
    const editAt = (r: BlockRow, at: number) => {
        pendingCaret.current = { id: r.id, at };
        setEditing({ id: r.id, draft: r.text });
    };

    // 순수 텍스트의 줄 이동처럼, 블럭 경계에서 화살표로 이웃 블럭에 들어간다
    const editNeighbor = (fromId: string, dir: -1 | 1, col: number) => {
        const i = sorted.findIndex(x => x.id === fromId);
        let j = i + dir;
        while (j >= 0 && j < sorted.length && !isText(sorted[j])) j += dir; // 특수 블럭은 건너뛴다
        if (j < 0 || j >= sorted.length) return false;
        const target = sorted[j];
        closeEdit();
        pendingCaret.current = { id: target.id, dir, col };
        setEditing({ id: target.id, draft: target.text });
        return true;
    };

    // 이동·삽입의 공통 원리: 두 이웃 pos 의 중점을 취한다. 정밀도 고갈은 서버가 정규화로 막는다.
    const posBetween = (prev?: BlockRow, next?: BlockRow) => {
        if (!prev && !next) return 1;
        if (!prev) return next!.pos - 1;
        if (!next) return prev.pos + 1;
        return (prev.pos + next.pos) / 2;
    };
    // 이웃한 두 텍스트 블럭을 하나로 잇는 계획. 특수 블럭이 빠져나가 텍스트가 맞닿을 때 흐름을 복원하는 데 쓴다.
    // 적용(apply)과 되돌리기(revert)를 돌려주고, 여기서 직접 기록하지 않는다 — 삭제·이동과 한 항목으로 묶기 위해서다.
    const planJoin = (upper?: BlockRow, lower?: BlockRow) => {
        if (!upper || !lower || !isText(upper) || !isText(lower)) return null;
        const joined = joinText(upper.text, lower.text);
        const lowerSnapshot = { ...lower };
        return {
            joint: joined.length - lower.text.length, // 이음새: 원래 아래쪽 텍스트가 시작하는 오프셋
            upper,
            lower,
            apply: () => { db.update({ id: upper.id, text: joined }); db.remove(lower.id); },
            revert: () => { db.insert(lowerSnapshot); db.update({ id: upper.id, text: upper.text }); },
        };
    };
    const drop = () => {
        if (dragId.current && dropAt && dragId.current !== dropAt.id) {
            const id = dragId.current;
            const t = sorted.findIndex(x => x.id === dropAt.id);
            const prev = dropAt.before ? sorted[t - 1] : sorted[t];
            const next = dropAt.before ? sorted[t] : sorted[t + 1];
            const i = sorted.findIndex(x => x.id === id);
            // 제자리에 놓은 것이 아니면 원래 자리의 앞뒤 텍스트가 맞닿으므로 이어 붙인다
            const join = prev?.id !== id && next?.id !== id ? planJoin(sorted[i - 1], sorted[i + 1]) : null;
            const oldPos = sorted[i]?.pos;
            const newPos = posBetween(prev, next);
            db.update({ id, pos: newPos });
            join?.apply();
            if (oldPos !== undefined) record({
                undo: () => { join?.revert(); db.update({ id, pos: oldPos }); },
                redo: () => { db.update({ id, pos: newPos }); join?.apply(); },
            });
        }
        dragId.current = null;
        setDropAt(null);
    };
    const setBg = (r: BlockRow, bg?: string) => {
        const oldStyle = { ...r.style }, newStyle = { ...r.style, bg };
        db.update({ id: r.id, style: newStyle }); // style 컬럼은 JSON 통째로 교체된다
        record({
            undo: () => db.update({ id: r.id, style: oldStyle }),
            redo: () => db.update({ id: r.id, style: newStyle }),
        });
    };
    // 특수 블럭 삭제. 앞뒤가 텍스트면 자동으로 병합해 흐름을 복원한다.
    const removeBlock = (r: BlockRow) => {
        const snapshot = { ...r };
        // 링크 블럭은 페이지의 유일한 입구라 서버가 페이지와 그 내용을 연쇄 삭제한다. 내용은 되돌릴 수 없으므로 확인을 받고,
        // undo 는 페이지 행(제목)과 링크만 되살린다 — 빈 페이지로 돌아온다.
        const page = r.type === 'subpage' ? pages.find(p => p.id === r.ref) : undefined;
        if (page && !confirm(`서브페이지 "${pageTitle(page)}" 와 그 내용이 함께 삭제됩니다. 계속할까요?`)) return;
        const pageSnapshot = page && { ...page };
        const i = sorted.findIndex(x => x.id === r.id);
        const join = planJoin(sorted[i - 1], sorted[i + 1]);
        db.remove(r.id);
        join?.apply();
        record({
            undo: () => { if (pageSnapshot) subpages.insert(pageSnapshot); db.insert(snapshot); join?.revert(); },
            redo: () => { db.remove(snapshot.id); join?.apply(); },
        });
        // 편집 중이던 블럭이 병합에 휩쓸리면 병합된 블럭에서 이어서 편집한다
        if (join && editing && (editing.id === join.upper.id || editing.id === join.lower.id)) {
            editAt({ ...join.upper, text: joinText(join.upper.text, join.lower.text) }, join.joint);
        }
    };
    // 문서 끝에 빈 텍스트 블럭을 하나 만들고 편집을 연다 (빈 문서, 또는 마지막 블럭이 특수 블럭일 때 이어 쓰는 입구).
    const appendText = () => {
        const row: BlockRow = { id: rid(8), doc_id: docId, text: '', pos: posBetween(sorted.at(-1)), style: {} };
        if (db.insert(row)) {
            setEditing({ id: row.id, draft: '' });
            record({ undo: () => db.remove(row.id), redo: () => db.insert(row) });
        }
    };
    // 캐럿 위치에 특수 블럭을 꽂는다. draft 에서 '/'와 필터([start, end))를 지운 텍스트를 start 에서 앞·뒤로 나누고 그 사이에 넣는다.
    // 앞쪽이 비면 앞 텍스트 블럭을 만들지 않고 현재 블럭이 뒤쪽이 된다. 뒤쪽은 비어도 남겨서 캐럿을 두고 계속 입력하게 한다.
    // 나뉘는 자리의 개행(앞쪽 끝·뒤쪽 첫 개행) 하나씩은 거둔다 — 특수 블럭이 그 줄 자리를 차지하므로 빈 줄이 남지 않게.
    const insertSpecialAt = (
        r: BlockRow, draft: string, start: number, end: number,
        block: Pick<BlockRow, 'type' | 'ref' | 'text'>, extra?: { undo?: () => void; redo?: () => void },
    ) => {
        let before = draft.slice(0, start), after = draft.slice(end);
        if (before.endsWith('\n')) before = before.slice(0, -1);
        if (after.startsWith('\n')) after = after.slice(1);
        const i = sorted.findIndex(x => x.id === r.id);
        const special: BlockRow = { id: rid(8), doc_id: docId, ...block, pos: 0, style: {} };
        const tail: BlockRow | null = before ? { id: rid(8), doc_id: docId, text: after, pos: 0, style: {} } : null;
        if (tail) { // r(앞) · special · tail(뒤)
            special.pos = posBetween(sorted[i], sorted[i + 1]);
            tail.pos = posBetween(special, sorted[i + 1]);
        } else { // special · r(뒤)
            special.pos = posBetween(sorted[i - 1], sorted[i]);
        }
        const firstText = tail ? before : after;
        const apply = () => {
            if (!db.update({ id: r.id, text: firstText })) return false;
            db.insert(special);
            if (tail) db.insert(tail);
            return true;
        };
        const revert = () => {
            if (tail) db.remove(tail.id);
            db.remove(special.id);
            db.update({ id: r.id, text: draft });
        };
        closeEdit(); // 스로틀에 걸려 있던 초안과 타이핑 덩어리를 먼저 확정한다
        if (!apply()) return false;
        record({
            undo: () => { revert(); extra?.undo?.(); },
            redo: () => { extra?.redo?.(); apply(); },
        });
        editAt(tail ?? { ...r, text: after }, 0);
        return true;
    };
    const runSlash = (cmd: SlashCommand) => {
        if (!slash || !editing || slash.id !== editing.id) return;
        const r = rows.find(x => x.id === slash.id);
        if (!r) return;
        const { draft } = editing;
        const start = slash.start, end = start + 1 + slash.filter.length;
        setSlash(null);
        cmd.run({
            pages, subpages, navigate,
            insert: (block, extra) => insertSpecialAt(r, draft, start, end, block, extra),
        });
    };

    const last = sorted.at(-1);
    return (
        <ModuleFrame title={title} db={db}>
            {sorted.map(r => {
                const isEditing = editing?.id === r.id;
                const text = isText(r);
                const matched = slash?.id === r.id ? matchCommands(slash.filter) : [];
                return (
                    <div
                        key={r.id}
                        className={`group relative -ml-6 pl-6 py-1.5 text-[16px] leading-[1.5] min-h-[40px] whitespace-pre-wrap ${text ? 'cursor-text' : ''}`}
                        onDragOver={e => {
                            e.preventDefault();
                            if (!dragId.current || dragId.current === r.id) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setDropAt({ id: r.id, before: e.clientY < rect.top + rect.height / 2 });
                        }}
                        onDrop={e => { e.preventDefault(); drop(); }}
                        onClick={!isEditing && text ? () => { pendingCaret.current = null; setEditing({ id: r.id, draft: r.text }); } : undefined}
                    >
                        {dropAt?.id === r.id && (
                            <div className={`absolute left-0 right-0 h-0.5 bg-[var(--c-bluBacAccPri)] ${dropAt.before ? 'top-0' : 'bottom-0'}`} />
                        )}
                        {/* 손잡이는 특수 블럭에만 있다 — 텍스트는 흐름의 일부라 개별 조작 대상이 아니다 */}
                        {!text && (
                            <span
                                className={`absolute left-1 top-2 group-hover:block cursor-grab select-none text-[var(--c-icoSec)] text-sm leading-normal ${menuFor === r.id ? 'block' : 'hidden'}`}
                                title="끌어서 이동 · 클릭하면 메뉴"
                                draggable
                                onDragStart={() => { setMenuFor(null); dragId.current = r.id; }}
                                onDragEnd={() => { dragId.current = null; setDropAt(null); }}
                                onClick={e => { e.stopPropagation(); setMenuFor(menuFor === r.id ? null : r.id); }}
                            >⠿</span>
                        )}
                        {menuFor === r.id && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={e => { e.stopPropagation(); setMenuFor(null); }} />
                                <div
                                    className="absolute left-1 top-8 z-20 bg-white border border-[var(--c-borPri)] rounded-md shadow-md p-2 text-xs whitespace-normal cursor-default w-max"
                                    onClick={e => e.stopPropagation()}
                                >
                                    <div className="flex items-center gap-1.5 mb-2">
                                        <span className="text-[var(--c-texSec)]">배경</span>
                                        {BG_COLORS.map(c => (
                                            <button
                                                key={c || 'none'}
                                                className="w-4 h-4 rounded-full border border-black/20 cursor-pointer"
                                                style={{ background: c || '#ffffff' }}
                                                title={c || '배경 없음'}
                                                onClick={() => { setBg(r, c || undefined); setMenuFor(null); }}
                                            />
                                        ))}
                                    </div>
                                    <button
                                        className="block w-full text-left text-[var(--c-redTexPri)] cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                        onClick={() => { setMenuFor(null); removeBlock(r); }}
                                    >✕ 블럭 삭제</button>
                                </div>
                            </>
                        )}
                        {slash?.id === r.id && isEditing && (
                            <div
                                className="absolute z-20 bg-white border border-[var(--c-borPri)] rounded-md shadow-md p-1 text-sm whitespace-normal cursor-default w-max min-w-40"
                                style={{ top: slash.top, left: slash.left }}
                                onMouseDown={e => e.preventDefault()} // textarea 의 포커스(캐럿)를 유지한다
                            >
                                {matched.length === 0
                                    ? <div className="px-2 py-1 text-[var(--c-texTer)]">일치하는 명령 없음</div>
                                    : matched.map((c, idx) => (
                                        <div
                                            key={c.label}
                                            className={`px-2 py-1 rounded cursor-pointer ${idx === slash.sel ? 'bg-[var(--ca-bacIntTra)]' : ''}`}
                                            onMouseEnter={() => setSlash(s => (s ? { ...s, sel: idx } : s))}
                                            onClick={() => runSlash(c)}
                                        >{c.icon} {c.label}</div>
                                    ))}
                            </div>
                        )}
                        <div className="rounded-md px-2 py-0.5" style={{ background: r.style?.bg }}>
                            {isEditing ? (
                                <textarea
                                    className="block w-full resize-none outline-none bg-[#2783de]/5 text-[16px] leading-[1.5]"
                                    rows={1}
                                    value={editing.draft}
                                    autoFocus
                                    ref={ta => {
                                        if (!ta) return;
                                        ta.style.height = 'auto';
                                        ta.style.height = `${ta.scrollHeight}px`;
                                        const pc = pendingCaret.current;
                                        if (pc && pc.id === r.id) {
                                            pendingCaret.current = null;
                                            const v = ta.value;
                                            let pos;
                                            if ('at' in pc) pos = Math.min(pc.at, v.length); // 절대 오프셋 (삽입·병합 이음새)
                                            else if (pc.dir === 1) { // 아래로 진입 → 첫 줄에서 열 위치 유지
                                                const nl = v.indexOf('\n');
                                                pos = Math.min(pc.col, nl === -1 ? v.length : nl);
                                            } else { // 위로 진입 → 마지막 줄에서 열 위치 유지
                                                const lastStart = v.lastIndexOf('\n') + 1;
                                                pos = lastStart + Math.min(pc.col, v.length - lastStart);
                                            }
                                            ta.focus();
                                            ta.setSelectionRange(pos, pos);
                                        }
                                    }}
                                    onChange={e => {
                                        const v = e.target.value, caret = e.target.selectionStart;
                                        onDraft(r.id, v);
                                        // '/' 가 지워지거나 캐럿이 그 앞으로 가거나 공백을 치면 메뉴를 닫고, 아니면 필터를 갱신한다
                                        setSlash(s => {
                                            if (!s || s.id !== r.id) return s;
                                            if (v[s.start] !== '/' || caret <= s.start) return null;
                                            const filter = v.slice(s.start + 1, caret);
                                            return /\s/.test(filter) ? null : { ...s, filter, sel: 0 };
                                        });
                                    }}
                                    onClick={() => setSlash(null)}
                                    onBlur={closeEdit}
                                    onKeyDown={e => {
                                        if (e.nativeEvent.isComposing) return; // 한글 조합 확정용 키 입력은 무시 (조합 중 '/' 도 메뉴를 열지 않는다)
                                        const ta = e.currentTarget;
                                        if (slash?.id === r.id) {
                                            if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
                                            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                                e.preventDefault();
                                                const n = matched.length;
                                                if (n) setSlash(s => (s ? { ...s, sel: (s.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n } : s));
                                                return;
                                            }
                                            if (e.key === 'Enter' && matched.length) { e.preventDefault(); runSlash(matched[slash.sel] ?? matched[0]); return; }
                                            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') setSlash(null);
                                        }
                                        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                                            // '/' 자체는 그대로 입력되게 두고, 메뉴만 캐럿 아래에 연다. 필터는 onChange 가 채운다.
                                            const { top, left } = caretBottomLeft(ta, ta.selectionStart);
                                            setSlash({ id: r.id, start: ta.selectionStart, filter: '', sel: 0, top, left });
                                        }
                                        // Enter 는 가로채지 않는다 — 블럭 안의 개행일 뿐이다. 블럭을 나누는 단축키는 없다.
                                        else if (e.key === 'Escape') closeEdit();
                                        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                            const dir = e.key === 'ArrowDown' ? 1 as const : -1 as const;
                                            const atEdge = dir === 1
                                                ? !ta.value.slice(ta.selectionEnd).includes('\n')   // 마지막 줄
                                                : !ta.value.slice(0, ta.selectionStart).includes('\n'); // 첫 줄
                                            if (!atEdge) return;
                                            const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
                                            if (editNeighbor(r.id, dir, ta.selectionStart - lineStart)) e.preventDefault();
                                        }
                                    }}
                                />
                            ) : r.type === 'subpage' ? (() => {
                                // 링크 블럭: 제목은 subpages 에서 실시간으로 읽는다. ref 대상이 사라졌으면 들어갈 수 없는 자리표시자만 남긴다.
                                const page = pages.find(p => p.id === r.ref);
                                return page
                                    ? <Link to={`/p/cowork/${page.id}`} className="underline decoration-black/30 cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-0.5">📄 {pageTitle(page)}</Link>
                                    : <span className="text-[var(--c-texTer)] cursor-default">📄 {pageTitle(undefined)}</span>;
                            })() : (
                                r.text || ' '
                            )}
                        </div>
                    </div>
                );
            })}
            {/* 문서 꼬리: 클릭하면 마지막 텍스트에 이어 쓰거나, 텍스트가 없으면 새 텍스트 블럭을 연다. 특수 블럭은 본문에서 '/' 로 넣는다. */}
            <div
                className="min-h-[40px] px-2 py-1.5 text-[14px] text-[var(--c-texTer)] cursor-text"
                onClick={() => {
                    if (!last || !isText(last)) { appendText(); return; }
                    // 편집 중이던 마지막 블럭이면 blur 로 닫히기 전의 초안을 이어받는다 (rows 의 text 는 스로틀만큼 늦을 수 있다)
                    const text = editing?.id === last.id ? editing.draft : last.text;
                    editAt({ ...last, text }, text.length);
                }}
                onDragOver={e => { // 목록 맨 끝으로의 드래그 이동
                    e.preventDefault();
                    if (dragId.current && last && dragId.current !== last.id) setDropAt({ id: last.id, before: false });
                }}
                onDrop={e => { e.preventDefault(); drop(); }}
            >
                {sorted.length === 0 && '여기에 입력하세요. \'/\' 로 페이지 등을 넣을 수 있습니다.'}
            </div>
        </ModuleFrame>
    );
}
