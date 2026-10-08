import { App, FileSystemAdapter } from "obsidian";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

class Vault {
	public static DEFAULT_TAB_SIZE = 4;

	public static getBasePath(app: App): string {
		let basePath;
		if (app.vault.adapter instanceof FileSystemAdapter) {
			basePath = app.vault.adapter.getBasePath();
		} else {
			throw new Error("Cannot determine base path.");
		}
		return `${basePath}`;
	}

	public static getConfigPath(app: App): string {
		return `${this.getBasePath(app)}/${app.vault.configDir}`;
	}

	public static getPluginPath(app: App): string {
		return `${this.getConfigPath(app)}/plugins/github-copilot`;
	}

	/**
	 * Base directory, outside the vault, used to cache the downloaded
	 * copilot-language-server binaries. This intentionally lives outside
	 * the vault (which is frequently stored under OneDrive/other synced
	 * cloud folders) because the language server bundle includes native
	 * modules (e.g. crypt32.node) whose binary content can trip DLP /
	 * sensitivity scanners that pattern-match for things like X.509
	 * certificate/private key material. Keeping large vendor binaries out
	 * of the synced vault avoids that entirely and also avoids needlessly
	 * syncing/re-uploading ~40MB of binaries on every device.
	 */
	public static getExternalCacheBasePath(app: App): string {
		const vaultId = crypto
			.createHash("md5")
			.update(this.getBasePath(app))
			.digest("hex")
			.slice(0, 12);
		return path.join(
			os.homedir(),
			".obsidian-github-copilot-cache",
			vaultId,
		);
	}

	public static getCopilotPath(app: App, version: string): string {
		return path.join(
			this.getExternalCacheBasePath(app),
			`copilot-${version}`,
		);
	}

	public static getAgentPath(app: App, version: string): string {
		return `${this.getCopilotPath(app, version)}/language-server.js`;
	}

	public static isFileExcluded(filePath: string, exclude: string[]): boolean {
		return exclude.some((path) => filePath.includes(path));
	}

	public static getTabSize(app: App): number {
		return (
			// @ts-expect-error - getConfig is not typed
			(app.vault.getConfig("tabSize") as number) || this.DEFAULT_TAB_SIZE
		);
	}
}

export default Vault;
