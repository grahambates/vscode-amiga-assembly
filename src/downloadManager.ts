import { ExtensionContext, ProgressLocation, Uri, window } from "vscode";
import * as path from 'path';
import { getApi, FileDownloader } from "@microsoft/vscode-file-downloader-api";
import axios from 'axios';
import { FileProxy } from "./fsProxy";
import winston = require("winston");

/**
 * Interface to store the Github Tag information
 */
export interface TagInfo {
    /** Name of the tag */
    name: string;
    /** url of the zip */
    zipball_url: string;
    /** extension of the tag */
    extension?: string;
    /** Version of the tag */
    version: Version;
}

/**
 * Class to manage the version and their comparison.
 * Version format : major.minor.increment
 */
export class Version {
    public major: number;
    public minor: number;
    public increment: number;

    /**
     * Constructor
     * @param version String containing a version
     */
    constructor(version: string) {
        const elms = version.split(".");
        this.major = 0;
        this.minor = 0;
        this.increment = 0;
        if (version.length > 0 && elms.length > 0) {
            this.major = parseInt(elms[0]);
            if (elms.length > 1) {
                this.minor = parseInt(elms[1]);
                if (elms.length > 2) {
                    this.increment = parseInt(elms[2]);
                }
            }
        }
    }

    /**
     * Compares two version
     * @param other Other Version to compare
     * @returns -1 : this is greater, 0 : equals, 1: other is grater
     */
    public compare(other: Version): number {
        if (other.major > this.major) {
            return 1;
        } else if (other.major < this.major) {
            return -1;
        } else {
            if (other.minor > this.minor) {
                return 1;
            } else if (other.minor < this.minor) {
                return -1;
            } else {
                if (other.increment > this.increment) {
                    return 1;
                } else if (other.increment < this.increment) {
                    return -1;
                } else {
                    return 0;
                }
            }
        }
    }

    /**
     * Verify if the two version are compatible : same major and minor
     * @param other Other version
     * @returns 
     */
    public isCompatible(other: Version): boolean {
        return this.major === other.major && this.minor === other.minor;
    }

    /**
     * Get the version as string
     * @returns version as string
     */
    public toString(): string {
        return `${this.major}.${this.minor}.${this.increment}`;
    }

    /**
     * Parse a version string
     * @param version Parses a version from string
     * @returns A version or null if it not a version format
     */
    public static parse(version: string): Version | null {
        // eslint-disable-next-line no-useless-escape
        if (version.match(/^[\d\.]+$/)) {
            return new Version(version);
        }
        return null;
    }
}

/**
 * Manager for the extension downloads
 */
export class DownloadManager {
    /** URL of the github project tags */
    protected tagsURL: string;
    /** URL of the github project branches */
    protected branchURL: string;

    /**
     * Constructor
     * @param branchURL  URL of the github project branches
     * @param tagsURL URL of the github project tags
     */
    constructor(branchURL: string, tagsURL: string) {
        this.branchURL = branchURL;
        this.tagsURL = tagsURL;
    }

    /**
     * Returns the version from a path
     * @param filePath Path to parse
     * @returns Version or null
     */
    public getVersionFromFilename(filePath: string): Version | null {
        const filename = path.basename(filePath);
        return Version.parse(filename);
    }

    /**
     * Delete a directory (useful for the tests)
     * @param directoryUri Uri of the directory
     * @returns 
     */
    public deleteDirectory(directoryUri: Uri): Promise<void> {
        const dProxy = new FileProxy(directoryUri);
        return dProxy.delete();
    }

    /**
     * Downloads the project.
     * @param context Extension context
     * @param version Version of te extension
     * @returns Uri of the downloaded project
     */
    public async downloadProject(context: ExtensionContext, version: string): Promise<Uri> {
        const [downloadedVersion, url] = await this.getZipURL(new Version(version));
        const uri = Uri.parse(url);
        // List all the download files
        const downloadedFiles: Uri[] = await this.listAllDownloadedFiles(context);
        let fileUri: Uri | undefined;
        for (const file of downloadedFiles) {
            const vDir = this.getVersionFromFilename(file.path);
            if (vDir) {
                if (vDir.compare(downloadedVersion) !== 0) {
                    await this.deleteDirectory(file);
                } else {
                    fileUri = file;
                }
            }
        }
        if (!fileUri) {
            fileUri = await this.downloadFile("downloads", uri, downloadedVersion.toString(), context, true);
        }
        const fProxy = new FileProxy(fileUri);
        const files = await fProxy.listFiles();
        return files[0].getUri();
    }

    /**
     * List all the tags of the project.
     * @returns List of tag infos
     */
    public async listTagsFromGitHub(): Promise<Array<TagInfo>> {
        const tagList = new Array<TagInfo>();
        const response = await axios.get(this.tagsURL);
        for (const d of response.data) {
            const elms = d.name.split("-");
            const version = new Version(elms[0]);
            let os: string | undefined;
            if (elms.length > 1) {
                os = elms[1];
            }
            tagList.push(<TagInfo>{
                name: d.name,
                zipball_url: d.zipball_url,
                version: version,
                extension: os
            });
        }
        return tagList;
    }

    /**
     * Get the current os name as written in the binaries names
     * @returns The current os name 
     */
    public getOsName(): string {
        switch (process.platform) {
            case "win32":
                return "windows";
            case "darwin":
                return "osx";
            default:
                return "debian";
        }
    }

    /**
     * Get the current branch name for the os
     * @returns The current branch name
     */
    public getBranchName(): string {
        switch (process.platform) {
            case "win32":
                return "windows_x64";
            case "darwin":
                return "osx";
            default:
                return "debian_x64";
        }
    }

    /**
     * Retrieves and selects the URL to download the binaries
     * @param version Selected version
     * @returns Tuple [version, URL of the binaries]
     */
    public async getZipURL(version: Version): Promise<[Version, string]> {
        const osName = this.getOsName();
        try {
            const tagInfos = await this.listTagsFromGitHub();
            let bestTagInfo: TagInfo | undefined;
            for (const tag of tagInfos) {
                if (!tag.extension || tag.extension === osName) {
                    if (version.isCompatible(tag.version) && (!bestTagInfo || bestTagInfo.version.compare(tag.version) > 0)) {
                        bestTagInfo = tag;
                    }
                }
            }
            if (bestTagInfo) {
                return [bestTagInfo.version, `${bestTagInfo.zipball_url}`];
            }
        } catch (error) {
            // Use the master...
            winston.error("Error retrieving tags from github", error);
        }
        // no tag : the master is returned
        const branchName = this.getBranchName();
        return [version, `${this.branchURL}/${branchName}.zip`];
    }

    /**
     * Gets the local downloaded file path
     * @param filename Downloaded file name
     * @param context Context of the extension
     * @returns local downloaded file path
     */
    public async getDownloadedFile(filename: string, context: ExtensionContext): Promise<Uri> {
        const fileDownloader: FileDownloader = await this.getFileDownloader();
        return fileDownloader.getItem(filename, context);
    }

    /**
     * Deletes the local downloaded file path
     * @param filename Downloaded file name
     * @param context Context of the extension
     */
    public async deleteDownloadedFile(filename: string, context: ExtensionContext): Promise<void> {
        const fileDownloader: FileDownloader = await this.getFileDownloader();
        await fileDownloader.deleteItem(filename, context);
    }

    /**
     * Deletes all downloaded files
     * @param context Context of the extension
     */
    public async deleteAllDownloadedFiles(context: ExtensionContext): Promise<void> {
        const fileDownloader: FileDownloader = await this.getFileDownloader();
        await fileDownloader.deleteAllItems(context);
    }

    /**
     * List the downloaded files
     * @param context Extension context
     */
    public async listAllDownloadedFiles(context: ExtensionContext): Promise<Uri[]> {
        const fileDownloader: FileDownloader = await this.getFileDownloader();
        return fileDownloader.listDownloadedItems(context);
    }

    /**
     * Return the file downloader api (useful for mocking)
     * @returns FileDownloader api
     */
    public getFileDownloader(): Promise<FileDownloader> {
        return getApi();
    }

    /**
     * Download a file
     * @param name Name of the file
     * @param uri URI of the files
     * @param outPath Output directory
     * @param context Extension context
     * @param extract If true the unzip the file
     * @returns Local uri of the downloaded file
     */
    public async downloadFile(name: string, uri: Uri, outPath: string, context: ExtensionContext, extract?: boolean): Promise<Uri> {
        return window.withProgress<Uri>({
            location: ProgressLocation.Notification,
            title: `Downloading ${name} `,
            cancellable: true
        }, async (progress, token) => {
            // Get downloader API and begin to download the requested file
            const fileDownloader = await this.getFileDownloader();
            let lastProgress = 0;
            const file: Uri = await fileDownloader.downloadFile(uri, outPath, context, token, (downloaded, total) => {
                // Just return if we don't know how large the file is
                if (!total) {
                    progress.report({ message: 'Please wait...' });
                } else {
                    // Otherwise, update the progress
                    progress.report({ message: `Please wait...`, increment: downloaded - lastProgress });
                    lastProgress = downloaded;
                }
            }, { shouldUnzip: extract });
            // Return the final path of the downloaded file
            return file;
        });
    }
}


/**
 * Manager for the extension binaries
 */
export class BinariesManager extends DownloadManager {
    /** URL of the github binaries project branches */
    static readonly BINARIES_BRANCH_URL = "https://github.com/prb28/vscode-amiga-assembly-binaries/archive/refs/heads";
    /** URL of the github binaries project tags */
    static readonly BINARIES_TAGS_URL = "https://api.github.com/repos/prb28/vscode-amiga-assembly-binaries/tags";

    /**
     * Constructor
     */
    constructor() {
        super(BinariesManager.BINARIES_BRANCH_URL, BinariesManager.BINARIES_TAGS_URL);
    }
}


/**
 * Manager for the extension example project
 */
export class ExampleProjectManager extends DownloadManager {
    /** URL of the github example project branches */
    static readonly BRANCH_URL = "https://github.com/prb28/vscode-amiga-wks-example/archive/refs/heads";
    /** URL of the github example project tags */
    static readonly TAGS_URL = "https://api.github.com/repos/prb28/vscode-amiga-wks-example/tags";

    /**
     * Constructor
     */
    constructor() {
        super(ExampleProjectManager.BRANCH_URL, ExampleProjectManager.TAGS_URL);
    }
}