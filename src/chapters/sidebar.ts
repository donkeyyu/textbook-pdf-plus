import { ItemView, Notice, SearchComponent, TFile, WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import type PDFPlus from '../main';
import type { Chapter } from './model';
import { TextbookGuideModal } from './guide';
import { noteLocation, openTextbookPage } from './note-header';
import { DEFAULT_INDEX_FOLDER, pdfHash, readIndex, textbookId } from './store';

export const CHAPTER_VIEW_TYPE = 'textbook-chapter-sidebar';
type NoteEntry = { file: TFile; page: number; printed: string; top: number; chapter: string | null; section: string | null; status: string };
const UNSORTED = '__unsorted';
const noteGroup = (note: NoteEntry, known: Set<string>) => note.section && known.has(note.section) ? note.section : note.chapter && known.has(note.chapter) ? note.chapter : UNSORTED;

// Groups notes by their stored chapter/section IDs; notes without a valid ID fall into the unsorted group.
export function groupNotes(chapters: Chapter[], notes: NoteEntry[]) {
    const known = new Set(chapters.map(node => node.id));
    const groups = new Map<string, NoteEntry[]>();
    const sorted = [...notes].sort((a, b) => a.page - b.page || a.top - b.top || a.file.path.localeCompare(b.file.path));
    for (const note of sorted) {
        const key = noteGroup(note, known);
        groups.set(key, [...groups.get(key) ?? [], note]);
    }
    return groups;
}

// Search the displayed names, including a section's parent; keep ancestors so results retain context.
export function filterSidebar(chapters: Chapter[], notes: NoteEntry[], query: string) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { chapters, notes };
    const byId = new Map(chapters.map(node => [node.id, node]));
    const known = new Set(byId.keys());
    const title = (id: string) => {
        const node = byId.get(id);
        return node ? `${node.title} ${byId.get(node.parent_id ?? '')?.title ?? ''}` : '未分章';
    };
    const matches = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term));
    const visible = new Set(chapters.filter(node => matches(title(node.id))).map(node => node.id));
    const filtered = notes.filter(note => matches(`${note.file.basename} ${title(noteGroup(note, known))}`));
    for (const note of filtered) visible.add(noteGroup(note, known));
    for (const id of [...visible]) {
        const parent = byId.get(id)?.parent_id;
        if (parent) visible.add(parent);
    }
    return { chapters: chapters.filter(node => visible.has(node.id)), notes: filtered };
}

export class ChapterSidebarView extends ItemView {
    private pdf: TFile | null = null;
    // Chapters start collapsed; the active note's chapter and section open when that note becomes active.
    private expanded = new Set<string>();
    private lastActive = '';
    private generation = 0;
    private query = '';
    private search: SearchComponent;
    private head: HTMLElement;
    private results: HTMLElement;
    private renderResults = () => {};
    private requestRefresh = debounce(() => void this.refresh(), 300, true);
    constructor(leaf: WorkspaceLeaf, private plugin: PDFPlus) { super(leaf); }
    getViewType() { return CHAPTER_VIEW_TYPE; }
    getDisplayText() { return '教材章节'; }
    getIcon() { return 'list-tree'; }

    async onOpen() {
        this.contentEl.empty();
        this.contentEl.addClass('textbook-sidebar');
        this.head = this.contentEl.createDiv('textbook-sidebar-head');
        this.search = new SearchComponent(this.contentEl).setPlaceholder('搜索笔记或章节').onChange(value => {
            this.query = value;
            this.renderResults();
            this.results.scrollTop = 0;
        });
        this.search.inputEl.setAttribute('aria-label', '搜索本教材的笔记或章节');
        this.results = this.contentEl.createDiv('textbook-sidebar-results');
        this.search.inputEl.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.query) {
                event.preventDefault(); event.stopPropagation();
                this.clearSearch();
            }
        });
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.requestRefresh()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.requestRefresh()));
        this.registerEvent(this.app.vault.on('rename', () => this.requestRefresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.requestRefresh()));
        const indexChanged = (file: TFile) => { if (file.extension === 'json' || file.extension === 'pdf') this.requestRefresh(); };
        this.registerEvent(this.app.vault.on('modify', indexChanged));
        this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) indexChanged(file); }));
        await this.refresh();
    }

    async onClose() { this.generation++; this.requestRefresh.cancel(); }

    private clearSearch() {
        this.query = '';
        this.search.setValue('');
        this.renderResults();
        this.search.inputEl.focus();
    }

    // Follows the active PDF, or the textbook of the active note; keeps the last textbook otherwise.
    private currentTextbook() {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension === 'pdf') return file;
        const properties = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
        const location = properties && noteLocation(properties);
        const pdf = location && this.app.metadataCache.getFirstLinkpathDest(location.link.split('#')[0], file!.path);
        if (pdf?.extension === 'pdf') return pdf;
        return this.pdf && this.app.vault.getAbstractFileByPath(this.pdf.path) === this.pdf ? this.pdf : null;
    }

    async refresh() {
        const generation = ++this.generation;
        const pdf = this.currentTextbook();
        if (pdf !== this.pdf) {
            this.pdf = pdf;
            this.query = ''; this.search.setValue('');
            this.expanded.clear(); this.lastActive = '';
            this.results.empty();
            this.renderResults = () => {};
        }
        this.search.setDisabled(!pdf);
        if (!pdf) {
            this.head.setText('教材章节');
            this.results.setText('打开教材 PDF 或教材笔记后，这里按章节列出笔记。');
            this.results.createEl('button', { text: '查看使用指南' }).onclick = () => new TextbookGuideModal(this.plugin).open();
            return;
        }
        this.head.setText(pdf.basename);
        if (!this.results.hasChildNodes()) this.results.createEl('p', { text: '正在读取教材笔记…', attr: { role: 'status' } });
        try {
            const hash = await pdfHash(this.app, pdf);
            const id = textbookId(hash);
            const folder = this.plugin.settings.textbookIndexFolder.trim() || DEFAULT_INDEX_FOLDER;
            const saved = await readIndex(this.app, `${folder}/${hash}.json`, id);
            if (generation !== this.generation) return;
            if (saved && saved.index.textbook_id !== id) throw Error('章节索引与教材不匹配');
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
            const active = this.app.workspace.getActiveFile();
            if (active && active.path !== this.lastActive) {
                this.lastActive = active.path;
                const entry = notes.find(note => note.file === active);
                const section = saved?.index.chapters.find(node => node.id === entry?.section);
                [entry?.chapter, entry?.section, section?.parent_id].forEach(id => id && this.expanded.add(id));
            }
            this.head.empty();
            this.head.createEl('strong', { text: pdf.basename });
            this.head.createSpan({ text: ` · ${notes.length} 篇笔记`, cls: 'textbook-sidebar-muted' });
            this.renderResults = () => this.render(pdf, saved?.index.chapters ?? [], notes, active, !!saved);
            this.renderResults();
        } catch {
            if (generation !== this.generation) return;
            this.renderResults = () => {};
            this.results.empty();
            this.results.createEl('p', { text: '无法读取教材或章节索引。请检查文件是否可用，再重试。', attr: { role: 'alert' } });
            this.results.createEl('button', { text: '重试' }).onclick = () => void this.refresh();
        }
    }

    private render(pdf: TFile, allChapters: Chapter[], allNotes: NoteEntry[], active: TFile | null, indexed: boolean) {
        const el = this.results;
        const scrollTop = el.scrollTop;
        el.empty();
        const searching = !!this.query.trim();
        const { chapters, notes } = filterSidebar(allChapters, allNotes, this.query);
        if (!indexed) el.createEl('p', { cls: 'textbook-sidebar-muted', text: '尚未建立章节索引：在 PDF 中运行“教材章节管理（提取与校正）”。以下按页码列出。' });
        if (searching) {
            el.createEl('p', { cls: 'textbook-sidebar-muted', text: `找到 ${notes.length} 篇笔记`, attr: { role: 'status' } });
            if (!notes.length && !chapters.length) {
                el.createEl('p', { text: '没有匹配的笔记或章节。试试更短的名称，或清除搜索。' });
                el.createEl('button', { text: '清除搜索' }).onclick = () => this.clearSearch();
            }
        } else if (!allNotes.length) {
            el.createEl('p', { cls: 'textbook-sidebar-muted', text: '还没有教材笔记。在 PDF 工具栏点击“框选笔记”，拖出一个方框即可创建。' });
            el.createEl('button', { text: '打开教材' }).onclick = () => void openTextbookPage(this.plugin, `${pdf.path}#page=1`, '').catch(error => new Notice(String(error)));
        }
        const groups = groupNotes(allChapters, notes);
        const renderNotes = (parent: HTMLElement, list: NoteEntry[] = []) => {
            for (const note of list) {
                const row = parent.createEl('button', { cls: `textbook-sidebar-note tree-item-self is-clickable${note.file === active ? ' is-active' : ''}`, attr: { type: 'button' } });
                if (note.file === active) row.setAttribute('aria-current', 'page');
                row.createSpan({ text: note.file.basename, cls: 'textbook-sidebar-title' });
                row.createSpan({ text: note.printed ? ` 第 ${note.printed} 页` : ` PDF 第 ${note.page} 页`, cls: 'textbook-sidebar-muted' });
                if (['ambiguous', 'conflict', 'missing'].includes(note.status)) row.createSpan({ text: ' · 待确认归属', cls: 'textbook-sidebar-warn' });
                row.onclick = () => void this.plugin.lib.workspace.openMarkdownLinkFromPDF(note.file.path, pdf.path, false).catch(error => new Notice(String(error)));
            }
        };
        const count = (node: Chapter) => (groups.get(node.id)?.length ?? 0) + chapters.filter(child => child.parent_id === node.id).reduce((sum, child) => sum + (groups.get(child.id)?.length ?? 0), 0);
        const renderNode = (parent: HTMLElement, node: Chapter) => {
            const box = parent.createDiv({ cls: `textbook-sidebar-node level-${node.level}` });
            const row = box.createDiv({ cls: 'textbook-sidebar-heading' });
            let open = searching || this.expanded.has(node.id);
            const toggle = row.createEl('button', { cls: 'textbook-sidebar-toggle', attr: { type: 'button' } });
            const title = row.createEl('button', { cls: 'textbook-sidebar-title tree-item-self is-clickable', attr: { type: 'button', 'aria-label': `${node.title}，打开 PDF 第 ${node.start.page} 页` } });
            title.createSpan({ text: node.title });
            title.createSpan({ text: ` ${count(node)}`, cls: 'textbook-sidebar-muted' });
            title.onclick = () => void openTextbookPage(this.plugin, `${pdf.path}#page=${node.start.page}`, '').catch(error => new Notice(String(error)));
            const children = box.createDiv('textbook-sidebar-children');
            const renderChildren = () => {
                toggle.setAttribute('aria-expanded', String(open));
                toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}${node.title}`);
                setIcon(toggle, open ? 'chevron-down' : 'chevron-right');
                children.hidden = !open;
                children.empty();
                if (!open) return;
                renderNotes(children, groups.get(node.id));
                for (const child of chapters.filter(item => item.parent_id === node.id)) renderNode(children, child);
            };
            toggle.onclick = () => {
                open = !open;
                if (!searching) open ? this.expanded.add(node.id) : this.expanded.delete(node.id);
                renderChildren();
            };
            renderChildren();
        };
        for (const node of chapters.filter(item => item.level === 1)) renderNode(el, node);
        const unsorted = groups.get(UNSORTED);
        if (unsorted?.length) {
            if (indexed) el.createDiv({ cls: 'textbook-sidebar-heading', text: `未分章 ${unsorted.length}` });
            renderNotes(el, unsorted);
        }
        el.scrollTop = scrollTop;
    }
}

export async function openChapterSidebar(plugin: PDFPlus) {
    const existing = plugin.app.workspace.getLeavesOfType(CHAPTER_VIEW_TYPE)[0];
    const leaf = existing ?? plugin.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: CHAPTER_VIEW_TYPE, active: true });
    await plugin.app.workspace.revealLeaf(leaf);
}
