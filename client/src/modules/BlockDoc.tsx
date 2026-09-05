// 블럭 문서 모듈. 편집 UX 결정 기록: docs/2026-08-31-cowork-block-editing.md
// 지도 원칙: "일반 텍스트처럼". 본문 텍스트는 하나의 흐름이고 사용자가 텍스트 블럭을 직접 나누거나 붙이지 않는다.
// 텍스트가 나뉘는 것은 그 사이에 특수 블럭(서브페이지 링크 등)이 '/' 명령으로 끼어들 때뿐이고, 특수 블럭이 사라지면 다시 붙는다.
// 쓰기가 본질인 모듈이라 rw 핸들을 요구한다 — ro 핸들을 꽂으면 컴파일 에러가 난다.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { v4 as uuid } from 'uuid';
import { rid } from '@/sync/store';
import type { RoTable, RwTable } from '@/sync/handle';
import { ModuleFrame } from './ModuleFrame';
import { peekKind, useSidePeek } from './SidePeek';
import { defaultTitle, elapsedMs, fmtClock, useRecorder, type RecordingRow } from './recorder';
import { MdEditor, toggleMark, type MdEditorHandle } from './MdEditor';
import type { EditorView } from '@codemirror/view';

// 블럭 단위 스타일. bg 는 배경색(모든 블럭). 굵게 등 텍스트 서식은 블럭 단위가 아니다.
// icon 은 콜아웃의 아이콘. cols·rows 는 표의 열·행 id 순서, row·col 은 칸이 속한 행·열 id (스키마 문서의 "슬롯").
export type BlockStyle = { bg?: string; icon?: string; cols?: string[]; rows?: string[]; row?: string; col?: string };
export type BlockRow = {
    id: string;
    doc_id: string;
    parent_id?: string | null; // 중첩 조립품용. 표의 칸(cell)이 표(table) id 를 가리킨다. 그 밖에는 NULL
    text: string;
    pos: number;
    type?: 'text' | 'subpage' | 'image' | 'file' | 'callout' | 'table' | 'cell' | 'recording' | 'toggle';
    ref?: string; // subpage → subpages.id, image·file → files.id, recording → recordings.id

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
// 업로드된 파일의 메타. 행은 서버의 업로드 API 만 만들고 클라이언트에는 읽기 전용으로 내려온다. 실체는 /api/files/<id>.
export type FileRow = {
    id: string;
    name: string;
    mime: string;
    size: number;
    author_id?: string;
    created_at?: number;
};
const FILE_LIMIT = 50 * 1024 * 1024; // 서버와 같은 상한. 클라이언트에서 먼저 걸러 올리기 전에 알려준다
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
// 파일 하나를 /api/files 로 올린다. 실패하면 알린 뒤 null.
async function uploadFile(file: File): Promise<FileRow | null> {
    if (file.size > FILE_LIMIT) { alert(`"${file.name}" 은 ${fmtSize(file.size)} 로 50MB 상한을 넘어 올릴 수 없습니다.`); return null; }
    let res: Response;
    try {
        res = await fetch('/api/files', {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
            body: file,
        });
    } catch { alert('업로드에 실패했습니다. 네트워크 연결을 확인해 주세요.'); return null; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { alert(body.error ?? `업로드에 실패했습니다 (${res.status}).`); return null; }
    return body.file as FileRow;
}
// 붙여넣기·드롭으로 들어온 여러 파일을 순서대로 올려 블럭으로 만든다. 실패한 파일은 건너뛴다 (각각 alert 로 알린다).
// 이미지 mime 이면 image 블럭, 나머지는 file 블럭이다.
async function uploadAll(files: File[]): Promise<Pick<BlockRow, 'type' | 'ref' | 'text'>[]> {
    const out: Pick<BlockRow, 'type' | 'ref' | 'text'>[] = [];
    for (const file of files) {
        const f = await uploadFile(file);
        if (f) out.push({ type: f.mime.startsWith('image/') ? 'image' : 'file', ref: f.id, text: '' });
    }
    return out;
}
// 파일 선택 대화상자를 열어 고른 파일을 올린다. 취소하면 null.
async function pickAndUpload(accept?: string): Promise<FileRow | null> {
    const file = await new Promise<File | null>(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
    });
    return file ? uploadFile(file) : null;
}

// 텍스트 블럭은 흐름의 일부라 개별 조작(손잡이·이동·삭제) 대상이 아니다. 그 밖의 type 은 전부 특수 블럭이다.
const isText = (r?: BlockRow) => !!r && (r.type ?? 'text') === 'text';
// 화살표로 드나드는 블럭: 본문 텍스트·콜아웃·토글. 특수 블럭이지만 안에 텍스트를 담으므로 줄 이동의 경유지가 된다(접힌 토글은 제외). 표의 칸은 Tab 으로 다닌다.
const inFlow = (r?: BlockRow) => !!r && (isText(r) || r.type === 'callout' || r.type === 'toggle');
// 토글 블럭의 원문: 첫 줄이 제목, 나머지가 본문. 접으면 제목만 보인다.
const toggleTitle = (text: string) => text.split('\n', 1)[0];
const CALLOUT_ICON = '💡';
const TABLE_INIT = { rows: 3, cols: 3 }; // '/표' 로 만드는 표의 초기 크기
// 표의 칸 블럭들. 칸은 부모(표)의 style.rows·cols 가 정한 (row, col) 슬롯을 style 로 가리키고, pos 는 같은 부모 안에서 서로 다르기만 하면 된다.
const makeCells = (tableId: string, docId: string, rows: string[], cols: string[], fromPos: number): BlockRow[] =>
    rows.flatMap((row, i) => cols.map((col, j) => ({
        id: rid(8), doc_id: docId, parent_id: tableId, type: 'cell' as const, text: '', pos: fromPos + i * cols.length + j + 1, style: { row, col },
    })));
// 화면에 문서가 둘 떠 있을 때(본문 + 사이드 패널의 서브페이지) Ctrl+Z 는 마지막으로 만진 문서의 스택만 움직인다.
let activeDoc: symbol | null = null;
// 병합은 화면상 내용이 유지되도록 개행으로 잇는다. 한쪽이 비어 있으면 개행을 덧붙이지 않는다.
const joinText = (a: string, b: string) => (a && b ? `${a}\n${b}` : a || b);

// 노션 라이트 테마의 블럭 배경 팔레트 (회·노랑·파랑·초록·보라)
const BG_COLORS = ['', '#f0efed', '#f9f3dc', '#e5f2fc', '#e8f1ec', '#f3ebf9'];
const SEND_THROTTLE_MS = 400; // 편집 중 텍스트는 blur 가 아니라 스로틀로 내보낸다
const TYPING_CHUNK_MS = 1000; // 이만큼 입력이 멈추면 타이핑 undo 덩어리를 닫는다

// ── '/' 명령 ─────────────────────────────────────────
// 특수 블럭은 텍스트 편집 중 '/' 를 쳐서 캐럿 위치에 넣는다. 새 종류는 이 배열에 추가하면 된다.
// run 은 부속 행(서브페이지 본체 등)을 만든 뒤 ctx.insert 로 블럭을 꽂는다. extra 는 그 부속 행의 undo/redo 로,
// 링크 블럭 삭제는 서버가 페이지까지 연쇄하므로 페이지 명령의 undo 는 비어 있다.
// 이미지·파일은 선택 대화상자 → 업로드가 끝난 뒤에야 블럭을 꽂는다. 대화상자가 열리면 에디터가 blur 되어 편집이 닫히지만,
// insert 는 명령을 고른 시점의 캐럿 자리를 기억하고 있어서 그 자리에 들어간다. 파일 실체는 블럭을 지워도 남는다 (GC 는 MVP 밖).
// 같은 첨부를 에디터에 붙여넣기(캐럿 자리)·문서에 드롭(안내선 자리)으로도 넣을 수 있다.
// 새로 꽂을 특수 블럭. id·style 은 보통 insert 가 채우지만, 자식을 거느리는 표처럼 미리 정해야 하면 넘길 수 있다.
type NewBlock = Pick<BlockRow, 'type' | 'ref' | 'text'> & Partial<Pick<BlockRow, 'id' | 'style'>>;
type SlashContext = {
    docId: string;
    db: RwTable<BlockRow>;
    pages: SubpageRow[];
    subpages: RwTable<SubpageRow>;
    navigate: (to: string) => void;
    insert: (block: NewBlock, extra?: { undo?: () => void; redo?: () => void }) => BlockRow[] | null; // 꽂힌 블럭 행들, 실패면 null
    edit: (r: BlockRow) => void; // 꽂은 블럭 안에서 바로 편집을 시작한다 (콜아웃·표의 첫 칸)
    // 블럭을 꽂는 대신 캐럿 자리에 마크다운 문법을 넣는다(할 일·구분선). 캐럿 앞에 글자가 있으면 새 줄로 내려서 넣고, line 이면 뒤에도 개행을 둔다.
    insertMarkup: (markup: string, line?: boolean) => void;
    openRecording: (id: string) => void; // 녹음 패널을 연다
};
type SlashCommand = { label: string; icon: string; keywords: string[]; run: (ctx: SlashContext) => void | Promise<void> };
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
    {
        label: '이미지', icon: '🖼️', keywords: ['image', 'img', 'picture', '사진', '그림'],
        run: async ({ insert }) => {
            const f = await pickAndUpload('image/*');
            if (f) insert({ type: 'image', ref: f.id, text: '' });
        },
    },
    {
        label: '파일', icon: '📎', keywords: ['file', 'attach', 'attachment', '첨부'],
        run: async ({ insert }) => {
            const f = await pickAndUpload();
            if (f) insert({ type: 'file', ref: f.id, text: '' });
        },
    },
    {
        label: '콜아웃', icon: CALLOUT_ICON, keywords: ['callout', '강조', '콜아웃'],
        // 회색 배경 상자에 아이콘 + 텍스트. 특수 블럭이면서 안에 텍스트를 담는 첫 사례 — 캐럿을 그 안으로 옮겨 바로 쓰게 한다.
        run: ({ insert, edit }) => {
            const [c] = insert({ type: 'callout', text: '', style: { icon: CALLOUT_ICON, bg: BG_COLORS[1] } }) ?? [];
            if (c) edit(c);
        },
    },
    {
        label: '표', icon: '▦', keywords: ['table', '테이블', '표'],
        // 표 블럭 하나 + 칸 블럭들(parent_id = 표). 행·열 순서는 표의 style 에, 칸 내용은 각 칸 블럭의 text 에 산다.
        // 표 삭제는 서버가 칸까지 연쇄하므로 삽입 undo 는 비어 있고, redo 는 칸을 다시 만들어야 한다.
        run: ({ insert, edit, db, docId }) => {
            const id = rid(8);
            const rows = Array.from({ length: TABLE_INIT.rows }, () => rid(4)), cols = Array.from({ length: TABLE_INIT.cols }, () => rid(4));
            const cells = makeCells(id, docId, rows, cols, 0);
            if (!insert({ id, type: 'table', text: '', style: { rows, cols } }, { redo: () => cells.forEach(c => db.insert(c)) })) return;
            cells.forEach(c => db.insert(c));
            edit(cells[0]);
        },
    },
    {
        label: '할 일', icon: '☑', keywords: ['todo', 'task', 'check', 'checkbox', '체크', '할일', '할 일'],
        // 블럭이 아니라 마크다운 할 일 항목('- [ ] ')이다. 체크박스 표시·클릭·Enter 이어 쓰기는 MdEditor 가 맡는다.
        run: ({ insertMarkup }) => insertMarkup('- [ ] '),
    },
    {
        label: '토글', icon: '▸', keywords: ['toggle', '접기', '토글'],
        // 콜아웃처럼 텍스트를 담는 특수 블럭. 첫 줄이 제목이고 나머지가 본문이며, 접으면 제목만 남는다. 접힘 상태는 이 화면에서만(동기화하지 않는다).
        run: ({ insert, edit }) => {
            const [t] = insert({ type: 'toggle', text: '' }) ?? [];
            if (t) edit(t);
        },
    },
    {
        label: '구분선', icon: '―', keywords: ['divider', 'hr', 'rule', '구분선', '가로선'],
        // 마크다운 구분선. '---' 는 앞 줄이 있으면 setext 제목이 되므로 '***' 를 넣는다.
        run: ({ insertMarkup }) => insertMarkup('***', true),
    },
    {
        label: '녹음', icon: '🎙️', keywords: ['record', 'recording', '회의', '녹음'],
        // 마이크 권한 → 녹음 시작(앱 수준 스토어) → 캐럿 자리에 링크 블럭 → 오른쪽 패널. 권한 대화상자로 에디터가 blur 되어도
        // insert 가 캐럿 자리를 기억한다. 블럭을 꽂지 못하면(연결 끊김) 녹음도 접는다 — 입구 없는 녹음을 남기지 않는다.
        run: async ({ insert, openRecording }) => {
            const id = await useRecorder.getState().start(defaultTitle());
            if (!id) return;
            if (!insert({ type: 'recording', ref: id, text: '' })) { void useRecorder.getState().stop(); return; }
            openRecording(id);
        },
    },
];
const matchCommands = (filter: string) => {
    const f = filter.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.label.startsWith(f) || c.keywords.some(k => k.startsWith(f)));
};
// 에디터 안 캐럿의 픽셀 위치(블럭 박스 기준). '/' 명령 메뉴를 캐럿 아래에 띄우는 데 쓴다.
// 블럭 박스는 에디터의 offsetParent(가장 가까운 positioned 조상)다.
function caretBottomLeft(view: EditorView, at: number) {
    const c = view.coordsAtPos(at);
    const box = (view.dom.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    return c && box ? { top: c.bottom - box.top, left: c.left - box.left } : { top: 0, left: 0 };
}

// inPeek: 이 문서가 오른쪽 패널(PagePeek)에 떠 있다. 그 안의 서브페이지 링크를 클릭하면 지금 페이지가 왼쪽(본문)으로 가고 새 페이지가 패널에 뜬다.
export function BlockDoc({ title, docId, db, subpages, files, recordings, inPeek }: {
    title: string; docId: string; db: RwTable<BlockRow>; subpages: RwTable<SubpageRow>; files: RoTable<FileRow>; recordings: RoTable<RecordingRow>; inPeek?: boolean;
}) {
    const rows = db.useRows().filter(r => r.doc_id === docId); // 핸들은 테이블 단위, 모듈은 문서 하나를 맡는다
    const sorted = rows.filter(r => !r.parent_id).sort((a, b) => a.pos - b.pos); // 최상위 흐름. 자식(표의 칸)은 부모가 그린다
    const pages = subpages.useRows(); // 링크 블럭의 제목 표시용
    const fileRows = files.useRows(); // 이미지·파일 블럭의 이름·크기 표시용
    const recRows = recordings.useRows(); // 녹음 블럭의 제목·상태 표시용
    const navigate = useNavigate();
    const openPeek = useSidePeek(s => s.open);
    const peekPage = useSidePeek(s => s.openPage);
    const openPage = (id: string) => { if (inPeek) navigate(`/p/cowork/${docId}`); peekPage(id); };
    // 녹음 패널도 같은 자리를 쓴다. 패널 안 문서에서 녹음을 열면 그 문서를 본문으로 보내고 녹음이 패널에 뜬다
    const peekRecording = useSidePeek(s => s.openRecording);
    const openRecording = (id: string) => { if (inPeek) navigate(`/p/cowork/${docId}`); peekRecording(id); };
    // 편집 중(포커스된) 텍스트 블럭과 그 초안. 텍스트 블럭마다 에디터(MdEditor)가 항상 떠 있고, 포커스가 곧 편집 시작이다.
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    const editors = useRef(new Map<string, MdEditorHandle>()); // 블럭 id → 에디터 핸들 (캐럿 놓기용)
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()); // 접힌 토글 블럭 id. 화면(클라이언트) 상태이며 동기화·undo 대상이 아니다
    const isCollapsed = (r: BlockRow) => r.type === 'toggle' && collapsed.has(r.id);
    const dragId = useRef<string | null>(null);
    const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null); // 드래그 중 안내선 위치
    // 열려 있는 블럭 컨텍스트 메뉴. 손잡이 클릭이면 손잡이 아래에, 우클릭이면 at(마우스 좌표)에 뜬다.
    // cell 은 표의 칸 안에서 우클릭했을 때 그 칸 — 칸·행 단위 항목은 후속 티켓(table-styling)이 채운다.
    const [menu, setMenu] = useState<{ id: string; cell?: string; at?: { x: number; y: number } } | null>(null);
    // 열려 있는 '/' 명령 메뉴. start 는 '/' 의 오프셋, filter 는 그 뒤에 이어 친 글자, sel 은 강조된 항목 번호
    const [slash, setSlash] = useState<{ id: string; start: number; filter: string; sel: number; top: number; left: number } | null>(null);
    const lastSentAt = useRef(0);
    const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 다음 렌더 후 에디터에 놓을 캐럿(원문 기준 오프셋). 이웃 블럭 진입·삽입·병합 이음새·꼬리 클릭에 쓴다.
    const pendingCaret = useRef<{ id: string; at: number } | null>(null);

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
        setEditing(ed => {
            if (!ed || ed.id !== id) return ed;
            pendingCaret.current = { id, at: text.length }; // 편집 중이던 블럭이면 캐럿은 텍스트 끝으로
            return { id, draft: text };
        });
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
    const self = useRef(Symbol('doc'));
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
            if (e.isComposing) return; // 한글 조합 중에는 undo 를 건드리지 않는다
            if (e.target instanceof HTMLInputElement) return; // 다른 모듈의 입력 필드는 건드리지 않는다
            if (activeDoc && activeDoc !== self.current) return; // 다른 문서(패널)를 만지던 중이면 그쪽 몫이다
            e.preventDefault();
            if (e.shiftKey) histRef.current.doRedo(); else histRef.current.doUndo();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, []);

    // 파일을 블럭 영역 밖에 떨어뜨렸을 때 브라우저가 그 파일로 이동해 버리는 것을 막는다
    useEffect(() => {
        const block = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
        window.addEventListener('dragover', block);
        window.addEventListener('drop', block);
        return () => { window.removeEventListener('dragover', block); window.removeEventListener('drop', block); };
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

    // 순수 텍스트의 줄 이동처럼, 블럭 경계에서 화살표로 이웃 블럭에 들어간다 (dir 1: 아래로 → 첫 줄, -1: 위로 → 마지막 줄, col 유지)
    const editNeighbor = (fromId: string, dir: -1 | 1, col: number) => {
        const i = sorted.findIndex(x => x.id === fromId);
        let j = i + dir;
        while (j >= 0 && j < sorted.length && (!inFlow(sorted[j]) || isCollapsed(sorted[j]))) j += dir; // 텍스트가 없는 특수 블럭·접힌 토글은 건너뛴다
        if (j < 0 || j >= sorted.length) return false;
        const target = sorted[j], t = target.text;
        closeEdit();
        let at: number;
        if (dir === 1) { const nl = t.indexOf('\n'); at = Math.min(col, nl === -1 ? t.length : nl); }
        else { const ls = t.lastIndexOf('\n') + 1; at = ls + Math.min(col, t.length - ls); }
        editAt(target, at);
        return true;
    };

    // 이동·삽입의 공통 원리: 두 이웃 pos 의 중점을 취한다. 정밀도 고갈은 서버가 정규화로 막는다.
    const posBetween = (prev?: BlockRow, next?: BlockRow) => {
        if (!prev && !next) return 1;
        if (!prev) return next!.pos - 1;
        if (!next) return prev.pos + 1;
        return (prev.pos + next.pos) / 2;
    };
    // prev 와 next 사이에 들어갈 특수 블럭 행들을 pos 를 매겨 만든다 (삽입은 호출부가 한다)
    const placeBetween = (prev: BlockRow | undefined, next: BlockRow | undefined, blocks: NewBlock[]) => {
        const out: BlockRow[] = [];
        for (const b of blocks) {
            const row: BlockRow = { id: rid(8), doc_id: docId, style: {}, ...b, pos: posBetween(out.at(-1) ?? prev, next) };
            out.push(row);
        }
        return out;
    };
    // 드롭 안내선 자리(두 블럭 사이)에 특수 블럭들을 끼운다. 텍스트를 나누지 않으므로 병합·분할이 없다.
    const insertBetween = (prev: BlockRow | undefined, next: BlockRow | undefined, blocks: NewBlock[]) => {
        const specials = placeBetween(prev, next, blocks);
        if (!specials.length) return;
        closeEdit();
        for (const sp of specials) db.insert(sp);
        record({
            undo: () => { for (const sp of specials) db.remove(sp.id); },
            redo: () => { for (const sp of specials) db.insert(sp); },
        });
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
    const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files');
    const dropFiles = async (dt: DataTransfer) => {
        const at = dropAt; // 업로드 동안 안내선이 바뀌어도 떨어뜨린 자리를 쓴다
        setDropAt(null);
        const t = at ? sorted.findIndex(x => x.id === at.id) : -1;
        const prev = !at ? sorted.at(-1) : at.before ? sorted[t - 1] : sorted[t];
        const next = !at ? undefined : at.before ? sorted[t] : sorted[t + 1];
        insertBetween(prev, next, await uploadAll(Array.from(dt.files)));
    };
    // 특수 블럭을 prev 와 next 사이로 옮긴다. 원래 자리의 앞뒤 텍스트가 맞닿으므로 이어 붙인다. 드래그 드롭과 메뉴의 위·아래 이동이 함께 쓴다.
    const moveTo = (id: string, prev?: BlockRow, next?: BlockRow) => {
        const i = sorted.findIndex(x => x.id === id);
        if (i < 0 || prev?.id === id || next?.id === id) return; // 제자리
        const join = planJoin(sorted[i - 1], sorted[i + 1]);
        const oldPos = sorted[i].pos;
        const newPos = posBetween(prev, next);
        db.update({ id, pos: newPos });
        join?.apply();
        record({
            undo: () => { join?.revert(); db.update({ id, pos: oldPos }); },
            redo: () => { db.update({ id, pos: newPos }); join?.apply(); },
        });
    };
    const drop = () => {
        if (dragId.current && dropAt && dragId.current !== dropAt.id) {
            const t = sorted.findIndex(x => x.id === dropAt.id);
            moveTo(dragId.current, dropAt.before ? sorted[t - 1] : sorted[t], dropAt.before ? sorted[t] : sorted[t + 1]);
        }
        dragId.current = null;
        setDropAt(null);
    };
    // 메뉴의 위로·아래로 이동: 이웃 블럭 하나를 건너뛴다
    const moveBlock = (r: BlockRow, dir: -1 | 1) => {
        const i = sorted.findIndex(x => x.id === r.id);
        if (dir === -1) { if (i > 0) moveTo(r.id, sorted[i - 2], sorted[i - 1]); }
        else if (i < sorted.length - 1) moveTo(r.id, sorted[i + 1], sorted[i + 2]);
    };
    // 바로 아래에 같은 블럭을 하나 더 만든다. 표는 칸까지 복사한다 (행·열 id 는 표 안에서만 유일하면 되므로 그대로 쓴다).
    // 이미지·파일은 같은 파일을 가리킨다. 서브페이지는 페이지 본문까지 복사해야 하므로 이번 범위 밖이다.
    const duplicateBlock = (r: BlockRow) => {
        const i = sorted.findIndex(x => x.id === r.id);
        const copy: BlockRow = { ...r, id: rid(8), style: { ...r.style }, pos: posBetween(sorted[i], sorted[i + 1]) };
        const cells = cellsOf(r).map(c => ({ ...c, id: rid(8), parent_id: copy.id, style: { ...c.style } }));
        const apply = () => { db.insert(copy); cells.forEach(c => db.insert(c)); };
        closeEdit();
        apply();
        record({ undo: () => db.remove(copy.id), redo: apply }); // 표를 지우면 서버가 칸까지 연쇄 삭제한다
    };
    // 이미지 ↔ 파일 전환. 같은 파일을 다르게 보여 줄 뿐이라 type 만 바꾼다.
    const setType = (r: BlockRow, type: BlockRow['type']) => {
        const old = r.type;
        db.update({ id: r.id, type });
        record({ undo: () => db.update({ id: r.id, type: old }), redo: () => db.update({ id: r.id, type }) });
    };
    const renamePage = (page: SubpageRow) => {
        const title = prompt('페이지 이름', page.title);
        if (title === null || title === page.title) return;
        subpages.update({ id: page.id, title });
        record({ undo: () => subpages.update({ id: page.id, title: page.title }), redo: () => subpages.update({ id: page.id, title }) });
    };
    const copyLink = (path: string) => navigator.clipboard.writeText(new URL(path, location.origin).href);
    const download = (f: FileRow) => { const a = document.createElement('a'); a.href = `/api/files/${f.id}?download`; a.download = f.name; a.click(); };
    const setBg = (r: BlockRow, bg?: string) => {
        const oldStyle = { ...r.style }, newStyle = { ...r.style, bg };
        db.update({ id: r.id, style: newStyle }); // style 컬럼은 JSON 통째로 교체된다
        record({
            undo: () => db.update({ id: r.id, style: oldStyle }),
            redo: () => db.update({ id: r.id, style: newStyle }),
        });
    };
    // 특수 블럭 삭제. 앞뒤가 텍스트면 자동으로 병합해 흐름을 복원한다.
    // 자식(표의 칸)은 서버가 연쇄 삭제하므로 여기서 지우지 않고, undo 때 되살리기 위해 스냅샷만 떠 둔다.
    const removeBlock = (r: BlockRow) => {
        const snapshot = { ...r };
        const children = rows.filter(x => x.parent_id === r.id).map(x => ({ ...x }));
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
            undo: () => { if (pageSnapshot) subpages.insert(pageSnapshot); db.insert(snapshot); children.forEach(c => db.insert(c)); join?.revert(); },
            redo: () => { db.remove(snapshot.id); join?.apply(); },
        });
        // 편집 중이던 블럭이 병합에 휩쓸리면 병합된 블럭에서 이어서 편집한다
        if (join && editing && (editing.id === join.upper.id || editing.id === join.lower.id)) {
            editAt({ ...join.upper, text: joinText(join.upper.text, join.lower.text) }, join.joint);
        } else if (editing?.id === r.id) {
            // 지운 블럭 안을 편집 중이었으면(빈 토글에서 Backspace) 캐럿을 이음새나 이웃 텍스트로 옮긴다
            const upper = sorted[i - 1], lower = sorted[i + 1];
            if (join) editAt({ ...join.upper, text: joinText(join.upper.text, join.lower.text) }, join.joint);
            else if (isText(upper)) editAt(upper, upper.text.length);
            else if (isText(lower)) editAt(lower, 0);
            else closeEdit();
        }
    };
    // 문서 끝에 빈 텍스트 블럭을 하나 만들고 편집을 연다 (빈 문서, 또는 마지막 블럭이 특수 블럭일 때 이어 쓰는 입구).
    const appendText = () => {
        const row: BlockRow = { id: rid(8), doc_id: docId, text: '', pos: posBetween(sorted.at(-1)), style: {} };
        if (db.insert(row)) {
            pendingCaret.current = { id: row.id, at: 0 };
            setEditing({ id: row.id, draft: '' });
            record({ undo: () => db.remove(row.id), redo: () => db.insert(row) });
        }
    };
    // 캐럿 위치에 특수 블럭(들)을 꽂는다. draft 에서 '/'와 필터([start, end))를 지운 텍스트를 start 에서 앞·뒤로 나누고 그 사이에 넣는다.
    // 붙여넣기는 지울 구간이 없으므로 start = end 로 부른다.
    // 앞쪽이 비면 앞 텍스트 블럭을 만들지 않고 현재 블럭이 뒤쪽이 된다. 뒤쪽은 비어도 남겨서 캐럿을 두고 계속 입력하게 한다.
    // 나뉘는 자리의 개행(앞쪽 끝·뒤쪽 첫 개행) 하나씩은 거둔다 — 특수 블럭이 그 줄 자리를 차지하므로 빈 줄이 남지 않게.
    const insertSpecialAt = (
        r: BlockRow, draft: string, start: number, end: number,
        blocks: NewBlock[], extra?: { undo?: () => void; redo?: () => void },
    ): BlockRow[] | null => {
        if (!blocks.length) return null;
        let before = draft.slice(0, start), after = draft.slice(end);
        if (before.endsWith('\n')) before = before.slice(0, -1);
        if (after.startsWith('\n')) after = after.slice(1);
        const i = sorted.findIndex(x => x.id === r.id);
        const tail: BlockRow | null = before ? { id: rid(8), doc_id: docId, text: after, pos: 0, style: {} } : null;
        // tail 이 있으면 r(앞) · specials · tail(뒤), 없으면 specials · r(뒤)
        const specials = placeBetween(tail ? sorted[i] : sorted[i - 1], tail ? sorted[i + 1] : sorted[i], blocks);
        if (tail) tail.pos = posBetween(specials.at(-1), sorted[i + 1]);
        const firstText = tail ? before : after;
        const apply = () => {
            if (!db.update({ id: r.id, text: firstText })) return false;
            for (const sp of specials) db.insert(sp);
            if (tail) db.insert(tail);
            return true;
        };
        const revert = () => {
            if (tail) db.remove(tail.id);
            for (const sp of specials) db.remove(sp.id);
            db.update({ id: r.id, text: draft });
        };
        closeEdit(); // 스로틀에 걸려 있던 초안과 타이핑 덩어리를 먼저 확정한다
        if (!apply()) return null;
        record({
            undo: () => { revert(); extra?.undo?.(); },
            redo: () => { extra?.redo?.(); apply(); },
        });
        editAt(tail ?? { ...r, text: after }, 0);
        return specials;
    };
    const runSlash = (cmd: SlashCommand) => {
        if (!slash || !editing || slash.id !== editing.id) return;
        const r = rows.find(x => x.id === slash.id);
        if (!r) return;
        const { draft } = editing;
        const start = slash.start, end = start + 1 + slash.filter.length;
        setSlash(null);
        cmd.run({
            docId, db, pages, subpages, navigate,
            insert: (block, extra) => insertSpecialAt(r, draft, start, end, [block], extra),
            edit: target => editAt(target, 0),
            insertMarkup: (markup, line) => {
                const view = editors.current.get(r.id)?.view;
                if (!view) return;
                const lineStart = draft.lastIndexOf('\n', start - 1) + 1;
                const insert = (start > lineStart ? '\n' : '') + markup + (line ? '\n' : '');
                view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length } });
            },
            openRecording,
        });
    };
    // 토글 접기·펼치기. 접을 때 그 안을 편집 중이었으면 편집을 닫는다 (에디터가 내려간다).
    const setOpen = (r: BlockRow, open: boolean) => {
        if (!open && editing?.id === r.id) closeEdit();
        setCollapsed(c => { const n = new Set(c); if (open) n.delete(r.id); else n.add(r.id); return n; });
    };
    // 콜아웃 아이콘 교체. 이모지 하나를 그대로 받는다.
    const setIcon = (r: BlockRow) => {
        const icon = prompt('콜아웃 아이콘 (이모지)', r.style?.icon ?? CALLOUT_ICON)?.trim();
        if (!icon || icon === r.style?.icon) return;
        const oldStyle = { ...r.style }, newStyle = { ...r.style, icon };
        db.update({ id: r.id, style: newStyle });
        record({ undo: () => db.update({ id: r.id, style: oldStyle }), redo: () => db.update({ id: r.id, style: newStyle }) });
    };

    // ── 표 ───────────────────────────────────────────────
    // 표의 구조 변경은 표 블럭의 style(rows·cols)과 칸 블럭의 삽입·삭제를 한 undo 항목으로 묶는다.
    const cellsOf = (t: BlockRow) => rows.filter(c => c.parent_id === t.id);
    const tableOp = (t: BlockRow, next: Pick<BlockStyle, 'rows' | 'cols'>, add: BlockRow[], del: BlockRow[]) => {
        const oldStyle = { ...t.style }, newStyle = { ...t.style, ...next };
        const apply = () => { db.update({ id: t.id, style: newStyle }); add.forEach(c => db.insert(c)); del.forEach(c => db.remove(c.id)); };
        const revert = () => { db.update({ id: t.id, style: oldStyle }); del.forEach(c => db.insert(c)); add.forEach(c => db.remove(c.id)); };
        closeEdit();
        apply();
        record({ undo: revert, redo: apply });
    };
    const nextCellPos = (t: BlockRow) => Math.max(0, ...cellsOf(t).map(c => c.pos));
    const addRow = (t: BlockRow) => {
        const row = rid(4), tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        tableOp(t, { rows: [...tr, row] }, makeCells(t.id, docId, [row], cols, nextCellPos(t)), []);
    };
    const addCol = (t: BlockRow) => {
        const col = rid(4), tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        tableOp(t, { cols: [...cols, col] }, makeCells(t.id, docId, tr, [col], nextCellPos(t)), []);
    };
    // 마지막 행·열을 지우면 표 자체를 지운다 (빈 표는 남기지 않는다)
    const delRow = (t: BlockRow, row: string) => {
        const tr = t.style?.rows ?? [];
        if (tr.length <= 1) return removeBlock(t);
        tableOp(t, { rows: tr.filter(x => x !== row) }, [], cellsOf(t).filter(c => c.style?.row === row));
    };
    const delCol = (t: BlockRow, col: string) => {
        const cols = t.style?.cols ?? [];
        if (cols.length <= 1) return removeBlock(t);
        tableOp(t, { cols: cols.filter(x => x !== col) }, [], cellsOf(t).filter(c => c.style?.col === col));
    };
    // 슬롯에 칸 블럭이 없으면(동시 편집 경계) 만들어서 편집을 연다. 있으면 그 끝에서 편집한다.
    const editCell = (t: BlockRow, row: string, col: string) => {
        const c = cellsOf(t).find(x => x.style?.row === row && x.style?.col === col);
        if (c) { editAt(c, c.text.length); return; }
        const [made] = makeCells(t.id, docId, [row], [col], nextCellPos(t));
        if (db.insert(made)) { record({ undo: () => db.remove(made.id), redo: () => db.insert(made) }); editAt(made, 0); }
    };
    // Tab / Shift+Tab 으로 다음·이전 칸. 행 끝에서는 다음 행 첫 칸으로, 표 끝에서는 멈춘다.
    const moveCell = (c: BlockRow, dir: -1 | 1) => {
        const t = rows.find(x => x.id === c.parent_id);
        if (!t) return;
        const tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        const i = tr.indexOf(c.style?.row ?? '') * cols.length + cols.indexOf(c.style?.col ?? '') + dir;
        if (i < 0 || i >= tr.length * cols.length) return;
        closeEdit();
        editCell(t, tr[Math.floor(i / cols.length)], cols[i % cols.length]);
    };

    // ── 블럭 컨텍스트 메뉴 ───────────────────────────────
    // 항목은 공통(복제·이동·삭제) + 타입별로 구성한다. 새 블럭 타입은 TYPE_ITEMS 에 키를 추가하면 된다 (예: 녹음 블럭).
    // 배경색은 항목이 아니라 메뉴 위쪽의 색 줄로 그린다. 각 항목의 조작은 record 로 undo 스택에 개별 항목으로 들어간다.
    type MenuItem = { label: string; icon: string; danger?: boolean; run: () => void };
    const fileOf = (r: BlockRow) => fileRows.find(x => x.id === r.ref);
    // cell 은 표의 칸 안에서 우클릭했을 때 그 칸. 칸·행 단위 항목(배경색·정렬 등)은 table-styling 티켓이 여기에 채운다.
    const TYPE_ITEMS: Record<string, (r: BlockRow, cell?: BlockRow) => MenuItem[]> = {
        subpage: r => {
            const page = pages.find(p => p.id === r.ref);
            if (!page) return [];
            return [
                { label: '이름 바꾸기', icon: '✎', run: () => renamePage(page) },
                { label: '패널에서 열기', icon: '▤', run: () => openPage(page.id) },
                { label: '페이지로 이동', icon: '→', run: () => navigate(`/p/cowork/${page.id}`) },
                { label: '새 탭에서 열기', icon: '↗', run: () => window.open(`/p/cowork/${page.id}`, '_blank') },
                { label: '링크 복사', icon: '🔗', run: () => copyLink(`/p/cowork/${page.id}`) },
            ];
        },
        image: r => {
            const f = fileOf(r);
            if (!f) return [];
            return [
                { label: '파일로 전환', icon: '📎', run: () => setType(r, 'file') },
                { label: '원본 새 탭에서 열기', icon: '↗', run: () => window.open(`/api/files/${f.id}`, '_blank') },
                { label: '다운로드', icon: '⬇', run: () => download(f) },
                { label: '링크 복사', icon: '🔗', run: () => copyLink(`/api/files/${f.id}`) },
            ];
        },
        file: r => {
            const f = fileOf(r);
            if (!f) return [];
            return [
                ...(f.mime.startsWith('image/') ? [{ label: '이미지로 전환', icon: '🖼️', run: () => setType(r, 'image') }] : []),
                ...(peekKind(f) ? [{ label: '패널에서 열기', icon: '▤', run: () => openPeek(f) }] : []),
                { label: '다운로드', icon: '⬇', run: () => download(f) },
                { label: '링크 복사', icon: '🔗', run: () => copyLink(`/api/files/${f.id}`) },
            ];
        },
        recording: r => {
            const rec = recRows.find(x => x.id === r.ref);
            if (!rec) return [];
            const f = rec.file_id ? fileRows.find(x => x.id === rec.file_id) : undefined;
            return [
                { label: '패널에서 열기', icon: '▤', run: () => openRecording(rec.id) },
                ...(f ? [{ label: '다운로드', icon: '⬇', run: () => download(f) }, { label: '링크 복사', icon: '🔗', run: () => copyLink(`/api/files/${f.id}`) }] : []),
            ];
        },
        callout: r => [{ label: '아이콘 바꾸기', icon: r.style?.icon || CALLOUT_ICON, run: () => setIcon(r) }],
        toggle: r => [isCollapsed(r) ? { label: '펼치기', icon: '▾', run: () => setOpen(r, true) } : { label: '접기', icon: '▸', run: () => setOpen(r, false) }],
        table: r => [
            { label: '행 추가', icon: '↓', run: () => addRow(r) },
            { label: '열 추가', icon: '→', run: () => addCol(r) },
        ],
    };
    // 메뉴에 그릴 항목 묶음(구분선으로 나뉜다): 타입별 → 공통(복제·이동) → 삭제. 빈 묶음은 뺀다.
    const menuGroups = (r: BlockRow, cell?: BlockRow): MenuItem[][] => {
        const i = sorted.findIndex(x => x.id === r.id);
        return [
            TYPE_ITEMS[r.type ?? '']?.(r, cell) ?? [],
            [
                ...(r.type !== 'subpage' ? [{ label: '복제', icon: '⧉', run: () => duplicateBlock(r) }] : []),
                ...(i > 0 ? [{ label: '위로 이동', icon: '↑', run: () => moveBlock(r, -1) }] : []),
                ...(i < sorted.length - 1 ? [{ label: '아래로 이동', icon: '↓', run: () => moveBlock(r, 1) }] : []),
            ],
            [{ label: '블럭 삭제', icon: '✕', danger: true, run: () => removeBlock(r) }],
        ].filter(g => g.length);
    };
    // 우클릭으로 메뉴를 연다. 특수 블럭 안 어디서든(콜아웃 본문·표의 칸 포함) 뜨고, 브라우저 기본 메뉴는 막는다.
    const openMenuAt = (e: MouseEvent, id: string, cell?: string) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ id, cell, at: { x: e.clientX, y: e.clientY } });
    };

    // 텍스트를 담는 블럭(본문 텍스트·콜아웃·표의 칸)의 에디터. 항상 마운트되어 있고 포커스가 곧 편집이다. 초안·스로틀 전송·undo 덩어리는 공통이고,
    // '/' 명령·파일 붙여넣기는 본문 텍스트에서만, 화살표 블럭 이동은 흐름(텍스트·콜아웃)에서만, Tab 칸 이동은 칸에서만 된다.
    const editor = (r: BlockRow) => {
        const isEditing = editing?.id === r.id;
        const text = isText(r);
        const matched = slash?.id === r.id ? matchCommands(slash.filter) : [];
        return (
            <MdEditor
                ref={h => {
                    if (!h) { editors.current.delete(r.id); return; }
                    editors.current.set(r.id, h);
                    const pc = pendingCaret.current;
                    if (pc && pc.id === r.id) { pendingCaret.current = null; h.setCaret(pc.at); }
                }}
                value={isEditing ? editing.draft : r.text}
                className={r.type === 'toggle' ? 'md-toggle' : undefined}
                onChange={(t, caret) => {
                    const prev = editing?.id === r.id ? editing.draft : r.text;
                    const view = editors.current.get(r.id)?.view;
                    // 포커스 없이 원문이 바뀌는 경우(할 일 체크박스 클릭)는 초안을 거치지 않고 바로 보내고, undo 항목 하나로 기록한다
                    if (view && !view.hasFocus && !isEditing) {
                        db.update({ id: r.id, text: t });
                        record({ undo: () => applyText(r.id, prev), redo: () => applyText(r.id, t) });
                        return;
                    }
                    onDraft(r.id, t);
                    // '/' 명령은 본문 텍스트에서만 연다. keydown 이 아니라 문서 변경으로 감지한다 — 모바일 가상 키보드는 keydown 의 key 가
                    // Unidentified 이거나 조합 이벤트로만 들어와 keydown 으로는 잡히지 않는다. 한글 조합은 '/' 를 만들지 않으므로 별도 가드가 필요 없다.
                    // '/' 자체는 그대로 입력되게 두고 메뉴만 캐럿 아래에 연다. 필터는 아래에서 이어 친 글자로 채운다.
                    let same = 0; // 앞에서부터 같은 글자 수 — 캐럿 앞의 '/' 가 이번 변경으로 들어온 것인지 본다
                    while (same < prev.length && same < t.length && prev[same] === t[same]) same++;
                    if (text && view && slash?.id !== r.id && caret > same && t[caret - 1] === '/') {
                        const { top, left } = caretBottomLeft(view, caret - 1);
                        setSlash({ id: r.id, start: caret - 1, filter: '', sel: 0, top, left });
                        return;
                    }
                    // '/' 가 지워지거나 캐럿이 그 앞으로 가거나 공백을 치면 메뉴를 닫고, 아니면 필터를 갱신한다
                    setSlash(s => {
                        if (!s || s.id !== r.id) return s;
                        if (t[s.start] !== '/' || caret <= s.start) return null;
                        const filter = t.slice(s.start + 1, caret);
                        return /\s/.test(filter) ? null : { ...s, filter, sel: 0 };
                    });
                }}
                // 포커스가 곧 편집 시작. 이웃 블럭에서 넘어온 경우(editAt)는 이미 editing 이 잡혀 있다.
                onFocus={view => { if (editing?.id !== r.id) setEditing({ id: r.id, draft: view.state.doc.toString() }); }}
                onBlur={() => { if (editing?.id === r.id) closeEdit(); }}
                interceptDrop={e => hasFiles(e.dataTransfer) || !!dragId.current}
                onPaste={text ? (files, at) => { // 클립보드에 파일(스크린샷 등)이 있으면 텍스트 대신 첨부로 받는다. 본문 텍스트에서만 — 콜아웃·칸은 나뉠 수 없다
                    const draft = editing?.id === r.id ? editing.draft : r.text;
                    uploadAll(files).then(blocks => insertSpecialAt(r, draft, at, at, blocks));
                    return true;
                } : undefined}
                onKeyDown={(e, { view, col, atFirstLine, atLastLine }) => {
                    const mod = e.ctrlKey || e.metaKey;
                    if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'i')) {
                        toggleMark(view, e.key === 'b' ? '**' : '*'); // Ctrl+B / Ctrl+I
                        return true;
                    }
                    if (slash?.id === r.id) {
                        if (e.key === 'Escape') { setSlash(null); return true; }
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            const n = matched.length;
                            if (n) setSlash(s => (s ? { ...s, sel: (s.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n } : s));
                            return true;
                        }
                        if (e.key === 'Enter' && matched.length) { runSlash(matched[slash.sel] ?? matched[0]); return true; }
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') setSlash(null);
                    }
                    if (r.type === 'cell' && e.key === 'Tab') { moveCell(r, e.shiftKey ? -1 : 1); return true; }
                    // 빈 토글에서 Backspace 는 토글을 지운다 (일반 텍스트에서 빈 줄을 지우듯). 앞뒤 텍스트는 병합되고 캐럿은 이음새로 간다
                    if (r.type === 'toggle' && e.key === 'Backspace' && view.state.doc.length === 0) { removeBlock(r); return true; }
                    // Enter 는 가로채지 않는다 — 블럭 안의 개행일 뿐이다 (목록 안에서는 CM 이 항목을 이어 준다). 블럭을 나누는 단축키는 없다.
                    if (e.key === 'Escape') { view.contentDOM.blur(); return true; } // blur → closeEdit
                    // 순수 텍스트의 줄 이동처럼, 첫·마지막 줄에서 ↑↓ 는 이웃 블럭으로 넘어간다
                    if (inFlow(r) && ((e.key === 'ArrowUp' && atFirstLine) || (e.key === 'ArrowDown' && atLastLine))) {
                        return editNeighbor(r.id, e.key === 'ArrowDown' ? 1 : -1, col);
                    }
                    return false;
                }}
            />
        );
    };

    const last = sorted.at(-1);
    return (
        <div onMouseDownCapture={() => { activeDoc = self.current; }} onFocusCapture={() => { activeDoc = self.current; }}>
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
                            // 블럭 손잡이 드래그와 OS 파일 드래그 둘 다 같은 안내선을 쓴다
                            if (hasFiles(e.dataTransfer) ? false : !dragId.current || dragId.current === r.id) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setDropAt({ id: r.id, before: e.clientY < rect.top + rect.height / 2 });
                        }}
                        onDragLeave={e => { // 블럭 밖으로 나가면 안내선을 거둔다 (이웃 블럭에 들어가면 그쪽 dragover 가 다시 세운다)
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(d => (d?.id === r.id ? null : d));
                        }}
                        onDrop={e => { e.preventDefault(); if (hasFiles(e.dataTransfer)) dropFiles(e.dataTransfer); else drop(); }}
                        // 에디터 안 클릭은 CM 이 캐럿을 놓는다. 에디터 밖 여백(패딩) 클릭은 텍스트 끝에서 이어 쓴다.
                        onClick={text ? e => { if (!(e.target as HTMLElement).closest('.cm-editor')) editAt(r, r.text.length); } : undefined}
                        onContextMenu={text ? undefined : e => openMenuAt(e, r.id)}
                    >
                        {dropAt?.id === r.id && (
                            <div className={`absolute left-0 right-0 h-0.5 bg-[var(--c-bluBacAccPri)] ${dropAt.before ? 'top-0' : 'bottom-0'}`} />
                        )}
                        {/* 손잡이는 특수 블럭에만 있다 — 텍스트는 흐름의 일부라 개별 조작 대상이 아니다 */}
                        {!text && (
                            <span
                                className={`block-handle absolute left-1 top-2 group-hover:block cursor-grab select-none text-[var(--c-icoSec)] text-sm leading-normal ${menu?.id === r.id ? 'block' : 'hidden'}`}
                                title="끌어서 이동 · 클릭하면 메뉴"
                                draggable
                                onDragStart={() => { setMenu(null); dragId.current = r.id; }}
                                onDragEnd={() => { dragId.current = null; setDropAt(null); }}
                                onClick={e => { e.stopPropagation(); setMenu(menu?.id === r.id ? null : { id: r.id }); }}
                            >⠿</span>
                        )}
                        {menu?.id === r.id && (
                            <>
                                {/* 뒷막: 바깥 클릭·우클릭으로 닫는다. 탑바(z-20)보다 위에 둬서 탑바를 클릭해도 닫힌다 */}
                                <div className="fixed inset-0 z-30" onClick={e => { e.stopPropagation(); setMenu(null); }} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
                                <div
                                    className={`z-40 bg-white border border-[var(--c-borPri)] rounded-md shadow-md p-1.5 text-xs whitespace-normal cursor-default w-max min-w-40 ${menu.at ? 'fixed' : 'absolute left-1 top-8'}`}
                                    // 우클릭 메뉴는 마우스 자리에 두되 화면 밖으로 나가지 않게 당긴다
                                    style={menu.at ? { left: Math.min(menu.at.x, window.innerWidth - 200), top: Math.min(menu.at.y, window.innerHeight - 320) } : undefined}
                                    onClick={e => e.stopPropagation()}
                                    onContextMenu={e => e.preventDefault()}
                                >
                                    <div className="flex items-center gap-1.5 px-1 py-1">
                                        <span className="text-[var(--c-texSec)]">배경</span>
                                        {BG_COLORS.map(c => (
                                            <button
                                                key={c || 'none'}
                                                className="bg-dot w-4 h-4 rounded-full border border-black/20 cursor-pointer"
                                                style={{ background: c || '#ffffff' }}
                                                title={c || '배경 없음'}
                                                onClick={() => { setBg(r, c || undefined); setMenu(null); }}
                                            />
                                        ))}
                                    </div>
                                    {menuGroups(r, menu.cell ? rows.find(x => x.id === menu.cell) : undefined).map((group, gi) => (
                                        <div key={gi} className="border-t border-[var(--c-borPri)] pt-1 mt-1">
                                            {group.map(item => (
                                                <button
                                                    key={item.label}
                                                    className={`menu-item flex items-center gap-2 w-full text-left cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-1 py-0.5 ${item.danger ? 'text-[var(--c-redTexPri)]' : ''}`}
                                                    onClick={() => { setMenu(null); item.run(); }}
                                                ><span className="w-4 text-center">{item.icon}</span>{item.label}</button>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                        {slash?.id === r.id && isEditing && (
                            <div
                                className="absolute z-20 bg-white border border-[var(--c-borPri)] rounded-md shadow-md p-1 text-sm whitespace-normal cursor-default w-max min-w-40"
                                style={{ top: slash.top, left: slash.left }}
                                onMouseDown={e => e.preventDefault()} // 에디터의 포커스(캐럿)를 유지한다
                            >
                                {matched.length === 0
                                    ? <div className="px-2 py-1 text-[var(--c-texTer)]">일치하는 명령 없음</div>
                                    : matched.map((c, idx) => (
                                        <div
                                            key={c.label}
                                            className={`slash-item px-2 py-1 rounded cursor-pointer ${idx === slash.sel ? 'bg-[var(--ca-bacIntTra)]' : ''}`}
                                            onMouseEnter={() => setSlash(s => (s ? { ...s, sel: idx } : s))}
                                            // click 이 아니라 mousedown 에서 실행한다. 터치는 탭 뒤 합성 mousedown → blur → click 순이라 click 시점엔 편집이 닫혀 있다
                                            onMouseDown={e => { e.preventDefault(); runSlash(c); }}
                                        >{c.icon} {c.label}</div>
                                    ))}
                            </div>
                        )}
                        <div className="rounded-md px-2 py-0.5" style={{ background: r.style?.bg }}>
                            {text ? editor(r) : r.type === 'callout' ? (
                                // 콜아웃: 아이콘 + 본문. 배경은 바깥 상자(style.bg)가 맡는다. 에디터 밖 여백을 클릭하면 본문 끝에서 이어 쓰고, 아이콘을 클릭하면 바꾼다.
                                <div className="flex gap-2 py-1 cursor-text" onClick={e => { if (!(e.target as HTMLElement).closest('.cm-editor')) editAt(r, r.text.length); }}>
                                    <span className="select-none cursor-pointer leading-[1.5]" title="아이콘 바꾸기" onClick={e => { e.stopPropagation(); setIcon(r); }}>{r.style?.icon || CALLOUT_ICON}</span>
                                    <div className="flex-1 min-w-0">{editor(r)}</div>
                                </div>
                            ) : r.type === 'toggle' ? (() => {
                                // 토글: 화살표 + 본문(첫 줄이 제목). 접으면 에디터를 내리고 제목 줄만 보인다. 제목을 클릭하면 펼쳐서 제목 끝에서 편집한다.
                                const open = !collapsed.has(r.id);
                                const title = toggleTitle(r.text);
                                return (
                                    <div className="flex gap-1 py-1 cursor-text" onClick={e => { if (open && !(e.target as HTMLElement).closest('.cm-editor')) editAt(r, r.text.length); }}>
                                        <span
                                            className="select-none cursor-pointer w-5 text-center leading-[1.5] text-[var(--c-icoSec)] hover:bg-[var(--ca-bacIntTra)] rounded"
                                            title={open ? '접기' : '펼치기'}
                                            onClick={e => { e.stopPropagation(); setOpen(r, !open); }}
                                        >{open ? '▾' : '▸'}</span>
                                        <div className="flex-1 min-w-0">
                                            {open ? editor(r) : (
                                                <div className={title ? '' : 'text-[var(--c-texTer)]'} onClick={() => { setOpen(r, true); pendingCaret.current = { id: r.id, at: title.length }; setEditing({ id: r.id, draft: r.text }); }}>{title || '토글'}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })() : r.type === 'table' ? (() => {
                                // 표: 행·열 순서는 표 블럭의 style, 내용은 자식 칸 블럭. 위 조작줄은 열 삭제·열 추가, 오른쪽은 행 삭제, 아래는 행 추가 (표에 마우스를 올리면 보인다).
                                const tr = r.style?.rows ?? [], cols = r.style?.cols ?? [];
                                const cells = cellsOf(r);
                                const ctl = 'table-ctl text-xs leading-none text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer select-none px-1 opacity-0 group-hover/table:opacity-100';
                                return ( // 좁은 화면에서는 표만 가로로 스크롤한다
                                    <div className="overflow-x-auto">
                                    <table className="group/table border-collapse text-[14px] leading-[1.5] my-1 whitespace-pre-wrap">
                                        <tbody>
                                            <tr>
                                                {cols.map(col => <td key={col} className="text-center"><span className={ctl} title="열 삭제" onClick={() => delCol(r, col)}>×</span></td>)}
                                                <td><span className={ctl} title="열 추가" onClick={() => addCol(r)}>+</span></td>
                                            </tr>
                                            {tr.map(row => (
                                                <tr key={row}>
                                                    {cols.map(col => {
                                                        const c = cells.find(x => x.style?.row === row && x.style?.col === col);
                                                        return (
                                                            <td
                                                                key={col}
                                                                className="border border-[var(--c-borPri)] align-top px-2 py-1 min-w-[96px] cursor-text"
                                                                onClick={e => { if (!(e.target as HTMLElement).closest('.cm-editor')) editCell(r, row, col); }}
                                                                onContextMenu={e => openMenuAt(e, r.id, c?.id)}
                                                            >{c ? editor(c) : ' '}</td>
                                                        );
                                                    })}
                                                    <td className="align-middle"><span className={ctl} title="행 삭제" onClick={() => delRow(r, row)}>×</span></td>
                                                </tr>
                                            ))}
                                            <tr><td colSpan={cols.length}><span className={ctl} title="행 추가" onClick={() => addRow(r)}>+</span></td></tr>
                                        </tbody>
                                    </table>
                                    </div>
                                );
                            })() : r.type === 'subpage' ? (() => {
                                // 링크 블럭: 제목은 subpages 에서 실시간으로 읽는다. ref 대상이 사라졌으면 들어갈 수 없는 자리표시자만 남긴다.
                                const page = pages.find(p => p.id === r.ref);
                                // 클릭은 오른쪽 패널에 띄우고, Alt+클릭은 그 페이지로 전환한다(브라우저의 Alt+클릭 기본 동작인 링크 저장을 막는다). Ctrl/Shift+클릭은 Link 의 새 탭·창 열기에 맡긴다.
                                return page
                                    ? (
                                        <Link
                                            to={`/p/cowork/${page.id}`}
                                            className="underline decoration-black/30 cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-0.5"
                                            title="클릭: 패널에서 열기 · Alt+클릭: 페이지로 이동"
                                            onClick={e => { if (e.altKey) { e.preventDefault(); navigate(`/p/cowork/${page.id}`); } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); openPage(page.id); } }}
                                        >📄 {pageTitle(page)}</Link>
                                    )
                                    : <span className="text-[var(--c-texTer)] cursor-default">📄 {pageTitle(undefined)}</span>;
                            })() : r.type === 'recording' ? (() => {
                                // 녹음 링크 블럭: 제목·상태는 recordings 에서 읽고, 클릭하면 오른쪽 패널에 녹음 상태가 뜬다
                                const rec = recRows.find(x => x.id === r.ref);
                                if (!rec) return <span className="text-[var(--c-texTer)] cursor-default">🎙️ 삭제된 녹음</span>;
                                return (
                                    <a
                                        href={`#recording-${rec.id}`}
                                        onClick={e => { e.preventDefault(); openRecording(rec.id); }}
                                        className="inline-flex items-center gap-1.5 underline decoration-black/30 cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-0.5"
                                        title={rec.title}
                                    >🎙️ {rec.title}
                                        {rec.status === 'recording' && <span className="inline-block w-2 h-2 rounded-full bg-[#e03e3e] animate-pulse" title="녹음 중" />}
                                        {rec.status === 'paused' && <span className="text-xs text-[var(--c-texTer)] no-underline">일시정지</span>}
                                        {rec.status === 'stopped' && <span className="text-xs text-[var(--c-texTer)] no-underline">{fmtClock(elapsedMs(rec))}</span>}
                                    </a>
                                );
                            })() : r.type === 'image' || r.type === 'file' ? (() => {
                                // 첨부 블럭: 메타는 files 에서 읽는다. 이미지는 본문에 인라인, 파일은 이름·크기를 보이고 클릭하면 다운로드한다.
                                // PDF·텍스트 형식(peekKind)은 예외로 오른쪽 사이드 패널(SidePeek)에서 연다. href 는 inline 주소로 두어 새 탭 열기도 통하게 한다.
                                const f = fileRows.find(x => x.id === r.ref);
                                if (!f) return <span className="text-[var(--c-texTer)] cursor-default">{r.type === 'image' ? '🖼️' : '📎'} 삭제된 파일</span>;
                                if (r.type === 'image') {
                                    return (
                                        <>
                                            <img src={`/api/files/${f.id}`} alt={r.text || f.name} draggable={false} className="block max-w-full max-h-[70vh] rounded-md" />
                                            {r.text && <div className="text-sm text-[var(--c-texSec)] mt-1">{r.text}</div>}
                                        </>
                                    );
                                }
                                const peek = peekKind(f) !== null;
                                return (
                                    <a
                                        href={peek ? `/api/files/${f.id}` : `/api/files/${f.id}?download`}
                                        onClick={peek ? e => { e.preventDefault(); openPeek(f); } : undefined}
                                        className="inline-flex items-center gap-1.5 underline decoration-black/30 cursor-pointer hover:bg-[var(--ca-bacIntTra)] rounded px-0.5"
                                        title={f.name}
                                    >📎 {r.text || f.name}<span className="text-xs text-[var(--c-texTer)] no-underline">{fmtSize(f.size)}</span></a>
                                );
                            })() : null}
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
                onDragOver={e => { // 목록 맨 끝으로의 드래그 이동·파일 드롭
                    e.preventDefault();
                    if (last && (hasFiles(e.dataTransfer) || (dragId.current && dragId.current !== last.id))) setDropAt({ id: last.id, before: false });
                }}
                onDragLeave={() => { if (last) setDropAt(d => (d?.id === last.id && !d.before ? null : d)); }}
                onDrop={e => { e.preventDefault(); if (hasFiles(e.dataTransfer)) dropFiles(e.dataTransfer); else drop(); }}
            >
                {sorted.length === 0 && '여기에 입력하세요. \'/\' 로 페이지·이미지·파일·콜아웃·표를 넣을 수 있습니다.'}
            </div>
        </ModuleFrame>
        </div>
    );
}
