import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

class TFile { constructor(path) { this.path = path; } }
class TFolder { constructor(path) { this.path = path; } }

function load() {
    const imports = {
        obsidian: { TFile, Modal: class {}, Notice: class {}, Setting: class {}, normalizePath: path => path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '') },
        '../../templates/教材框选笔记.md': { __esModule: true, default: readFileSync(new URL('../templates/教材框选笔记.md', import.meta.url), 'utf8') },
        './settings-ui': {},
    };
    const context = { exports: {}, require: id => {
        if (!(id in imports)) throw Error(`Unexpected import: ${id}`);
        return imports[id];
    } };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/chapters/guide.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, context);
    return context.exports;
}

function vault(files = {}) {
    const entries = new Map(Object.entries(files));
    return {
        entries,
        getAbstractFileByPath: path => entries.get(path) ?? null,
        createFolder: async path => { entries.set(path, new TFolder(path)); },
        create: async (path, data) => { entries.set(path, Object.assign(new TFile(path), { data })); },
    };
}

const { ensureTemplate } = load();

test('creates the bundled template and its folder', async () => {
    const app = { vault: vault() };
    assert.equal(await ensureTemplate(app, ''), 'created');
    assert.ok(app.vault.entries.get('Templates') instanceof TFolder);
    assert.match(app.vault.entries.get('Templates/教材框选笔记.md').data, /{{back_to_textbook}}/);
});

test('never replaces an existing template', async () => {
    const mine = new TFile('Templates/教材框选笔记.md');
    const app = { vault: vault({ Templates: new TFolder('Templates'), 'Templates/教材框选笔记.md': mine }) };
    assert.equal(await ensureTemplate(app, 'Templates/教材框选笔记.md'), 'exists');
    assert.equal(app.vault.entries.get('Templates/教材框选笔记.md'), mine);
});
