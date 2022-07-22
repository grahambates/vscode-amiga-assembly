import * as vscode from 'vscode';
import { DocumentationManager } from './documentation';

/**
 * Hover provider class for le assembly language
 */
export class M68kHoverProvider implements vscode.HoverProvider {
    static readonly DEFAULT_NUMBER_DISPLAY_FORMAT = "#`@dec@` - $`@hex@` - %`@bin@` @ascii@";
    documentationManager: DocumentationManager;
    constructor(documentationManager: DocumentationManager) {
        this.documentationManager = documentationManager;
    }
    /**
     * Main hover function
     * @param document Document to be processed
     * @return Hover results
     */
    public async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        const word = document.getWordRangeAtPosition(position);
        if (word) {
            const text = document.getText(word);
            const [register, func, lvo] = await Promise.all([
                this.documentationManager.getRegisterByName(text.toUpperCase()),
                this.documentationManager.getFunction(text),
                this.documentationManager.getFunction('_LVO' + text),
            ]);
            const found = register || func || lvo
            if (found) {
                const rendered = new vscode.MarkdownString(found.description);
                return new vscode.Hover(rendered, word);
            }
        }
        return null;
    }
}
