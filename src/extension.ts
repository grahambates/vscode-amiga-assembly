// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { M68kHoverProvider } from './hover';
import { M86kColorProvider } from './color';
import { DebugSession } from './debugSession';
import { VASMCompiler } from './vasm';
import { StatusManager } from './status';
import { Disassembler, DisassembleRequestType } from './disassemble';
import { DisassemblyContentProvider } from './disassemblyContentProvider';
import { DataGeneratorCodeLensProvider } from './expressionDataGenerator';
import { IFFViewerPanel } from './iffImageViewer';
import { DocumentationManager } from './documentation';
import { DisassembledMemoryDataProvider } from './viewDisassembled';
import * as winston from 'winston';
import * as TransportStream from 'winston-transport';
import { FileProxy } from './fsProxy';
import { AmigaBuildTaskProvider, CompilerController } from './customTaskProvider';
import { BinariesManager } from './downloadManager';
import { ConfigurationHelper } from './configurationHelper';
import { WorkspaceManager } from './workspaceManager';
import HttpRequestHandler from './filedownloader/networking/HttpRequestHandler';
import FileDownloader from './filedownloader/FileDownloader';
import OutputLogger from './filedownloader/logging/OutputLogger';
import { DataBreakpointSizesStorage } from './breakpointStorage';
import { NumberFormat, VariableDisplayFormatRequest } from 'uae-dap';
import { createBltconHelperPanel } from './bltconHelper';

// Setting all the globals values
export const AMIGA_ASM_MODE: vscode.DocumentFilter = { language: 'm68k' };
export const AMIGA_DEBUG_ASM_MODE: vscode.DocumentFilter = {
    language: 'amiga-assembly-debug.disassembly',
    scheme: 'disassembly',
};

class SimpleConsoleTransport extends TransportStream {
    private outputChannel: vscode.OutputChannel;
    constructor(outputChannel: vscode.OutputChannel) {
        super();
        this.outputChannel = outputChannel;
    }
    public log(info: any, callback: any) {
        setImmediate(() => this.emit('logged', info));
        this.outputChannel.appendLine(`[${info.level}] ${info.message}`);
        if (callback) {
            callback();
        }
    }
}

export class ExtensionState {
    private compiler: VASMCompiler | undefined;
    private errorDiagnosticCollection: vscode.DiagnosticCollection | undefined;
    private warningDiagnosticCollection:
        | vscode.DiagnosticCollection
        | undefined;
    private statusManager: StatusManager | undefined;
    private disassembler: Disassembler | undefined;
    private dataGenerator: DataGeneratorCodeLensProvider | undefined;
    private documentationManager: DocumentationManager | undefined;
    private outputChannel: vscode.OutputChannel;
    private buildDir: FileProxy | undefined;
    private tmpDir: FileProxy | undefined;
    private context: vscode.ExtensionContext | undefined;
    private version: string;
    private workspaceRootDir: vscode.Uri | null = null;
    private forcedBuildDir?: FileProxy;
    private iffViewPanelsMap: Map<vscode.WebviewPanel, IFFViewerPanel>;
    private fileDownloader?: FileDownloader;

    private extensionPath: string = path.join(__dirname, '..');

    public constructor() {
        this.outputChannel =
            vscode.window.createOutputChannel('Amiga Assembly');
        const transport = new SimpleConsoleTransport(this.outputChannel);
        const level: string | undefined = this.getLogLevel();
        if (level) {
            transport.level = level;
        }
        winston.add(transport);
        this.version = vscode.extensions.getExtension(
            'prb28.amiga-assembly'
        )?.packageJSON.version;
        this.iffViewPanelsMap = new Map<vscode.WebviewPanel, IFFViewerPanel>();
    }
    public getLogLevel(): string | undefined {
        return ConfigurationHelper.retrieveStringPropertyInDefaultConf(
            'logLevel'
        );
    }
    public getErrorDiagnosticCollection(): vscode.DiagnosticCollection {
        if (this.errorDiagnosticCollection === undefined) {
            this.errorDiagnosticCollection =
                vscode.languages.createDiagnosticCollection('m68k-error');
        }
        return this.errorDiagnosticCollection;
    }
    public getWarningDiagnosticCollection(): vscode.DiagnosticCollection {
        if (this.warningDiagnosticCollection === undefined) {
            this.warningDiagnosticCollection =
                vscode.languages.createDiagnosticCollection('m68k-warning');
        }
        return this.warningDiagnosticCollection;
    }
    public getStatusManager(): StatusManager {
        if (this.statusManager === undefined) {
            this.statusManager = new StatusManager();
        }
        return this.statusManager;
    }
    public getCompiler(): VASMCompiler {
        if (this.compiler === undefined) {
            this.compiler = new VASMCompiler();
        }
        return this.compiler;
    }
    public getDisassembler(): Disassembler {
        if (this.disassembler === undefined) {
            this.disassembler = new Disassembler();
        }
        return this.disassembler;
    }
    public static getCurrent(): ExtensionState {
        // activate the extension
        const ext = vscode.extensions.getExtension('prb28.amiga-assembly');
        if (ext) {
            return ext.exports.getState();
        }
        return new ExtensionState();
    }
    public static isActive(): boolean {
        // activate the extension
        const ext = vscode.extensions.getExtension('prb28.amiga-assembly');
        if (ext) {
            return ext.isActive;
        }
        return false;
    }
    public getDataGenerator(): DataGeneratorCodeLensProvider {
        if (this.dataGenerator === undefined) {
            this.dataGenerator = new DataGeneratorCodeLensProvider();
        }
        return this.dataGenerator;
    }
    public async getDocumentationManager(): Promise<DocumentationManager> {
        if (this.documentationManager === undefined) {
            this.documentationManager = new DocumentationManager(
                this.extensionPath
            );
            await this.documentationManager.load();
        }
        return this.documentationManager;
    }

    public getBinariesManager(): BinariesManager {
        return new BinariesManager(
            ConfigurationHelper.retrieveStringPropertyInDefaultConf(
                'binariesBranchURL'
            ),
            ConfigurationHelper.retrieveStringPropertyInDefaultConf(
                'binariesTagsURL'
            )
        );
    }

    public setExtensionPath(extensionPath: string): void {
        this.extensionPath = extensionPath;
    }
    public getExtensionPath(): string {
        return this.extensionPath;
    }
    public getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }
    public dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
    }

    /**
     * Default build dir : Workspace/build
     */
    private getDefaultBuildDir(): FileProxy {
        const rootDir = this.getWorkspaceRootDir();
        if (rootDir) {
            return new FileProxy(
                rootDir.with({ path: rootDir.path + '/build' })
            );
        }
        return new FileProxy(vscode.Uri.file('./build'));
    }

    /**
     * If it is an absolute path returns it, or add it to the current workspace path
     */
    private getPathOrRelative(pathSelected: string): FileProxy {
        if (!path.isAbsolute(pathSelected)) {
            const rootDir = this.getWorkspaceRootDir();
            if (rootDir) {
                return new FileProxy(
                    rootDir.with({ path: `${rootDir.path}/${pathSelected}` })
                );
            }
        }
        return new FileProxy(vscode.Uri.file(pathSelected));
    }

    /**
     * Returns the temporary directory
     */
    public getTmpDir(): FileProxy {
        const tmpDirPath: any =
            ConfigurationHelper.retrieveStringPropertyInDefaultConf('tmpDir');
        if (tmpDirPath) {
            this.tmpDir = this.getPathOrRelative(tmpDirPath);
        } else {
            this.tmpDir = this.getDefaultBuildDir();
        }
        return this.tmpDir;
    }

    /**
     * Forces build dir for the tests
     * @param buildDir Forced build dir
     */
    public forceBuildDir(buildDir: FileProxy): void {
        this.forcedBuildDir = buildDir;
    }

    /**
     * Returns the build directory
     */
    public getBuildDir(): FileProxy {
        if (this.forcedBuildDir) {
            return this.forcedBuildDir;
        }
        const buildDirPath: any =
            ConfigurationHelper.retrieveStringPropertyInDefaultConf('buildDir');
        if (buildDirPath) {
            this.buildDir = this.getPathOrRelative(buildDirPath);
        } else {
            this.buildDir = this.getDefaultBuildDir();
        }
        return this.buildDir;
    }

    /**
     * Reads the workspace folder dir
     */
    getWorkspaceRootDir(): vscode.Uri | null {
        if (this.workspaceRootDir) {
            return this.workspaceRootDir;
        } else if (
            vscode.workspace.workspaceFolders &&
            vscode.workspace.workspaceFolders.length > 0
        ) {
            return vscode.workspace.workspaceFolders[0].uri;
        }
        return null;
    }

    /**
     * Reads the workspaces folders
     */
    getWorkspaceFolders(): Array<vscode.Uri> {
        const folders = new Array<vscode.Uri>();
        if (this.workspaceRootDir) {
            folders.push(this.workspaceRootDir);
        } else {
            if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    folders.push(folder.uri);
                }
            }
        }
        return folders;
    }

    /**
     * Select a workspace root directory
     * @param workspaceRootDir Workspace root directory
     */
    setWorkspaceRootDir(workspaceRootDir: vscode.Uri): void {
        this.workspaceRootDir = workspaceRootDir;
    }

    /**
     * Set the extension context
     */
    setExtensionContext(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * Get the extension context
     */
    getExtensionContext(): vscode.ExtensionContext | undefined {
        return this.context;
    }

    /**
     * Get the extension version
     */
    getExtensionVersion(): string {
        return this.version;
    }

    /** List of the opened panels */
    getIffViewPanelsMap(): Map<vscode.WebviewPanel, IFFViewerPanel> {
        return this.iffViewPanelsMap;
    }

    setFileDownloader(fileDownloader: FileDownloader) {
        this.fileDownloader = fileDownloader;
    }

    getFileDownloader(): FileDownloader | undefined {
        return this.fileDownloader;
    }
}

const state = new ExtensionState();

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext): Promise<any> {
    state.setExtensionPath(context.extensionPath);

    // Create the file downloader
    const logger = new OutputLogger(state.getOutputChannel(), context);
    const requestHandler = new HttpRequestHandler(logger);
    state.setFileDownloader(new FileDownloader(requestHandler, logger));

    // Preparing the status manager
    const statusManager = state.getStatusManager();
    vscode.window.onDidChangeActiveTextEditor(
        statusManager.showHideStatus,
        null,
        context.subscriptions
    );
    context.subscriptions.push(statusManager);

    winston.info('Starting Amiga Assembly');

    // Declaring the Hover
    const docManager = await state.getDocumentationManager();
    let disposable = vscode.languages.registerHoverProvider(
        AMIGA_ASM_MODE,
        new M68kHoverProvider(docManager)
    );
    context.subscriptions.push(disposable);

    // create a new disassembler
    const disassembler = state.getDisassembler();
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.disassemble-file',
        async () => {
            try {
                await disassembler.showInputPanel(DisassembleRequestType.FILE);
            } catch (err) {
                vscode.window.showErrorMessage(err.message);
            }
        }
    );
    context.subscriptions.push(disposable);

    // create a new disassembler for copper address
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.disassemble-copper',
        async () => {
            try {
                await disassembler.showInputPanel(
                    DisassembleRequestType.COPPER
                );
            } catch (err) {
                vscode.window.showErrorMessage(err.message);
            }
        }
    );
    context.subscriptions.push(disposable);

    // create a new disassembler for memory address
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.disassemble-memory',
        async () => {
            try {
                await disassembler.showInputPanel(
                    DisassembleRequestType.MEMORY
                );
            } catch (err) {
                vscode.window.showErrorMessage(err.message);
            }
        }
    );
    context.subscriptions.push(disposable);

    // Show documentation
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.showdoc',
        async (args: any) => {
            let newPath = args.path;
            if (!newPath.endsWith('.md')) {
                newPath += '.md';
            }
            const docsPathOnDisk = vscode.Uri.file(
                path.join(context.extensionPath, 'docs', newPath)
            );
            await vscode.commands.executeCommand(
                'markdown.showPreview',
                docsPathOnDisk
            );
        }
    );
    context.subscriptions.push(disposable);
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.showdoc-toc',
        async () => {
            const docsPathOnDisk = vscode.Uri.file(
                path.join(context.extensionPath, 'docs', 'toc.md')
            );
            await vscode.commands.executeCommand(
                'markdown.showPreview',
                docsPathOnDisk
            );
        }
    );
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('amiga-assembly.bltcon-helper', async () => {
        createBltconHelperPanel(context.extensionUri);
    });
    context.subscriptions.push(disposable);

    // Color provider
    context.subscriptions.push(
        vscode.languages.registerColorProvider(
            AMIGA_ASM_MODE,
            new M86kColorProvider()
        )
    );
    context.subscriptions.push(
        vscode.languages.registerColorProvider(
            AMIGA_DEBUG_ASM_MODE,
            new M86kColorProvider()
        )
    );

    // Diagnostics
    const errorDiagnosticCollection = state.getErrorDiagnosticCollection();
    const warningDiagnosticCollection = state.getWarningDiagnosticCollection();
    context.subscriptions.push(errorDiagnosticCollection);
    context.subscriptions.push(warningDiagnosticCollection);

    // VASM Command
    const compiler = state.getCompiler();
    // Build on save
    const vController = new CompilerController();
    context.subscriptions.push(vController);
    // Clean the workspace
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.clean-vasm-workspace',
        async () => {
            try {
                await compiler.cleanWorkspace();
                statusManager.onDefault();
            } catch (error) {
                statusManager.onError(error.message);
            }
        }
    );
    context.subscriptions.push(disposable);

    // Build task provides
    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(
            AmigaBuildTaskProvider.AMIGA_BUILD_SCRIPT_TYPE,
            new AmigaBuildTaskProvider(state)
        )
    );

    // Data generator code lens provider
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.generate-data',
        async (range: vscode.Range) => {
            try {
                await state.getDataGenerator().onGenerateData(range);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        }
    );
    context.subscriptions.push(disposable);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            AMIGA_ASM_MODE,
            state.getDataGenerator()
        )
    );

    // Debugger View commands

    const setDisplayFormat = (
        variableInfo: any,
        variableDisplayFormat: NumberFormat
    ) => {
        const ds = vscode.debug.activeDebugSession;
        if (!ds) {
            return;
        }
        const args: VariableDisplayFormatRequest = {
            variableInfo,
            variableDisplayFormat,
        };
        ds.customRequest('modifyVariableFormat', args);
    };

    disposable = vscode.commands.registerCommand(
        'amiga-assembly.showVariableAsBin',
        (variableInfo) => {
            setDisplayFormat(variableInfo, NumberFormat.BINARY);
        }
    );
    context.subscriptions.push(disposable);
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.showVariableAsDec',
        (variableInfo) => {
            setDisplayFormat(variableInfo, NumberFormat.DECIMAL);
        }
    );
    context.subscriptions.push(disposable);
    disposable = vscode.commands.registerCommand(
        'amiga-assembly.showVariableAsHex',
        (variableInfo) => {
            setDisplayFormat(variableInfo, NumberFormat.HEXADECIMAL);
        }
    );
    context.subscriptions.push(disposable);

    // Views
    const disassembledMemoryDataProvider = new DisassembledMemoryDataProvider();
    vscode.window.registerTreeDataProvider(
        'disassembledMemory',
        disassembledMemoryDataProvider
    );
    vscode.commands.registerCommand(
        'disassembledMemory.setDisassembledMemory',
        (memory: DebugProtocol.DisassembledInstruction[]) =>
            disassembledMemoryDataProvider.setDisassembledMemory(memory)
    );

    // register a configuration provider for debug types:
    // Universal:
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('amiga-assembly', new InlineDebugAdapterFactory()));
    // Deprecated:
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('fs-uae', new FsUAEConfigurationProvider()));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('fs-uae', new InlineDebugAdapterFactory()));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('uae-run', new RunFsUAEConfigurationProvider()));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('uae-run', new RunFsUAEInlineDebugAdapterFactory()));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('winuae', new WinUAEConfigurationProvider()));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('winuae', new InlineDebugAdapterFactory()));
    winston.info("------> done");

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('disassembly', new DisassemblyContentProvider()));
    // IFF view
    if (vscode.window.registerWebviewPanelSerializer) {
        // Make sure we register a serializer in activation event
        vscode.window.registerWebviewPanelSerializer(IFFViewerPanel.VIEW_TYPE, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                const view = state.getIffViewPanelsMap().get(webviewPanel);
                if (view) {
                    await view.update();
                }
            },
        });
    }
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'amiga-assembly.view-iff',
            async (imageUri: vscode.Uri) => {
                const [panel, view] = await IFFViewerPanel.create(
                    context.extensionPath,
                    imageUri
                );
                state.getIffViewPanelsMap().set(panel, view);
                panel.onDidDispose(() => {
                    state.getIffViewPanelsMap().delete(panel);
                });
            }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'amiga-assembly.download-binaries',
            async () => {
                const binariesManager = state.getBinariesManager();
                const ctx = state.getExtensionContext();
                const version = state.getExtensionVersion();
                if (ctx) {
                    try {
                        console.log('executing command');
                        ConfigurationHelper.setBinariesPath(
                            (
                                await binariesManager.downloadProject(
                                    ctx,
                                    version
                                )
                            ).fsPath
                        );
                        console.log('executing command END');
                    } catch (error) {
                        vscode.window.showErrorMessage(error.message);
                    }
                }
            }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'amiga-assembly.clean-downloaded-binaries',
            async () => {
                const binariesManager = state.getBinariesManager();
                const ctx = state.getExtensionContext();
                if (ctx) {
                    try {
                        await binariesManager.deleteAllDownloadedFiles(ctx);
                    } catch (error) {
                        vscode.window.showErrorMessage(error.message);
                    }
                }
            }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'amiga-assembly.create-example-workspace',
            async (destinationDirectory?: vscode.Uri) => {
                const ctx = state.getExtensionContext();
                if (ctx) {
                    const workspaceManager = new WorkspaceManager();
                    const version = state.getExtensionVersion();
                    try {
                        const workspaceURI =
                            await workspaceManager.createExampleWorkspace(
                                ctx,
                                version,
                                destinationDirectory
                            );
                        await vscode.commands.executeCommand(
                            'vscode.openFolder',
                            workspaceURI
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(error.message);
                    }
                }
            }
        )
    );
    state.setExtensionContext(context);
    // clearing the data breakpoints storage
    context.subscriptions.push(
        vscode.commands.registerCommand('amiga-assembly.clear-data-breakpoints-storage', async () => {
            const storage = new DataBreakpointSizesStorage();
            storage.clear();
        })
    );
    state.setExtensionContext(context);
    const api = {
        getState(): ExtensionState {
            return state;
        },
    };

    if (
        ConfigurationHelper.retrieveBooleanProperty(
            ConfigurationHelper.getDefaultConfiguration(null),
            'downloadBinaries',
            true
        )
    ) {
        setTimeout(async () => {
            try {
                await vscode.commands.executeCommand(
                    'amiga-assembly.download-binaries'
                );
            } catch (error) {
                // forget it
            }
        }, 500);
    }
    return api;
}

export function deactivate() {
    // nothing to do
}

class FsUAEConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'm68k') {
                config.type = 'fs-uae';
                config.name = 'Launch';
                config.request = 'launch';
                config.stopOnEntry = true;
                config.startEmulator = true;
                config.emulator = '${config:amiga-assembly.binDir}/fs-uae';
                if (
                    process.platform === 'win32' &&
                    !config.emulator.endsWith('.exe')
                ) {
                    config.emulator = config.emulator + '.exe';
                }
                config.program = '${workspaceFolder}/uae/dh0/myprogram';
                config.serverName = 'localhost';
                config.serverPort = 6860;
                config.preLaunchTask =
                    AmigaBuildTaskProvider.AMIGA_BUILD_PRELAUNCH_TASK_NAME;
                config.options = [
                    '--chip_memory=2048',
                    '--hard_drive_0=${workspaceFolder}//uae/dh0',
                    '--joystick_port_1=none',
                    '--amiga_model=A1200',
                    '--remote_debugger=200',
                    '--use_remote_debugger=true',
                    '--automatic_input_grab=0',
                ];
                config.emulatorWorkingDir = '${config:amiga-assembly.binDir}';
            }
        }
        return config;
    }
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    createDebugAdapterDescriptor(
        _session: vscode.DebugSession
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
        return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession());
    }
}

class RunFsUAEConfigurationProvider
    implements vscode.DebugConfigurationProvider
{
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'm68k') {
                config.type = 'uae-run';
                config.name = 'Launch';
                config.request = 'launch';
                config.emulator = 'fs-uae';
                config.emulator = '${config:amiga-assembly.binDir}/fs-uae';
                if (
                    process.platform === 'win32' &&
                    !config.emulator.endsWith('.exe')
                ) {
                    config.emulator = config.emulator + '.exe';
                }
                config.preLaunchTask =
                    AmigaBuildTaskProvider.AMIGA_BUILD_PRELAUNCH_TASK_NAME;
                config.options = [
                    '--chip_memory=2048',
                    '--hard_drive_0=${workspaceFolder}//uae/dh0',
                    '--amiga_model=A1200',
                    '--automatic_input_grab=0',
                ];
                config.emulatorWorkingDir = '${config:amiga-assembly.binDir}';
            }
        }
        return config;
    }
}

class RunFsUAEInlineDebugAdapterFactory
    implements vscode.DebugAdapterDescriptorFactory
{
    createDebugAdapterDescriptor(
        _session: vscode.DebugSession
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
        return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession());
    }
}

class WinUAEConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'm68k') {
                config.type = 'winuae';
                config.name = 'Launch';
                config.request = 'launch';
                config.stopOnEntry = true;
                config.startEmulator = true;
                config.emulator = '${config:amiga-assembly.binDir}/winuae.exe';
                config.program = '${workspaceFolder}/uae/dh0/myprogram';
                config.conf = 'configuration/dev.winuae';
                config.preLaunchTask =
                    AmigaBuildTaskProvider.AMIGA_BUILD_PRELAUNCH_TASK_NAME;
                config.serverName = 'localhost';
                config.serverPort = 2345;
                config.emulatorWorkingDir = '${config:amiga-assembly.binDir}';
                config.options = [
                    '-s',
                    'debugging_trigger=SYS:myprogram',
                    '-s',
                    'filesystem=rw,dh0:${workspaceFolder}\\uae\\dh0',
                    '-s',
                    'debugging_features=gdbserver',
                ];
                config.preLaunchTask = 'amigaassembly: build';
            }
        }
        return config;
    }
}
