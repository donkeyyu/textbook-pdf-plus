import { ItemView, Notice, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import type PDFPlus from '../main';
import type { Chapter } from './model';
import { noteLocation, openTextbookPage } from './note-header';
import { DEFAULT_INDEX_FOLDER, pdfHash, readIndex, textbookId } from './store';

export const CHAPTER_VIEW_TYPE = 'textbook-chapter-sidebar';
type NoteEntry = { file: TFile; page: number; printed: string; top: number; chapter: string | null; section: string | null; status: string };
const UNSORTED = '__unsorted';

// Groups notes by their stored chapter/section IDs; notes without a valid ID fall into the unsorted group.
export function groupNotes(chapters: Chapter[], notes: NoteEntry[]) {
    const known = new Set(chapters.map(node => node.id));
    const groups = new Map<string, NoteEntry[]>();
    const sorted = [...notes].sort((a, b) => a.page - b.page || a.top - b.top || a.file.path.localeCompare(b.file.path));
    for (const note of sorted) {
        const key = note.section && known.has(note.section) ? note.section : note.chapter && known.has(note.chapter) ? note.chapter : UNSORTED;
        groups.set(key, [...groups.get(key) ?? [], note]);
    }
    return groups;
}

export class ChapterSidebarView extends ItemView {
    private pdf: TFile | null = null;
    // Chapters start collapsed; the active note's chapter and section open when that note becomes active.
    private expanded = new Set<string>();
    private lastActive = '';
    private requestRefresh = debounce(() => void this.refresh(), 300, true);
    constructor(leaf: WorkspaceLeaf, private plugin: PDFPlus) { super(leaf); }
    getViewType() { return CHAPTER_VIEW_TYPE; }
    getDisplayText() { return '教材章节'; }
    getIcon() { return 'list-tree'; }

    async onOpen() {
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.requestRefresh()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.requestRefresh()));
        this.registerEvent(this.app.vault.on('rename', () => this.requestRefresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.requestRefresh()));
        this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile && file.extension === 'json') this.requestRefresh(); }));
        await this.refresh();
    }

    // Follows the active PDF, or the textbook of the active note; keeps the last textbook otherwise.
    private currentTextbook() {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension === 'pdf') return file;
        const properties = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
        const location = properties && noteLocation(properties);
        const pdf = location && this.app.metadataCache.getFirstLinkpathDest(location.link.split('#')[0], file!.path);
        return pdf ?? this.pdf;
    }

    async refresh() {
        const pdf = this.currentTextbook();
        const el = this.contentEl;
        el.addClass('textbook-sidebar');
        if (!pdf) { el.empty(); el.createEl('p', { cls: 'textbook-sidebar-empty', text: '打开教材 PDF 或教材笔记后，这里按章节列出笔记。' }); return; }
        this.pdf = pdf;
        const hash = await pdfHash(this.app, pdf);
        const id = textbookId(hash);
        const folder = this.plugin.settings.textbookIndexFolder.trim() || DEFAULT_INDEX_FOLDER;
        const saved = await readIndex(this.app, `${folder}/${hash}.json`, id).catch(() => null);
        const notes: NoteEntry[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            const properties = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (properties?.textbook_id !== id) continue;
            notes.push({
                file, page: Number(properties.pdf_page) || 0, printed: String(properties.printed_page ?? '').trim(), top: Number(properties.region_top) || 0,
                chapter: typeof properties.chapter_id === 'string' ? properties.chapter_id : null,
                section: typeof properties.section_id === 'string' ? properties.section_id : null,
                status: String(properties.chapter_status ?? ''),
            });
        }
        if (this.pdf !== pdf) return;
        const active = this.app.workspace.getActiveFile();
        if (active && active.path !== this.lastActive) {
            this.lastActive = active.path;
            const entry = notes.find(note => note.file === active);
            [entry?.chapter, entry?.section].forEach(id => id && this.expanded.add(id));
        }
        el.empty();
        const head = el.createDiv('textbook-sidebar-head');
        head.createEl('strong', { text: pdf.basename });
        head.createSpan({ text: ` · ${notes.length} 篇笔记`, cls: 'textbook-sidebar-muted' });
        const chapters = saved?.index.chapters ?? [];
        if (!saved) el.createEl('p', { cls: 'textbook-sidebar-muted', text: '尚未建立章节索引：在 PDF 中运行“教材章节管理（提取与校正）”。以下按页码列出。' });
        const groups = groupNotes(chapters, notes);
        const renderNotes = (parent: HTMLElement, list: NoteEntry[] = []) => {
            for (const note of list) {
                const row = parent.createDiv({ cls: `textbook-sidebar-note tree-item-self is-clickable${note.file === active ? ' is-active' : ''}` });
                row.createSpan({ text: note.file.basename, cls: 'textbook-sidebar-title' });
                row.createSpan({ text: note.printed ? ` 第 ${note.printed} 页` : ` PDF 第 ${note.page} 页`, cls: 'textbook-sidebar-muted' });
                if (['ambiguous', 'conflict', 'missing'].includes(note.status)) row.createSpan({ text: ' · 待确认归属', cls: 'textbook-sidebar-warn' });
                row.onclick = () => void this.app.workspace.getLeaf(false).openFile(note.file);
            }
        };
        const count = (node: Chapter) => (groups.get(node.id)?.length ?? 0) + chapters.filter(child => child.parent_id === node.id).reduce((sum, child) => sum + (groups.get(child.id)?.length ?? 0), 0);
        const renderNode = (parent: HTMLElement, node: Chapter) => {
            const box = parent.createDiv({ cls: `textbook-sidebar-node level-${node.level}` });
            const row = box.createDiv({ cls: 'textbook-sidebar-heading tree-item-self is-clickable' });
            const open = this.expanded.has(node.id);
            const toggle = row.createSpan({ cls: 'textbook-sidebar-toggle', text: open ? '▾' : '▸' });
            const title = row.createSpan({ text: node.title, cls: 'textbook-sidebar-title' });
            row.createSpan({ text: ` ${count(node)}`, cls: 'textbook-sidebar-muted' });
            title.setAttribute('aria-label', `打开第 ${node.start.page} 页`);
            toggle.onclick = event => { event.stopPropagation(); open ? this.expanded.delete(node.id) : this.expanded.add(node.id); void this.refresh(); };
            row.onclick = () => void openTextbookPage(this.plugin, `${pdf.path}#page=${node.start.page}`, '').catch(error => new Notice(String(error)));
            if (!open) return;
            const children = box.createDiv('textbook-sidebar-children');
            renderNotes(children, groups.get(node.id));
            for (const child of chapters.filter(item => item.parent_id === node.id)) renderNode(children, child);
        };
        for (const node of chapters.filter(item => item.level === 1)) renderNode(el, node);
        const unsorted = groups.get(UNSORTED);
        if (unsorted?.length) {
            el.createDiv({ cls: 'textbook-sidebar-heading', text: saved ? `未分章 ${unsorted.length}` : '' });
            renderNotes(el, unsorted);
        }
    }
}

export async function openChapterSidebar(plugin: PDFPlus) {
    const existing = plugin.app.workspace.getLeavesOfType(CHAPTER_VIEW_TYPE)[0];
    const leaf = existing ?? plugin.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: CHAPTER_VIEW_TYPE, active: true });
    await plugin.app.workspace.revealLeaf(leaf);
}
