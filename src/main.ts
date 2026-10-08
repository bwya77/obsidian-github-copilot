import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";

import EventManager from "./events/EventManager";
import CopilotAgent from "./copilot/CopilotAgent";
import StatusBar from "./status/StatusBar";
import CopilotPluginSettingTab, {
	CopilotPluginSettings,
	DEFAULT_SETTINGS,
} from "./settings/CopilotPluginSettingTab";
import ExtensionManager from "./extensions/ExtensionManager";
import Vault from "./helpers/Vault";
import File from "./helpers/File";
import Logger from "./helpers/Logger";
import Cacher from "./copilot/Cacher";
import ChatView from "./copilot-chat/views/ChatView";
import { CHAT_VIEW_TYPE } from "./copilot-chat/types/constants";
import github from "./config/github";

export default class CopilotPlugin extends Plugin {
	settingsTab: CopilotPluginSettingTab;
	settings: CopilotPluginSettings;
	statusBar: StatusBar | null;
	copilotAgent: CopilotAgent;
	private cmExtensionManager: ExtensionManager;
	private eventManager: EventManager;
	version = "1.474.5";
	tabSize = Vault.DEFAULT_TAB_SIZE;

	async onload() {
		this.settingsTab = new CopilotPluginSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		await this.settingsTab.loadSettings();

		this.statusBar = new StatusBar(this);

		Logger.getInstance().setDebug(this.settings.debug);

		this.tabSize = Vault.getTabSize(this.app);

		// Recreate or update the copilot folder and artifacts from the bundle.
		// Also detect a previously incomplete/corrupted extraction (missing
		// the language-server.js entry point) so the plugin can self-heal
		// instead of silently trying to spawn a nonexistent agent forever.
		const copilotPath = Vault.getCopilotPath(this.app, this.version);
		const agentIsMissing = !fs.existsSync(
			Vault.getAgentPath(this.app, this.version),
		);
		if (!File.doesFolderExist(copilotPath) || agentIsMissing) {
			await File.createFolder(copilotPath);

			try {
				await File.downloadFileAsync(
					github.RELEASE_URL(this.version),
					copilotPath + ".zip",
				);
				Logger.getInstance().log("Download finished.");
				File.unzipFile(copilotPath + ".zip", copilotPath);
				File.removeFile(copilotPath + ".zip");
			} catch (err) {
				Logger.getInstance().log(`Download failed: ${err}`);
				new Notice(
					"[GitHub Copilot] Failed to download the Copilot language server. Please restart Obsidian to retry.",
				);
			}

			await File.removeOldCopilotFolders(
				this.version,
				Vault.getExternalCacheBasePath(this.app),
			);
		}

		if (
			this.settings.nodePath === DEFAULT_SETTINGS.nodePath ||
			this.settings.nodePath === ""
		) {
			new Notice(
				"[GitHub Copilot] Please set the path to your node executable in the settings to use autocomplete feature.",
			);
		}

		if (
			this.settingsTab.isCopilotEnabled() &&
			!this.settings.nodePathUpdatedToNode22
		) {
			new Notice(
				"[GitHub Copilot] Copilot has changed the minimum node version to 22. Please update your node version if you are using an older version.",
			);
		}

		this.copilotAgent = new CopilotAgent(this);
		if (await this.settingsTab.isCopilotEnabledWithPathCheck()) {
			await this.copilotAgent.setup();
		}

		this.eventManager = new EventManager(this);
		this.eventManager.registerEvents();

		this.cmExtensionManager = new ExtensionManager(this);
		this.registerEditorExtension(this.cmExtensionManager.getExtensions());

		const file = this.app.workspace.getActiveFile();
		if (file) {
			Cacher.getInstance().setCurrentFilePath(
				Vault.getBasePath(this.app),
				file.path,
			);
		}

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		if (this.settings.openChatOnStartup) {
			// Defer until the workspace layout has fully loaded — calling
			// getRightLeaf() before then can hit a null workspace split
			// internally in Obsidian and throw (surfacing as "Cannot read
			// properties of null (reading 'children')").
			this.app.workspace.onLayoutReady(() => {
				this.activateView();
			});
		}

		this.addCommand({
			id: "open-copilot-chat",
			name: "Open Copilot Chat",
			callback: () => {
				this.activateView();
				const leaves =
					this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
				if (leaves.length > 0) {
					this.app.workspace.revealLeaf(leaves[0]);
				}
			},
		});
	}

	onunload() {
		this.copilotAgent?.stopAgent();
		this.statusBar = null;
		this.deactivateView();
	}

	async activateView(): Promise<void> {
		try {
			const { workspace } = this.app;

			let leaf: WorkspaceLeaf | null = null;
			const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
			if (leaves.length > 0) {
				leaf = leaves[0];
			} else {
				leaf = workspace.getRightLeaf(false);
				await leaf?.setViewState({
					type: CHAT_VIEW_TYPE,
					active: true,
				});
			}
			if (!leaf) {
				Logger.getInstance().error("Failed to create chat view.");
				return;
			}
		} catch (error) {
			Logger.getInstance().error(
				`Failed to activate Copilot Chat view: ${error}`,
			);
		}
	}

	async deactivateView() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	}
}
