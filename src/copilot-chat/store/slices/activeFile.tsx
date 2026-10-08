import { StateCreator } from "zustand";
import { TFile } from "obsidian";
import CopilotPlugin from "../../../main";

export interface ActiveFileInfo {
	path: string;
	filename: string;
}

export interface ActiveFileSlice {
	activeFile: ActiveFileInfo | null;
	autoAttachActiveFile: boolean;
	setActiveFile: (file: TFile | null) => void;
	initActiveFileTracking: (plugin: CopilotPlugin | undefined) => void;
	setAutoAttachActiveFile: (
		plugin: CopilotPlugin | undefined,
		value: boolean,
	) => void;
}

export const createActiveFileSlice: StateCreator<
	any, // We use any here as we'll properly type it in the store.ts
	[],
	[],
	ActiveFileSlice
> = (set, get) => ({
	activeFile: null,
	autoAttachActiveFile: true,

	setActiveFile: (file: TFile | null) => {
		if (!file || file.extension !== "md") {
			return;
		}

		set({
			activeFile: {
				path: file.path,
				filename: file.basename,
			},
		});
	},

	initActiveFileTracking: (plugin: CopilotPlugin | undefined) => {
		if (!plugin) {
			return;
		}

		set({
			autoAttachActiveFile: plugin.settings.autoAttachActiveFile ?? true,
		});

		// Seed with whatever markdown file is currently active (e.g. the
		// note open next to the chat pane when it first loads).
		const currentFile = plugin.app.workspace.getActiveFile();
		if (currentFile) {
			get().setActiveFile(currentFile);
		}

		// Keep tracking the active file as the user switches notes. We
		// deliberately ignore events where there is no file (e.g. focusing
		// the chat pane itself) so the chat stays aware of the last note
		// the user had open rather than losing context.
		plugin.registerEvent(
			plugin.app.workspace.on("file-open", (file) => {
				if (file) {
					get().setActiveFile(file);
				}
			}),
		);
	},

	setAutoAttachActiveFile: (
		plugin: CopilotPlugin | undefined,
		value: boolean,
	) => {
		set({ autoAttachActiveFile: value });

		if (!plugin) {
			return;
		}

		plugin.settings.autoAttachActiveFile = value;
		plugin.saveData(plugin.settings).catch((error) => {
			console.error("Failed to save auto-attach setting:", error);
		});
	},
});
