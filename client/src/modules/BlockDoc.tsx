// 블럭 문서 모듈. 편집 UX 결정 기록: docs/2026-08-31-cowork-block-editing.md
// 지도 원칙: "일반 텍스트처럼". 블럭은 여러 줄을 담는 굵은 단위이고, Enter 는 그냥 개행이다.
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

// 노션 라이트 테마의 블럭 배경 팔레트 (회·노랑·파랑·초록·보라)
const BG_COLORS = ['', '#f0efed', '#f9f3dc', '#e5f2fc', '#e8f1ec', '#f3ebf9'];
const SEND_THROTTLE_MS = 400; // 편집 중 텍스트는 blur 가 아니라 스로틀로 내보낸다
const TYPING_CHUNK_MS = 1000; // 이만큼 입력이 멈추면 타이핑 undo 덩어리를 닫는다

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
    const lastSentAt = useRef(0);
    const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 다음에 열리는 textarea 에 캐럿을 놓을 위치. 화살표 진입은 줄 기준(dir 1: 아래로 → 첫 줄, -1: 위로 → 마지막 줄, col 유지),
    // 병합은 절대 오프셋(at) 기준이다.
    const pendingCaret = useRef<{ id: string; dir: -1 | 1; col: number } | { id: string; at: number } | null>(null);
    // 손잡이를 누르는 순간(블러 전) 살아 있는 캐럿 위치를 붙잡아 둔다 — 메뉴의 "이 위치에서 분할"용
    const savedCaret = useRef<{ id: string; offset: number } | null>(null);

    // 타이핑과 구조 조작(분할·병합·삭제·생성·이동·배경색)이 하나의 undo/redo 스택에 들어간다.
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
        if (!editing) return;
        if (sendTimer.current) { clearTimeout(sendTimer.current); sendTimer.current = null; }
        const r = rows.find(x => x.id === editing.id);
        if (r && r.text !== editing.draft) sendText(editing.id, editing.draft); // 남은 초안 최종 반영
        closeTypingChunk(); // 블럭을 떠나면 타이핑 덩어리도 닫는다
        setEditing(null);
    };

    // 순수 텍스트의 줄 이동처럼, 블럭 경계에서 화살표로 이웃 블럭에 들어간다
    const editNeighbor = (fromId: string, dir: -1 | 1, col: number) => {
        const i = sorted.findIndex(x => x.id === fromId);
        let j = i + dir;
        while (j >= 0 && j < sorted.length && sorted[j].type === 'subpage') j += dir; // 링크 블럭은 건너뛴다
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
    const drop = () => {
        if (dragId.current && dropAt && dragId.current !== dropAt.id) {
            const id = dragId.current;
            const t = sorted.findIndex(x => x.id === dropAt.id);
            const prev = dropAt.before ? sorted[t - 1] : sorted[t];
            const next = dropAt.before ? sorted[t] : sorted[t + 1];
            const oldPos = rows.find(x => x.id === id)?.pos;
            const newPos = posBetween(prev, next);
            db.update({ id, pos: newPos });
            if (oldPos !== undefined) record({
                undo: () => db.update({ id, pos: oldPos }),
                redo: () => db.update({ id, pos: newPos }),
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
    const removeBlock = (r: BlockRow) => {
        const snapshot = { ...r };
        // 링크 블럭은 페이지의 유일한 입구라 서버가 페이지와 그 내용을 연쇄 삭제한다. 내용은 되돌릴 수 없으므로 확인을 받고,
        // undo 는 페이지 행(제목)과 링크만 되살린다 — 빈 페이지로 돌아온다.
        const page = r.type === 'subpage' ? pages.find(p => p.id === r.ref) : undefined;
        if (page && !confirm(`서브페이지 "${pageTitle(page)}" 와 그 내용이 함께 삭제됩니다. 계속할까요?`)) return;
        const pageSnapshot = page && { ...page };
        db.remove(r.id);
        record({
            undo: () => { if (pageSnapshot) subpages.insert(pageSnapshot); db.insert(snapshot); },
            redo: () => db.remove(snapshot.id),
        });
    };
    const insertAfter = (afterId: string | null) => {
        const id = rid(8);
        const i = afterId ? sorted.findIndex(r => r.id === afterId) : sorted.length - 1;
        const row: BlockRow = { id, doc_id: docId, text: '', pos: posBetween(sorted[i], sorted[i + 1]), style: {} };
        if (db.insert(row)) {
            setEditing({ id, draft: '' });
            record({ undo: () => db.remove(id), redo: () => db.insert(row) });
        }
    };
    // 서브페이지 행을 만들고 그 자리에 링크 블럭을 꽂은 뒤, 노션처럼 바로 그 페이지로 들어간다 (제목부터 적게).
    const insertSubpageAfter = (afterId: string | null) => {
        const pageId = uuid();
        const page: SubpageRow = { id: pageId, title: '', pos: Math.max(0, ...pages.map(p => p.pos)) + 1 };
        const i = afterId ? sorted.findIndex(r => r.id === afterId) : sorted.length - 1;
        const row: BlockRow = { id: rid(8), doc_id: docId, type: 'subpage', ref: pageId, text: '', pos: posBetween(sorted[i], sorted[i + 1]), style: {} };
        if (subpages.insert(page) && db.insert(row)) {
            record({
                undo: () => db.remove(row.id), // 링크 삭제가 페이지까지 연쇄된다
                redo: () => { subpages.insert(page); db.insert(row); },
            });
            navigate(`/p/cowork/${pageId}`);
        }
    };
    // 캐럿 위치를 기점으로 블럭을 둘로 나눈다 (현재 블럭 update + 새 블럭 insert).
    // 줄 맨 앞(직전 글자가 개행)에서 나누면 앞 블럭 끝에 빈 줄이 남지 않도록 그 개행 하나를 거둔다.
    const splitAt = (r: BlockRow, offset: number) => {
        const at = Math.min(offset, r.text.length);
        const rest = r.text.slice(at);
        let first = r.text.slice(0, at);
        if (first.endsWith('\n')) first = first.slice(0, -1);
        const id = rid(8);
        const i = sorted.findIndex(x => x.id === r.id);
        const row: BlockRow = { id, doc_id: docId, text: rest, pos: posBetween(sorted[i], sorted[i + 1]), style: {} };
        db.update({ id: r.id, text: first });
        if (db.insert(row)) {
            pendingCaret.current = { id, dir: 1, col: 0 };
            setEditing({ id, draft: rest });
            record({
                undo: () => { db.remove(id); db.update({ id: r.id, text: r.text }); },
                redo: () => { db.update({ id: r.id, text: first }); db.insert(row); },
            });
        }
    };
    // 병합: 화면상 내용이 유지되도록 개행으로 잇고, 아래쪽 블럭을 지운다. 한쪽이 빈 블럭이면 개행을 덧붙이지 않는다.
    // focusJoint 면 병합된 블럭을 편집 상태로 열고 캐럿을 이음새(원래 아래쪽 텍스트의 시작)에 둔다.
    const mergeInto = (upper: BlockRow, lower: BlockRow, focusJoint = false) => {
        if (upper.type === 'subpage' || lower.type === 'subpage') return;
        const joined = upper.text && lower.text ? `${upper.text}\n${lower.text}` : upper.text || lower.text;
        const snapshot = { ...lower };
        db.update({ id: upper.id, text: joined });
        db.remove(lower.id);
        record({
            undo: () => { db.insert(snapshot); db.update({ id: upper.id, text: upper.text }); },
            redo: () => { db.update({ id: upper.id, text: joined }); db.remove(snapshot.id); },
        });
        if (focusJoint) {
            pendingCaret.current = { id: upper.id, at: joined.length - lower.text.length };
            setEditing({ id: upper.id, draft: joined });
        }
    };

    return (
        <ModuleFrame title={title} db={db}>
            {sorted.map(r => {
                const isEditing = editing?.id === r.id;
                return (
                    <div
                        key={r.id}
                        className={`group relative -ml-6 pl-6 py-1.5 text-[16px] leading-[1.5] min-h-[40px] whitespace-pre-wrap ${r.type === 'subpage' ? '' : 'cursor-text'}`}
                        onDragOver={e => {
                            e.preventDefault();
                            if (!dragId.current || dragId.current === r.id) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setDropAt({ id: r.id, before: e.clientY < rect.top + rect.height / 2 });
                        }}
                        onDrop={e => { e.preventDefault(); drop(); }}
                        onClick={!isEditing && r.type !== 'subpage' ? () => { pendingCaret.current = null; setEditing({ id: r.id, draft: r.text }); } : undefined}
                    >
                        {dropAt?.id === r.id && (
                            <div className={`absolute left-0 right-0 h-0.5 bg-[var(--c-bluBacAccPri)] ${dropAt.before ? 'top-0' : 'bottom-0'}`} />
                        )}
                        <span
                            className={`absolute left-1 top-2 group-hover:block cursor-grab select-none text-[var(--c-icoSec)] text-sm leading-normal ${menuFor === r.id ? 'block' : 'hidden'}`}
                            title="끌어서 이동 · 클릭하면 메뉴"
                            draggable
                            onMouseDown={() => { // 블러가 캐럿을 지우기 전에 위치를 붙잡는다
                                const ae = document.activeElement;
                                savedCaret.current = isEditing && ae instanceof HTMLTextAreaElement
                                    ? { id: r.id, offset: ae.selectionStart }
                                    : null;
                            }}
                            onDragStart={() => { setMenuFor(null); dragId.current = r.id; }}
                            onDragEnd={() => { dragId.current = null; setDropAt(null); }}
                            onClick={e => { e.stopPropagation(); setMenuFor(menuFor === r.id ? null : r.id); }}
                        >⠿</span>
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
                                    {savedCaret.current?.id === r.id && r.type !== 'subpage' && (
                                        <button
                                            className="block w-full text-left cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                            onClick={() => { const sc = savedCaret.current!; setMenuFor(null); splitAt(r, sc.offset); }}
                                        >✂ 이 위치에서 분할</button>
                                    )}
                                    {(() => {
                                        const i = sorted.findIndex(x => x.id === r.id);
                                        const prev = sorted[i - 1], next = sorted[i + 1];
                                        const canUp = prev && prev.type !== 'subpage' && r.type !== 'subpage';
                                        const canDown = next && next.type !== 'subpage' && r.type !== 'subpage';
                                        return (
                                            <>
                                                {canUp && (
                                                    <button
                                                        className="block w-full text-left cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                                        onClick={() => { setMenuFor(null); mergeInto(prev, r); }}
                                                    >⇧ 위 블럭과 병합</button>
                                                )}
                                                {canDown && (
                                                    <button
                                                        className="block w-full text-left cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                                        onClick={() => { setMenuFor(null); mergeInto(r, next); }}
                                                    >⇩ 아래 블럭과 병합</button>
                                                )}
                                            </>
                                        );
                                    })()}
                                    <button
                                        className="block w-full text-left cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                        onClick={() => { setMenuFor(null); insertSubpageAfter(r.id); }}
                                    >📄 아래에 서브페이지 추가</button>
                                    <button
                                        className="block w-full text-left text-[var(--c-redTexPri)] cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5"
                                        onClick={() => { setMenuFor(null); removeBlock(r); }}
                                    >✕ 블럭 삭제</button>
                                </div>
                            </>
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
                                            if ('at' in pc) pos = Math.min(pc.at, v.length); // 절대 오프셋 (병합 이음새)
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
                                    onChange={e => onDraft(r.id, e.target.value)}
                                    onBlur={closeEdit}
                                    onKeyDown={e => {
                                        if (e.nativeEvent.isComposing) return; // 한글 조합 확정용 키 입력은 무시
                                        // 블럭 경계 조작은 일반 텍스트 편집기의 문단 조작과 같은 감각이다:
                                        // Ctrl+Enter 는 캐럿 뒤를 새 블럭으로 분할, 블럭 맨 앞에서 Backspace 는 위 블럭과 병합.
                                        // Ctrl+Backspace 는 가로채지 않는다 — 브라우저의 "이전 단어 삭제"를 그대로 둔다.
                                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                            e.preventDefault();
                                            const at = e.currentTarget.selectionStart;
                                            const draft = editing.draft;
                                            closeEdit(); // 스로틀에 걸려 있던 초안을 먼저 확정한다
                                            splitAt({ ...r, text: draft }, at);
                                        }
                                        // 일반 Enter 는 가로채지 않는다 — 블럭 안의 개행일 뿐이다
                                        else if (e.key === 'Escape') closeEdit();
                                        else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey
                                            && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
                                            e.preventDefault();
                                            const i = sorted.findIndex(x => x.id === r.id);
                                            const prev = sorted[i - 1];
                                            if (!prev || prev.type === 'subpage') return; // 위 블럭이 없거나 링크 블럭이면 아무 일도 없다
                                            const draft = editing.draft;
                                            closeEdit();
                                            mergeInto(prev, { ...r, text: draft }, true);
                                        }
                                        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                            const ta = e.currentTarget;
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
            <div
                className="flex gap-3 text-[14px] text-[var(--c-texTer)] px-2 py-1.5"
                onDragOver={e => { // 목록 맨 끝으로의 드래그 이동
                    e.preventDefault();
                    const last = sorted.at(-1);
                    if (dragId.current && last && dragId.current !== last.id) setDropAt({ id: last.id, before: false });
                }}
                onDrop={e => { e.preventDefault(); drop(); }}
            >
                <span className="cursor-pointer" onClick={() => insertAfter(null)}>+ 블럭 추가</span>
                <span className="cursor-pointer" onClick={() => insertSubpageAfter(null)}>+ 서브페이지</span>
            </div>
        </ModuleFrame>
    );
}
