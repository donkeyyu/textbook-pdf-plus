import type { Rect } from '../typings';
import { Chapter, ChapterIndex, positionValue, validateIndex } from './model';
import { frontmatter, updateAssignment, withProperties } from './store';

// Format written by the textbook-reader desktop app (`.textbook/textbooks/<sha256>/catalog.json`).
export type ElectronCatalog = {
    textbookId: string; title: string; pageCount: number;
    pages: { page: number; printedPage: string | null }[];
    chapters: { id: string; title: string; start?: number; end?: number; source?: string }[];
    sections: { id: string; title: string; chapterId: string; start?: number; end?: number; source?: string }[];
};
type Anchor = { textbook?: unknown; pdf_page?: unknown; chapter?: unknown; section?: unknown; rects?: unknown };
export type MigrationBook = {
    hash: string; pdfPath: string; index: ChapterIndex | null; indexPath: string;
    views: Map<number, number[]>; printed: Map<number, string>;
};

// Whole-page catalog ranges become positions; ends are pulled back to the next start so siblings never overlap.
export function catalogToIndex(catalog: ElectronCatalog, pdfPath: string): ChapterIndex {
    const ranged = <T extends { start?: number; end?: number; source?: string }>(items: T[]) => items.filter(item => item.source !== 'custom' && Number.isInteger(item.start) && Number.isInteger(item.end));
    const toNodes = (items: { id: string; title: string; start?: number; end?: number }[], level: 1 | 2, parent: (id: string) => string | null) => {
        const nodes: Chapter[] = items.map(item => ({ id: item.id, title: item.title, source_title: item.title, level, parent_id: parent(item.id), source: 'manual', start: { page: item.start!, y: 0 }, end: { page: item.end!, y: 1 } }));
        nodes.sort((a, b) => positionValue(a.start) - positionValue(b.start));
        nodes.forEach((node, i) => {
            const next = nodes.slice(i + 1).find(other => level === 1 || other.parent_id === node.parent_id);
            if (next && positionValue(node.end) > positionValue(next.start)) node.end = { ...next.start };
        });
        return nodes;
    };
    const chapters = toNodes(ranged(catalog.chapters), 1, () => null);
    const sectionParent = new Map(catalog.sections.map(section => [section.id, section.chapterId]));
    const sections = toNodes(ranged(catalog.sections).filter(section => chapters.some(chapter => chapter.id === section.chapterId)), 2, id => sectionParent.get(id) ?? null);
    for (const section of sections) {
        const parent = chapters.find(chapter => chapter.id === section.parent_id)!;
        if (positionValue(section.start) < positionValue(parent.start)) section.start = { ...parent.start };
        if (positionValue(section.end) > positionValue(parent.end)) section.end = { ...parent.end };
    }
    const index: ChapterIndex = {
        version: 1, textbook_id: `book_${catalog.textbookId.slice(0, 24)}`, pdf_sha256: catalog.textbookId, pdf_path: pdfPath, page_count: catalog.pageCount,
        chapters: [...chapters, ...sections.filter(section => positionValue(section.start) < positionValue(section.end))].sort((a, b) => positionValue(a.start) - positionValue(b.start) || a.level - b.level),
    };
    validateIndex(index);
    return index;
}

const validRect = (rect: unknown): rect is number[] => Array.isArray(rect) && rect.length === 4 && rect.every(n => typeof n === 'number' && Number.isFinite(n));
// Electron rects are [x, y, width, height] fractions from the page's top-left corner.
export function toPdfRect([x, y, w, h]: number[], view: number[]): Rect {
    const [x0, y0, x1, y1] = view, width = x1 - x0, height = y1 - y0;
    return [x0 + x * width, y1 - (y + h) * height, x0 + (x + w) * width, y1 - y * height].map(Math.round) as Rect;
}
function anchorLinks(anchor: Anchor, books: Map<string, MigrationBook>) {
    const book = typeof anchor.textbook === 'string' ? books.get(anchor.textbook) : undefined;
    const page = Number(anchor.pdf_page);
    const view = book?.views.get(page);
    if (!book || !view) return null;
    const rects = Array.isArray(anchor.rects) ? anchor.rects.filter(validRect) : [];
    return { book, page, rects, pdfRects: rects.map(rect => toPdfRect(rect, view)) };
}
const pdfLink = (book: MigrationBook, page: number, rect: Rect | null, text: string) => `[[${book.pdfPath}#page=${page}${rect ? `&rect=${rect.join(',')}&color=yellow` : ''}|${text}]]`;

// Converts one Electron note. `_textbook` stays in place; plugin properties and PDF links are added around it.
export function convertNote(source: string, books: Map<string, MigrationBook>, options: { linkPrefix: string; notePaths: Set<string>; diagramFolder: string | null }) {
    const { properties } = frontmatter(source);
    const meta = properties._textbook && typeof properties._textbook === 'object' ? properties._textbook as Record<string, unknown> : {};
    const anchors = (Array.isArray(meta.anchors) ? meta.anchors : []) as Anchor[];
    const resolved = anchors.map(anchor => ({ anchor, links: anchorLinks(anchor, books) })).filter(item => item.links);
    const diagrams = new Set<string>();
    let { body } = frontmatter(source);
    body = body.replace(/\[([^\]]*)\]\(textbook:([^)\s]+)\)/g, (whole, text: string, encoded: string) => {
        try {
            const target = (JSON.parse(decodeURIComponent(encoded)) as Anchor[]).map(anchor => anchorLinks(anchor, books)).find(Boolean);
            return target ? pdfLink(target.book, target.page, target.pdfRects[0] ?? null, text) : whole;
        } catch { return whole; }
    });
    if (options.linkPrefix) body = body.replace(/(!?)\[\[([^\]|#]+)([^\]]*)\]\]/g, (whole, bang: string, path: string, rest: string) => options.notePaths.has(path) ? `${bang}[[${options.linkPrefix}/${path}${rest}]]` : whole);
    body = body.replace(/!\[([^\]]*)\]\(\/initial-diagrams\/([\w-]+\.(?:svg|png|jpe?g|webp))\)/g, (whole, _alt: string, name: string) => {
        if (!options.diagramFolder) return whole;
        diagrams.add(name);
        return `![[${options.diagramFolder}/${name}]]`;
    });
    const primary = resolved[0];
    if (primary?.links) {
        const { book, page, pdfRects, rects } = primary.links;
        const returnLinks = resolved.flatMap(({ links }, i) => (links!.pdfRects.length ? links!.pdfRects : [null]).map((rect, j) => pdfLink(links!.book, links!.page, rect, i === 0 && j === 0 ? '返回教材原文' : `教材原文 第${links!.page}页`)));
        body = `${returnLinks.join(' · ')}\n\n${body}`;
        const top = rects.length ? Math.min(...rects.map(rect => rect[1])) : null;
        const bottom = rects.length ? Math.max(...rects.map(rect => rect[1] + rect[3])) : null;
        const union = pdfRects.length ? [Math.min(...pdfRects.map(r => r[0])), Math.min(...pdfRects.map(r => r[1])), Math.max(...pdfRects.map(r => r[2])), Math.max(...pdfRects.map(r => r[3]))] : null;
        const section = typeof primary.anchor.section === 'string' && book.index?.chapters.some(node => node.id === primary.anchor.section && node.level === 2) ? primary.anchor.section : null;
        const chapter = typeof primary.anchor.chapter === 'string' && book.index?.chapters.some(node => node.id === primary.anchor.chapter && node.level === 1) ? primary.anchor.chapter : null;
        const type = meta.initial_type ?? properties.initial_type;
        const added: Record<string, unknown> = {
            textbook: `[[${book.pdfPath}]]`, textbook_id: `book_${book.hash.slice(0, 24)}`, textbook_index: book.indexPath, pdf_page: page,
            pdf_rect: union, region_top: top, region_bottom: bottom,
            chapter_assignment: 'auto',
        };
        if (!properties.printed_page && book.printed.get(page)) added.printed_page = book.printed.get(page);
        if (!properties.content_type && typeof type === 'string') added.content_type = type === 'question' ? '习题' : '知识点';
        const content = withProperties(source, added);
        const withBody = content.slice(0, content.length - frontmatter(content).body.length) + body;
        let assigned = updateAssignment(withBody, book.index);
        // Keep the Electron chapter as a manual choice only when automatic matching disagrees with it.
        const auto = frontmatter(assigned).properties;
        const agrees = top !== null && (!chapter || auto.chapter_id === chapter) && (!section || auto.section_id === section);
        if ((chapter || section) && !agrees) {
            const parent = section ? book.index!.chapters.find(node => node.id === section)!.parent_id : chapter;
            assigned = updateAssignment(withProperties(withBody, { chapter_assignment: 'manual', chapter_id: parent, section_id: section }), book.index);
            if (top === null) assigned = withProperties(assigned, { chapter_status: 'matched', chapter_title: book.index!.chapters.find(node => node.id === parent)?.title ?? '', section_title: book.index!.chapters.find(node => node.id === section)?.title ?? '' });
        } else if (top === null) assigned = withProperties(assigned, { chapter_status: book.index ? 'unassigned' : 'unindexed' });
        return { content: assigned, diagrams, located: true };
    }
    return { content: source.slice(0, source.length - frontmatter(source).body.length) + body, diagrams, located: false };
}
