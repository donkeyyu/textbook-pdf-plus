import { Modal, Notice, Setting } from 'obsidian';
import type PDFPlus from '../main';
import type { PDFViewerChild } from '../typings';
import { Chapter, ChapterIndex, Heading, headingsToChapters, mergeCandidates, validateIndex } from './model';
import { affectedNotes, apiKey, frontmatter, indexIdentity, outlineHeadings, pageLines, readIndex, requestHeadings, saveIndex } from './store';

export class ChaptersModal extends Modal {
    private index: ChapterIndex;
    private path: string;
    private raw: string | null = null;
    private busy = false;
    private cancelled = false;
    private first = 1;
    private last = 1;
    constructor(private plugin: PDFPlus, private child: PDFViewerChild) { super(plugin.app); }
    private get doc() { return this.child.pdfViewer.pdfViewer!.pdfDocument; }
    async onOpen() {
        this.titleEl.setText('教材章节管理');
        try {
            const pdf = this.child.file!;
            const identity = await indexIdentity(this.app, pdf, this.doc.numPages, this.plugin.settings.textbookIndexFolder);
            this.path = identity.path;
            const saved = await readIndex(this.app, this.path);
            this.index = saved?.index ?? identity.empty;
            if (this.index.pdf_sha256 !== identity.empty.pdf_sha256) throw Error('索引与教材不匹配');
            this.raw = saved?.raw ?? null;
            this.last = this.doc.numPages;
            this.render();
        } catch (error) { this.contentEl.setText(String(error)); }
    }
    onClose() { this.cancelled = true; }
    private report(error: unknown) { new Notice(error instanceof Error ? error.message : String(error), 10000); }
    private import(headings: Heading[], lastPage = this.doc.numPages) {
        if (!headings.length) { new Notice('未发现章、节标题；可手动添加或尝试其他页范围'); return; }
        const candidates = headingsToChapters(headings, lastPage, () => crypto.randomUUID());
        this.index.chapters = mergeCandidates(this.index.chapters, candidates);
        this.render();
        new Notice('候选已载入。请核对原页、父章及起止位置，再预览保存；已有章节保持不变。', 10000);
    }
    private async run(action: () => Promise<void>) {
        if (this.busy) return;
        this.busy = true;
        try { await action(); } catch (error) { this.report(error); }
        finally { this.busy = false; }
    }
    private render() {
        const el = this.contentEl;
        el.empty(); this.modalEl.addClass('textbook-chapters-modal');
        el.createEl('p', { text: `${this.child.file!.basename} · ${this.doc.numPages} 页。位置使用 PDF 页序；页内位置从顶部 0% 到底部 100%。名称可改，ID 不变。` });
        new Setting(el).setName('提取章节候选')
            .addButton(button => button.setButtonText('读取 PDF 目录（本地）').onClick(() => this.run(async () => this.import(await outlineHeadings(this.doc)))));
        new Setting(el).setName('AI 提取页范围').setDesc('默认全书；可分批提取。仅发送选定页的文字和行位置，不发送整份 PDF。扫描页无文字时需先 OCR。')
            .addText(text => text.setValue(String(this.first)).then(text => { text.inputEl.type = 'number'; text.inputEl.setAttribute('aria-label', 'AI 起始页'); }).onChange(value => this.first = Number(value)))
            .addText(text => text.setValue(String(this.last)).then(text => { text.inputEl.type = 'number'; text.inputEl.setAttribute('aria-label', 'AI 结束页'); }).onChange(value => this.last = Number(value)));
        const status = el.createEl('p', { cls: 'textbook-index-status', text: `接收服务：${this.plugin.settings.textbookAIBaseUrl || '未配置'} · 模型：${this.plugin.settings.textbookAIModel || '未配置'}。调用可能产生服务商费用。` });
        new Setting(el).setName('云端提取（结果须校正后保存）')
            .addButton(button => button.setButtonText('发送选定页文字并提取').onClick(() => this.run(async () => {
                const { first, last } = this;
                const baseUrl = this.plugin.settings.textbookAIBaseUrl.trim(), model = this.plugin.settings.textbookAIModel.trim();
                if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > this.doc.numPages || first > last) throw Error('请选择有效的 PDF 页范围');
                const key = apiKey(this.app);
                if (!key) throw Error('请先在教材笔记管理中保存 api_key');
                this.cancelled = false;
                const headings: Heading[] = [], emptyPages: number[] = [];
                for (let page = first; page <= last; page += 6) {
                    if (this.cancelled) return;
                    const pages = [];
                    for (let n = page; n <= Math.min(last, page + 5); n++) {
                        const data = await pageLines(this.doc, n);
                        if (!data.lines.some(line => line.text.trim())) emptyPages.push(n);
                        else pages.push(data);
                    }
                    status.setText(`正在提取 PDF 第 ${page}–${Math.min(last, page + 5)} 页…`);
                    if (pages.length) headings.push(...await requestHeadings(baseUrl, model, key, pages));
                }
                if (this.cancelled) return;
                this.import(headings, last);
                if (emptyPages.length) new Notice(`以下页无可提取文字，未识别：${emptyPages.join('、')}。需 OCR 或手动补充。`, 15000);
                status.setText('提取完成；候选尚未保存。');
            })))
            .addButton(button => button.setButtonText('取消提取').onClick(() => { this.cancelled = true; status.setText('已取消后续处理；正在发送的请求可能仍会完成。'); }));
        new Setting(el).setName('校正目录')
            .addButton(button => button.setButtonText('添加章').onClick(() => this.addNode(1)))
            .addButton(button => button.setButtonText('添加节').onClick(() => this.addNode(2)));
        for (const node of this.index.chapters) {
            const row = el.createDiv('textbook-chapter-row');
            new Setting(row).setName(node.level === 1 ? '章' : '节')
                .addText(text => text.setValue(node.title).then(text => text.inputEl.setAttribute('aria-label', `章节名称 ${node.id}`)).onChange(value => node.title = value))
                .addButton(button => button.setButtonText('查看原页').onClick(() => {
                    void this.app.workspace.openLinkText(`${this.child.file!.path}#page=${node.start.page}`, '', false);
                }))
                .addButton(button => button.setButtonText('移除候选').onClick(() => {
                    if (this.busy) return;
                    this.index.chapters = this.index.chapters.filter(item => item.id !== node.id);
                    this.render();
                }));
            row.createEl('small', { text: `ID：${node.id} · 来源：${node.source} · 移除/拆分/合并均在保存预览中检查笔记迁移` });
            if (node.level === 2) new Setting(row).setName('所属章').addDropdown(dropdown => {
                dropdown.addOption('', '请选择');
                this.index.chapters.filter(item => item.level === 1).forEach(parent => dropdown.addOption(parent.id, parent.title));
                dropdown.setValue(node.parent_id ?? '').onChange(value => node.parent_id = value || null);
            });
            for (const [key, label] of [['start', '起点'], ['end', '终点']] as const) {
                new Setting(row).setName(`${label}：PDF 页 / 页内百分比`)
                    .addText(text => text.setValue(String(node[key].page)).then(text => { text.inputEl.type = 'number'; text.inputEl.setAttribute('aria-label', `${label}页 ${node.id}`); }).onChange(value => node[key].page = Number(value)))
                    .addText(text => text.setValue(String(Math.round(node[key].y * 10000) / 100)).then(text => { text.inputEl.type = 'number'; text.inputEl.setAttribute('aria-label', `${label}百分比 ${node.id}`); }).onChange(value => node[key].y = Number(value) / 100));
            }
        }
        new Setting(el).setName('保存索引与笔记关联')
            .setDesc('请先核对原页。保存前显示受影响笔记；手动指定的关联只提示冲突，不自动覆盖。')
            .addButton(button => button.setButtonText('预览保存').setCta().onClick(() => this.run(async () => {
                validateIndex(this.index);
                const draft = structuredClone(this.index);
                const baselineRaw = this.raw;
                const changes = await affectedNotes(this.app, draft);
                const preview = new Modal(this.app);
                preview.titleEl.setText('确认章节索引及关联更新');
                preview.contentEl.createEl('p', { text: `${draft.chapters.length} 个章节，${changes.length} 篇笔记将更新。索引按教材内容哈希保存；名称变更保留 ID。` });
                const list = preview.contentEl.createEl('ul');
                for (const change of changes) {
                    const before = frontmatter(change.before).properties, after = frontmatter(change.after).properties;
                    list.createEl('li', { text: `${change.file.basename}：${before.chapter_title || '未分章'} / ${before.section_title || '未分节'} → ${after.chapter_title || '未分章'} / ${after.section_title || '未分节'}（${after.chapter_status}）` });
                }
                let saving = false;
                new Setting(preview.contentEl).addButton(button => button.setButtonText('确认保存并更新关联').setCta().onClick(async () => {
                    if (saving) return;
                    saving = true; button.setDisabled(true);
                    try {
                        const identity = await indexIdentity(this.app, this.child.file!, this.doc.numPages, this.plugin.settings.textbookIndexFolder);
                        if (identity.empty.pdf_sha256 !== draft.pdf_sha256) throw Error('教材已更改，请重新打开章节管理');
                        this.raw = await saveIndex(this.app, this.path, draft, baselineRaw);
                        this.index = draft;
                        const failed: string[] = [];
                        for (const change of changes) {
                            try {
                                await this.app.vault.process(change.file, current => {
                                    if (current !== change.before) throw Error('笔记已更改');
                                    return change.after;
                                });
                            } catch { failed.push(change.file.path); }
                        }
                        preview.close(); this.render();
                        new Notice(failed.length ? `索引已保存；以下笔记未更新，请再次预览保存重试：${failed.join('、')}` : '章节索引与笔记关联已保存', 12000);
                    } catch (error) { this.report(error); }
                    finally { saving = false; button.setDisabled(false); }
                }));
                preview.open();
            })));
    }
    private addNode(level: 1 | 2) {
        if (this.busy) return;
        const parent = [...this.index.chapters].reverse().find(node => node.level === 1);
        const node: Chapter = { id: crypto.randomUUID(), title: level === 1 ? '新章（请校正范围）' : '新节（请校正范围）', level, parent_id: level === 2 ? parent?.id ?? null : null, start: { page: 1, y: 0 }, end: { page: this.doc.numPages, y: 1 }, source: 'manual' };
        this.index.chapters.push(node); this.render();
    }
}
