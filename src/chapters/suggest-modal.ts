import { Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type PDFPlus from '../main';
import type { Rect } from '../typings';
import { noteLocation } from './note-header';
import { apiKey, frontmatter } from './store';
import { Suggestion, applySuggestion, regionText, requestSuggestion } from './suggest';

// Reuse an open viewer's document; otherwise load one and release it afterwards.
export async function withTextbookDocument<T>(plugin: PDFPlus, pdf: TFile, use: (doc: PDFDocumentProxy) => Promise<T>) {
    let open: PDFDocumentProxy | undefined;
    plugin.lib.workspace.iteratePDFViewerChild(child => {
        if (!open && child.file?.path === pdf.path) open = child.pdfViewer.pdfViewer?.pdfDocument;
    });
    if (open) return use(open);
    const doc = await plugin.lib.loadPDFDocument(pdf);
    try { return await use(doc); } finally { void doc.destroy(); }
}

export function canSuggest(plugin: PDFPlus, file: TFile | null) {
    const properties = file && plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!properties && !!noteLocation(properties) && Array.isArray(properties.pdf_rect) && properties.pdf_rect.length === 4;
}

export class SuggestionModal extends Modal {
    private sending = false;
    constructor(private plugin: PDFPlus, private note: TFile) { super(plugin.app); }

    onOpen() {
        this.titleEl.setText('AI 笔记建议');
        const { textbookAIBaseUrl: url, textbookAIModel: model, textbookAISendImage: image } = this.plugin.settings;
        this.contentEl.createEl('p', { text: `将发送到 ${url || '未配置的服务'}（${model || '未配置模型'}）：${image ? '框选区域图片、' : ''}框内文字、章节名称和本笔记正文（前 4000 字）。调用可能产生服务商费用。` });
        this.contentEl.createEl('p', { cls: 'setting-item-description', text: '返回结果先在此核对，确认后才写入笔记；已有内容不会被覆盖。' });
        const status = this.contentEl.createEl('p', { cls: 'textbook-index-status' });
        new Setting(this.contentEl).addButton(button => button.setButtonText('发送并生成建议').setCta().onClick(async () => {
            if (this.sending) return;
            this.sending = true; button.setDisabled(true); status.setText('正在生成建议…');
            try { this.review(await this.request()); } catch (error) {
                status.setText(error instanceof Error ? error.message : String(error));
            } finally { this.sending = false; button.setDisabled(false); }
        }));
    }

    private async request() {
        const { textbookAIBaseUrl, textbookAIModel, textbookAISendImage } = this.plugin.settings;
        const key = apiKey(this.app);
        if (!key) throw Error('请先在教材笔记管理中保存 api_key');
        const content = await this.app.vault.read(this.note);
        const { properties, body } = frontmatter(content);
        const location = noteLocation(properties);
        const rect = properties.pdf_rect as Rect;
        if (!location || !Array.isArray(rect) || rect.length !== 4) throw Error('此笔记没有框选区域');
        const pdf = this.app.metadataCache.getFirstLinkpathDest(location.link.split('#')[0], this.note.path);
        if (!pdf) throw Error('找不到教材 PDF');
        const page = Number(properties.pdf_page);
        const { text, image } = await withTextbookDocument(this.plugin, pdf, async doc => ({
            text: await regionText(doc, page, rect),
            image: textbookAISendImage ? await this.plugin.lib.pdfPageToImageDataUrl(await doc.getPage(page), { type: 'image/jpeg', encoderOptions: 0.85, resolution: 2, cropRect: rect }) : undefined,
        }));
        if (!text.trim() && !image) throw Error('框内没有可提取文字；请开启“附带框选图片”后重试');
        return requestSuggestion(textbookAIBaseUrl.trim(), textbookAIModel.trim(), key, { textbook: pdf.basename, chapter: location.chapter, page: location.label, text, note: body }, image);
    }

    private review(suggestion: Suggestion) {
        const el = this.contentEl;
        el.empty();
        const choice = { rename: !!suggestion.title, ...suggestion, concepts: suggestion.concepts.join('、'), useExplanation: !!suggestion.explanation, useHint: !!suggestion.hint };
        el.createEl('p', { cls: 'setting-item-description', text: 'AI 建议仅供参考，请对照原页核对后再写入。' });
        new Setting(el).setName('标题（重命名笔记）').addText(text => text.setValue(choice.title).onChange(value => choice.title = value))
            .addToggle(toggle => toggle.setValue(choice.rename).onChange(value => choice.rename = value));
        new Setting(el).setName('类型').addDropdown(dropdown => dropdown.addOptions({ '': '不修改', 知识点: '知识点', 习题: '习题' }).setValue(choice.content_type).onChange(value => choice.content_type = value as Suggestion['content_type']));
        new Setting(el).setName('知识点').setDesc('用顿号分隔；写入 concepts 属性，作为图谱连接。').addText(text => text.setValue(choice.concepts).onChange(value => choice.concepts = value));
        const area = (name: string, key: 'explanation' | 'hint', toggleKey: 'useExplanation' | 'useHint') => {
            new Setting(el).setName(name).addToggle(toggle => toggle.setValue(choice[toggleKey]).onChange(value => choice[toggleKey] = value));
            const input = el.createEl('textarea', { cls: 'textbook-suggestion-text' });
            input.value = choice[key]; input.rows = 6;
            input.oninput = () => choice[key] = input.value;
        };
        area('插入“理解”', 'explanation', 'useExplanation');
        area('插入“思路与方法”（折叠）', 'hint', 'useHint');
        new Setting(el).addButton(button => button.setButtonText('写入笔记').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                const concepts = choice.concepts.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);
                await this.app.vault.process(this.note, current => applySuggestion(current, {
                    content_type: choice.content_type, concepts,
                    explanation: choice.useExplanation ? choice.explanation.trim() : '', hint: choice.useHint ? choice.hint.trim() : '',
                }));
                const title = choice.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
                if (choice.rename && title && title !== this.note.basename) {
                    const target = normalizePath(`${this.note.parent?.path ?? ''}/${title}.md`);
                    if (this.app.vault.getAbstractFileByPath(target)) new Notice(`已有同名笔记，未重命名：${title}`);
                    else await this.app.fileManager.renameFile(this.note, target);
                }
                this.close(); new Notice('笔记建议已写入');
            } catch (error) {
                new Notice(error instanceof Error ? error.message : String(error));
                button.setDisabled(false);
            }
        }));
    }
}
