import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const context = { exports: {}, require: () => ({}) };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/rectangle-editor.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const rewrite = context.exports.rewriteRectangleLinks;
const embed = '![[math.pdf#page=12&rect=1,2,3,4&color=yellow|region]]';
const link = '[[math.pdf#page=12&rect=1,2,3,4&color=yellow|return]]';
const text = `${embed}\n\nMy notes stay here.\n\n${link}\nOther [[other.pdf#page=12&rect=1,2,3,4]]`;
const refs = [embed, link].map(original => ({ original, start: text.indexOf(original), end: text.indexOf(original) + original.length }));
test('move updates both references without touching prose or other PDFs', () => {
    const result = rewrite(text, refs, [10, 20, 30, 40]);
    assert.equal(result.split('rect=10,20,30,40').length, 3);
    assert.ok(result.includes('My notes stay here.'));
    assert.ok(result.includes('other.pdf#page=12&rect=1,2,3,4'));
});
test('delete drops embed but retains body and page link', () => {
    const result = rewrite(text, refs, null);
    assert.ok(!result.includes(embed));
    assert.ok(result.includes('[[math.pdf#page=12|return]]'));
    assert.ok(result.includes('My notes stay here.'));
});
test('stale offsets fail without modifying the file', () => {
    assert.throws(() => rewrite('edited' + text, refs, null), /笔记已更改/);
});

function rectangleHarness() {
    const elements = [];
    const doc = {
        querySelectorAll: () => elements.filter(el => el.selected),
        addEventListener() {}, removeEventListener() {},
    };
    const make = rect => {
        const el = { dataset: { textbookRect: JSON.stringify(rect) }, ownerDocument: doc, selected: false,
            createDiv: () => ({ dataset: {}, setAttribute() {} }), addEventListener() {},
        };
        el.classList = { add: () => el.selected = true, remove: () => el.selected = false };
        elements.push(el);
        return el;
    };
    const child = { getPage: page => page === 12 ? { div: { querySelectorAll: () => elements } } : undefined };
    const visualizer = { app: {}, child, domManager: { onClearDomInPage() {} }, register() {} };
    return { make, child, visualizer };
}
test('return link activates only the matching rectangle on the target page', () => {
    const { make, child } = rectangleHarness();
    const other = make([10, 20, 30, 40]);
    other.selected = true;
    const target = make([99, 608, 340, 650]);
    context.exports.activateLinkedRectangle(child, 12, [99.1, 608.1, 340.1, 650.1]);
    assert.equal(target.selected, true);
    assert.equal(other.selected, false);
    target.selected = false;
    context.exports.activateLinkedRectangle(child, 11, [99, 608, 340, 650]);
    assert.equal(target.selected, false);
});
test('return link waits for the matching box; later navigation cancels pending activation', () => {
    const { make, child, visualizer } = rectangleHarness();
    const rect = [99, 608, 340, 650];
    context.exports.activateLinkedRectangle(child, 12, rect);
    const target = make(rect);
    context.exports.attachRectangleEditor(visualizer, target, 12, rect, new Set());
    assert.equal(target.selected, true);
    const next = [1, 2, 3, 4];
    context.exports.activateLinkedRectangle(child, 12, next);
    context.exports.clearPendingRectangle(child);
    const cancelled = make(next);
    context.exports.attachRectangleEditor(visualizer, cancelled, 12, next, new Set());
    assert.equal(cancelled.selected, false);
});
