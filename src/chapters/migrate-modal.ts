import { Modal, Notice, Platform, Setting, TFile, normalizePath } from 'obsidian';
import type PDFPlus from '../main';
import { ElectronCatalog, MigrationBook, catalogToIndex, convertNote } from './migration';
import { DEFAULT_INDEX_FOLDER, pdfHash, readIndex, saveIndex } from './store';

type NodeFs = { readFile(path: string): Promise<Uint8Array>; readFile(path: string, encoding: 'utf8'): Promise<string>; readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>; stat(path: string): Promise<{ size: number }> };
type BookPlan = { catalog: ElectronCatalog; folder: string; pdf: TFile | null; copyTo: string; indexPath: string; indexExists: boolean; indexError: string; chapterCount: number };
type Plan = { books: BookPlan[]; notes: { relative: string; target: string; exists: boolean }[] };
const node = () => {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (!Platform.isDesktopApp || !req) throw Error('迁移需要桌面版 Obsidian');
    return { fs: req('fs/promises') as NodeFs, path: req('path') as { join(...parts: string[]): string } };
};
const safeName = (name: string) => name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || '教材';
const bytes = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

async function listNotes(fs: NodeFs, path: ReturnType<typeof node>['path'], root: string, relative = ''): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) result.push(...await listNotes(fs, path, root, child));
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push(child);
    }
    return result;
}

export class MigrationModal extends Modal {
    private source = '';
    private target = '课本解读笔记';
    private diagrams = '';
    private busy = false;
    constructor(private plugin: PDFPlus) { super(plugin.app); }

    onOpen() {
        this.titleEl.setText('导入课本解读笔记');
        const el = this.contentEl;
        el.createEl('p', { text: '从“课本解读”桌面版笔记库复制 Markdown 笔记到本库，原笔记库不修改。笔记位置转为 PDF 框选链接，教材目录转为章节索引（已有索引保持不变）。同名笔记跳过，不覆盖。' });
        new Setting(el).setName('桌面版笔记库文件夹').setDesc('完整路径，例如 /Users/你/Documents/课本解读笔记').addText(text => text.setPlaceholder('/Users/…/课本解读笔记').onChange(value => this.source = value.trim()));
        new Setting(el).setName('导入到库内文件夹').setDesc('留空导入到库根目录。').addText(text => text.setValue(this.target).onChange(value => this.target = value.trim()));
        new Setting(el).setName('图示文件夹（可选）').setDesc('桌面版源码中的 src/desktop/initial-diagrams 完整路径；填写后复制笔记引用的图示。').addText(text => text.onChange(value => this.diagrams = value.trim()));
        const output = el.createDiv();
        new Setting(el).addButton(button => button.setButtonText('预览导入').setCta().onClick(() => this.run(async () => this.preview(output, await this.plan()))));
    }

    private async run(action: () => Promise<void>) {
        if (this.busy) return;
        this.busy = true;
        try { await action(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 10000); } finally { this.busy = false; }
    }

    private targetPath(relative: string) { return normalizePath(this.target ? `${this.target}/${relative}` : relative); }

    private async plan(): Promise<Plan> {
        const { fs, path } = node();
        if (!this.source) throw Error('请填写桌面版笔记库文件夹');
        if (this.target.split('/').includes('..') || this.target.startsWith('/')) throw Error('导入文件夹必须是库内相对路径');
        const root = path.join(this.source, '.textbook', 'textbooks');
        const books: BookPlan[] = [];
        const pdfs = this.app.vault.getFiles().filter(file => file.extension === 'pdf');
        const indexFolder = this.plugin.settings.textbookIndexFolder.trim() || DEFAULT_INDEX_FOLDER;
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => { throw Error('该文件夹不是课本解读笔记库（缺少 .textbook/textbooks）'); })) {
            if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
            const folder = path.join(root, entry.name);
            const catalog = JSON.parse(await fs.readFile(path.join(folder, 'catalog.json'), 'utf8')) as ElectronCatalog;
            if (catalog.textbookId !== entry.name) throw Error(`教材目录与文件夹不一致：${entry.name}`);
            const size = await fs.stat(path.join(folder, 'source.pdf')).then(stat => stat.size, () => -1);
            let pdf: TFile | null = null;
            for (const file of pdfs.filter(file => file.stat.size === size)) if (await pdfHash(this.app, file) === entry.name) { pdf = file; break; }
            const indexPath = `${indexFolder}/${entry.name}.json`;
            const existing = await readIndex(this.app, indexPath, `book_${entry.name.slice(0, 24)}`).catch(() => null);
            let indexError = '', chapterCount = 0;
            try { chapterCount = catalogToIndex(catalog, '').chapters.length; } catch (error) { indexError = error instanceof Error ? error.message : String(error); }
            if (!pdf && size < 0) throw Error(`${catalog.title}：库中没有此教材 PDF，桌面版也缺少 source.pdf`);
            books.push({ catalog, folder, pdf, copyTo: this.targetPath(`${safeName(catalog.title)}.pdf`), indexPath: existing?.path ?? indexPath, indexExists: !!existing, indexError, chapterCount });
        }
        if (!books.length) throw Error('没有找到已添加的教材');
        const notes = (await listNotes(fs, path, this.source)).map(relative => ({ relative, target: this.targetPath(relative), exists: !!this.app.vault.getAbstractFileByPath(this.targetPath(relative)) }));
        return { books, notes };
    }

    private preview(output: HTMLElement, plan: Plan) {
        output.empty();
        const list = output.createEl('ul');
        for (const book of plan.books) {
            list.createEl('li', { text: `${book.catalog.title}：${book.pdf ? `使用库中 ${book.pdf.path}` : `复制 PDF 到 ${book.copyTo}`}；${book.indexExists ? '保留已有章节索引' : book.indexError ? `目录无法转为索引（${book.indexError}），笔记标为未建索引` : `由桌面版目录建立章节索引（${book.chapterCount} 个章节）`}` });
        }
        const skipped = plan.notes.filter(note => note.exists).length;
        list.createEl('li', { text: `${plan.notes.length - skipped} 篇笔记将导入到 ${this.target || '库根目录'}${skipped ? `；${skipped} 篇已存在，跳过` : ''}` });
        new Setting(output).addButton(button => button.setButtonText('确认导入').setCta().onClick(() => this.run(async () => {
            button.setDisabled(true);
            await this.apply(plan);
            this.close();
        })));
    }

    private async ensureFolder(path: string) {
        const parts = path.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
            const folder = parts.slice(0, i).join('/');
            if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        }
    }

    private async apply(plan: Plan) {
        const { fs, path } = node();
        const books = new Map<string, MigrationBook>();
        for (const book of plan.books) {
            let pdf = book.pdf;
            if (!pdf) {
                const existing = this.app.vault.getAbstractFileByPath(book.copyTo);
                if (existing) throw Error(`${book.copyTo} 已存在但内容不同，请改名后重试`);
                await this.ensureFolder(book.copyTo);
                pdf = await this.app.vault.createBinary(book.copyTo, bytes(await fs.readFile(path.join(book.folder, 'source.pdf'))));
            }
            const doc = await this.plugin.lib.loadPDFDocument(pdf);
            const views = new Map<number, number[]>();
            try {
                if (doc.numPages !== book.catalog.pageCount) throw Error(`${book.catalog.title}：PDF 页数与桌面版目录不一致`);
                for (let page = 1; page <= doc.numPages; page++) views.set(page, (await doc.getPage(page)).view);
            } finally { void doc.destroy(); }
            let index = (await readIndex(this.app, book.indexPath).catch(() => null))?.index ?? null;
            if (!index && !book.indexError) {
                index = catalogToIndex(book.catalog, pdf.path);
                await saveIndex(this.app, book.indexPath, index, null);
            }
            const printed = new Map(book.catalog.pages.filter(page => page.printedPage).map(page => [page.page, page.printedPage!]));
            books.set(book.catalog.textbookId, { hash: book.catalog.textbookId, pdfPath: pdf.path, index, indexPath: book.indexPath, views, printed });
        }
        const notePaths = new Set(plan.notes.map(note => note.relative));
        const diagramFolder = this.diagrams ? this.targetPath('initial-diagrams') : null;
        const diagrams = new Set<string>();
        const failed: string[] = [];
        let imported = 0;
        for (const note of plan.notes) {
            if (note.exists || this.app.vault.getAbstractFileByPath(note.target)) continue;
            try {
                const converted = convertNote(await fs.readFile(path.join(this.source, note.relative), 'utf8'), books, { linkPrefix: this.target, notePaths, diagramFolder });
                converted.diagrams.forEach(name => diagrams.add(name));
                await this.ensureFolder(note.target);
                await this.app.vault.create(note.target, converted.content);
                imported++;
            } catch (error) { failed.push(`${note.relative}（${error instanceof Error ? error.message : String(error)}）`); }
        }
        for (const name of diagrams) {
            const target = `${diagramFolder}/${name}`;
            if (this.app.vault.getAbstractFileByPath(target)) continue;
            try {
                await this.ensureFolder(target);
                await this.app.vault.createBinary(target, bytes(await fs.readFile(path.join(this.diagrams, name))));
            } catch { failed.push(`图示 ${name}`); }
        }
        if (failed.length) console.warn('Textbook migration skipped:', failed);
        new Notice(`已导入 ${imported} 篇笔记${diagrams.size ? `、${diagrams.size} 个图示` : ''}。${failed.length ? `${failed.length} 项失败，详见开发者控制台：${failed.slice(0, 3).join('；')}` : ''}`, 15000);
    }
}
