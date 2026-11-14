import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

class TFile {
    constructor(path) {
        this.path = path;
        this.basename = path.split('/').pop().replace(/\.[^.]+$/, '');
        this.extension = path.split('.').pop();
    }
}
function load(store = {}) {
    const imports = {
        obsidian: { TFile, ItemView: class { constructor(leaf) { this.app = leaf.app; } }, debounce: callback => Object.assign(callback, { cancel() {} }) },
        './guide': {},
        './note-header': {},
        './store': { DEFAULT_INDEX_FOLDER: '教材索引', pdfHash: async () => 'hash', textbookId: hash => `book_${hash}`, ...store },
    };
    const context = { exports: {}, Map, Set, require: id => {
        if (!(id in imports)) throw Error(`Unexpected import: ${id}`);
        return imports[id];
    } };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/chapters/sidebar.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    return context.exports;
}
const { filterSidebar, groupNotes } = load();
const chapters = [
    { id: 'c1', title: '有理数', level: 1, parent_id: null },
    { id: 's1', title: '绝对值', level: 2, parent_id: 'c1' },
    { id: 's2', title: '数轴', level: 2, parent_id: 'c1' },
    { id: 'c2', title: '几何', level: 1, parent_id: null },
];
const note = (name, chapter = 'c1', section = 's1', page = 1, top = 0) => ({
    file: new TFile(`笔记/${name}.md`), chapter, section, page, top, printed: '', status: '',
});
const notes = [note('ABS Example'), note('练习', 'c1', 's2'), note('三角形', 'c2', null)];
const ids = list => Array.from(list, entry => entry.id);
const names = list => Array.from(list, entry => entry.file.basename);

test('search ignores case and outer whitespace and requires every term across displayed names', () => {
    const result = filterSidebar(chapters, notes, '  aBs\t有理数  ');
    assert.deepEqual(names(result.notes), ['ABS Example']);
    assert.deepEqual(ids(result.chapters), ['c1', 's1']);
    assert.equal(filterSidebar(chapters, notes, 'ABS 几何').notes.length, 0);
});

test('searching a parent chapter includes its sections and notes but excludes other chapters', () => {
    const result = filterSidebar(chapters, notes, '有理数');
    assert.deepEqual(ids(result.chapters), ['c1', 's1', 's2']);
    assert.deepEqual(names(result.notes), ['ABS Example', '练习']);
});

test('section and note matches retain their parent chapter, including empty sections', () => {
    const section = filterSidebar(chapters, notes, '数轴');
    assert.deepEqual(ids(section.chapters), ['c1', 's2']);
    assert.deepEqual(names(section.notes), ['练习']);
    const empty = filterSidebar(chapters, [], '绝对值');
    assert.deepEqual(ids(empty.chapters), ['c1', 's1']);
    assert.equal(empty.notes.length, 0);
});

test('missing section IDs fall back to a valid chapter and unknown IDs remain searchable as unsorted', () => {
    const entries = [note('归章笔记', 'c1', 'deleted'), note('遗留笔记', 'deleted', 'gone'), note('新笔记', null, null)];
    assert.deepEqual(names(filterSidebar(chapters, entries, '有理数').notes), ['归章笔记']);
    const unsorted = filterSidebar(chapters, entries, '未分章');
    assert.deepEqual(names(unsorted.notes), ['遗留笔记', '新笔记']);
    assert.deepEqual(ids(unsorted.chapters), []);
    assert.deepEqual(names(filterSidebar([], entries, '遗留').notes), ['遗留笔记']);
    const groups = groupNotes(chapters, entries);
    assert.deepEqual(names(groups.get('c1')), ['归章笔记']);
    assert.equal(groups.get('__unsorted').length, 2);
});

test('no matches return empty lists and clearing the query restores the full source lists', () => {
    const absent = filterSidebar(chapters, notes, '不存在');
    assert.equal(absent.chapters.length, 0);
    assert.equal(absent.notes.length, 0);
    for (const query of ['', ' \n\t ']) {
        const all = filterSidebar(chapters, notes, query);
        assert.equal(all.chapters, chapters);
        assert.equal(all.notes, notes);
    }
});

test('grouping orders notes by physical page, vertical position and path without mutating input', () => {
    const entries = [note('z', 'c1', 's1', 2, .2), note('b', 'c1', 's1', 1, .8), note('a', 'c1', 's1', 1, .8), note('first', 'c1', 's1', 1, .1)];
    entries[0].printed = '1'; entries[3].printed = '99';
    assert.deepEqual(names(groupNotes(chapters, entries).get('s1')), ['first', 'a', 'b', 'z']);
    assert.deepEqual(names(entries), ['z', 'b', 'a', 'first']);
});

// Record refresh output only; rendering and native controls are verified in Obsidian.
function output() {
    return {
        entries: [],
        empty() { this.entries = []; },
        setText(text) { this.entries = [{ text }]; },
        hasChildNodes() { return this.entries.length > 0; },
        createEl(tag, options) { const entry = { tag, ...options }; this.entries.push(entry); return entry; },
        createSpan(options) { return this.createEl('span', options); },
    };
}
function refreshHost(readIndex) {
    const { ChapterSidebarView } = load({ readIndex });
    const pdf = new TFile('教材.pdf');
    const app = { workspace: { getActiveFile: () => pdf }, vault: { getMarkdownFiles: () => [] } };
    const view = new ChapterSidebarView({ app }, { settings: { textbookIndexFolder: '' } });
    view.head = output(); view.results = output();
    view.search = { setValue() {}, setDisabled() {} };
    const renders = [];
    view.render = (_pdf, chapters) => { renders.push(chapters); view.results.setText('rendered'); };
    return { view, renders };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const saved = title => ({ index: { textbook_id: 'book_hash', chapters: [{ id: title, title }] } });

test('a slower earlier refresh cannot replace newer results or show a stale error', async () => {
    for (const failOlder of [false, true]) {
        const older = deferred(), newer = deferred();
        let reads = 0;
        const { view, renders } = refreshHost(() => ++reads === 1 ? older.promise : newer.promise);
        const first = view.refresh();
        await Promise.resolve();
        const second = view.refresh();
        await Promise.resolve();
        newer.resolve(saved('new'));
        await second;
        if (failOlder) older.reject(Error('old failure'));
        else older.resolve(saved('old'));
        await first;
        assert.deepEqual(renders.map(ids), [['new']]);
        assert.deepEqual(view.results.entries, [{ text: 'rendered' }]);
    }
});

test('unreadable or mismatched indexes show a retry action instead of a normal missing-index result', async () => {
    for (const readIndex of [async () => { throw Error('bad JSON'); }, async () => ({ index: { textbook_id: 'other', chapters: [] } })]) {
        const { view, renders } = refreshHost(readIndex);
        await view.refresh();
        assert.equal(renders.length, 0);
        assert.equal(view.results.entries[0].attr.role, 'alert');
        assert.equal(typeof view.results.entries.find(entry => entry.tag === 'button').onclick, 'function');
    }
});

test('closing the sidebar prevents a pending refresh from rendering', async () => {
    const pending = deferred();
    const { view, renders } = refreshHost(() => pending.promise);
    const refresh = view.refresh();
    await Promise.resolve();
    await view.onClose();
    pending.resolve(saved('late'));
    await refresh;
    assert.equal(renders.length, 0);
});
