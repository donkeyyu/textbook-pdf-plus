import { FileView, MarkdownView, Notice } from 'obsidian';
import type PDFPlus from '../main';
import { chooseNoteChapter } from './panel';

export function noteLocation(properties: Record<string, unknown>) {
    const raw = properties.textbook;
    const link = typeof raw === 'string' ? raw.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0] : '';
    const page = Number(properties.pdf_page);
    if (!link || !Number.isInteger(page) || page < 1) return null;
    const name = link.split('/').pop()!.replace(/\.pdf$/i, '');
    const printed = String(properties.printed_page ?? '').trim();
    const chapter = [properties.chapter_title, properties.section_title].filter(value => typeof value === 'string' && value.trim()).join(' / ');
    const statuses: Record<string, string> = { ambiguous: '框选跨越章节，请选择归属', conflict: '手动章节与位置不符', missing: '原章节已移除，请重新选择', unindexed: '尚未建立章节索引', unassigned: '此位置尚未分配章节', region_removed: '框选已删除，保留页码位置' };
    return { label: `${name} · ${printed ? `第 ${printed} 页` : `PDF 第 ${page} 页`}`, link: `${link}#page=${page}`, chapter: chapter || '选择所属章节', status: statuses[String(properties.chapter_status)] ?? '' };
}

export function registerNoteHeaders(plugin: PDFPlus) {
    const refresh = () => {
        for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;
            const root = view.contentEl;
            const properties = view.file && plugin.app.metadataCache.getFileCache(view.file)?.frontmatter;
            const location = properties && properties.textbook_id ? noteLocation(properties) : null;
            root.toggleClass('textbook-note-view', !!location);
            let header = root.querySelector<HTMLElement>(':scope > .textbook-note-header');
            if (!location || !view.file) { header?.remove(); continue; }
            const signature = JSON.stringify([view.file.path, location]);
            if (header?.dataset.signature === signature) continue;
            header?.remove();
            header = root.createDiv('textbook-note-header');
            root.prepend(header);
            header.dataset.signature = signature;
            const file = view.file;
            const source = header.createEl('button', { text: location.label, cls: 'textbook-note-location' });
            source.setAttribute('aria-label', `返回教材：${location.label}`);
            source.onclick = () => {
                const open = async () => {
                    const [path, subpath] = location.link.split('#');
                    const pdf = plugin.app.metadataCache.getFirstLinkpathDest(path, file.path);
                    const existing = pdf && plugin.app.workspace.getLeavesOfType('pdf').find(leaf => leaf.view instanceof FileView && leaf.view.file?.path === pdf.path);
                    if (existing && pdf) {
                        await existing.openFile(pdf, { eState: { subpath: `#${subpath}` } });
                        await plugin.app.workspace.revealLeaf(existing);
                    } else await plugin.app.workspace.openLinkText(location.link, file.path, 'split');
                };
                void open().catch(error => new Notice(String(error)));
            };
            const chapter = header.createEl('button', { text: location.chapter, cls: 'textbook-note-chapter' });
            chapter.setAttribute('aria-label', `修改所属章节：${location.chapter}`);
            chapter.onclick = () => { void chooseNoteChapter(plugin, file).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
            if (location.status) header.createEl('span', { text: location.status, cls: 'textbook-note-status', attr: { role: 'status' } });
        }
    };
    plugin.registerEvent(plugin.app.workspace.on('layout-change', refresh));
    plugin.registerEvent(plugin.app.workspace.on('file-open', refresh));
    plugin.registerEvent(plugin.app.metadataCache.on('changed', refresh));
    plugin.app.workspace.onLayoutReady(refresh);
    plugin.register(() => {
        for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
            leaf.view.containerEl.querySelectorAll('.textbook-note-header').forEach(el => el.remove());
            leaf.view.containerEl.querySelectorAll('.textbook-note-view').forEach(el => el.removeClass('textbook-note-view'));
        }
    });
}
