import { App, Notice, Setting, TFile, TextComponent, normalizePath } from 'obsidian';
import type PDFPlus from '../main';
import { FuzzyFolderSuggest, FuzzyMarkdownFileSuggest } from '../utils/suggest';
import { DEFAULT_TEMPLATE_PATH, ensureTemplate } from './guide';
import { DEFAULT_INDEX_FOLDER } from './store';

const SECRET_ID = 'textbook-pdf-plus-api-key';
type Secrets = { getSecret(id: string): string | null; setSecret(id: string, value: string): void };
type TextKey = 'textbookNoteFolder' | 'textbookNoteTemplate' | 'textbookIndexFolder' | 'textbookAIBaseUrl' | 'textbookAIModel';

// Describes where a blank note folder sends new notes, mirroring Obsidian's "Default location for new notes".
export function defaultNoteFolder(app: App) {
    const location = app.vault.getConfig('newFileLocation');
    if (location === 'current') return '与教材 PDF 相同的文件夹';
    if (location === 'folder') return String(app.vault.getConfig('newFileFolderPath') ?? '').trim() || '库根目录';
    return '库根目录';
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// One form for the settings tab and the start guide, so both always show and edit the same values.
export function renderTextbookSettings(plugin: PDFPlus, el: HTMLElement, refresh: () => void) {
    const { app, settings } = plugin;
    const text = (setting: Setting, key: TextKey, placeholder: string, configure?: (input: TextComponent) => void) => setting.addText(input => {
        input.setPlaceholder(placeholder).setValue(settings[key]).onChange(async value => {
            settings[key] = value;
            await plugin.saveSettings();
        });
        input.inputEl.size = Math.max(24, placeholder.length);
        configure?.(input);
    });
    // Path suggestions write the chosen value directly; Obsidian's suggest does not fire the input's change event.
    const pick = (key: TextKey) => async (path: string) => {
        settings[key] = path;
        await plugin.saveSettings();
        refresh();
    };

    new Setting(el).setName('笔记保存').setHeading();
    text(new Setting(el).setName('笔记存放位置').setDesc('新框选笔记保存到这个库内文件夹，不存在时自动创建。留空使用默认位置（跟随 Obsidian 的“新建笔记的存放位置”）。'),
        'textbookNoteFolder', `默认：${defaultNoteFolder(app)}`,
        input => new FuzzyFolderSuggest(app, input.inputEl).onSelect(({ item }) => void pick('textbookNoteFolder')(item.path)));

    const templatePath = normalizePath(settings.textbookNoteTemplate.trim() || DEFAULT_TEMPLATE_PATH);
    const template = app.vault.getAbstractFileByPath(templatePath);
    const templateSetting = new Setting(el).setName('笔记模板')
        .setDesc(template instanceof TFile ? '新框选笔记使用这个模板。点击“编辑模板”修改内容，下一次框选生效。' : `⚠️ 未找到 ${templatePath}。点击“创建模板”生成默认模板。`);
    text(templateSetting, 'textbookNoteTemplate', DEFAULT_TEMPLATE_PATH, input => {
        new FuzzyMarkdownFileSuggest(app, input.inputEl).onSelect(({ item }) => void pick('textbookNoteTemplate')(item.path));
        // Re-render only when the typed path changes whether the template exists, so tabbing onward keeps focus.
        input.inputEl.addEventListener('blur', () => {
            const path = normalizePath(settings.textbookNoteTemplate.trim() || DEFAULT_TEMPLATE_PATH);
            if ((app.vault.getAbstractFileByPath(path) instanceof TFile) !== (template instanceof TFile)) refresh();
        });
    });
    if (template instanceof TFile) {
        templateSetting.addButton(button => button.setButtonText('编辑模板').onClick(() => void app.workspace.getLeaf('tab').openFile(template)));
    } else {
        templateSetting.addButton(button => button.setButtonText('创建模板').setCta().onClick(async () => {
            try {
                await ensureTemplate(app, templatePath);
                new Notice('已创建笔记模板');
            } catch (error) { new Notice(`创建失败：${message(error)}`); }
            refresh();
        }));
    }

    text(new Setting(el).setName('章节索引文件夹').setDesc('新建章节索引保存到这个库内文件夹。已有索引移动位置后仍可使用。'),
        'textbookIndexFolder', DEFAULT_INDEX_FOLDER,
        input => new FuzzyFolderSuggest(app, input.inputEl).onSelect(({ item }) => void pick('textbookIndexFolder')(item.path)));

    new Setting(el).setName('AI 服务（可选）').setHeading()
        .setDesc('用于识别章节和生成笔记建议。不设置也能框选笔记、浏览章节。服务需支持 OpenAI 兼容的 Responses API；只在你点击发送时调用，可能产生服务商费用。');
    text(new Setting(el).setName('服务地址').setDesc('服务商提供的 API 基础地址（api_url），不含 /responses。'),
        'textbookAIBaseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    text(new Setting(el).setName('模型名称').setDesc('服务商提供的完整模型 ID（model_name）。'),
        'textbookAIModel', 'deepseek-v4.1-flash-1017');

    // Runtime check keeps the PDF workflow usable with the older supported host API.
    const secrets = (app as App & { secretStorage?: Secrets }).secretStorage;
    let keyInput: TextComponent;
    new Setting(el)
        .setName('API 密钥')
        .setDesc(secrets ? '密钥（api_key）保存在 Obsidian 安全存储中，不写入插件配置文件。输入后点击保存；已保存的密钥不再显示。' : '保存密钥需要 Obsidian 1.11.4 或更新版本。')
        .addText(input => {
            keyInput = input;
            input.inputEl.type = 'password';
            input.inputEl.autocomplete = 'off';
            input.setPlaceholder(secrets?.getSecret(SECRET_ID) ? '已保存；输入新密钥可替换' : '输入 API Key');
            input.setDisabled(!secrets);
        })
        .addButton(button => button.setButtonText('保存密钥').setDisabled(!secrets).onClick(() => {
            const value = keyInput.getValue().trim();
            if (!value || !secrets) { new Notice('请先输入 API Key'); return; }
            try {
                secrets.setSecret(SECRET_ID, value);
                keyInput.setValue('').setPlaceholder('已保存；输入新密钥可替换');
                new Notice('API Key 已保存');
            } catch { new Notice('API Key 保存失败，请重试'); }
        }))
        .addButton(button => button.setButtonText('清除密钥').setDisabled(!secrets).onClick(() => {
            try {
                secrets?.setSecret(SECRET_ID, '');
                keyInput.setValue('').setPlaceholder('输入 API Key');
                new Notice('API Key 已清除');
            } catch { new Notice('API Key 清除失败，请重试'); }
        }));
    new Setting(el).setName('AI 笔记建议附带框选图片')
        .setDesc('开启后同时发送框选区域图片，便于识别公式和图形；模型须支持图片输入。关闭后只发送框内文字。')
        .addToggle(toggle => toggle.setValue(settings.textbookAISendImage).onChange(async value => {
            settings.textbookAISendImage = value;
            await plugin.saveSettings();
        }));
}
