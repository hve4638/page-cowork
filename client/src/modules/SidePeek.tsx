// 사이드 뷰어. 파일 블럭(BlockDoc)에서 PDF·텍스트 파일을 열거나 서브페이지 링크를 클릭하면 Workspace 오른쪽에 패널로 떠서 보여준다.
// 서브페이지는 PagePeek(제목 + BlockDoc)이 그리고, 상단 '전체 보기' 로 그 페이지로 전환한다. Alt+클릭은 패널 없이 바로 전환한다.
// PDF 는 pdf.js(react-pdf) 로 패널 안에 직접 그린다(PdfViewer). 번들이 크므로 lazy import 로 PDF 를 처음 열 때만 내려받는다.
// 텍스트는 fetch 로 받아 pre 에 원문 그대로 보인다(마크다운 렌더링은 markdown-styling 티켓의 몫).
// 열린 파일은 zustand 스토어에 두어 깊이 다른 두 자리(블럭 · Workspace 레이아웃)가 공유한다.
import { lazy, Suspense, useEffect, useState } from 'react';
import { create } from 'zustand';
import type { FileRow } from './BlockDoc';

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

// 패널에 열린 것: 파일(PDF·텍스트) 또는 서브페이지. 한 번에 하나만 열린다.
type PeekItem = { kind: 'file'; file: FileRow } | { kind: 'page'; id: string };
export const useSidePeek = create<{ item: PeekItem | null; open: (file: FileRow) => void; openPage: (id: string) => void; close: () => void }>(set => ({
    item: null,
    open: file => set({ item: { kind: 'file', file } }),
    openPage: id => set({ item: { kind: 'page', id } }),
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
