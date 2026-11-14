import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type PDFPlus from '../main';
import DEFAULT_TEMPLATE from '../../templates/教材框选笔记.md';
import { renderTextbookSettings } from './settings-ui';

export const DEFAULT_TEMPLATE_PATH = 'Templates/教材框选笔记.md';

// Writes the bundled template when the path is free; an existing file is never replaced.
export async function ensureTemplate(app: App, path: string) {
    const target = normalizePath(path.trim() || DEFAULT_TEMPLATE_PATH);
    const existing = app.vault.getAbstractFileByPath(target);
    if (existing instanceof TFile) return 'exists';
    if (existing) throw new Error(`${target} 已被文件夹占用`);
    const folder = target.split('/').slice(0, -1).join('/');
    if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    await app.vault.create(target, DEFAULT_TEMPLATE);
    return 'created';
}

// Start page for students: environment checklist first, then the learning steps in the order they are used.
export class TextbookGuideModal extends Modal {
    constructor(private plugin: PDFPlus) { super(plugin.app); }

    onOpen() {
        this.modalEl.addClass('textbook-guide');
        this.titleEl.setText('教材学习 · 开始使用');
        this.render();
    }

    onClose() { this.contentEl.empty(); }

    private render() {
        const el = this.contentEl;
        el.empty();
        el.createEl('h3', { text: '第一步：准备环境' });
        el.createEl('p', { cls: 'setting-item-description', text: `确认下面的设置。修改会自动保存，之后也可以在 设置 → ${this.plugin.manifest.name} 中修改。` });
        renderTextbookSettings(this.plugin, el.createDiv(), () => this.render());

        el.createEl('h3', { text: '第二步：开始学习' });
        const steps: [string, string, (() => void)?, string?][] = [
            ['打开教材 PDF', '把教材 PDF 放进库中，在文件列表里点击打开。'],
            ['建立章节目录', '在 PDF 中运行“教材章节管理”，读取书签或用 AI 识别章节，核对后保存。', () => this.run('textbook-chapters', '请先打开教材 PDF，再建立章节。'), '建立章节'],
            ['框选做笔记', '点击 PDF 工具栏的“框选笔记”，从左上拖到右下。笔记会在旁边打开，并自动归入章节。', () => this.run('rectangle-note', '请先打开教材 PDF，再框选。'), '开始框选'],
            ['按章节复习', '章节侧栏按章节列出全部笔记，可搜索，点一下即可跳回原文。', () => this.run('textbook-chapter-sidebar', ''), '打开章节侧栏'],
            ['AI 建议（可选）', '在笔记顶部栏点击“AI 建议”。发送前会列出要发送的内容，确认后才写入笔记。'],
        ];
        steps.forEach(([name, desc, action, label], i) => {
            const setting = new Setting(el).setName(`${i + 1}. ${name}`).setDesc(desc);
            if (action && label) setting.addButton(button => button.setButtonText(label).onClick(action));
        });

        el.createEl('p', { cls: 'setting-item-description', text: '随时可以点击左侧栏的学士帽图标，或在命令面板搜索“教材学习”，再次打开本页。' });
    }

    // Commands check their own preconditions (an open PDF); explain the next step instead of failing silently.
    private run(command: string, hint: string) {
        this.close();
        if (!this.app.commands.executeCommandById(`${this.plugin.manifest.id}:${command}`) && hint) new Notice(hint);
    }
}
