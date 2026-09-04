// pdf.js(react-pdf) 기반 PDF 뷰어. SidePeek 이 lazy import 로 불러 쓰므로 이 파일과 pdfjs-dist 는 별도 청크로 분리된다.
// 한 번에 한 페이지만 그려 좁은 패널에서도 가볍게 동작하게 하고, 기본 배율은 패널 폭 맞춤(zoom=1)이다.
import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import type { FileRow } from './BlockDoc';

// pdf.js 는 파싱을 웹 워커에서 하므로 워커 스크립트 주소를 알려줘야 한다. Vite 가 new URL(..., import.meta.url) 을 에셋으로 빼 준다.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export default function PdfViewer({ file }: { file: FileRow }) {
    const [numPages, setNumPages] = useState(0);
    const [page, setPage] = useState(1);
    const [pageInput, setPageInput] = useState('1');
    const [zoom, setZoom] = useState(1); // 1 = 패널 폭 맞춤
    const [width, setWidth] = useState(0); // 페이지를 그릴 영역의 가로 폭(px)
    const bodyRef = useRef<HTMLDivElement>(null);

    // 패널 폭이 바뀌면(창 크기 변경 등) 폭 맞춤 배율을 다시 계산한다.
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    function goTo(n: number) {
        const next = Math.min(Math.max(1, n), numPages || 1);
        setPage(next);
        setPageInput(String(next));
        bodyRef.current?.scrollTo({ top: 0 });
    }

    const btn = 'px-2 py-0.5 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)] disabled:opacity-40 disabled:cursor-default';
    return (
        <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-1 px-2 h-9 text-[13px] border-b border-[var(--c-borPri)] select-none">
                <button className={btn} onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="이전 페이지">‹</button>
                <input
                    className="w-10 text-center border border-[var(--c-borPri)] rounded-md py-0.5 bg-transparent"
                    value={pageInput}
                    onChange={e => setPageInput(e.target.value)}
                    onBlur={() => goTo(Number(pageInput) || page)}
                    onKeyDown={e => { if (e.key === 'Enter') goTo(Number(pageInput) || page); }}
                    aria-label="페이지 번호"
                />
                <span className="text-[var(--c-texSec)]">/ {numPages || '–'}</span>
                <button className={btn} onClick={() => goTo(page + 1)} disabled={page >= numPages} aria-label="다음 페이지">›</button>
                <span className="flex-1" />
                <button className={btn} onClick={() => setZoom(z => Math.max(ZOOM_MIN, z / ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="축소">−</button>
                <button className={btn} onClick={() => setZoom(1)} title="폭 맞춤">{Math.round(zoom * 100)}%</button>
                <button className={btn} onClick={() => setZoom(z => Math.min(ZOOM_MAX, z * ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="확대">+</button>
            </div>
            <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto bg-[var(--ca-bacIntTra)]">
                <Document
                    file={`/api/files/${file.id}`}
                    onLoadSuccess={d => { setNumPages(d.numPages); setPage(1); setPageInput('1'); }}
                    loading={<div className="p-4 text-sm text-[var(--c-texTer)]">불러오는 중…</div>}
                    error={<div className="p-4 text-sm text-[var(--c-texSec)]">PDF 를 열지 못했습니다. 다운로드해서 확인하세요.</div>}
                >
                    {width > 0 && (
                        <Page
                            pageNumber={page}
                            width={width * zoom}
                            renderAnnotationLayer={false}
                            loading={<div className="p-4 text-sm text-[var(--c-texTer)]">페이지 그리는 중…</div>}
                        />
                    )}
                </Document>
            </div>
        </div>
    );
}
