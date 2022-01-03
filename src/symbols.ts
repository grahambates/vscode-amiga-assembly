/* eslint-disable @typescript-eslint/ban-types */
import { Range, Uri, workspace, TextDocument } from 'vscode';
import { ASMLine } from './parser';

export class SymbolFile {
    private uri: Uri;
    private definedSymbols = new Array<Symbol>();
    private referredSymbols = new Array<Symbol>();
    private variables = new Array<Symbol>();
    private labels = new Array<Symbol>();
    private macros = new Array<Symbol>();
    private subroutines = new Array<string>();
    private dcLabel = new Array<Symbol>();
    private includeDir = "";
    private includedFiles = new Array<Symbol>();

    constructor(uri: Uri) {
        this.uri = uri;
    }

    public async readFile(): Promise<SymbolFile> {
        // Read the file
        const document = await workspace.openTextDocument(this.uri);
        this.readDocument(document);
        return this;
    }

    public readDocument(document: TextDocument): void {
        this.clear();
        let lastLabel: Symbol | null = null;
        const labelsBeforeRts = Array<Symbol>();
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const asmLine = new ASMLine(line.text, line);
            let [symbol, range] = asmLine.getSymbolFromLabelOrVariable();
            if ((symbol !== undefined) && (range !== undefined)) {
                this.definedSymbols.push(new Symbol(symbol, this, range));
            } else {
                const results = asmLine.getSymbolFromData();
                for (let k = 0; k < results.length; k++) {
                    [symbol, range] = results[k];
                    if ((symbol !== undefined) && (range !== undefined)) {
                        this.referredSymbols.push(new Symbol(symbol, this, range));
                    }
                }
                if (asmLine.mnemonic) {
                    this.referredSymbols.push(new Symbol(asmLine.mnemonic, this, asmLine.mnemonicRange));
                }
            }
            const instruct = asmLine.instruction.toLowerCase();
            if (asmLine.label.length > 0) {
                let label = asmLine.label.replace(":", "");
                const isLocal = label.indexOf(".") === 0;
                if (isLocal) {
                    label = lastLabel?.getLabel() + label;
                }
                const s = new Symbol(label, this, asmLine.labelRange);
                // Is this actually a macro definition in `<name> macro` syntax?
                if (instruct.indexOf("macro") === 0) {
                    this.macros.push(s);
                } else {
                    this.labels.push(s);
                    if (!isLocal) {
                        lastLabel = s;
                    }
                }
            } else if (instruct.indexOf("macro") === 0) {
                // Handle ` macro <name>` syntax
                const s = new Symbol(asmLine.data, this, asmLine.dataRange);
                this.macros.push(s);
            }
            if (asmLine.variable.length > 0) {
                this.variables.push(new Symbol(asmLine.variable, this, asmLine.variableRange, asmLine.value));
            }
            if (instruct.indexOf("bsr") >= 0) {
                this.subroutines.push(asmLine.data);
            } else if ((instruct.indexOf("dc") === 0) || (instruct.indexOf("ds") === 0) || (instruct.indexOf("incbin") === 0)) {
                if (lastLabel) {
                    this.dcLabel.push(lastLabel);
                }
            } else if (instruct.indexOf("rts") >= 0) {
                if (lastLabel) {
                    labelsBeforeRts.push(lastLabel);
                }
            } else if (instruct === "incdir") {
                this.includeDir = asmLine.data.replace(/"/g, '');
            } else if (instruct === "include") {
                const includeSymbol = new Symbol(asmLine.data.replace(/"/g, ''), this, asmLine.dataRange);
                this.includedFiles.push(includeSymbol);
                this.definedSymbols.push(includeSymbol);
            }
        }
        let inSub = false;
        let lastParent: Symbol | undefined;
        for (const l of this.labels) {
            if (this.subroutines.indexOf(l.getLabel()) >= 0) {
                inSub = true;
                lastParent = l;
            } else if (inSub && lastParent) {
                l.setParent(lastParent.getLabel());
                const range = lastParent.getRange();
                lastParent.setRange(range.union(l.getRange()));
            }
            if (labelsBeforeRts.indexOf(l) >= 0) {
                inSub = false;
            }
        }
    }

    public clear(): void {
        this.definedSymbols = new Array<Symbol>();
        this.referredSymbols = new Array<Symbol>();
        this.variables = new Array<Symbol>();
        this.labels = new Array<Symbol>();
        this.macros = new Array<Symbol>();
        this.subroutines = new Array<string>();
        this.dcLabel = new Array<Symbol>();
        this.includeDir = "";
        this.includedFiles = new Array<Symbol>();
    }

    public getUri(): Uri {
        return this.uri;
    }
    public getDefinedSymbols(): Array<Symbol> {
        return this.definedSymbols;
    }
    public getReferredSymbols(): Array<Symbol> {
        return this.referredSymbols;
    }
    public getVariables(): Array<Symbol> {
        return this.variables;
    }
    public getLabels(): Array<Symbol> {
        return this.labels;
    }
    public getMacros(): Array<Symbol> {
        return this.macros;
    }
    public getSubRoutines(): Array<string> {
        return this.subroutines;
    }
    public getDcLabels(): Array<Symbol> {
        return this.dcLabel;
    }
    public getIncludeDir(): string {
        return this.includeDir;
    }
    public getIncludedFiles(): Array<Symbol> {
        return this.includedFiles;
    }
}

export class Symbol {
    private label: string;
    private file: SymbolFile;
    private range: Range;
    private value?: string;
    private parent = "";
    constructor(label: string, file: SymbolFile, range: Range, value?: string) {
        this.label = label;
        this.file = file;
        this.range = range;
        this.value = value;
        this.parent = label;
    }
    public getFile(): SymbolFile {
        return this.file;
    }
    public getRange(): Range {
        return this.range;
    }
    public setRange(range: Range): void {
        this.range = range;
    }
    public getLabel(): string {
        return this.label;
    }
    public getValue(): string | undefined {
        return this.value;
    }
    public getParent(): string {
        return this.parent;
    }
    public setParent(parent: string): void {
        this.parent = parent;
    }
}