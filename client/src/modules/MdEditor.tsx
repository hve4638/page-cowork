// 텍스트 블럭 하나의 마크다운 에디터. CodeMirror 6 + codemirror-live-markdown(옵시디언식 라이브 프리뷰).
// 원문(마크다운 문자열)이 그대로 문서이고 서식은 데코레이션(뷰 전용)이라 get/set 에서 원문이 변하지 않는다.
// 캐럿이 있는 줄만 마크업 기호가 보이고, 나머지 줄은 서식만 보인다. 포커스가 없으면 모든 줄이 서식만 보인다(CSS).
// 라이브러리는 기호를 숨기고 인라인·제목 클래스를 붙이는 것까지만 하므로, 목록 불릿·인용 테두리·코드 펜스 줄은 여기서 보탠다.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Annotation, EditorState, EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap } from '@codemirror/commands';
import { livePreviewPlugin, markdownStylePlugin, linkPlugin, mouseSelectingField, collapseOnSelectionFacet } from 'codemirror-live-markdown';
import './markdown.css';

export type MdEditorHandle = {
    view: EditorView;
    // 캐럿(선택)을 놓고 포커스한다. 오프셋은 원문 기준.
    setCaret: (at: number, to?: number) => void;
};
export type MdKeyContext = {
    view: EditorView;
    head: number; // 캐럿 오프셋
    atFirstLine: boolean; // 위로 더 갈 줄이 없다 (시각적 줄 기준)
    atLastLine: boolean;
    col: number; // 논리 줄 안의 열 (이웃 블럭 진입 시 열 유지용)
};

class TextWidget extends WidgetType {
    constructor(readonly text: string, readonly cls: string) { super(); }
    override eq(o: TextWidget) { return o.text === this.text && o.cls === this.cls; }
    override toDOM() { const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
    override ignoreEvent() { return false; }
}
// 할 일 항목의 체크박스. 원문의 '- [ ] ' / '- [x] '(불릿 + 표식)를 통째로 대신한다. 클릭은 아래 mousedown 핸들러가 받아 원문의 [ ]/[x] 를 바꾼다.
class CheckWidget extends WidgetType {
    constructor(readonly checked: boolean) { super(); }
    override eq(o: CheckWidget) { return o.checked === this.checked; }
    override toDOM() { const s = document.createElement('span'); s.className = 'cm-md-check'; s.dataset['checked'] = this.checked ? '1' : ''; return s; }
    override ignoreEvent() { return false; }
}
// 구분선(***·---). 캐럿이 닿지 않은 줄의 원문 대신 가로선을 그린다.
class HrWidget extends WidgetType {
    override eq() { return true; }
    override toDOM() { const s = document.createElement('span'); s.className = 'cm-md-hr'; return s; }
    override ignoreEvent() { return false; }
}
// 할 일 줄: 들여쓰기 · 불릿 · 표식([ ]/[x]) · 뒤 공백. 표식의 체크 글자는 from + m[1].length + m[2].length + 1 에 있다.
const TASK_RE = /^(\s*)([-*+]\s+)\[([ xX])\](\s?)/;
// 체크박스 클릭: 그 줄의 [ ] ↔ [x]. 원문 변경이라 onChange 로 올라간다.
function toggleTask(view: EditorView, line: { from: number; text: string }) {
    const m = TASK_RE.exec(line.text);
    if (!m) return false;
    const at = line.from + m[1].length + m[2].length + 1;
    view.dispatch({ changes: { from: at, to: at + 1, insert: m[3] === ' ' ? 'x' : ' ' } });
    return true;
}
// Enter 로 할 일 항목을 이어 쓴다(lang-markdown 의 목록 이어 쓰기는 '- ' 까지만 넣는다). 빈 항목에서 Enter 는 항목을 지워 목록을 끝낸다.
function continueTask(view: EditorView) {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head);
    const m = TASK_RE.exec(line.text);
    if (!m || sel.head < line.from + m[0].length) return false;
    if (line.text.length === m[0].length) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from } });
        return true;
    }
    const insert = `\n${m[1]}${m[2]}[ ] `;
    view.dispatch({ changes: { from: sel.head, insert }, selection: { anchor: sel.head + insert.length } });
    return true;
}

// 목록·인용·코드 블럭·할 일·구분선의 줄 장식. 캐럿이 든 줄은 라이브러리가 기호를 보여 주므로 여기서는 손대지 않는다.
const blockDecor = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view); }
    build(view: EditorView) {
        const { state } = view;
        const active = new Set<number>();
        if (view.hasFocus) for (const r of state.selection.ranges) {
            for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) active.add(l);
        }
        const out: { from: number; to: number; deco: Decoration }[] = [];
        const lineClass = (from: number, to: number, cls: string) => {
            for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(Math.max(from, to - 1)).number; l++) {
                out.push({ from: state.doc.line(l).from, to: state.doc.line(l).from, deco: Decoration.line({ class: cls }) });
            }
        };
        syntaxTree(state).iterate({
            enter: n => {
                if (n.name === 'Blockquote') lineClass(n.from, n.to, 'cm-md-quote');
                else if (n.name === 'FencedCode' || n.name === 'CodeBlock') lineClass(n.from, n.to, 'cm-md-code');
                else if (n.name === 'Task') {
                    // 할 일 항목: 불릿과 표식을 체크박스 하나로 바꾸고, 끝난 항목은 줄 전체를 흐리게 한다 (캐럿 줄은 원문 그대로)
                    const line = state.doc.lineAt(n.from);
                    const m = TASK_RE.exec(line.text);
                    if (!m) return;
                    if (m[3] !== ' ') out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-md-task-done' }) });
                    if (active.has(line.number)) return;
                    out.push({ from: line.from + m[1].length, to: line.from + m[0].length, deco: Decoration.replace({ widget: new CheckWidget(m[3] !== ' ') }) });
                } else if (n.name === 'HorizontalRule') {
                    const line = state.doc.lineAt(n.from);
                    if (active.has(line.number)) return;
                    out.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new HrWidget() }) });
                } else if (n.name === 'ListMark' || n.name === 'QuoteMark') {
                    const line = state.doc.lineAt(n.from);
                    if (active.has(line.number) || (n.name === 'ListMark' && TASK_RE.test(line.text))) return; // 할 일 줄의 불릿은 체크박스가 대신한다
                    const text = state.doc.sliceString(n.from, n.to);
                    // 불릿은 • 로, 번호는 그대로, 인용 기호는 지우고 줄 테두리로 대신한다
                    const w = n.name === 'QuoteMark' ? null : new TextWidget(/^\d/.test(text) ? text : '•', 'cm-md-mark');
                    out.push({ from: n.from, to: n.to, deco: Decoration.replace(w ? { widget: w } : {}) });
                }
            },
        });
        return Decoration.set(out.map(d => d.deco.range(d.from, d.to)), true); // true: 정렬은 CM 에 맡긴다
    }
}, { decorations: v => v.decorations });

// 포커스 여부를 상태에 둔다 (줄 전체를 숨기는 블럭 데코레이션은 StateField 에서만 제공할 수 있고, StateField 는 뷰의 포커스를 모른다)
const setFocused = StateEffect.define<boolean>();
const focusedField = StateField.define<boolean>({
    create: () => false,
    update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFocused) ? e.value : acc), v),
});
// 캐럿이 코드 블럭 밖이면 펜스(```) 줄을 통째로 숨긴다. 안에 들어오면 다시 보인다.
const buildFences = (state: EditorState) => {
    const out: ReturnType<Decoration['range']>[] = [];
    const focused = state.field(focusedField);
    syntaxTree(state).iterate({
        enter: n => {
            if (n.name !== 'FencedCode') return;
            const inside = focused && state.selection.ranges.some(r => r.to >= n.from && r.from <= n.to);
            if (inside) return;
            const lines = new Set(n.node.getChildren('CodeMark').map(m => state.doc.lineAt(m.from).number));
            for (const ln of lines) { const line = state.doc.line(ln); out.push(Decoration.replace({ block: true }).range(line.from, line.to)); }
        },
    });
    return Decoration.set(out, true);
};
const fenceField = StateField.define<DecorationSet>({
    create: buildFences,
    update: (d, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(setFocused)) ? buildFences(tr.state) : d),
    provide: f => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
    '&': { fontSize: '16px', lineHeight: '1.5' },
    '.cm-content': { padding: '0', fontFamily: 'inherit', caretColor: 'inherit' },
    '.cm-line': { padding: '0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
});

const external = Annotation.define<boolean>(); // 바깥(value prop)에서 갈아끼운 트랜잭션 표식 — onChange 로 되돌리지 않는다

export function MdEditor({ ref, value, onChange, onFocus, onBlur, onKeyDown, onPaste, interceptDrop, className }: {
    ref?: Ref<MdEditorHandle>;
    value: string;
    onChange: (text: string, caret: number) => void; // 사용자 입력으로 원문이 바뀔 때 (caret 은 바뀐 뒤의 캐럿 오프셋)
    onFocus?: (view: EditorView) => void;
    onBlur?: () => void;
    // true 를 돌려주면 처리된 것으로 보고 브라우저·CM 기본 동작을 막는다
    onKeyDown?: (e: KeyboardEvent, ctx: MdKeyContext) => boolean | void;
    onPaste?: (files: File[], at: number) => boolean | void;
    interceptDrop?: (e: DragEvent) => boolean; // true 면 CM 이 드롭을 처리하지 않는다 (블럭 손잡이·파일 드롭은 바깥이 맡는다)
    className?: string;
}) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // ref 콜백은 뷰를 만드는 useEffect 보다 먼저 불리므로, 마운트 직후의 setCaret 은 여기 담아 두었다가 뷰가 생기면 적용한다.
    // 뷰 생성 시 지우지 않는다 — StrictMode(개발)는 effect 를 두 번 돌려 첫 뷰를 파괴하므로 두 번째 뷰에도 같은 캐럿이 필요하다.
    const pendingCaret = useRef<[number, number] | null>(null);
    const placeCaret = (view: EditorView, at: number, to: number) => {
        const len = view.state.doc.length;
        const c = (n: number) => Math.max(0, Math.min(n, len));
        view.dispatch({ selection: EditorSelection.range(c(at), c(to)) });
        view.focus();
    };
    // 최신 콜백을 CM 이벤트 핸들러에서 쓰기 위한 상자 (핸들러는 마운트 시 한 번만 등록된다)
    const cb = useRef({ onChange, onFocus, onBlur, onKeyDown, onPaste, interceptDrop });
    cb.current = { onChange, onFocus, onBlur, onKeyDown, onPaste, interceptDrop };

    useEffect(() => {
        const extensions: Extension[] = [
            markdown({ base: markdownLanguage }), // GFM (취소선·표·작업 목록) + Enter 로 목록 이어 쓰기
            collapseOnSelectionFacet.of(true), mouseSelectingField, livePreviewPlugin, markdownStylePlugin,
            linkPlugin({ openInNewTab: true }), // 캐럿이 닿지 않은 링크는 클릭 가능한 앵커 위젯으로 (javascript: 등은 라이브러리가 거른다)
            blockDecor, theme, EditorView.lineWrapping,
            focusedField, EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)), fenceField,
            keymap.of(defaultKeymap), // undo/redo 는 문서 수준 스택(BlockDoc)이 맡으므로 CM history 는 넣지 않는다
            EditorView.updateListener.of(u => {
                if (u.docChanged && !u.transactions.some(t => t.annotation(external))) cb.current.onChange(u.state.doc.toString(), u.state.selection.main.head);
                if (u.focusChanged) { if (u.view.hasFocus) cb.current.onFocus?.(u.view); else cb.current.onBlur?.(); }
            }),
            // 키맵(Enter 목록 이어 쓰기·화살표 등)보다 먼저 받아야 '/' 메뉴의 Enter 와 블럭 경계의 ↑↓ 를 가로챌 수 있다
            Prec.highest(EditorView.domEventHandlers({
                keydown: (e, view) => {
                    if (e.isComposing) return false;
                    const { head } = view.state.selection.main;
                    const line = view.state.doc.lineAt(head);
                    // 그 방향에 줄이 없으면 moveVertically 가 문서 시작·끝으로 옮기므로, 같은 시각적 줄(y)에 머무는지로 경계를 판정한다
                    const probe = (forward: boolean) => {
                        const nh = view.moveVertically(view.state.selection.main, forward).head;
                        const a = view.coordsAtPos(head), b = view.coordsAtPos(nh);
                        return a && b ? Math.abs(a.top - b.top) < 1 : view.state.doc.lineAt(nh).number === line.number;
                    };
                    const ctx: MdKeyContext = {
                        view, head, col: head - line.from,
                        atFirstLine: e.key === 'ArrowUp' && probe(false),
                        atLastLine: e.key === 'ArrowDown' && probe(true),
                    };
                    if (cb.current.onKeyDown?.(e, ctx)) return true;
                    return e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && continueTask(view);
                },
                paste: (e, view) => {
                    const files = Array.from(e.clipboardData?.files ?? []);
                    if (!files.length) return false;
                    return !!cb.current.onPaste?.(files, view.state.selection.main.head);
                },
                drop: e => !!cb.current.interceptDrop?.(e),
                mousedown: (e, view) => {
                    if (e.button !== 0) return false;
                    // 체크박스 위젯 클릭은 캐럿을 옮기지 않고 그 줄의 표식만 바꾼다 (포커스가 없어도 된다)
                    const check = (e.target as HTMLElement).closest?.('.cm-md-check');
                    if (check) { e.preventDefault(); return toggleTask(view, view.state.doc.lineAt(view.posAtDOM(check))); }
                    // 링크 위젯(캐럿이 닿지 않은 링크)은 클릭하면 연다. CM 에 맡기면 캐럿이 놓이면서 위젯이 원문으로 바뀌어 이동이 안 된다.
                    // href 는 라이브러리가 sanitize 한 값이다 (javascript: 등은 비어 있다).
                    const a = (e.target as HTMLElement).closest?.('a.cm-link-widget') as HTMLAnchorElement | null;
                    if (!a?.href) return false;
                    e.preventDefault();
                    window.open(a.href, '_blank', 'noopener,noreferrer');
                    return true;
                },
            })),
        ];
        const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current! });
        viewRef.current = view;
        if (pendingCaret.current) { const [at, to] = pendingCaret.current; placeCaret(view, at, to); }
        return () => { view.destroy(); viewRef.current = null; };
    }, []);

    // 바깥 원문이 바뀌면(원격 갱신·undo) 문서를 갈아끼운다. 사용자가 친 내용은 onChange 로 이미 올라가 있어 같으므로 건드리지 않는다.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const cur = view.state.doc.toString();
        if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: external.of(true) });
    }, [value]);

    useImperativeHandle(ref, () => ({
        get view() { return viewRef.current!; },
        setCaret: (at, to = at) => {
            const view = viewRef.current;
            if (view) { pendingCaret.current = null; placeCaret(view, at, to); } else pendingCaret.current = [at, to];
        },
    }), []);

    return <div ref={host} className={className} />;
}

// 선택 영역을 마크다운 기호로 감싼다. 이미 감싸여 있으면 벗기고, 선택이 없으면 기호 쌍 사이에 캐럿을 둔다.
export function toggleMark(view: EditorView, mark: string) {
    const { from, to } = view.state.selection.main;
    const m = mark.length, doc = view.state.doc;
    const sel = doc.sliceString(from, to);
    if (from >= m && doc.sliceString(from - m, from) === mark && doc.sliceString(to, to + m) === mark) {
        view.dispatch({ changes: [{ from: from - m, to: from }, { from: to, to: to + m }], selection: EditorSelection.range(from - m, to - m) });
    } else if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
        view.dispatch({ changes: { from, to, insert: sel.slice(m, -m) }, selection: EditorSelection.range(from, to - 2 * m) });
    } else {
        view.dispatch({ changes: { from, to, insert: mark + sel + mark }, selection: EditorSelection.range(from + m, to + m) });
    }
}
