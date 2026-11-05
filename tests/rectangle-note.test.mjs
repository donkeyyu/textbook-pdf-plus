import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the production method with the Obsidian host replaced by a small fake.
const notices = [];
class MarkdownView {}
class TFile {}
const template = readFileSync(new URL('../templates/教材框选笔记.md', import.meta.url), 'utf8');
const code = ts.transpileModule(readFileSync(new URL('../src/color-palette.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const context = {
    exports: {}, console: { error() {} },
    require(id) {
        if (id === 'obsidian') return { TFile, MarkdownView, normalizePath: path => path.replace(/\/+/g, '/'), Notice: class { constructor(message) { notices.push(message); } } };
        if (id === 'lib/component') return { PDFPlusComponent: class {} };
        if (id === 'utils') return {};
        throw new Error(`Unexpected import: ${id}`);
    }
};
vm.runInNewContext(code, context);
const createNote = context.exports.ColorPalette.prototype.createNoteForRectangle;
function host({ saveFails = false, openFails = false, templateMissing = false, templateText = template } = {}) {
    const events = [];
    const pdf = { path: 'books/math.pdf', basename: 'math' };
    const note = { path: 'notes/math - 第12页笔记.md' };
    const view = Object.assign(new MarkdownView(), {
        file: note,
        async setState() { events.push('editable'); },
        editor: { lastLine: () => 4, setCursor: () => events.push('cursor'), focus: () => events.push('focus') }
    });
    return {
        events, child: { file: pdf }, selectedColorName: null,
        app: {
            vault: {
                getAbstractFileByPath: () => templateMissing ? null : new TFile(),
                read: async () => templateText
            },
            fileManager: {
                generateMarkdownLink: file => `[[${file.path}]]`,
                getNewFileParent: () => ({ path: 'notes' }),
                async createNewMarkdownFile(folder, name, content) {
                    if (saveFails) throw new Error('disk full');
                    events.push({ folder, name, content });
                    return note;
                }
            },
            workspace: { getActiveViewOfType: () => view }
        },
        lib: {
            generateMarkdownLink(file, source, subpath, alias) {
                assert.equal(source, 'notes/note.md');
                return `![[${file.path}${subpath}|${alias}]]`;
            },
            workspace: { async openMarkdownLinkFromPDF(path) {
                if (openFails) throw new Error('view unavailable');
                events.push(path);
            } }
        }
    };
}
test('saving a rectangle creates one note with visible backlink and focuses its editor', async () => {
    const h = host();
    await createNote.call(h, 12, [20.2, 30.7, 80, 100]);
    assert.match(h.events[0].content, /textbook: "\[\[books\/math.pdf\]\]"\npdf_page: 12/);
    assert.match(h.events[0].content, /content_type:\nnote_type:/);
    assert.match(h.events[0].content, /rect=20,31,80,100&color=yellow/);
    assert.match(h.events[0].content, /\n\n\[\[books\/math.pdf/);
    assert.equal(h.events.filter(e => typeof e === 'object').length, 1);
    assert.deepEqual(h.events.slice(1), ['notes/math - 第12页笔记.md', 'editable', 'cursor', 'focus']);
});
test('save failure does not open an unsaved note; open failure reports the saved path', async () => {
    notices.length = 0;
    const h = host({ saveFails: true });
    await createNote.call(h, 12, [1, 2, 3, 4]);
    assert.deepEqual(h.events, []);
    assert.match(notices[0], /未能保存/);
    const saved = host({ openFails: true });
    await createNote.call(saved, 12, [1, 2, 3, 4]);
    assert.equal(saved.events.length, 1);
    assert.match(notices[1], /笔记已保存：notes/);
});

test('edited template applies on the next selection; missing template does not create a note', async () => {
    const edited = host({ templateText: 'note_type: 说明\n{{ textbook_region }}\n{{back_to_textbook}}\nCustom notes\n' });
    await createNote.call(edited, 12, [1, 2, 3, 4]);
    assert.match(edited.events[0].content, /^note_type: 说明/);
    assert.match(edited.events[0].content, /Custom notes/);
    assert.doesNotMatch(edited.events[0].content, /{{/);
    notices.length = 0;
    const missing = host({ templateMissing: true });
    await createNote.call(missing, 12, [1, 2, 3, 4]);
    assert.deepEqual(missing.events, []);
    assert.match(notices[0], /找不到模板/);
});
