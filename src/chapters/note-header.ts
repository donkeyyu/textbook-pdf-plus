import { FileView, MarkdownView, Notice, TFile } from 'obsidian';
import type PDFPlus from '../main';
import { frontmatter, readIndex, saveNoteChapter, withProperties } from './store';
import { SuggestionModal, canSuggest } from './suggest-modal';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
// Reuse an open pane for this PDF; navigation always uses the physical page.
export async function openTextbookPage(plugin: PDFPlus, link: string, sourcePath: string) {
    const [path, subpath] = link.split('#');
    const pdf = plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    const existing = pdf && plugin.app.workspace.getLeavesOfType('pdf').find(leaf => leaf.view instanceof FileView && leaf.view.file?.path === pdf.path);
    if (existing && pdf) {
        await existing.openFile(pdf, { eState: { subpath: `#${subpath}` } });
        await plugin.app.workspace.revealLeaf(existing);
    } else await plugin.app.workspace.openLinkText(link, sourcePath, 'split');
}
const TYPE_OPTIONS = { content_type: ['知识点', '习题'], note_type: ['补充', '说明'] } as const;
async function setProperty(plugin: PDFPlus, file: TFile, key: string, value: string) {
    await plugin.app.vault.process(file, current => withProperties(current, { [key]: value || null }));
}

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
            const signature = JSON.stringify([view.file.path, properties]);
            if (header?.dataset.signature === signature) continue;
            header?.remove();
            header = root.createDiv('textbook-note-header');
            root.prepend(header);
            header.dataset.signature = signature;
            const file = view.file;
            const source = header.createEl('button', { text: location.label, cls: 'textbook-note-location' });
            source.setAttribute('aria-label', `返回教材：${location.label}`);
            source.onclick = () => { void openTextbookPage(plugin, location.link, file.path).catch(error => new Notice(message(error))); };
            const chapter = header.createEl('select', { cls: 'textbook-note-chapter', attr: { 'aria-label': '所属章节' } });
            chapter.createEl('option', { text: location.chapter });
            chapter.disabled = true;
            const populate = async () => {
                const { properties } = frontmatter(await plugin.app.vault.read(file));
                const saved = typeof properties.textbook_index === 'string' ? await readIndex(plugin.app, properties.textbook_index, properties.textbook_id) : null;
                if (!chapter.isConnected) return;
                if (!saved) { chapter.options[0].text = '请先建立章节索引'; return; }
                if (properties.textbook_id !== saved.index.textbook_id) throw Error('笔记与索引教材不匹配');
                chapter.empty();
                chapter.createEl('option', { text: `按位置自动匹配 · ${location.chapter}`, value: '' });
                for (const node of saved.index.chapters) {
                    const parent = saved.index.chapters.find(item => item.id === node.parent_id);
                    chapter.createEl('option', { text: parent ? `${parent.title} / ${node.title}` : node.title, value: node.id });
                }
                const selected = properties.chapter_assignment === 'manual' ? String(properties.section_id || properties.chapter_id || '') : '';
                if (selected && !saved.index.chapters.some(node => node.id === selected)) {
                    chapter.createEl('option', { text: '原章节已移除，请重新选择', value: selected });
                }
                chapter.value = selected;
                chapter.disabled = false;
                chapter.onchange = async () => {
                    chapter.disabled = true;
                    try {
                        await saveNoteChapter(plugin.app, file, chapter.value);
                    } catch (error) {
                        chapter.value = selected;
                        new Notice(message(error));
                    } finally {
                        if (header) delete header.dataset.signature;
                        refresh();
                    }
                };
            };
            void populate().catch(error => {
                chapter.options[0].text = '章节加载失败，请重新打开笔记';
                new Notice(message(error));
            });
            for (const [key, values] of Object.entries(TYPE_OPTIONS)) {
                const current = typeof properties?.[key] === 'string' ? properties[key] as string : '';
                const select = header.createEl('select', { cls: 'textbook-note-type', attr: { 'aria-label': key === 'content_type' ? '内容类型' : '笔记类型' } });
                select.createEl('option', { text: key === 'content_type' ? '内容类型' : '笔记类型', value: '' });
                for (const value of new Set([...values, ...(current ? [current] : [])])) select.createEl('option', { text: value, value });
                select.value = current;
                select.onchange = () => {
                    select.disabled = true;
                    void setProperty(plugin, file, key, select.value).catch(error => { select.value = current; new Notice(message(error)); }).finally(() => select.disabled = false);
                };
            }
            if (canSuggest(plugin, file)) {
                const ai = header.createEl('button', { text: 'AI 建议', cls: 'textbook-note-ai' });
                ai.setAttribute('aria-label', '用 AI 生成本笔记的标题、知识点和补充说明');
                ai.onclick = () => new SuggestionModal(plugin, file).open();
            }
            if (location.status) header.createEl('span', { text: location.status, cls: 'textbook-note-status', attr: { role: 'status' } });
        }
    };
    plugin.registerEvent(plugin.app.workspace.on('layout-change', refresh));
    plugin.registerEvent(plugin.app.workspace.on('file-open', refresh));
    plugin.registerEvent(plugin.app.metadataCache.on('changed', refresh));
    // A saved or moved index changes the chapter list, so rebuild headers even though note properties did not change.
    const indexChanged = (file: { path: string }) => {
        if (!file.path.endsWith('.json')) return;
        document.querySelectorAll<HTMLElement>('.textbook-note-header').forEach(header => delete header.dataset.signature);
        refresh();
    };
    plugin.registerEvent(plugin.app.vault.on('create', indexChanged));
    plugin.registerEvent(plugin.app.vault.on('modify', indexChanged));
    plugin.registerEvent(plugin.app.vault.on('rename', indexChanged));
    plugin.app.workspace.onLayoutReady(refresh);
    plugin.register(() => {
        for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
            leaf.view.containerEl.querySelectorAll('.textbook-note-header').forEach(el => el.remove());
            leaf.view.containerEl.querySelectorAll('.textbook-note-view').forEach(el => el.removeClass('textbook-note-view'));
        }
    });
}
