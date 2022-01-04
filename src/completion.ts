import * as vscode from 'vscode';
import { DocumentationManager, DocumentationType, isDocumentationLazy } from './documentation';
import { M68kDefinitionHandler } from './definitionHandler';
import { ASMLine } from './parser';
import { M68kLanguage } from './language';
import { FileProxy } from './fsProxy';
import { Uri } from 'vscode';

export class M68kCompletionItemProvider implements vscode.CompletionItemProvider {
    documentationManager: DocumentationManager;
    definitionHandler: M68kDefinitionHandler;
    language: M68kLanguage;

    constructor(documentationManager: DocumentationManager, definitionHandler: M68kDefinitionHandler, language: M68kLanguage) {
        this.documentationManager = documentationManager;
        this.definitionHandler = definitionHandler;
        this.language = language;
    }

    public async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
        const completions: vscode.CompletionItem[] = [];
        const completionLabels: string[] = [];

        let wordRange = document.getWordRangeAtPosition(position);
        const line = document.lineAt(position.line);
        const asmLine = new ASMLine(line.text, line);

        let lastChar = "";
        if (position.character > 0) {
            lastChar = line.text.charAt(position.character - 1);
        }

        // Which part of the ASM line is the word in?
        const isInComment = asmLine.commentRange.contains(position);
        const isInMnemonic = asmLine.mnemonicRange.contains(position);
        const isInData = asmLine.dataRange.contains(position);
        const isInSize = !wordRange && (lastChar === ".") && asmLine.instructionRange.contains(position.translate(undefined, -1));

        // Instruction size completions:
        if (isInSize) {
            return this.provideCompletionsForSize(document, position);
        }

        // No completions:
        if (isInComment || !wordRange) {
            return [];
        }

        // File completions for include directive:

        if (!isInMnemonic && asmLine.instruction.toLowerCase() === "include") {
            return this.provideCompletionForIncludes(asmLine, document, position);
        }

        let labelPrefix = ""; 

        // Adjustments to word/range for local labels:
        const isLocalLabel = line.text.charAt(wordRange.start.character -1) === ".";
        if (isLocalLabel) {
            // Extend range to include leading dot
            wordRange = new vscode.Range(
                new vscode.Position(wordRange.start.line, wordRange.start.character - 1),
                wordRange.end
            );
            // Find previous global label
            for (let i = wordRange.start.line; i >= 0; i--) {
                const match = document.lineAt(i).text.match(/^(\w+)\b/);
                if (match) {
                    labelPrefix = match[0];
                    break;
                }
            }
        }

        const word = labelPrefix + document.getText(wordRange);

        // Documentation completions:

        let docKeywords = await this.documentationManager.findKeywordStartingWith(word);

        const mnemonicTypes = [DocumentationType.INSTRUCTION, DocumentationType.DIRECTIVE];
        const registerTypes = [DocumentationType.REGISTER, DocumentationType.CPU_REGISTER];

        // Filter by type based on position:
        if (isInMnemonic) {
            docKeywords = docKeywords.filter(k => mnemonicTypes.includes(k.type));
        } else {
            docKeywords = docKeywords.filter(k => !mnemonicTypes.includes(k.type));
        }

        // Lazy load all descriptions
        await Promise.all(docKeywords.map(k => 
            isDocumentationLazy(k) ? k.loadDescription() : null)
        );

        for (const docKeyword of docKeywords) {
            const isRegister = registerTypes.includes(docKeyword.type)
            let label = docKeyword.name;

            // Match input case for registers
            if (isRegister) {
                if (word[0] === word[0].toLowerCase()) {
                    label = label.toLowerCase()
                }
            }
            // Match input case for mnemonics
            const isMnemonic = mnemonicTypes.includes(docKeyword.type);
            if (isMnemonic && word[0] === word[0].toUpperCase()) {
                label = label.toUpperCase()
            }
            // Add optional _LVO prefix for library functions
            if (isInData && word.startsWith("_LVO")) {
                label = "_LVO" + label;
            }

            const kind = isRegister ?  vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Function;
            const completion = new vscode.CompletionItem(label, kind);
            completion.detail = docKeyword.detail;
            completion.documentation = new vscode.MarkdownString(docKeyword.description);
            completions.push(completion);
            completionLabels.push(label);
        }

        // Symbol definition completions:

        if (isInMnemonic) {
            // Macro symbols:
            const macros = this.definitionHandler.findMacroStartingWith(word);
            for (const [label] of macros.entries()) {
                if (!completionLabels.includes(label)) {
                    const kind = vscode.CompletionItemKind.Function;
                    const completion = new vscode.CompletionItem(label, kind);
                    completion.detail =  "macro";
                    completions.push(completion);
                    completionLabels.push(label);
                }
            }
        } else {
            // Label symbols:
            const labels = this.definitionHandler.findLabelStartingWith(word);
            for (const [label, symbol] of labels.entries()) {
                if (!completionLabels.includes(label)) {
                    const kind = vscode.CompletionItemKind.Function;
                    const completion = new vscode.CompletionItem(label.substring(labelPrefix.length), kind);
                    const filename = symbol.getFile().getUri().path.split("/").pop();
                    const line = symbol.getRange().start.line;
                    completion.detail =  "label " + filename + ":" + line;
                    completion.range = { replacing: wordRange, inserting: wordRange }
                    completions.push(completion);
                    completionLabels.push(label);
                }
            }
            // Varaible symbols:
            const variables = this.definitionHandler.findVariableStartingWith(word);
            for (const [variable, value] of variables.entries()) {
                if (!completionLabels.includes(variable)) {
                    const kind = vscode.CompletionItemKind.Variable;
                    const completion = new vscode.CompletionItem(variable, kind);
                    completion.detail = value;
                    completion.range = { replacing: wordRange, inserting: wordRange }
                    completions.push(completion);
                }
            }
        } 

        return completions;
    }

    private provideCompletionsForSize(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const localRange = document.getWordRangeAtPosition(position.translate(undefined, -1));
        const word = document.getText(localRange);
        const extensions = this.language.getExtensions(word.toLowerCase());
        if (extensions) {
            const isUpper = word === word.toUpperCase();
            for (let ext of extensions) {
                const text = isUpper ? ext.toUpperCase() : ext;
                const completion = new vscode.CompletionItem(text, vscode.CompletionItemKind.Unit);
                completions.push(completion);
            }
        }
        return completions;
    }

    private async retrieveIncludeDir(documentFile: FileProxy): Promise<FileProxy | undefined> {
        let includeDir: FileProxy | undefined;
        if (await documentFile.exists()) {
            const includeDirInSource = await this.definitionHandler.getIncludeDir(documentFile.getUri());
            if (includeDirInSource) {
                let incDirFile = new FileProxy(Uri.file(includeDirInSource));
                if (await incDirFile.exists() && await incDirFile.isDirectory()) {
                    includeDir = incDirFile
                } else {
                    // May be a relative path to the current
                    incDirFile = documentFile.getParent().getRelativeFile(includeDirInSource);
                    if (await incDirFile.exists() && await incDirFile.isDirectory()) {
                        includeDir = incDirFile
                    }
                }
            }
        }
        return includeDir;
    }

    private async provideCompletionsForFile(asmLine: ASMLine, documentFile: FileProxy, parent: FileProxy, position: vscode.Position, checkAbsolute: boolean): Promise<vscode.CompletionItem[]> {
        const documentPath = FileProxy.normalize(documentFile.getPath());
        const completions = new Array<vscode.CompletionItem>();
        // filtering the path from the include
        let length = position.character - asmLine.dataRange.start.character;
        let start = 0;
        if (asmLine.data.startsWith("\"")) {
            start = 1;
            length--;
        }
        let filter: string | undefined;
        if (length > 0) {
            const typedPath = asmLine.data.substr(start, length);
            // check for an absolute path
            let newParent = new FileProxy(Uri.file(FileProxy.normalize(typedPath)));
            if (checkAbsolute && await newParent.exists() && await newParent.isDirectory()) {
                parent = newParent;
            } else {
                // check for a relative path
                newParent = parent.getRelativeFile(typedPath);
                if (await newParent.exists() && await newParent.isDirectory()) {
                    parent = newParent;
                } else {
                    // check for relative path with filename
                    const normalizedTypedPath = FileProxy.normalize(typedPath);
                    const pos = normalizedTypedPath.lastIndexOf("/");
                    if (pos > 0) {
                        const subPath = normalizedTypedPath.substr(0, pos);
                        newParent = parent.getRelativeFile(subPath);
                        if (await newParent.exists() && await newParent.isDirectory()) {
                            parent = newParent;
                            filter = normalizedTypedPath.substr(pos + 1);
                        } else {
                            filter = typedPath;
                        }
                    } else {
                        filter = typedPath;
                    }
                }
            }
        }
        for (const f of await parent.listFiles()) {
            if (documentPath !== FileProxy.normalize(f.getPath()) && (!filter || f.getName().startsWith(filter)) && !f.getName().startsWith(".")) {
                // search for the files
                let kind = vscode.CompletionItemKind.File;
                let name = f.getName();
                let sortText = `B${name}`;
                if (await f.isDirectory()) {
                    kind = vscode.CompletionItemKind.Folder;
                    name += "/";
                    sortText = `A${name}`;
                }
                const completion = new vscode.CompletionItem(name, kind);
                completion.sortText = sortText;
                completions.push(completion);
            }
        }
        return completions;
    }

    private cleanAndReorder(completions: vscode.CompletionItem[]): vscode.CompletionItem[] {
        const fileMap = new Map<string, vscode.CompletionItem>();
        for (const c of completions) {
            fileMap.set(c.label.toString(), c);
        }
        return Array.from(fileMap.values());
    }

    private async provideCompletionForIncludes(asmLine: ASMLine, document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
        let completions = new Array<vscode.CompletionItem>();
        // current folder of the document
        const fp = new FileProxy(document.uri);
        const includeDir: FileProxy | undefined = await this.retrieveIncludeDir(fp);
        if (includeDir) {
            completions = await this.provideCompletionsForFile(asmLine, fp, includeDir, position, false);
        }
        completions = completions.concat(await this.provideCompletionsForFile(asmLine, fp, fp.getParent(), position, true));
        return this.cleanAndReorder(completions);
    }
}
