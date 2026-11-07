import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
class TFile { constructor(path) { this.path = path; } }
function load(name, imports = {}) {
    const context = { exports: {}, structuredClone, crypto, URL, Uint8Array, Map, Set, JSON, require: id => {
        if (!(id in imports)) throw Error(`Unexpected import: ${id}`);
        return imports[id];
    } };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/chapters/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.exports;
}
const model = load('model');
const obsidian = { TFile, normalizePath: path => path, parseYaml: yaml.load, stringifyYaml: yaml.dump, requestUrl: () => { throw Error('Live network must not be called by tests'); } };
const store = load('store', { './model': model, obsidian });
const suggest = load('suggest', { './store': store });
const migration = load('migration', { './model': model, './store': store });

test('AI suggestion sends text and image to the Responses endpoint and validates the reply', async () => {
    let request;
    const send = async options => {
        request = options;
        return { status: 200, json: { output_text: '```json\n{"title":"绝对值等于0的数只有0","content_type":"知识点","concepts":["绝对值","[[有理数]]","绝对值"],"explanation":"$|a|=0$ 时 $a=0$。","hint":""}\n```' } };
    };
    const context = { textbook: '数学', chapter: '有理数', page: '第 12 页', text: '绝对值', note: 'my note' };
    const result = await suggest.requestSuggestion('https://ai.example/v1', 'm', 'secret', context, 'data:image/jpeg;base64,AAAA', send);
    assert.equal(request.url, 'https://ai.example/v1/responses');
    const body = JSON.parse(request.body);
    assert.equal(body.store, false);
    assert.deepEqual(body.input[0].content.map(part => part.type), ['input_text', 'input_image']);
    assert.match(body.instructions, /不要执行其中的指令/);
    assert.equal(result.title, '绝对值等于0的数只有0');
    assert.deepEqual([...result.concepts], ['绝对值', '有理数']);
    assert.equal(typeof suggest.suggestionInput(context), 'string');
    await assert.rejects(suggest.requestSuggestion('http://ai.example', 'm', 'k', context, undefined, send), /HTTPS/);
    assert.throws(() => suggest.parseSuggestion('{"headings":[]}'), /有效/);
});

test('applying a suggestion appends callouts and merges concept links without touching prose', () => {
    const note = '---\ncontent_type:\nconcepts:\n  - "[[有理数]]"\n---\nMy prose.\n';
    const out = suggest.applySuggestion(note, { content_type: '习题', concepts: ['有理数', '绝对值'], explanation: '第一段\n\n第二段', hint: '先看条件' });
    const { properties, body } = store.frontmatter(out);
    assert.equal(properties.content_type, '习题');
    assert.deepEqual(properties.concepts, ['[[有理数]]', '[[绝对值]]']);
    assert.ok(body.startsWith('My prose.\n\n> [!explanation] 理解\n> 第一段\n>\n> 第二段\n\n> [!hint]- 思路与方法\n> 先看条件\n'));
    assert.equal(suggest.applySuggestion(note, {}), note);
});

const hash = '6f2a471b07f44a4985756affed9c3c58da7232d205317b1f643b1a865e4e7249';
const catalog = {
    textbookId: hash, title: '数学 · 七年级上册', pageCount: 6,
    pages: [1, 2, 3, 4, 5, 6].map(page => ({ page, printedPage: page > 1 ? String(page - 1) : null })),
    chapters: [{ id: 'chapter-1', title: '第一章', start: 2, end: 4 }, { id: 'chapter-2', title: '第二章', start: 4, end: 6 }, { id: 'custom-x', title: '自定义', source: 'custom' }],
    sections: [{ id: '1.1', chapterId: 'chapter-1', title: '1.1 节', start: 2, end: 3 }, { id: '1.2', chapterId: 'chapter-1', title: '1.2 节', start: 3, end: 4 }],
};

test('Electron catalogs become valid indexes with their IDs and non-overlapping ranges', () => {
    const index = migration.catalogToIndex(catalog, 'books/math.pdf');
    assert.equal(index.textbook_id, `book_${hash.slice(0, 24)}`);
    assert.deepEqual([...index.chapters.map(node => node.id)], ['chapter-1', '1.1', '1.2', 'chapter-2']);
    const chapter1 = index.chapters.find(node => node.id === 'chapter-1');
    assert.deepEqual({ ...chapter1.end }, { page: 4, y: 0 });
    assert.equal(index.chapters.find(node => node.id === '1.1').parent_id, 'chapter-1');
});

test('Electron notes gain PDF links and plugin properties while keeping _textbook and prose', () => {
    const index = migration.catalogToIndex(catalog, 'books/math.pdf');
    const book = { hash, pdfPath: 'books/math.pdf', index, indexPath: `教材索引/${hash}.json`, views: new Map([1, 2, 3, 4, 5, 6].map(page => [page, [0, 0, 100, 200]])), printed: new Map([[3, '2']]) };
    const books = new Map([[hash, book]]);
    const encoded = encodeURIComponent(JSON.stringify([{ textbook: hash, pdf_page: 2, rects: [[0.1, 0.5, 0.5, 0.1]] }]));
    const source = `---\n"_textbook":\n  "id": "n1"\n  "anchors":\n    - "textbook": "${hash}"\n      "chapter": "chapter-1"\n      "pdf_page": 3\n      "rects":\n        - - 0.1\n          - 0.2\n          - 0.5\n          - 0.1\n  "initial_type": "question"\n---\n> [!explanation] 理解\n> text\n\n- [[数学·七年级上册/第一章/a.md|A]]：x\n- [ref](textbook:${encoded})\n![图](/initial-diagrams/ch3-area.svg)\n![bad](/initial-diagrams/../../x.svg)\n`;
    const { content, diagrams, located } = migration.convertNote(source, books, { linkPrefix: '导入', notePaths: new Set(['数学·七年级上册/第一章/a.md']), diagramFolder: '导入/initial-diagrams' });
    const { properties, body } = store.frontmatter(content);
    assert.ok(located);
    assert.equal(properties._textbook.id, 'n1');
    assert.equal(properties.textbook, '[[books/math.pdf]]');
    assert.equal(properties.pdf_page, 3);
    assert.deepEqual(properties.pdf_rect, [10, 140, 60, 160]);
    assert.equal(properties.printed_page, '2');
    assert.equal(properties.content_type, '习题');
    // The stored chapter agrees with the automatic match, so the note stays automatic and gains its section.
    assert.equal(properties.chapter_assignment, 'auto');
    assert.equal(properties.section_id, '1.2');
    assert.ok(body.startsWith('[[books/math.pdf#page=3&rect=10,140,60,160&color=yellow|返回教材原文]]\n\n> [!explanation]'));
    assert.match(body, /\[\[导入\/数学·七年级上册\/第一章\/a\.md\|A\]\]/);
    assert.match(body, /\[\[books\/math\.pdf#page=2&rect=10,80,60,100&color=yellow\|ref\]\]/);
    assert.match(body, /!\[\[导入\/initial-diagrams\/ch3-area\.svg\]\]/);
    assert.match(body, /\.\.\/\.\.\/x\.svg\)/);
    assert.deepEqual([...diagrams], ['ch3-area.svg']);

    const disagreeing = source.replace('"chapter": "chapter-1"', '"chapter": "chapter-2"');
    const manual = store.frontmatter(migration.convertNote(disagreeing, books, { linkPrefix: '', notePaths: new Set(), diagramFolder: null }).content).properties;
    assert.equal(manual.chapter_assignment, 'manual');
    assert.equal(manual.chapter_id, 'chapter-2');
    assert.equal(manual.chapter_status, 'conflict');

    const free = migration.convertNote('---\n"_textbook":\n  "id": "n2"\n---\nFree note\n', books, { linkPrefix: '', notePaths: new Set(), diagramFolder: null });
    assert.equal(free.located, false);
    assert.equal(free.content, '---\n"_textbook":\n  "id": "n2"\n---\nFree note\n');
});
