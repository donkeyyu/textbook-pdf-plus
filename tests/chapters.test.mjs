import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
class TFile { constructor(path) { this.path = path; this.stat = { size: 4, mtime: 1 }; } }
function load(name, imports = {}) {
    const context = { exports: {}, structuredClone, crypto, URL, Uint8Array, Map, Set, JSON, require: id => {
        if (!(id in imports)) throw Error(`Unexpected import: ${id}`);
        return imports[id];
    } };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/chapters/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.exports;
}
const model = load('model');
const store = load('store', { './model': model, obsidian: { TFile, normalizePath: path => path.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''), parseYaml: yaml.load, stringifyYaml: yaml.dump, requestUrl: () => { throw Error('Live network must not be called by tests'); } } });
const pos = (page, y) => ({ page, y });
const chapters = [
    { id: 'c1', title: '章一', source_title: '章一', level: 1, parent_id: null, start: pos(1, 0), end: pos(3, 1), source: 'outline' },
    { id: 's1', title: '第一节', source_title: '第一节', level: 2, parent_id: 'c1', start: pos(1, .2), end: pos(2, .5), source: 'outline' },
    { id: 's2', title: '第二节', source_title: '第二节', level: 2, parent_id: 'c1', start: pos(2, .5), end: pos(3, 1), source: 'outline' },
];
const index = { version: 1, textbook_id: 'book_one', pdf_sha256: 'hash', pdf_path: 'book.pdf', page_count: 3, chapters };
test('same-page boundary: contained, crossing and exact boundary regions', () => {
    model.validateIndex(index);
    assert.equal(model.matchRegion(chapters, pos(2, .1), pos(2, .5)).section.id, 's1');
    assert.equal(model.matchRegion(chapters, pos(2, .5), pos(2, .8)).section.id, 's2');
    const crossing = model.matchRegion(chapters, pos(2, .4), pos(2, .6));
    assert.equal(crossing.status, 'ambiguous');
    assert.equal(crossing.section, undefined);
    assert.equal(crossing.chapter.id, 'c1');
});
test('rename and re-extract preserve IDs, titles, corrections and parent mapping', () => {
    const existing = structuredClone(chapters);
    existing[1].title = '我的节名';
    const candidates = structuredClone(chapters).map(node => ({ ...node, id: 'new_' + node.id, parent_id: node.parent_id ? 'new_' + node.parent_id : null }));
    const merged = model.mergeCandidates(existing, candidates);
    assert.equal(merged.length, 3);
    assert.equal(merged[1].title, '我的节名');
    assert.equal(merged[1].id, 's1');
    assert.equal(merged[2].parent_id, 'c1');
});
test('invalid hierarchy and overlapping siblings are refused', () => {
    const invalid = structuredClone(index);
    invalid.chapters[2].start.y = .4;
    assert.throws(() => model.validateIndex(invalid), /重叠/);
    invalid.chapters[2].start.y = .5;
    invalid.chapters[2].parent_id = 'missing';
    assert.throws(() => model.validateIndex(invalid), /所属章/);
});
test('manual assignments survive moves and deleted nodes remain explicitly missing', () => {
    const previous = { chapter_assignment: 'manual', chapter_id: 'c1', section_id: 's1' };
    const result = model.assignment(index, previous, pos(2, .6), pos(2, .7));
    assert.equal(result.section_id, 's1');
    assert.equal(result.chapter_status, 'conflict');
    const removed = { ...index, chapters: chapters.filter(c => c.id !== 's1') };
    assert.equal(model.assignment(removed, previous, pos(2, .2), pos(2, .3)).chapter_status, 'missing');
    const auto = model.assignment(index, {}, pos(2, .6), pos(2, .7));
    assert.equal(auto.section_id, 's2');
});
test('range corrections and title changes update note properties without changing prose', () => {
    const input = store.withProperties('Body and [[links]] stay.\n', { textbook_id: 'book_one', content_type: '习题', pdf_page: 2, region_top: .2, region_bottom: .3 });
    const assigned = store.updateAssignment(input, index);
    assert.equal(store.frontmatter(assigned).properties.section_id, 's1');
    const renamed = structuredClone(index); renamed.chapters[1].title = '新名字';
    const output = store.updateAssignment(assigned, renamed);
    const parsed = store.frontmatter(output);
    assert.equal(parsed.properties.section_title, '新名字');
    assert.equal(parsed.properties.section_id, 's1');
    assert.equal(parsed.properties.content_type, '习题');
    assert.equal(parsed.body, 'Body and [[links]] stay.\n');
    assert.equal(store.frontmatter(store.updateAssignment(input, null)).properties.chapter_status, 'unindexed');
});
test('Responses request uses configured endpoint and validates output against source lines', async () => {
    const pages = [{ page: 2, lines: [{ y: .2, text: '1.1 正数和负数' }] }];
    let sent;
    const fake = async request => { sent = request; return { status: 200, json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ headings: [{ title: '1.1 正数和负数', level: 2, page: 2, y: .2 }] }) }] }] } }; };
    const result = await store.requestHeadings('https://example.invalid/v1/', 'model-test', 'fake-key', pages, fake);
    assert.equal(sent.url, 'https://example.invalid/v1/responses');
    assert.equal(JSON.parse(sent.body).store, false);
    assert.equal(result[0].start.y, .2);
    assert.throws(() => model.parseAIHeadings('{"headings":[{"title":"不存在","level":1,"page":2,"y":0.2}]}', pages), /无法在原页/);
    await assert.rejects(store.requestHeadings('https://example.invalid', 'model', 'key', pages, async () => ({ status: 401 })), /HTTP 401/);
    await assert.rejects(store.requestHeadings('http://example.invalid', 'model', 'key', pages, fake), /HTTPS/);
    await assert.rejects(store.requestHeadings('https://example.invalid', 'model', 'key', pages, async () => ({ status: 200, json: { status: 'incomplete' } })), /未完成/);
});
test('persisted index survives reload and stale writes are blocked atomically', async () => {
    const files = new Map();
    const app = { vault: {
        getAbstractFileByPath: path => files.get(path)?.file,
        createFolder: async path => files.set(path, { file: {}, text: '' }),
        create: async (path, text) => files.set(path, { file: new TFile(path), text }),
        read: async file => files.get(file.path).text,
        process: async (file, update) => { files.get(file.path).text = update(files.get(file.path).text); },
    } };
    const path = '教材索引/test.json';
    const raw = await store.saveIndex(app, path, index, null);
    assert.equal((await store.readIndex(app, path)).index.chapters[1].id, 's1');
    files.get(path).text = raw + ' ';
    await assert.rejects(store.saveIndex(app, path, index, raw), /其他窗口/);
    assert.equal(files.get(path).text, raw + ' ');
});
test('rectangle metadata normalizes PDF coordinates and preserves source links', async () => {
    const pdf = new TFile('book.pdf');
    const doc = { numPages: 3, getPage: async () => ({ view: [0, 0, 100, 100] }) };
    const app = { vault: { readBinary: async () => new TextEncoder().encode('book').buffer, getAbstractFileByPath: () => null, getFiles: () => [] } };
    const out = await store.rectangleMetadata({ app, settings: { textbookIndexFolder: '' } }, pdf, doc, 2, [10, 60, 80, 80], '![[book.pdf#page=2&rect=10,60,80,80]]\n');
    const { properties, body } = store.frontmatter(out);
    assert.equal(properties.region_top, .2);
    assert.equal(properties.region_bottom, .4);
    assert.equal(properties.chapter_status, 'unindexed');
    assert.ok(properties.textbook_id.startsWith('book_'));
    assert.equal(body, '![[book.pdf#page=2&rect=10,60,80,80]]\n');
});

test('real textbook PDF exposes valid outline locations and page text', { skip: !process.env.TEXTBOOK_PDF }, async t => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(readFileSync(process.env.TEXTBOOK_PDF)), useSystemFonts: true }).promise;
    try {
        const headings = await store.outlineHeadings(doc);
        assert.ok(headings.every(h => h.start.page >= 1 && h.start.page <= doc.numPages && h.start.y >= 0 && h.start.y <= 1));
        const page = await store.pageLines(doc, 12);
        assert.ok(page.lines.some(line => line.text.includes('水')));
        t.diagnostic(`${doc.numPages} PDF pages; ${headings.length} outline headings; page 12: ${page.lines.length} text lines`);
        if (headings.length) {
            let counter = 0;
            const nodes = model.headingsToChapters(headings, doc.numPages, () => `test-${++counter}`);
            model.validateIndex({ ...index, page_count: doc.numPages, chapters: nodes });
        }
    } finally { await doc.destroy(); }
});

test('partial extraction does not extend the final heading past selected pages', () => {
    const nodes = model.headingsToChapters([{ title: '章', level: 1, start: pos(9, .1), source: 'ai' }], 12, () => 'partial');
    assert.equal(nodes[0].end.page, 12);
    assert.equal(model.matchRegion(nodes, pos(13, 0), pos(13, .2)).status, 'unassigned');
});

const { noteLocation } = load('note-header', { obsidian: {}, './store': store, './suggest-modal': {} });
test('moving a legacy rectangle supplies the textbook needed by its header', async () => {
    const pdf = new TFile('教材/数学.pdf');
    const doc = { numPages: 3, getPage: async () => ({ view: [0, 0, 100, 100] }) };
    const app = { vault: { readBinary: async () => new TextEncoder().encode('book').buffer, getAbstractFileByPath: () => null, getFiles: () => [] } };
    const body = '![[教材/数学.pdf#page=2&rect=10,60,80,80]]\nOld note body.\n';
    const updated = await store.rectangleMetadata({ app, settings: { textbookIndexFolder: '教材索引' } }, pdf, doc, 2, [10, 60, 80, 80], body);
    const parsed = store.frontmatter(updated);
    assert.equal(noteLocation(parsed.properties)?.link, '教材/数学.pdf#page=2');
    assert.equal(parsed.body, body);
});
test('chapter selection uses the current note, so body edits made after opening do not block it', async () => {
    const note = new TFile('note.md'), indexFile = new TFile('index.json');
    let content = store.withProperties('Keep my prose.\n', { textbook_id: 'book_one', textbook_index: 'index.json', pdf_page: 2, region_top: .6, region_bottom: .7 });
    const app = { vault: {
        getAbstractFileByPath: () => indexFile,
        read: async file => file === indexFile ? JSON.stringify(index) : content,
        process: async (_file, update) => { content = update(content); },
    } };
    content += 'Typed after the header loaded.\n';
    await store.saveNoteChapter(app, note, 's1');
    assert.equal(store.frontmatter(content).properties.section_id, 's1');
    assert.equal(store.frontmatter(content).properties.chapter_status, 'conflict');
    assert.match(content, /Typed after the header loaded/);
    await assert.rejects(store.saveNoteChapter(app, note, 'removed'), /章节已移除/);
    const process = app.vault.process;
    app.vault.process = async (file, update) => { content = content.replace('book_one', 'book_two'); return process(file, update); };
    await assert.rejects(store.saveNoteChapter(app, note, ''), /其他教材/);
    content = content.replace('book_two', 'book_one'); app.vault.process = process;
    await store.saveNoteChapter(app, note, '');
    const parsed = store.frontmatter(content);
    assert.equal(parsed.properties.chapter_assignment, 'auto');
    assert.equal(parsed.properties.section_id, 's2');
    assert.equal(parsed.body, 'Keep my prose.\nTyped after the header loaded.\n');
});
test('property writes keep comments, order, quoting and nested values of other keys', () => {
    const source = '---\n# my comment\n"_textbook":\n  "id": "x"\n  "anchors":\n    - "pdf_page": 3\ntags:\n- a\n- b\ncontent_type: 知识点 # inline\n---\nBody\n';
    const result = store.withProperties(source, { content_type: '习题', tags: ['c'], pdf_page: 4 });
    assert.equal(result, '---\n# my comment\n"_textbook":\n  "id": "x"\n  "anchors":\n    - "pdf_page": 3\ntags:\n  - c\ncontent_type: 习题\npdf_page: 4\n---\nBody\n');
    assert.equal(store.withProperties('Plain body\n', { a: 1 }), '---\na: 1\n---\nPlain body\n');
    assert.equal(store.withProperties(result, { '_textbook': null }).includes('"anchors"'), false);
});
test('indexes are found by content hash after moving them to another folder', () => {
    const hash = 'a'.repeat(64);
    const moved = new TFile(`我的索引/${hash}.json`); moved.extension = 'json'; moved.basename = hash;
    const app = { vault: { getAbstractFileByPath: path => path === moved.path ? moved : null, getFiles: () => [moved] } };
    assert.equal(store.locateIndex(app, `教材索引/${hash}.json`, `book_${hash.slice(0, 24)}`), moved.path);
    assert.equal(store.locateIndex(app, `教材索引/${'b'.repeat(64)}.json`), `教材索引/${'b'.repeat(64)}.json`);
});
test('student header shows readable names, distinguishes printed pages, and retains physical navigation', () => {
    const properties = { textbook: '[[教材/数学.pdf|数学]]', pdf_page: 12, chapter_title: '有理数', section_title: '正数和负数', chapter_id: 'internal', section_id: 'secret', chapter_status: 'conflict' };
    const location = noteLocation(properties);
    assert.equal(location.label, '数学 · PDF 第 12 页');
    assert.equal(location.link, '教材/数学.pdf#page=12');
    assert.equal(location.chapter, '有理数 / 正数和负数');
    assert.equal(location.status, '手动章节与位置不符');
    assert.ok(!JSON.stringify(location).includes('internal'));
    const printed = noteLocation({ ...properties, printed_page: '5' });
    assert.equal(printed.label, '数学 · 第 5 页');
    assert.equal(printed.link, location.link);
    assert.equal(noteLocation({ textbook: 'book.pdf', pdf_page: 0 }), null);
    assert.equal(noteLocation({}), null);
    assert.equal(noteLocation({ textbook: 'book.pdf', pdf_page: 1 }).chapter, '选择所属章节');
});
