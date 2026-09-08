// 블럭 문서 모듈. 편집 UX 결정 기록: docs/2026-08-31-cowork-block-editing.md
// 지도 원칙: "일반 텍스트처럼". 본문 텍스트는 하나의 흐름이고 사용자가 텍스트 블럭을 직접 나누거나 붙이지 않는다.
// 텍스트가 나뉘는 것은 그 사이에 특수 블럭(서브페이지 링크 등)이 '/' 명령으로 끼어들 때뿐이고, 특수 블럭이 사라지면 다시 붙는다.
// 쓰기가 본질인 모듈이라 rw 핸들을 요구한다 — ro 핸들을 꽂으면 컴파일 에러가 난다.
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { v4 as uuid } from 'uuid';
import { readTable, rid } from '@/sync/store';
import { commit, drop as dropGroup, group, newGroup, onBeforeUndo, run } from '@/sync/history';
import { merge3 } from '@/sync/merge';
import type { RoTable, RwTable } from '@/sync/handle';
import { peekKind, useSidePeek } from './SidePeek';
import { defaultTitle, elapsedMs, fmtClock, useRecorder, type RecordingRow } from './recorder';
import { MdEditor, toggleMark, type MdEditorHandle } from './MdEditor';
import { fmtDateTime, propTime, type PagePropRow } from './props';
import { table } from '@/sync/handle';
import { runMacro, type MacroRow, type NewBlock } from './macros';
import { MEETING_TEMPLATE_ID, templatePages } from './templates';
import type { EditorView } from '@codemirror/view';

// 블럭 단위 스타일. bg 는 배경색(모든 블럭). 굵게 등 텍스트 서식은 블럭 단위가 아니다.
// icon 은 콜아웃의 아이콘. cols·rows 는 표의 열·행 id 순서, row·col 은 칸이 속한 행·열 id (스키마 문서의 "슬롯").
// 표 블럭: rows·cols 는 슬롯 순서, header 는 첫 행 강조, widths 는 열 id → px. 칸 블럭: row·col 은 슬롯, bg·align 은 칸 서식.
// 탭 블럭: tabs 는 탭 슬롯 순서(id·이름표), 자식 블럭의 tab 은 자기가 속한 슬롯 (표의 row·col 과 같은 방식).
export type BlockStyle = {
    bg?: string; icon?: string; cols?: string[]; rows?: string[]; row?: string; col?: string;
    header?: boolean; widths?: Record<string, number>; align?: 'left' | 'center' | 'right';
    tabs?: { id: string; label: string }[]; tab?: string;
    template?: string; // 회의 보드(meetings): 새 회의에 쓸 템플릿 페이지 id. 없으면 내장 회의록 (macro-template 2026-09-07)
};
export type BlockRow = {
    id: string;
    doc_id: string;
    parent_id?: string | null; // 중첩 조립품용. 표의 칸(cell)이 표(table) id 를, 탭 안의 블럭이 탭(tabs) id 를 가리킨다. 그 밖에는 NULL
    text: string;
    pos: number;
    type?: 'text' | 'subpage' | 'image' | 'file' | 'callout' | 'table' | 'cell' | 'recording' | 'toggle' | 'tabs' | 'meetings' | 'button';
    ref?: string; // subpage → subpages.id, image·file → files.id, recording → recordings.id, meetings → 보드 키(uuid, 행 없음), button → 매크로 id

    style?: BlockStyle;
    updated_at?: number; // 서버가 찍는다
};
// 서브페이지 본체. 링크 블럭(type='subpage')이 ref 로 가리키고, 제목은 페이지 화면의 h1 과 링크 블럭·브레드크럼이 함께 쓴다.
export type SubpageRow = {
    id: string;
    title: string;
    pos: number;
    kind?: 'meeting' | 'template' | null; // 'meeting' 이면 회의록(페이지 목록에서 빠지고 회의 보드·사이드바 회의 목록에 보인다), 'template' 이면 템플릿 페이지(사이드바 템플릿 목록)
    board_id?: string | null; // 소속 회의 보드의 키 (meetings 블럭의 ref)
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
// 페이지를 가리키는 링크 블럭 (페이지의 유일한 입구라 삭제가 연쇄된다)
const isPageLink = (r?: BlockRow) => !!r && r.type === 'subpage';
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
// 병합은 화면상 내용이 유지되도록 개행으로 잇는다. 한쪽이 비어 있으면 개행을 덧붙이지 않는다.
const joinText = (a: string, b: string) => (a && b ? `${a}\n${b}` : a || b);

// 노션 라이트 테마의 블럭 배경 팔레트 (회·노랑·파랑·초록·보라)
const BG_COLORS = ['', '#f0efed', '#f9f3dc', '#e5f2fc', '#e8f1ec', '#f3ebf9'];
const PLACEHOLDER = "여기에 입력하세요. '/' 로 페이지·이미지·파일·콜아웃·표를 넣을 수 있습니다.";
const SEND_THROTTLE_MS = 400; // 편집 중 텍스트는 blur 가 아니라 스로틀로 내보낸다
const TYPING_CHUNK_MS = 1000; // 이만큼 입력이 멈추면 타이핑 undo 덩어리를 닫는다

// ── '/' 명령 ─────────────────────────────────────────
// 특수 블럭은 텍스트 편집 중 '/' 를 쳐서 캐럿 위치에 넣는다. 새 종류는 이 배열에 추가하면 된다.
// 이 배열은 코드에 고정된 내장 명령이고, 사용자가 만든 매크로(macros 테이블)가 matchCommands 에서 뒤에 합쳐진다. 사이드바의 "내장 매크로" 목록도 이 배열을 보인다.
// run 은 부속 행(서브페이지 본체 등)을 만든 뒤 ctx.insert 로 블럭을 꽂는다. 동기 실행 부분은 하나의 undo 묶음이다 (runSlash 가 group 으로 감싼다).
// 링크 블럭 삭제는 서버가 페이지까지 연쇄하고 같은 묶음으로 로그하므로, undo 가 페이지와 본문까지 되살린다.
// 이미지·파일은 선택 대화상자 → 업로드가 끝난 뒤에야 블럭을 꽂는다. 대화상자가 열리면 에디터가 blur 되어 편집이 닫히지만,
// insert 는 명령을 고른 시점의 캐럿 자리를 기억하고 있어서 그 자리에 들어간다. 파일 실체는 블럭을 지워도 남는다 (GC 는 MVP 밖).
// 같은 첨부를 에디터에 붙여넣기(캐럿 자리)·문서에 드롭(안내선 자리)으로도 넣을 수 있다.
// 새로 꽂을 블럭(NewBlock, macros.ts). id·style 은 보통 insert 가 채우지만, 자식을 거느리는 표처럼 미리 정해야 하면 넘길 수 있다.
type SlashContext = {
    docId: string;
    db: RwTable<BlockRow>;
    pages: SubpageRow[];
    subpages: RwTable<SubpageRow>;
    props: RwTable<PagePropRow>;
    navigate: (to: string) => void;
    insert: (block: NewBlock | NewBlock[]) => BlockRow[] | null; // 꽂힌 블럭 행들, 실패면 null. 여러 개(템플릿)면 배열
    edit: (r: BlockRow) => void; // 꽂은 블럭 안에서 바로 편집을 시작한다 (콜아웃·표의 첫 칸)
    // 블럭을 꽂는 대신 캐럿 자리에 마크다운 문법을 넣는다(할 일·구분선). 캐럿 앞에 글자가 있으면 새 줄로 내려서 넣고, line 이면 뒤에도 개행을 둔다.
    insertMarkup: (markup: string, line?: boolean) => void;
    openRecording: (id: string) => void; // 녹음 패널을 연다
};
export type SlashCommand = { label: string; icon: string; keywords: string[]; run: (ctx: SlashContext) => void | Promise<void> };
export const SLASH_COMMANDS: SlashCommand[] = [
    {
        label: '페이지', icon: '📄', keywords: ['page', 'subpage', '서브페이지'],
        // 서브페이지 행을 만들고 캐럿 자리에 링크 블럭을 꽂은 뒤, 노션처럼 바로 그 페이지로 들어간다 (제목부터 적게).
        run: ({ pages, subpages, navigate, insert }) => {
            const page: SubpageRow = { id: uuid(), title: '', pos: Math.max(0, ...pages.map(p => p.pos)) + 1 };
            if (!subpages.insert(page)) return;
            if (insert({ type: 'subpage', ref: page.id, text: '' })) navigate(`/p/cowork/${page.id}`);
        },
    },
    {
        label: '회의', icon: '📅', keywords: ['meeting', '회의', '회의록', 'board'],
        // 회의 보드. ref 가 보드 키이고 회의록(subpages.kind='meeting')이 board_id 로 이 키를 참조한다. 보드 안에서 회의를 만들고(오른쪽 패널) 목록을 본다.
        // 키는 행이 아니라서 블럭을 지워도 회의록은 남고, undo 로 블럭이 같은 키로 돌아오면 다시 보인다.
        run: ({ insert }) => { insert({ type: 'meetings', ref: uuid(), text: '' }); },
    },
    {
        label: '탭', icon: '🗂️', keywords: ['tab', 'tabs', '탭'],
        // 탭 컨테이너. 탭마다 독립된 블럭 흐름(중첩 BlockDoc)을 담는다. 자식은 parent_id = 탭 블럭, style.tab = 슬롯.
        run: ({ insert }) => { insert({ type: 'tabs', text: '', style: { tabs: [{ id: rid(4), label: '탭 1' }, { id: rid(4), label: '탭 2' }] } }); },
    },
    {
        label: '버튼', icon: '🔘', keywords: ['button', 'macro', '버튼', '매크로'],
        // 매크로 버튼. text 가 이름표, ref 가 매크로 id. 누르면 매크로가 실행되고 블럭을 만드는 명령이면 버튼 바로 아래에 들어간다. 설정은 블럭 메뉴의 "버튼 설정".
        run: ({ insert }) => { insert({ type: 'button', text: '버튼', ref: '' }); },
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
        run: ({ insert, edit, db, docId }) => {
            const id = rid(8);
            const rows = Array.from({ length: TABLE_INIT.rows }, () => rid(4)), cols = Array.from({ length: TABLE_INIT.cols }, () => rid(4));
            const cells = makeCells(id, docId, rows, cols, 0);
            if (!insert({ id, type: 'table', text: '', style: { rows, cols } })) return;
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
// 버튼이 가리킬 수 있는 내장 명령의 id. 버튼 자신은 뺀다
export const commandId = (c: SlashCommand) => `builtin:cmd:${c.label}`;
export const BUTTON_COMMANDS = SLASH_COMMANDS.filter(c => c.label !== '버튼');
// 사용자 매크로를 '/' 명령으로. 실행은 매크로 엔진이 맡고, 캐럿 자리 삽입(insert)·이동을 넘겨 준다
const macroCommand = (m: MacroRow): SlashCommand => ({
    label: m.name, icon: m.icon || '⚡', keywords: m.keywords,
    run: ({ docId, db, subpages, props, navigate, insert }) => {
        const err = runMacro(m, { docId, vars: {}, blocks: db, subpages, props, navigate, insertAt: insert });
        if (err) alert(err);
    },
});
const matchCommands = (filter: string, macros: MacroRow[]) => {
    const f = filter.toLowerCase();
    return [...SLASH_COMMANDS, ...macros.map(macroCommand)].filter(c => c.label.toLowerCase().startsWith(f) || c.keywords.some(k => k.toLowerCase().startsWith(f)));
};
// 에디터 안 캐럿의 픽셀 위치(블럭 박스 기준). '/' 명령 메뉴를 캐럿 아래에 띄우는 데 쓴다.
// 블럭 박스는 에디터의 offsetParent(가장 가까운 positioned 조상)다.
function caretBottomLeft(view: EditorView, at: number) {
    const c = view.coordsAtPos(at);
    const box = (view.dom.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    return c && box ? { top: c.bottom - box.top, left: c.left - box.left } : { top: 0, left: 0 };
}

// inPeek: 이 문서가 오른쪽 패널(PagePeek)에 떠 있다. 그 안의 서브페이지 링크를 클릭하면 지금 페이지가 왼쪽(본문)으로 가고 새 페이지가 패널에 뜬다.
// scope: 탭 블럭 안의 중첩 흐름을 그릴 때. 그 탭(parentId)의 그 슬롯(slot)에 속한 블럭만 흐름으로 삼고, 새로 만드는 블럭에는 parent_id·style.tab 을 찍는다.
// undo 스택은 세션 전역 하나(sync/history.ts)라 중첩 인스턴스·패널 문서의 조작도 시간순으로 한 줄에 쌓인다.
export function BlockDoc({ docId, db, subpages, props, files, recordings, inPeek, scope }: {
    docId: string; db: RwTable<BlockRow>; subpages: RwTable<SubpageRow>; props: RwTable<PagePropRow>; files: RoTable<FileRow>; recordings: RoTable<RecordingRow>;
    inPeek?: boolean; scope?: { parentId: string; slot: string };
}) {
    const rows = db.useRows().filter(r => r.doc_id === docId); // 핸들은 테이블 단위, 모듈은 문서 하나를 맡는다. 자식 조회(표의 칸 등)를 위해 문서 전체를 든다
    const sorted = rows // 이 인스턴스가 그리는 흐름. 자식(표의 칸·탭 안 블럭)은 부모가 그린다
        .filter(r => (scope ? r.parent_id === scope.parentId && r.style?.tab === scope.slot : !r.parent_id))
        .sort((a, b) => a.pos - b.pos);
    // 이 흐름에 새로 만드는 행. 탭 안이면 부모·슬롯을 찍는다
    const scoped = (row: BlockRow): BlockRow => (scope ? { ...row, parent_id: scope.parentId, style: { tab: scope.slot, ...row.style } } : row);
    const pages = subpages.useRows(); // 링크 블럭의 제목 표시용
    const propRows = props.useRows(); // 회의 보드가 회의록의 일시 속성을 읽는다
    const fileRows = files.useRows(); // 이미지·파일 블럭의 이름·크기 표시용
    const recRows = recordings.useRows(); // 녹음 블럭의 제목·상태 표시용
    const macroRows = table<MacroRow>('macros', 'ro').useRows(); // '/' 목록에 합쳐 보이는 사용자 매크로
    const navigate = useNavigate();
    const openPeek = useSidePeek(s => s.open);
    const peekPage = useSidePeek(s => s.openPage);
    const openPage = (id: string) => { if (inPeek) navigate(`/p/cowork/${docId}`); peekPage(id); };
    // 녹음 패널도 같은 자리를 쓴다. 패널 안 문서에서 녹음을 열면 그 문서를 본문으로 보내고 녹음이 패널에 뜬다
    const peekRecording = useSidePeek(s => s.openRecording);
    const openRecording = (id: string) => { if (inPeek) navigate(`/p/cowork/${docId}`); peekRecording(id); };
    // 회의 보드의 "새 회의" 생성 창도 같은 패널 자리를 쓴다. 생성은 MeetingForm 이 한 묶음으로 보내 전역 스택에 오른다
    const peekNewMeeting = useSidePeek(s => s.openNewMeeting);
    const openNewMeeting = (boardId: string) => {
        if (inPeek) navigate(`/p/cowork/${docId}`);
        peekNewMeeting(boardId);
    };
    const [activeTab, setActiveTab] = useState<Record<string, string>>({}); // 탭 블럭 id → 보고 있는 슬롯. 화면 상태라 동기화하지 않는다
    const [boardSettings, setBoardSettings] = useState<string | null>(null); // 설정 모달이 열린 회의 보드 블럭 id (템플릿 선택)
    const [buttonSettings, setButtonSettings] = useState<string | null>(null); // 설정 모달이 열린 매크로 버튼 블럭 id (이름표·매크로)
    // 편집 중(포커스된) 텍스트 블럭과 그 초안. 텍스트 블럭마다 에디터(MdEditor)가 항상 떠 있고, 포커스가 곧 편집 시작이다.
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    const editors = useRef(new Map<string, MdEditorHandle>()); // 블럭 id → 에디터 핸들 (캐럿 놓기용)
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()); // 접힌 토글 블럭 id. 화면(클라이언트) 상태이며 동기화·undo 대상이 아니다
    const isCollapsed = (r: BlockRow) => r.type === 'toggle' && collapsed.has(r.id);
    const dragId = useRef<string | null>(null);
    const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null); // 드래그 중 안내선 위치
    // 열려 있는 블럭 컨텍스트 메뉴. 손잡이 클릭이면 손잡이 아래에, 우클릭이면 at(마우스 좌표)에 뜬다.
    // cell 은 표의 칸 안에서 우클릭했을 때 그 칸 — 칸·행 단위 항목은 후속 티켓(table-styling)이 채운다.
    // line 은 표의 행·열 손잡이를 클릭해 연 메뉴 — 그 행·열의 삽입·삭제 항목만 보인다.
    const [menu, setMenu] = useState<{ id: string; cell?: string; line?: { kind: 'row' | 'col'; id: string }; at?: { x: number; y: number } } | null>(null);
    // 열려 있는 '/' 명령 메뉴. start 는 '/' 의 오프셋, filter 는 그 뒤에 이어 친 글자, sel 은 강조된 항목 번호
    const [slash, setSlash] = useState<{ id: string; start: number; filter: string; sel: number; top: number; left: number } | null>(null);
    const lastSentAt = useRef(0);
    const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 다음 렌더 후 에디터에 놓을 캐럿(원문 기준 오프셋). 이웃 블럭 진입·삽입·병합 이음새·꼬리 클릭에 쓴다.
    const pendingCaret = useRef<{ id: string; at: number } | null>(null);

    // 타이핑과 구조 조작(삽입·삭제·이동·배경색)이 세션 전역 undo/redo 스택(sync/history.ts)에 묶음 단위로 들어간다.
    // 구조 조작은 group(fn) 으로 한 묶음이 되고, 타이핑은 키 입력을 덩어리로 뭉쳤다가 입력 멈춤·구조 조작·undo 시점에 닫아 한 묶음으로 올린다.
    // 되돌리는 계산은 서버가 로그로 한다 — 여기서는 역연산을 들고 있지 않는다.
    const typingChunk = useRef<{ id: string; group: string } | null>(null);
    const textGroup = useRef<string | null>(null); // 마지막 타이핑 덩어리의 묶음. 덩어리가 닫힌 뒤 스로틀에 남아 있던 전송도 이 묶음에 붙는다 (서버가 amend)
    const chunkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTypingChunk = () => {
        if (chunkTimer.current) { clearTimeout(chunkTimer.current); chunkTimer.current = null; }
        const c = typingChunk.current;
        typingChunk.current = null;
        if (c) commit(c.group);
    };
    useEffect(() => onBeforeUndo(closeTypingChunk), []);

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
    // 편집 중인 블럭의 텍스트가 밖에서 바뀌면(남의 편집, 또는 서버가 내 전송을 남의 것과 병합한 결과) 그 차이를 초안에 합친다 — 서버와 같은 3-way 병합.
    // known 은 서버가 가졌다고 믿는 텍스트라, 내 전송의 echo 는 같아서 걸리지 않는다. 캐럿은 MdEditor 가 차이만 적용하며 옮긴다.
    useEffect(() => {
        if (!editing) return;
        const r = rows.find(x => x.id === editing.id);
        if (!r) return;
        if (known.current?.id !== editing.id) { known.current = { id: editing.id, text: r.text }; return; }
        const k = known.current.text;
        if (r.text === k) return;
        known.current = { id: editing.id, text: r.text };
        const merged = merge3(k, r.text, editing.draft);
        if (merged !== editing.draft) setEditing({ id: editing.id, draft: merged });
    }, [rows, editing]);

    // 편집 중 텍스트 전송. base 는 이 클라이언트가 마지막으로 보내거나 받은 그 블럭의 텍스트로, 서버가 남의 변경과 3-way 병합하는 기준이다.
    const known = useRef<{ id: string; text: string } | null>(null); // 편집 중인 블럭에 대해 서버가 가졌다고 믿는 텍스트
    const sendText = (id: string, text: string) => {
        const base = known.current?.id === id ? known.current.text : (readTable('blocks') as BlockRow[]).find(x => x.id === id)?.text ?? '';
        const g = textGroup.current ?? (textGroup.current = newGroup());
        run(g, () => db.update({ id, text }, base));
        if (typingChunk.current?.group !== g) commit(g); // 덩어리가 이미 닫힌 뒤의 스로틀 전송이면 지금 스택에 올린다 (닫힐 때 보낸 게 없었을 수 있다)
        known.current = { id, text };
        lastSentAt.current = Date.now();
    };
    const onDraft = (id: string, text: string) => {
        if (typingChunk.current?.id !== id) {
            closeTypingChunk();
            textGroup.current = newGroup();
            typingChunk.current = { id, group: textGroup.current };
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
        // 꼬리 클릭으로 만든 빈 블럭에서 아무것도 치지 않고 나가면 그 블럭을 거둔다 — 빈 흐름(탭 안 등)에 40px 공백과 사라진 placeholder 만 남지 않게.
        // 그때 쌓인 "빈 블럭 만들기" undo 항목도 함께 거둬 Ctrl+Z 가 무의미한 단계에 걸리지 않게 한다. 첫 blur 한 번만 본다.
        const blank = blankRef.current;
        blankRef.current = null;
        if (blank && r && r.id === blank.id && editing.draft === '') {
            run(blank.group, () => db.remove(r.id));
            dropGroup(blank.group);
            closeTypingChunk();
            setEditing(null);
            return;
        }
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
            const row: BlockRow = scoped({ id: rid(8), doc_id: docId, style: {}, ...b, pos: posBetween(out.at(-1) ?? prev, next) });
            out.push(row);
        }
        return out;
    };
    // 드롭 안내선 자리(두 블럭 사이)에 특수 블럭들을 끼운다. 텍스트를 나누지 않으므로 병합·분할이 없다.
    const insertBetween = (prev: BlockRow | undefined, next: BlockRow | undefined, blocks: NewBlock[]): BlockRow[] | null => {
        const specials = placeBetween(prev, next, blocks);
        if (!specials.length) return null;
        closeEdit();
        return group(() => {
            if (!db.insert(specials[0])) return null;
            for (const sp of specials.slice(1)) db.insert(sp);
            return specials;
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
        const newPos = posBetween(prev, next);
        closeTypingChunk();
        group(() => { db.update({ id, pos: newPos }); join?.apply(); });
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
        closeEdit();
        group(() => { db.insert(copy); cells.forEach(c => db.insert(c)); });
    };
    // 이미지 ↔ 파일 전환. 같은 파일을 다르게 보여 줄 뿐이라 type 만 바꾼다.
    const setType = (r: BlockRow, type: BlockRow['type']) => {
        group(() => db.update({ id: r.id, type }));
    };
    const renamePage = (page: SubpageRow) => {
        const title = prompt('페이지 이름', page.title);
        if (title === null || title === page.title) return;
        group(() => subpages.update({ id: page.id, title }));
    };
    const copyLink = (path: string) => navigator.clipboard.writeText(new URL(path, location.origin).href);
    const download = (f: FileRow) => { const a = document.createElement('a'); a.href = `/api/files/${f.id}?download`; a.download = f.name; a.click(); };
    const setBg = (r: BlockRow, bg?: string) => {
        group(() => db.update({ id: r.id, style: { ...r.style, bg } })); // style 컬럼은 JSON 통째로 교체된다
    };
    // 여러 블럭의 style 을 한 번에 고치고 하나의 undo 항목으로 묶는다 (표의 헤더·열 너비, 칸·행의 배경·정렬).
    const patchStyle = (targets: BlockRow[], patch: Partial<BlockStyle>) => {
        group(() => targets.forEach(r => db.update({ id: r.id, style: { ...r.style, ...patch } })));
    };
    // 특수 블럭 삭제. 앞뒤가 텍스트면 자동으로 병합해 흐름을 복원한다.
    // 자식(표의 칸·탭 안 블럭)과 참조 행(서브페이지와 그 본문, 녹음)은 서버가 같은 묶음으로 연쇄 삭제하므로 undo 가 전부 되살린다.
    const removeBlock = (r: BlockRow) => {
        const page = isPageLink(r) ? pages.find(p => p.id === r.ref) : undefined;
        if (page && !confirm(`서브페이지 "${pageTitle(page)}" 와 그 내용이 함께 삭제됩니다. 계속할까요? (Ctrl+Z 로 되돌릴 수 있습니다)`)) return;
        const i = sorted.findIndex(x => x.id === r.id);
        const join = planJoin(sorted[i - 1], sorted[i + 1]);
        closeTypingChunk();
        group(() => { db.remove(r.id); join?.apply(); });
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
    const blankRef = useRef<{ id: string; group: string } | null>(null); // 꼬리 클릭으로 방금 만든 빈 블럭 (closeEdit 이 거둘 후보)
    const appendText = () => {
        const row: BlockRow = scoped({ id: rid(8), doc_id: docId, text: '', pos: posBetween(sorted.at(-1)), style: {} });
        closeTypingChunk();
        const g = newGroup();
        if (run(g, () => db.insert(row))) {
            commit(g);
            pendingCaret.current = { id: row.id, at: 0 };
            setEditing({ id: row.id, draft: '' });
            blankRef.current = { id: row.id, group: g };
        }
    };
    // 캐럿 위치에 특수 블럭(들)을 꽂는다. draft 에서 '/'와 필터([start, end))를 지운 텍스트를 start 에서 앞·뒤로 나누고 그 사이에 넣는다.
    // 붙여넣기는 지울 구간이 없으므로 start = end 로 부른다.
    // 앞쪽이 비면 앞 텍스트 블럭을 만들지 않고 현재 블럭이 뒤쪽이 된다. 뒤쪽은 비어도 남겨서 캐럿을 두고 계속 입력하게 한다.
    // 나뉘는 자리의 개행(앞쪽 끝·뒤쪽 첫 개행) 하나씩은 거둔다 — 특수 블럭이 그 줄 자리를 차지하므로 빈 줄이 남지 않게.
    // 텍스트 블럭이 섞여 있으면(템플릿 넣기) 텍스트 병합 불변식을 지킨다: 맨 앞의 텍스트들은 앞쪽에, 맨 뒤의 텍스트들은 뒤쪽에 개행으로 이어 붙이고,
    // 특수 블럭 사이에 낀 텍스트만 따로 블럭이 된다. 특수 블럭이 하나도 없으면 현재 블럭의 텍스트만 바뀐다 (반환은 빈 배열).
    const insertSpecialAt = (r: BlockRow, draft: string, start: number, end: number, blocks: NewBlock[]): BlockRow[] | null => {
        if (!blocks.length) return null;
        let before = draft.slice(0, start), after = draft.slice(end);
        if (before.endsWith('\n')) before = before.slice(0, -1);
        if (after.startsWith('\n')) after = after.slice(1);
        const isTextBlock = (b: NewBlock) => (b.type ?? 'text') === 'text';
        const rest = [...blocks];
        let trail = '';
        while (rest.length && isTextBlock(rest[0])) before = joinText(before, rest.shift()!.text);
        while (rest.length && isTextBlock(rest.at(-1)!)) trail = joinText(rest.pop()!.text, trail);
        after = joinText(trail, after);
        if (!rest.length) {
            const text = joinText(before, after);
            closeEdit();
            if (!group(() => db.update({ id: r.id, text }))) return null;
            known.current = { id: r.id, text };
            editAt({ ...r, text }, before.length);
            return [];
        }
        const i = sorted.findIndex(x => x.id === r.id);
        const tail: BlockRow | null = before ? scoped({ id: rid(8), doc_id: docId, text: after, pos: 0, style: {} }) : null;
        // tail 이 있으면 r(앞) · specials · tail(뒤), 없으면 specials · r(뒤)
        const specials = placeBetween(tail ? sorted[i] : sorted[i - 1], tail ? sorted[i + 1] : sorted[i], rest);
        if (tail) tail.pos = posBetween(specials.at(-1), sorted[i + 1]);
        const firstText = tail ? before : after;
        closeEdit(); // 스로틀에 걸려 있던 초안과 타이핑 덩어리를 먼저 확정한다
        const ok = group(() => {
            if (!db.update({ id: r.id, text: firstText })) return false;
            for (const sp of specials) db.insert(sp);
            if (tail) db.insert(tail);
            return true;
        });
        if (!ok) return null;
        known.current = { id: r.id, text: firstText };
        editAt(tail ?? { ...r, text: after }, trail.length); // 뒤에 이어 붙인 템플릿 텍스트의 끝에 캐럿
        return specials;
    };
    // 매크로 버튼 실행. '/' 와 달리 캐럿이 없으므로 결과 블럭은 버튼 바로 아래에 들어가고, 마크다운 명령(할 일·구분선)은 아래 텍스트 블럭의 첫 줄에 넣는다(없으면 새 텍스트 블럭).
    const runButton = (b: BlockRow) => {
        const i = sorted.findIndex(x => x.id === b.id);
        const next = sorted[i + 1];
        const insert = (block: NewBlock | NewBlock[]) => insertBetween(b, next, Array.isArray(block) ? block : [block]);
        const ctx: SlashContext = {
            docId, db, pages, subpages, props, navigate, insert,
            edit: target => editAt(target, 0),
            insertMarkup: markup => {
                if (next && isText(next)) { const text = joinText(markup, next.text); group(() => db.update({ id: next.id, text })); known.current = { id: next.id, text }; editAt({ ...next, text }, markup.length); }
                else { const [row] = insert({ type: 'text', text: markup }) ?? []; if (row) editAt(row, markup.length); }
            },
            openRecording,
        };
        closeEdit();
        const cmd = BUTTON_COMMANDS.find(c => commandId(c) === b.ref);
        if (cmd) { void group(() => cmd.run(ctx)); return; } // 동기 부분(행 만들기 + 블럭 꽂기)이 한 묶음. 업로드 뒤의 꽂기는 그 자체로 묶음이 된다
        const m = macroRows.find(x => x.id === b.ref);
        if (!m) { setButtonSettings(b.id); return; } // 매크로가 없으면 설정을 연다
        const err = group(() => runMacro(m, { docId, vars: {}, blocks: db, subpages, props, navigate, insertAt: insert }));
        if (err) alert(err);
    };
    const runSlash = (cmd: SlashCommand) => {
        if (!slash || !editing || slash.id !== editing.id) return;
        const r = rows.find(x => x.id === slash.id);
        if (!r) return;
        const { draft } = editing;
        const start = slash.start, end = start + 1 + slash.filter.length;
        setSlash(null);
        void group(() => cmd.run({ // 동기 부분(행 만들기 + 블럭 꽂기)이 한 묶음. 업로드 뒤의 꽂기는 그 자체로 묶음이 된다
            docId, db, pages, subpages, props, navigate,
            insert: block => insertSpecialAt(r, draft, start, end, Array.isArray(block) ? block : [block]),
            edit: target => editAt(target, 0),
            insertMarkup: (markup, line) => {
                const view = editors.current.get(r.id)?.view;
                if (!view) return;
                const lineStart = draft.lastIndexOf('\n', start - 1) + 1;
                const insert = (start > lineStart ? '\n' : '') + markup + (line ? '\n' : '');
                view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length } });
            },
            openRecording,
        }));
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
        group(() => db.update({ id: r.id, style: { ...r.style, icon } }));
    };

    // ── 표 ───────────────────────────────────────────────
    // 표의 구조 변경은 표 블럭의 style(rows·cols)과 칸 블럭의 삽입·삭제를 한 undo 항목으로 묶는다.
    const cellsOf = (t: BlockRow) => rows.filter(c => c.parent_id === t.id);
    const tableOp = (t: BlockRow, next: Pick<BlockStyle, 'rows' | 'cols' | 'widths'>, add: BlockRow[], del: BlockRow[]) => {
        closeEdit();
        group(() => { db.update({ id: t.id, style: { ...t.style, ...next } }); add.forEach(c => db.insert(c)); del.forEach(c => db.remove(c.id)); });
    };
    const nextCellPos = (t: BlockRow) => Math.max(0, ...cellsOf(t).map(c => c.pos));
    const splice = (list: string[], at: number, id: string) => [...list.slice(0, at), id, ...list.slice(at)]; // at 자리에 끼운 새 배열
    // at 은 끼워 넣을 자리(그 번호 앞). 없으면 끝에 붙인다.
    const addRow = (t: BlockRow, at?: number) => {
        const row = rid(4), tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        tableOp(t, { rows: splice(tr, at ?? tr.length, row) }, makeCells(t.id, docId, [row], cols, nextCellPos(t)), []);
    };
    const addCol = (t: BlockRow, at?: number) => {
        const col = rid(4), tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        tableOp(t, { cols: splice(cols, at ?? cols.length, col) }, makeCells(t.id, docId, tr, [col], nextCellPos(t)), []);
    };
    // 행·열 순서 바꾸기: 표 블럭의 rows·cols 만 바뀌고 칸은 그대로다.
    const moveLine = (t: BlockRow, kind: 'row' | 'col', id: string, to: string) => {
        const key = kind === 'row' ? 'rows' : 'cols';
        const list = t.style?.[key] ?? [];
        const from = list.indexOf(id), dest = list.indexOf(to);
        if (from < 0 || dest < 0 || from === dest) return;
        patchStyle([t], { [key]: splice(list.filter(x => x !== id), dest, id) });
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
        const widths = { ...t.style?.widths }; delete widths[col]; // 지운 열의 너비도 함께 버린다
        tableOp(t, { cols: cols.filter(x => x !== col), widths }, [], cellsOf(t).filter(c => c.style?.col === col));
    };
    // 슬롯에 칸 블럭이 없으면(동시 편집 경계) 만들어서 편집을 연다. 있으면 그 끝에서 편집한다.
    const editCell = (t: BlockRow, row: string, col: string) => {
        setSel({ table: t.id, anchor: { row, col }, head: { row, col } });
        const c = cellsOf(t).find(x => x.style?.row === row && x.style?.col === col);
        if (c) { editAt(c, c.text.length); return; }
        const [made] = makeCells(t.id, docId, [row], [col], nextCellPos(t));
        if (group(() => db.insert(made))) editAt(made, 0);
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

    // ── 탭 ───────────────────────────────────────────────
    // 탭 구조 변경은 탭 블럭의 style.tabs 만 바꾼다 (patchStyle 이 undo 를 기록). 탭 삭제는 그 슬롯의 자식 블럭도 함께 지우고 undo 로 되살린다.
    const tabsOf = (t: BlockRow) => t.style?.tabs ?? [];
    const addTab = (t: BlockRow) => {
        const tab = { id: rid(4), label: `탭 ${tabsOf(t).length + 1}` };
        patchStyle([t], { tabs: [...tabsOf(t), tab] });
        setActiveTab(a => ({ ...a, [t.id]: tab.id }));
    };
    const renameTab = (t: BlockRow, id: string) => {
        const cur = tabsOf(t).find(x => x.id === id);
        const label = prompt('탭 이름', cur?.label ?? '')?.trim();
        if (!cur || !label || label === cur.label) return;
        patchStyle([t], { tabs: tabsOf(t).map(x => (x.id === id ? { ...x, label } : x)) });
    };
    const delTab = (t: BlockRow, id: string) => {
        const tabs = tabsOf(t);
        if (tabs.length <= 1) return removeBlock(t); // 마지막 탭을 지우면 탭 블럭 자체를 지운다
        const children = rows.filter(x => x.parent_id === t.id && x.style?.tab === id).map(x => ({ ...x }));
        if (children.length && !confirm('이 탭과 그 안의 블럭을 삭제합니다. 계속할까요?')) return;
        closeEdit();
        group(() => { db.update({ id: t.id, style: { ...t.style, tabs: tabs.filter(x => x.id !== id) } }); children.forEach(c => db.remove(c.id)); });
    };

    // ── 회의 보드 ────────────────────────────────────────
    // 회의록 삭제는 행·본문·속성의 실제 삭제이고, 서버 로그의 되감기가 내용째 되살린다 (undo-model 2026-09-08)
    const removeMeeting = (p: SubpageRow) => { group(() => subpages.remove(p.id)); };

    type MenuItem = { label: string; icon: string; danger?: boolean; run: () => void };

    // ── 칸 선택 ─────────────────────────────────────────
    // 칸을 클릭하면 편집(캐럿)과 함께 그 칸이 선택되고, 끌면 같은 표 안에서 직사각형 범위가 선택된다. 로컬 상태라 저장·동기화하지 않는다.
    // 우클릭 메뉴의 칸 서식(배경·정렬)은 이 선택에 적용된다. 표 밖(메뉴 제외)을 누르면 풀린다.
    type Slot = { row: string; col: string };
    const [sel, setSel] = useState<{ table: string; anchor: Slot; head: Slot } | null>(null);
    const selRect = (t: BlockRow) => { // 선택이 이 표에 있으면 그 범위의 (행 목록, 열 목록)
        if (!sel || sel.table !== t.id) return null;
        const tr = t.style?.rows ?? [], cols = t.style?.cols ?? [];
        const [r1, r2] = [tr.indexOf(sel.anchor.row), tr.indexOf(sel.head.row)].sort((a, b) => a - b);
        const [c1, c2] = [cols.indexOf(sel.anchor.col), cols.indexOf(sel.head.col)].sort((a, b) => a - b);
        if (r1 < 0 || c1 < 0) return null;
        return { rows: tr.slice(r1, r2 + 1), cols: cols.slice(c1, c2 + 1) };
    };
    // 선택된 칸의 표시: 파란 기운 + 범위 둘레에만 테두리(칸마다 두르면 격자처럼 보인다)
    const selStyle = (t: BlockRow, row: string, col: string): CSSProperties | undefined => {
        const q = selRect(t);
        if (!q || !q.rows.includes(row) || !q.cols.includes(col)) return undefined;
        const edge = [
            row === q.rows[0] && 'inset 0 1.5px 0 var(--c-bluBacAccPri)', row === q.rows.at(-1) && 'inset 0 -1.5px 0 var(--c-bluBacAccPri)',
            col === q.cols[0] && 'inset 1.5px 0 0 var(--c-bluBacAccPri)', col === q.cols.at(-1) && 'inset -1.5px 0 0 var(--c-bluBacAccPri)',
        ].filter(Boolean).join(', ');
        return { backgroundImage: 'linear-gradient(rgba(35,131,226,.10), rgba(35,131,226,.10))', boxShadow: edge || undefined };
    };
    const inSel = (t: BlockRow, row: string, col: string) => { const q = selRect(t); return !!q && q.rows.includes(row) && q.cols.includes(col); };
    const selCells = (t: BlockRow) => { const q = selRect(t); return q ? cellsOf(t).filter(c => q.rows.includes(c.style?.row ?? '') && q.cols.includes(c.style?.col ?? '')) : []; };
    // 칸에서 누르기 시작: 왼쪽 버튼은 그 칸을 선택하고 끌면 범위를 넓힌다. 오른쪽 버튼은 선택 밖의 칸이면 그 칸만 선택한다(선택 안이면 유지).
    const startSelect = (e: ReactPointerEvent<HTMLElement>, t: BlockRow, row: string, col: string) => {
        if (e.button === 2) { if (!inSel(t, row, col)) setSel({ table: t.id, anchor: { row, col }, head: { row, col } }); return; }
        if (e.button !== 0) return;
        setSel({ table: t.id, anchor: { row, col }, head: { row, col } });
        let multi = false;
        const move = (ev: PointerEvent) => {
            const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('td[data-cell-table]');
            if (!td || td.dataset['cellTable'] !== t.id) return;
            const head = { row: td.dataset['row']!, col: td.dataset['col']! };
            if (head.row === row && head.col === col) { if (multi) setSel(s => (s ? { ...s, head } : s)); return; }
            // 다른 칸으로 넘어가면 텍스트 선택이 아니라 칸 선택이다: 에디터의 캐럿을 거두고 브라우저 선택도 지운다
            if (!multi) { multi = true; closeEdit(); (document.activeElement as HTMLElement | null)?.blur(); }
            window.getSelection()?.removeAllRanges();
            setSel(s => (s ? { ...s, head } : s));
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    useEffect(() => {
        if (!sel) return;
        const onDown = (e: PointerEvent) => {
            const el = e.target as HTMLElement | null;
            if (el?.closest(`td[data-cell-table="${sel.table}"]`) || el?.closest('.block-menu')) return;
            setSel(null);
        };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [sel]);

    // 행·열 손잡이: 끌면 그 행·열이 놓은 자리로 옮겨지고, 움직이지 않고 놓으면 그 행·열의 메뉴가 열린다.
    // 끄는 동안은 마우스 아래 칸의 행·열(over)만 로컬 상태로 표시하고, 놓을 때 한 번 저장한다.
    const [lineDrag, setLineDrag] = useState<{ table: string; kind: 'row' | 'col'; id: string; over: string } | null>(null);
    const startLine = (e: ReactPointerEvent<HTMLElement>, t: BlockRow, kind: 'row' | 'col', id: string) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const at = { x: e.clientX, y: e.clientY };
        let over = id, moved = false;
        const move = (ev: PointerEvent) => {
            if (!moved && Math.abs(ev.clientX - at.x) + Math.abs(ev.clientY - at.y) < 4) return;
            moved = true;
            const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('td[data-cell-table]');
            if (!td || td.dataset['cellTable'] !== t.id) return;
            over = td.dataset[kind]!;
            setLineDrag({ table: t.id, kind, id, over });
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setLineDrag(null);
            if (moved) moveLine(t, kind, id, over);
            else setMenu({ id: t.id, line: { kind, id }, at });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    // 행·열 메뉴 항목: 앞·뒤 삽입과 삭제
    const lineItems = (t: BlockRow, line: { kind: 'row' | 'col'; id: string }): MenuItem[][] => {
        const row = line.kind === 'row';
        const i = (row ? t.style?.rows : t.style?.cols)?.indexOf(line.id) ?? -1;
        const add = row ? addRow : addCol;
        return [
            [
                { label: row ? '위에 행 삽입' : '왼쪽에 열 삽입', icon: row ? '↑' : '←', run: () => add(t, i) },
                { label: row ? '아래에 행 삽입' : '오른쪽에 열 삽입', icon: row ? '↓' : '→', run: () => add(t, i + 1) },
            ],
            [{ label: row ? '행 삭제' : '열 삭제', icon: '✕', danger: true, run: () => (row ? delRow : delCol)(t, line.id) }],
        ];
    };

    // 열 너비 드래그. 끄는 동안은 로컬 상태로만 그리고, 놓을 때 표 블럭의 style.widths 에 한 번 저장한다(undo 항목 하나).
    const [resizing, setResizing] = useState<{ table: string; col: string; width: number } | null>(null);
    const startResize = (e: ReactPointerEvent<HTMLElement>, t: BlockRow, col: string) => {
        e.preventDefault();
        e.stopPropagation();
        const cellEl = e.currentTarget.parentElement as HTMLElement; // 손잡이가 든 조작줄 칸 = 그 열
        const startX = e.clientX, startW = cellEl.getBoundingClientRect().width;
        let width = startW;
        const move = (ev: PointerEvent) => { width = Math.max(40, Math.round(startW + ev.clientX - startX)); setResizing({ table: t.id, col, width }); };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setResizing(null);
            if (width !== startW) patchStyle([t], { widths: { ...t.style?.widths, [col]: width } });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ── 블럭 컨텍스트 메뉴 ───────────────────────────────
    // 항목은 공통(복제·이동·삭제) + 타입별로 구성한다. 새 블럭 타입은 TYPE_ITEMS 에 키를 추가하면 된다 (예: 녹음 블럭).
    // 배경색은 항목이 아니라 메뉴 위쪽의 색 줄로 그린다. 각 항목의 조작은 record 로 undo 스택에 개별 항목으로 들어간다.
    const fileOf = (r: BlockRow) => fileRows.find(x => x.id === r.ref);
    // 표의 칸 안에서 우클릭하면 칸·행 단위 배경·정렬 줄이 메뉴 위쪽(색 줄 아래)에 따로 그려진다 — 항목이 아니라 색 점·정렬 버튼 줄이라 여기 없다.
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
        tabs: r => [{ label: '탭 추가', icon: '＋', run: () => addTab(r) }],
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
        button: r => [{ label: '버튼 설정', icon: '⚙', run: () => setButtonSettings(r.id) }],
        toggle: r => [isCollapsed(r) ? { label: '펼치기', icon: '▾', run: () => setOpen(r, true) } : { label: '접기', icon: '▸', run: () => setOpen(r, false) }],
        table: r => [
            { label: r.style?.header ? '헤더 행 해제' : '헤더 행 강조', icon: '▀', run: () => patchStyle([r], { header: !r.style?.header }) },
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
                ...(!isPageLink(r) ? [{ label: '복제', icon: '⧉', run: () => duplicateBlock(r) }] : []),
                ...(i > 0 ? [{ label: '위로 이동', icon: '↑', run: () => moveBlock(r, -1) }] : []),
                ...(i < sorted.length - 1 ? [{ label: '아래로 이동', icon: '↓', run: () => moveBlock(r, 1) }] : []),
            ],
            [{ label: '블럭 삭제', icon: '✕', danger: true, run: () => removeBlock(r) }],
        ].filter(g => g.length);
    };
    // 메뉴 위쪽의 색 점 줄과 정렬 버튼 줄. 고르면 메뉴를 닫는다. undefined 는 '없음'(기본값으로 되돌림).
    const colorRow = (label: string, pick: (bg?: string) => void) => (
        <div className="flex items-center gap-1.5 px-1 py-1">
            <span className="text-[var(--c-texSec)] w-16 shrink-0">{label}</span>
            {BG_COLORS.map(c => (
                <button
                    key={c || 'none'}
                    className="bg-dot w-5 h-5 rounded-full border border-black/20 cursor-pointer"
                    style={{ background: c || '#ffffff' }}
                    title={c || '배경 없음'}
                    onClick={() => { pick(c || undefined); setMenu(null); }}
                />
            ))}
        </div>
    );
    const ALIGNS: { align?: BlockStyle['align']; icon: string; title: string }[] = [
        { align: undefined, icon: '⇤', title: '왼쪽 정렬(기본)' }, { align: 'center', icon: '↔', title: '가운데 정렬' }, { align: 'right', icon: '⇥', title: '오른쪽 정렬' },
    ];
    const alignRow = (label: string, pick: (align?: BlockStyle['align']) => void) => (
        <div className="flex items-center gap-1.5 px-1 py-1">
            <span className="text-[var(--c-texSec)] w-16 shrink-0">{label}</span>
            {ALIGNS.map(a => (
                <button
                    key={a.title}
                    className="align-btn w-6 h-6 rounded border border-[var(--c-borPri)] cursor-pointer hover:bg-[var(--ca-bacIntTra)] leading-none"
                    title={a.title}
                    onClick={() => { pick(a.align); setMenu(null); }}
                >{a.icon}</button>
            ))}
        </div>
    );
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
        const matched = slash?.id === r.id ? matchCommands(slash.filter, macroRows) : [];
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
                        closeTypingChunk();
                        group(() => db.update({ id: r.id, text: t }, prev));
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
        <div>
            {sorted.map(r => {
                const isEditing = editing?.id === r.id;
                const text = isText(r);
                const matched = slash?.id === r.id ? matchCommands(slash.filter, macroRows) : [];
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
                        {/* 흐름이 빈 텍스트 블럭 하나뿐이면 placeholder 를 그 위에 겹쳐 보인다 (꼬리의 placeholder 는 블럭이 하나도 없을 때만 나온다) */}
                        {text && sorted.length === 1 && (isEditing ? editing.draft : r.text) === '' && (
                            <span className="absolute left-[38px] top-[9.5px] text-[14px] leading-[1.5] text-[var(--c-texTer)] pointer-events-none select-none">{PLACEHOLDER}</span>
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
                                    className={`block-menu z-40 bg-white border border-[var(--c-borPri)] rounded-md shadow-md p-1.5 text-[16px] whitespace-normal cursor-default w-max min-w-40 ${menu.at ? 'fixed' : 'absolute left-1 top-8'}`}
                                    // 우클릭 메뉴는 마우스 자리에 두되 화면 밖으로 나가지 않게 당긴다
                                    style={menu.at ? { left: Math.min(menu.at.x, window.innerWidth - 200), top: Math.max(0, Math.min(menu.at.y, window.innerHeight - (menu.line ? 140 : 340))) } : undefined}
                                    onClick={e => e.stopPropagation()}
                                    onContextMenu={e => e.preventDefault()}
                                >
                                    {/* 블럭 배경. 표는 칸 배경으로 대신하므로 없다(표 상자에도 칠하지 않는다) */}
                                    {r.type !== 'table' && colorRow('배경', bg => setBg(r, bg))}
                                    {/* 표의 칸에서 열었으면 선택된 칸(끌어서 고른 범위 전부)의 배경·정렬 줄. 한 undo 항목으로 묶인다 */}
                                    {menu.cell && selCells(r).length > 0 && (
                                        <>
                                            {colorRow('칸 배경', bg => patchStyle(selCells(r), { bg }))}
                                            {alignRow('칸 정렬', align => patchStyle(selCells(r), { align }))}
                                        </>
                                    )}
                                    {(menu.line ? lineItems(r, menu.line) : menuGroups(r, menu.cell ? rows.find(x => x.id === menu.cell) : undefined)).map((group, gi) => (
                                        // 구분선은 묶음 사이와, 위에 색·정렬 줄이 있을 때만 (표 손잡이 메뉴는 위에 아무 줄도 없다)
                                        <div key={gi} className={gi > 0 || r.type !== 'table' || menu.cell ? 'border-t border-[var(--c-borPri)] pt-1 mt-1' : ''}>
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
                        <div className="rounded-md px-2 py-0.5" style={{ background: r.type === 'table' ? undefined : r.style?.bg }}>
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
                                // 표: 행·열 순서는 표 블럭의 style, 내용은 자식 칸 블럭.
                                // 표에 마우스를 올리면 각 열 위·각 행 왼쪽에 손잡이(끌어 이동·클릭해 메뉴), 아래·오른쪽에 표 너비·높이 전체의 + 막대(행·열 추가)가 보인다.
                                const tr = r.style?.rows ?? [], cols = r.style?.cols ?? [];
                                const cells = cellsOf(r);
                                // 열 너비: 저장값(style.widths) 위에 드래그 중인 열의 임시값을 덮는다
                                const widthOf = (col: string) => (resizing?.table === r.id && resizing.col === col ? resizing.width : r.style?.widths?.[col]);
                                const dragging = lineDrag?.table === r.id ? lineDrag : null; // 손잡이를 끄는 중이면 놓일 행·열을 파랗게 표시
                                const show = 'opacity-0 group-hover/table:opacity-100'; // 표에 마우스를 올려야 보이는 조작 요소
                                const pill = `absolute z-10 rounded-full bg-[var(--c-borPri)] hover:bg-[var(--c-icoSec)] cursor-grab ${show}`;
                                const bar = `flex items-center justify-center rounded text-[var(--c-texTer)] bg-[var(--c-graBacSec)] hover:bg-[var(--ca-bacIntTra)] cursor-pointer select-none ${show}`;
                                return ( // 좁은 화면에서는 표만 가로로 스크롤한다. 안쪽 여백은 손잡이·+ 막대가 표 밖으로 삐져나올 자리다
                                    <div className="overflow-x-auto">
                                    <div className="group/table relative w-max mx-auto pt-3 pl-3 pr-5 pb-5 my-1">
                                    <table className="border-collapse text-[14px] leading-[1.5] whitespace-pre-wrap">
                                        <colgroup>{cols.map(col => <col key={col} style={{ width: widthOf(col) }} />)}</colgroup>
                                        <tbody>
                                            {tr.map((row, ri) => (
                                                <tr key={row}>
                                                    {cols.map((col, ci) => {
                                                        const c = cells.find(x => x.style?.row === row && x.style?.col === col);
                                                        const header = ri === 0 && r.style?.header; // 헤더 행: 굵게 + 연회색. 칸에 배경색이 있으면 그 색이 이긴다
                                                        const selected = selStyle(r, row, col);
                                                        const dropHere = dragging && (dragging.kind === 'row' ? dragging.over === row : dragging.over === col) && dragging.over !== dragging.id;
                                                        return (
                                                            <td
                                                                key={col}
                                                                data-cell-table={r.id} data-row={row} data-col={col}
                                                                className={`relative border border-[var(--c-borPri)] align-top px-2 py-1 min-w-[96px] cursor-text ${header ? 'font-semibold' : ''} ${selected ? 'cell-selected' : ''}`}
                                                                style={{
                                                                    background: c?.style?.bg ?? (header ? 'var(--c-graBacSec)' : undefined), textAlign: c?.style?.align,
                                                                    ...selected,
                                                                    ...(dropHere ? { boxShadow: 'inset 0 0 0 1.5px var(--c-bluBacAccPri)' } : {}),
                                                                }}
                                                                onPointerDown={e => startSelect(e, r, row, col)}
                                                                onClick={e => { if (!(e.target as HTMLElement).closest('.cm-editor')) editCell(r, row, col); }}
                                                                onContextMenu={e => openMenuAt(e, r.id, c?.id)}
                                                            >
                                                                {/* 첫 행 칸 위에는 열 손잡이와 열 오른쪽 경계의 너비 손잡이, 첫 열 칸 왼쪽에는 행 손잡이 */}
                                                                {ri === 0 && <span className={`${pill} -top-2.5 left-1/2 -translate-x-1/2 h-1.5 w-6`} title="끌어서 열 이동 · 클릭하면 메뉴" onPointerDown={e => startLine(e, r, 'col', col)} onClick={e => e.stopPropagation()} />}
                                                                {ri === 0 && <span className="col-resize absolute z-10 -right-1 top-0 bottom-0 w-2 cursor-col-resize" title="열 너비 조절" onPointerDown={e => { e.stopPropagation(); startResize(e, r, col); }} onClick={e => e.stopPropagation()} />}
                                                                {ci === 0 && <span className={`${pill} -left-2.5 top-1/2 -translate-y-1/2 w-1.5 h-6`} title="끌어서 행 이동 · 클릭하면 메뉴" onPointerDown={e => startLine(e, r, 'row', row)} onClick={e => e.stopPropagation()} />}
                                                                {c ? editor(c) : ' '}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className={`${bar} absolute left-3 right-5 bottom-1 h-3.5 text-xs leading-none`} title="행 추가" onClick={() => addRow(r)}>+</div>
                                    <div className={`${bar} absolute top-3 bottom-5 right-1 w-3.5 text-xs leading-none`} title="열 추가" onClick={() => addCol(r)}>+</div>
                                    </div>
                                    </div>
                                );
                            })() : isPageLink(r) ? (() => {
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
                            })() : r.type === 'tabs' ? (() => {
                                // 탭 블럭: 탭 줄(클릭 전환·더블클릭 이름 바꾸기·× 삭제·+ 추가) 아래에 보고 있는 슬롯의 중첩 흐름을 그린다.
                                const tabs = tabsOf(r);
                                const cur = tabs.find(t => t.id === activeTab[r.id]) ?? tabs[0];
                                return (
                                    <div className="rounded-md border border-[var(--c-borPri)]">
                                        <div className="flex items-center gap-0.5 px-1 border-b border-[var(--c-borPri)] text-[14px] overflow-x-auto overflow-y-hidden">
                                            {tabs.map(t => (
                                                <span
                                                    key={t.id}
                                                    className={`group/tab flex items-center gap-1 px-2.5 py-1.5 -mb-px border-b-2 cursor-pointer select-none whitespace-nowrap ${
                                                        cur?.id === t.id ? 'border-[var(--c-texPri)] text-[var(--c-texPri)] font-medium' : 'border-transparent text-[var(--c-texSec)] hover:text-[var(--c-texPri)]'}`}
                                                    onClick={() => setActiveTab(a => ({ ...a, [r.id]: t.id }))}
                                                    onDoubleClick={() => renameTab(r, t.id)}
                                                    title="더블클릭: 이름 바꾸기"
                                                >
                                                    {t.label}
                                                    <button className="opacity-0 group-hover/tab:opacity-100 px-0.5 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="탭 삭제" onClick={e => { e.stopPropagation(); delTab(r, t.id); }}>×</button>
                                                </span>
                                            ))}
                                            <button className="px-2 py-1 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="탭 추가" onClick={() => addTab(r)}>＋</button>
                                        </div>
                                        {cur && (
                                            // 이 흐름의 드래그·드롭 이벤트가 바깥 블럭(탭 블럭 자신)의 안내선·파일 드롭으로 새지 않게 막는다
                                            <div key={cur.id} className="px-6 py-1" onDragOver={e => e.stopPropagation()} onDrop={e => e.stopPropagation()}>
                                                <BlockDoc docId={docId} db={db} subpages={subpages} props={props} files={files} recordings={recordings} inPeek={inPeek} scope={{ parentId: r.id, slot: cur.id }} />
                                            </div>
                                        )}
                                    </div>
                                );
                            })() : r.type === 'meetings' ? (() => {
                                // 회의 보드: 이 보드(ref) 에 속한 회의록을 속성 '일시' 로 나눠 보인다 — 다가오는 회의(오늘 0시 이후, 가까운 순)와 전체 목록(최신순).
                                // 항목 클릭은 패널, Alt+클릭은 이동. × 는 삭제 표시(undo 가능). "새 회의" 는 오른쪽 패널의 생성 창을 연다.
                                const heldAt = (p: SubpageRow) => propTime(propRows, p.id, '일시');
                                const mine = pages.filter(p => p.kind === 'meeting' && p.board_id === r.ref);
                                const today = new Date(); today.setHours(0, 0, 0, 0);
                                const upcoming = mine.filter(p => (heldAt(p) ?? -1) >= today.getTime()).sort((a, b) => heldAt(a)! - heldAt(b)!);
                                const all = [...mine].sort((a, b) => (heldAt(b) ?? b.created_at ?? 0) - (heldAt(a) ?? a.created_at ?? 0));
                                const item = (p: SubpageRow) => {
                                    const t = heldAt(p);
                                    return (
                                        <div key={p.id} className="group/item flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)] text-[14px]">
                                            <Link
                                                to={`/p/cowork/${p.id}`}
                                                className="flex-1 min-w-0 truncate cursor-pointer"
                                                title="클릭: 패널에서 열기 · Alt+클릭: 페이지로 이동"
                                                onClick={e => { if (e.altKey) { e.preventDefault(); navigate(`/p/cowork/${p.id}`); } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); openPage(p.id); } }}
                                            >📄 {pageTitle(p)}</Link>
                                            <span className="shrink-0 text-[12px] text-[var(--c-texTer)] font-mono tabular-nums">{t !== null ? fmtDateTime(t) : '일시 없음'}</span>
                                            <button className="shrink-0 opacity-0 group-hover/item:opacity-100 px-1 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="회의록 삭제 (Ctrl+Z 로 되돌릴 수 있음)" onClick={() => removeMeeting(p)}>×</button>
                                        </div>
                                    );
                                };
                                return (
                                    <div className="rounded-md border border-[var(--c-borPri)] p-3 flex flex-col gap-3 select-none">
                                        <div className="flex items-center gap-2">
                                            <span className="flex-1 text-[15px] font-medium">📅 회의</span>
                                            <button className="h-7 w-7 rounded-md text-[15px] cursor-pointer bg-transparent! text-[var(--c-texTer)] hover:bg-[var(--ca-bacIntTra)]! hover:text-[var(--c-texPri)]" title="보드 설정" aria-label="보드 설정" onClick={() => setBoardSettings(r.id)}>⚙</button>
                                            <button className="h-7 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95" onClick={() => openNewMeeting(r.ref!)}>새 회의</button>
                                        </div>
                                        <div>
                                            <div className="px-2 pb-1 text-[12px] font-medium text-[var(--c-texTer)]">다가오는 회의</div>
                                            {upcoming.length ? upcoming.map(item) : <div className="px-2 py-1 text-[13px] text-[var(--c-texTer)]">예정된 회의가 없습니다</div>}
                                        </div>
                                        <div>
                                            <div className="px-2 pb-1 text-[12px] font-medium text-[var(--c-texTer)]">회의록</div>
                                            {all.length ? all.map(item) : <div className="px-2 py-1 text-[13px] text-[var(--c-texTer)]">아직 회의록이 없습니다. "새 회의" 로 시작하세요.</div>}
                                        </div>
                                    </div>
                                );
                            })() : r.type === 'button' ? (() => {
                                // 매크로 버튼. 이름표(text)를 누르면 ref 의 매크로를 실행한다. 매크로가 비었거나 지워졌으면 흐리게 보이고 누르면 설정이 열린다
                                const target = BUTTON_COMMANDS.find(c => commandId(c) === r.ref) ?? macroRows.find(x => x.id === r.ref);
                                return (
                                    <button
                                        className={`h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer select-none ${target ? 'bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95' : 'bg-[var(--c-graBacSec)]! text-[var(--c-texTer)] hover:bg-[#e6e5e3]!'}`}
                                        title={target ? `매크로 실행: ${'label' in target ? target.label : target.name}` : '매크로가 정해지지 않았습니다. 눌러서 설정하세요'}
                                        onClick={() => runButton(r)}
                                    >{r.text || '버튼'}</button>
                                );
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
                {sorted.length === 0 && PLACEHOLDER}
            </div>
            {buttonSettings && (() => {
                // 매크로 버튼 설정 모달: 이름표(text)·실행할 매크로(ref). 입력마다 바로 동기화하고 undo 는 기록하지 않는다 (속성 편집과 같은 취급)
                const b = rows.find(x => x.id === buttonSettings);
                if (!b) return null;
                return (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setButtonSettings(null)}>
                        <div className="w-80 rounded-lg bg-[var(--c-bacPri)] shadow-xl p-5 flex flex-col gap-4 text-sm" onClick={e => e.stopPropagation()}>
                            <div className="text-[15px] font-medium">🔘 버튼 설정</div>
                            <label className="flex flex-col gap-1">
                                <span className="text-[12px] text-[var(--c-texSec)]">이름표</span>
                                <input className="h-9 px-2 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px]" value={b.text} onChange={e => db.update({ id: b.id, text: e.target.value })} />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[12px] text-[var(--c-texSec)]">누르면 실행할 매크로</span>
                                <select className="h-9 px-2 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px] cursor-pointer" value={b.ref ?? ''} onChange={e => db.update({ id: b.id, ref: e.target.value })}>
                                    <option value="">선택하세요</option>
                                    {macroRows.length > 0 && <optgroup label="내 매크로">{macroRows.map(m => <option key={m.id} value={m.id}>{m.icon || '⚡'} {m.name}</option>)}</optgroup>}
                                    <optgroup label="내장 명령">{BUTTON_COMMANDS.map(c => <option key={c.label} value={commandId(c)}>{c.icon} {c.label}</option>)}</optgroup>
                                </select>
                                <span className="text-[12px] text-[var(--c-texTer)]">블럭을 만드는 명령은 버튼 바로 아래에 들어갑니다.</span>
                            </label>
                            <div className="flex justify-end">
                                <button className="h-8 px-3 rounded-full text-[13px] cursor-pointer bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!" onClick={() => setButtonSettings(null)}>닫기</button>
                            </div>
                        </div>
                    </div>
                );
            })()}
            {boardSettings && (() => {
                // 회의 보드 설정 모달: 새 회의에 쓸 템플릿을 고른다 (블럭 상태 style.template, patchStyle 이 undo 를 기록)
                const b = rows.find(x => x.id === boardSettings);
                if (!b) return null;
                const templates = templatePages(pages);
                const tplId = templates.some(t => t.id === b.style?.template) ? b.style!.template! : MEETING_TEMPLATE_ID;
                return (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setBoardSettings(null)}>
                        <div className="w-80 rounded-lg bg-[var(--c-bacPri)] shadow-xl p-5 flex flex-col gap-4 text-sm" onClick={e => e.stopPropagation()}>
                            <div className="text-[15px] font-medium">📅 회의 보드 설정</div>
                            <label className="flex flex-col gap-1">
                                <span className="text-[12px] text-[var(--c-texSec)]">새 회의에 쓸 템플릿</span>
                                <select className="h-9 px-2 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px] cursor-pointer" value={tplId} onChange={e => patchStyle([b], { template: e.target.value === MEETING_TEMPLATE_ID ? undefined : e.target.value })}>
                                    {templates.map(t => <option key={t.id} value={t.id}>{pageTitle(t)}</option>)}
                                </select>
                                <span className="text-[12px] text-[var(--c-texTer)]">템플릿은 사이드바 "템플릿" 에서 만들거나 복제해 고칩니다.</span>
                            </label>
                            <div className="flex justify-end">
                                <button className="h-8 px-3 rounded-full text-[13px] cursor-pointer bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!" onClick={() => setBoardSettings(null)}>닫기</button>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
