// 서버 sync.ts 의 merge3 와 같은 알고리즘. 편집 중 남의 변경을 초안에 합칠 때 쓴다 (2026-09-08 undo-model).
import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();
// 텍스트 3-way 병합: base → next 의 편집 각각을, base → current 의 diff 로 위치를 옮겨 current 에 적용한다.
// 삽입은 옮긴 자리에 넣고, 삭제는 그 자리의 글자가 아직 같을 때만 지운다. 같은 글자를 동시에 고친 경우는 양쪽이 모두 남는다.
// (diff-match-patch 의 patch_apply 는 문서 끝의 삭제에서 뒤 글자를 잘라먹어 쓰지 않는다.)
export function merge3(base: string, next: string, current: string): string {
    if (base === current) return next; // 그 사이 아무도 안 고쳤다
    if (base === next) return current; // 내 변경이 없다
    const toCur = dmp.diff_main(base, current);
    let out = current, shift = 0, p = 0;
    for (const [op, text] of dmp.diff_main(base, next)) {
        if (op === 0) { p += text.length; continue; }
        const at = dmp.diff_xIndex(toCur, p) + shift;
        if (op === 1) { out = out.slice(0, at) + text + out.slice(at); shift += text.length; }
        else {
            if (out.slice(at, at + text.length) === text) { out = out.slice(0, at) + out.slice(at + text.length); shift -= text.length; }
            p += text.length;
        }
    }
    return out;
}
