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
