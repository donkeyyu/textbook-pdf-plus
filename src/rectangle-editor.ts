import { Menu, Notice, TFile } from 'obsidian';
import type { PDFViewerBacklinkVisualizer } from './backlink-visualizer';
import type { PDFBacklinkCache } from './lib/pdf-backlink-index';
import type { Rect } from './typings';

// Use cached Markdown ranges, and refuse stale ranges rather than modifying unrelated text.
export function rewriteRectangleLinks(text: string, refs: { start: number; end: number; original: string }[], rect: Rect | null) {
    const unique = [...new Map(refs.map(ref => [ref.start, ref])).values()].sort((a, b) => b.start - a.start);
    for (const ref of unique) {
        if (text.slice(ref.start, ref.end) !== ref.original) throw new Error('笔记已更改，请稍后重试');
        let replacement = ref.original;
        if (rect) replacement = replacement.replace(/([?&]rect=)[\d.,+-]+/, (_, prefix) => prefix + rect.join(','));
        else if (replacement.startsWith('!')) replacement = '';
        else replacement = replacement.replace(/&(?:rect|color)=[^\s|\]&#)]+/g, '');
        text = text.slice(0, ref.start) + replacement + text.slice(ref.end);
    }
    return text;
}

export function attachRectangleEditor(visualizer: PDFViewerBacklinkVisualizer, el: HTMLElement, pageNumber: number, initial: Rect, caches: Set<PDFBacklinkCache>) {
    const { app } = visualizer;
    const page = visualizer.child.getPage(pageNumber);
    const doc = el.ownerDocument;
    let busy = false;
    let cancelDrag: (() => void) | undefined;
    let rect = initial;
    const paint = (value: Rect) => {
        const [x, y, right, top] = page.pdfPage.view;
        el.style.left = `${100 * (value[0] - x) / (right - x)}%`;
        el.style.top = `${100 * (top - value[3]) / (top - y)}%`;
        el.style.width = `${100 * (value[2] - value[0]) / (right - x)}%`;
        el.style.height = `${100 * (value[3] - value[1]) / (top - y)}%`;
    };
    const save = async (next: Rect | null) => {
        if (busy) return;
        busy = true;
        try {
            const paths = new Set([...caches].map(cache => cache.sourcePath));
            if (paths.size !== 1) throw new Error('此框关联多篇笔记，暂不支持调整');
            const file = app.vault.getAbstractFileByPath([...paths][0]);
            if (!(file instanceof TFile)) throw new Error('关联笔记不存在');
            const refs = [...caches].map(({ refCache }) => {
                if (!('position' in refCache)) throw new Error('属性中的区域链接暂不支持调整');
                return { start: refCache.position.start.offset, end: refCache.position.end.offset, original: refCache.original };
            });
            await app.vault.process(file, text => rewriteRectangleLinks(text, refs, next));
            if (next) { rect = next; paint(next); }
            else el.remove();
        } catch (error) {
            paint(rect);
            new Notice(`框选未更改：${error instanceof Error ? error.message : String(error)}`);
        } finally { busy = false; }
    };
    const select = () => {
        doc.querySelectorAll('.pdf-plus-rect-selected').forEach(other => other.classList.remove('pdf-plus-rect-selected'));
        el.classList.add('pdf-plus-rect-selected');
    };
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const handle = el.createDiv({ cls: `pdf-plus-rect-handle ${corner}` });
        handle.dataset.corner = corner;
        handle.setAttribute('aria-label', `调整框选 ${corner}`);
    }
    el.addEventListener('pointerdown', event => {
        if (event.button !== 0 || busy) return;
        select();
        const corner = (event.target as HTMLElement).dataset.corner;
        const box = el.getBoundingClientRect();
        const nearBorder = Math.min(Math.abs(event.clientX - box.left), Math.abs(event.clientX - box.right), Math.abs(event.clientY - box.top), Math.abs(event.clientY - box.bottom)) <= 8;
        if (!corner && !nearBorder) return;
        event.preventDefault();
        event.stopPropagation();
        const start = page.viewport.convertToPdfPoint(event.clientX - page.div.getBoundingClientRect().left, event.clientY - page.div.getBoundingClientRect().top);
        let next = rect;
        let moved = false;
        const move = (e: PointerEvent) => {
            const bounds = page.div.getBoundingClientRect();
            const point = page.viewport.convertToPdfPoint(e.clientX - bounds.left, e.clientY - bounds.top);
            let dx = point[0] - start[0], dy = point[1] - start[1];
            moved ||= Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) > 3;
            if (!moved) return;
            const [xmin, ymin, xmax, ymax] = page.pdfPage.view;
            next = [...rect];
            if (!corner) {
                dx = Math.max(xmin - rect[0], Math.min(xmax - rect[2], dx));
                dy = Math.max(ymin - rect[1], Math.min(ymax - rect[3], dy));
                next = [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
            } else {
                if (corner.includes('w')) next[0] = Math.max(xmin, Math.min(rect[2] - 4, rect[0] + dx));
                else next[2] = Math.min(xmax, Math.max(rect[0] + 4, rect[2] + dx));
                if (corner.includes('n')) next[3] = Math.min(ymax, Math.max(rect[1] + 4, rect[3] + dy));
                else next[1] = Math.max(ymin, Math.min(rect[3] - 4, rect[1] + dy));
            }
            paint(next);
        };
        const cleanup = () => {
            doc.removeEventListener('pointermove', move);
            doc.removeEventListener('pointerup', up);
            doc.removeEventListener('pointercancel', cancel);
            cancelDrag = undefined;
        };
        const cancel = () => { cleanup(); paint(rect); };
        const up = () => { cleanup(); if (moved) void save(next.map(Math.round) as Rect); };
        cancelDrag = cancel;
        doc.addEventListener('pointermove', move);
        doc.addEventListener('pointerup', up);
        doc.addEventListener('pointercancel', cancel);
    });
    el.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        select();
        new Menu().addItem(item => item.setTitle('删除框选（保留笔记）').setIcon('trash').onClick(() => { void save(null); })).showAtMouseEvent(event);
    }, true);
    const escape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { cancelDrag?.(); el.classList.remove('pdf-plus-rect-selected'); }
    };
    doc.addEventListener('keydown', escape);
    const cleanup = () => { cancelDrag?.(); doc.removeEventListener('keydown', escape); };
    visualizer.domManager.onClearDomInPage(pageNumber, cleanup);
    visualizer.register(cleanup);
}
