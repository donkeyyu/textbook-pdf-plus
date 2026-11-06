export type Position = { page: number; y: number };
export type Chapter = {
    id: string; parent_id: string | null; level: 1 | 2; title: string;
    source_title?: string; start: Position; end: Position; source: 'outline' | 'ai' | 'manual';
};
export type ChapterIndex = {
    version: 1; textbook_id: string; pdf_sha256: string; pdf_path: string; page_count: number;
    chapters: Chapter[];
};
export type Heading = { title: string; level: 1 | 2; start: Position; source: Chapter['source'] };
export const positionValue = (p: Position) => p.page - 1 + p.y;
const normalized = (text: string) => text.replace(/\s+/g, '').normalize('NFKC');

export function validateIndex(index: ChapterIndex) {
    if (index.version !== 1 || !Number.isInteger(index.page_count) || index.page_count < 1 || !Array.isArray(index.chapters)) throw Error('索引格式不正确');
    const ids = new Set<string>();
    for (const node of index.chapters) {
        if (typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.title !== 'string' || !node.title.trim() || ![1, 2].includes(node.level)) throw Error('章节 ID 重复或标题、层级无效');
        ids.add(node.id);
        for (const p of [node.start, node.end]) {
            if (!p || !Number.isInteger(p.page) || p.page < 1 || p.page > index.page_count || !Number.isFinite(p.y) || p.y < 0 || p.y > 1) throw Error(`${node.title}：页码或页内位置无效`);
        }
        if (positionValue(node.start) >= positionValue(node.end)) throw Error(`${node.title}：终点必须在起点之后`);
        if (node.level === 1 && node.parent_id !== null) throw Error('章不能有父章节');
    }
    for (const node of index.chapters) {
        if (node.level === 2) {
            const parent = index.chapters.find(p => p.id === node.parent_id && p.level === 1);
            if (!parent || positionValue(node.start) < positionValue(parent.start) || positionValue(node.end) > positionValue(parent.end)) throw Error(`${node.title}：小节范围必须在所属章内`);
        }
        for (const other of index.chapters) {
            if (node.id !== other.id && node.level === other.level && Math.max(positionValue(node.start), positionValue(other.start)) < Math.min(positionValue(node.end), positionValue(other.end))) throw Error(`${node.title} 与 ${other.title} 范围重叠`);
        }
    }
}

export function headingsToChapters(headings: Heading[], pageCount: number, id: () => string): Chapter[] {
    const sorted = [...headings].sort((a, b) => positionValue(a.start) - positionValue(b.start) || a.level - b.level);
    let parent: string | null = null;
    return sorted.map((heading, i) => {
        const next = sorted.slice(i + 1).find(item => item.level <= heading.level);
        const node: Chapter = { ...heading, id: id(), parent_id: heading.level === 1 ? null : parent, source_title: heading.title, end: next?.start ?? { page: pageCount, y: 1 } };
        if (node.level === 1) parent = node.id;
        return node;
    });
}

// Re-extraction is additive: existing titles, ranges and IDs are never overwritten.
export function mergeCandidates(existing: Chapter[], candidates: Chapter[]) {
    const result = structuredClone(existing);
    const mapped = new Map<string, string>();
    for (const candidate of [...candidates].sort((a, b) => a.level - b.level)) {
        const same = existing.filter(node => node.level === candidate.level && (
            positionValue(node.start) === positionValue(candidate.start) || normalized(node.source_title ?? node.title) === normalized(candidate.source_title ?? candidate.title)
        ));
        const match = same.length === 1 ? same[0] : undefined;
        if (same.length > 1) throw Error(`无法唯一配对 ${candidate.title}，请手动校正，已有索引未修改`);
        mapped.set(candidate.id, match?.id ?? candidate.id);
        if (!match) result.push({ ...candidate, parent_id: candidate.parent_id ? mapped.get(candidate.parent_id) ?? candidate.parent_id : null });
    }
    return result.sort((a, b) => positionValue(a.start) - positionValue(b.start) || a.level - b.level);
}

export function matchRegion(chapters: Chapter[], start: Position, end: Position) {
    const from = positionValue(start), to = positionValue(end);
    const overlapping = chapters.filter(node => positionValue(node.start) < to && positionValue(node.end) > from);
    const sections = overlapping.filter(node => node.level === 2);
    const inside = (node: Chapter) => positionValue(node.start) <= from && positionValue(node.end) >= to;
    const chapter = overlapping.find(node => node.level === 1 && inside(node));
    const section = sections.length === 1 && inside(sections[0]) ? sections[0] : undefined;
    const ambiguous = sections.length > 0 && !section || !chapter && overlapping.length > 0;
    return { chapter, section, status: ambiguous ? 'ambiguous' : chapter || section ? 'matched' : 'unassigned' };
}

export function assignment(index: ChapterIndex | null, previous: Record<string, unknown>, start: Position, end: Position) {
    const match = matchRegion(index?.chapters ?? [], start, end);
    const manual = previous.chapter_assignment === 'manual';
    let chapter = match.chapter, section = match.section;
    let status = index ? match.status : 'unindexed';
    if (manual && index) {
        chapter = index.chapters.find(node => node.level === 1 && node.id === previous.chapter_id);
        section = index.chapters.find(node => node.level === 2 && node.id === previous.section_id);
        const target = section ?? chapter;
        const missing = !!previous.section_id && !section || !!previous.chapter_id && !chapter;
        status = missing || !target ? 'missing' : positionValue(target.start) <= positionValue(start) && positionValue(target.end) >= positionValue(end) ? 'matched' : 'conflict';
    }
    return {
        chapter_id: manual ? previous.chapter_id ?? null : chapter?.id ?? null,
        section_id: manual ? previous.section_id ?? null : section?.id ?? null,
        chapter_title: chapter?.title ?? '', section_title: section?.title ?? '',
        chapter_assignment: manual ? 'manual' : 'auto', chapter_status: status,
    };
}

export function parseAIHeadings(raw: string, pages: { page: number; lines: { y: number; text: string }[] }[]): Heading[] {
    const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''));
    if (!Array.isArray(parsed.headings)) throw Error('AI 未返回 headings 数组');
    return parsed.headings.map((item: { title: string; level: 1 | 2; page: number; y: number }) => {
        if (typeof item.title !== 'string' || !item.title.trim() || ![1, 2].includes(item.level)) throw Error('AI 返回了无效标题');
        const page = pages.find(p => p.page === item.page);
        const line = page?.lines.find(line => Math.abs(line.y - item.y) < 0.015 && normalized(line.text).includes(normalized(item.title)));
        if (!line) throw Error(`AI 标题无法在原页文字及位置中核对：${item.title}`);
        return { title: item.title, level: item.level, start: { page: item.page, y: line.y }, source: 'ai' };
    });
}
