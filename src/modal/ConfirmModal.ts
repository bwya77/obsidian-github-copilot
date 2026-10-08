import { App, Modal, Setting } from "obsidian";

/**
 * A simple Yes/No confirmation modal using Obsidian's own Modal API.
 * Prefer this over the browser's native `confirm()`, which can render
 * unreliably (or be missed entirely) inside Obsidian's Electron shell.
 */
class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;
	private confirmText: string;

	constructor(
		app: App,
		message: string,
		onConfirm: () => void,
		confirmText = "Confirm",
	) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
		this.confirmText = confirmText;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default ConfirmModal;
