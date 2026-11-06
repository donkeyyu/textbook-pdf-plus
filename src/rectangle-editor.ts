import { rectangleMetadata, withProperties } from './chapters/store';
import { Menu, Notice, TFile } from 'obsidian';
import type { PDFViewerBacklinkVisualizer } from './backlink-visualizer';
import type { PDFBacklinkCache } from './lib/pdf-backlink-index';
import type { PDFViewerChild, Rect } from './typings';

const pendingRectangle = new WeakMap<PDFViewerChild, { page: number; rect: Rect }>();
const sameRectangle = (a: Rect, b: Rect) => a.every((value, i) => Math.abs(value - b[i]) < 0.51);
function selectRectangle(el: HTMLElement) {
    el.ownerDocument.querySelectorAll('.pdf-plus-rect-selected').forEach(other => other.classList.remove('pdf-plus-rect-selected'));
    el.classList.add('pdf-plus-rect-selected');
}
export function clearPendingRectangle(child: PDFViewerChild) { pendingRectangle.delete(child); }
export function activateLinkedRectangle(child: PDFViewerChild, page: number, rect: Rect) {
    pendingRectangle.set(child, { page, rect });
    const elements = child.getPage(page)?.div.querySelectorAll<HTMLElement>('[data-textbook-rect]') ?? [];
    for (const el of elements) {
        if (sameRectangle(JSON.parse(el.dataset.textbookRect!), rect)) {
            selectRectangle(el);
            pendingRectangle.delete(child);
            break;
        }
    }
}

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
    el.dataset.textbookRect = JSON.stringify(initial);
    const paint = (value: Rect) => {
        el.dataset.textbookRect = JSON.stringify(value);
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
            const before = await app.vault.read(file);
            let after = rewriteRectangleLinks(before, refs, next);
            if (next) {
                const document = visualizer.child.pdfViewer.pdfViewer?.pdfDocument;
                if (!document) throw Error('教材尚未加载完成');
                after = await rectangleMetadata(visualizer.plugin, visualizer.file, document, pageNumber, next, after);
            } else after = withProperties(after, { pdf_rect: null, region_top: null, region_bottom: null, chapter_status: 'region_removed' });
            await app.vault.process(file, current => {
                if (current !== before) throw Error('笔记已更改，请稍后重试');
                return after;
            });
            if (next) { rect = next; paint(next); }
            else el.remove();
        } catch (error) {
            paint(rect);
            new Notice(`框选未更改：${error instanceof Error ? error.message : String(error)}`);
        } finally { busy = false; }
    };
    const select = () => selectRectangle(el);
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const handle = el.createDiv({ cls: `pdf-plus-rect-handle ${corner}` });
        handle.dataset.corner = corner;
        handle.setAttribute('aria-label', `调整框选 ${corner}`);
    }
    for (const edge of ['n', 'e', 's', 'w']) {
        const hitArea = el.createDiv({ cls: `pdf-plus-rect-edge ${edge}` });
        hitArea.dataset.edge = edge;
        hitArea.setAttribute('aria-label', '拖动边线调整大小');
    }
    const pending = pendingRectangle.get(visualizer.child);
    if (pending?.page === pageNumber && sameRectangle(initial, pending.rect)) {
        select();
        pendingRectangle.delete(visualizer.child);
    }
    el.title = '拖动框内移动 · 拖动边线或圆点调整大小 · 双击打开笔记';
    el.addEventListener('pointerdown', event => {
        if (event.button !== 0 || busy) return;
        select();
        const target = event.target as HTMLElement;
        const corner = target.dataset.corner ?? target.dataset.edge;
        event.preventDefault();
        event.stopPropagation();
        const bounds = page.div.getBoundingClientRect();
        const start = page.viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
        const win = doc.defaultView!;
        let frame = 0;
        el.setPointerCapture(event.pointerId);
        el.classList.add('pdf-plus-rect-dragging');
        let next = rect;
        let moved = false;
        const move = (e: PointerEvent) => {
            if (e.pointerId !== event.pointerId) return;
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
                if (corner.includes('e')) next[2] = Math.min(xmax, Math.max(rect[0] + 4, rect[2] + dx));
                if (corner.includes('n')) next[3] = Math.min(ymax, Math.max(rect[1] + 4, rect[3] + dy));
                if (corner.includes('s')) next[1] = Math.max(ymin, Math.min(rect[3] - 4, rect[1] + dy));
            }
            if (!frame) frame = win.requestAnimationFrame(() => {
                frame = 0;
                if (corner) paint(next); // Keep handles circular while resizing.
                else el.style.transform = `translate(${100 * (next[0] - rect[0]) / (rect[2] - rect[0])}%, ${-100 * (next[1] - rect[1]) / (rect[3] - rect[1])}%)`;
            });
        };
        const cleanup = () => {
            win.cancelAnimationFrame(frame);
            el.style.transform = '';
            el.classList.remove('pdf-plus-rect-dragging');
            if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
            doc.removeEventListener('pointermove', move);
            doc.removeEventListener('pointerup', up);
            doc.removeEventListener('pointercancel', cancel);
            cancelDrag = undefined;
        };
        const cancel = () => { cleanup(); paint(rect); };
        const up = (e: PointerEvent) => {
            if (e.pointerId !== event.pointerId) return;
            move(e);
            cleanup();
            if (moved) { paint(next); void save(next.map(Math.round) as Rect); }
        };
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
    const deselect = (event: PointerEvent) => {
        if (!el.contains(event.target as Node)) el.classList.remove('pdf-plus-rect-selected');
    };
    doc.addEventListener('pointerdown', deselect);
    doc.addEventListener('keydown', escape);
    const cleanup = () => {
        cancelDrag?.();
        doc.removeEventListener('keydown', escape);
        doc.removeEventListener('pointerdown', deselect);
    };
    visualizer.domManager.onClearDomInPage(pageNumber, cleanup);
    visualizer.register(cleanup);
}
