import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Notice, TFile } from "obsidian";

import { concat, cx } from "../../../utils/style";
import { usePlugin } from "../../hooks/usePlugin";
import { useCopilotStore } from "../../store/store";
import MermaidDiagram from "./MermaidDiagram";
import ConfirmModal from "../../../modal/ConfirmModal";

const BASE_CLASSNAME = "copilot-chat-message";

export interface MessageProps {
	className?: string;
	icon: string;
	name: string;
	message: string;
	role?: "user" | "assistant" | "system";
	linkedNotes?: {
		path: string;
		filename: string;
		content: string;
	}[];
}

interface CodeProps {
	node?: unknown;
	className?: string;
	inline?: boolean;
	children?: React.ReactNode;
}

const CodeBlockCopyButton: React.FC<{ code: string }> = ({ code }) => {
	const [isCopied, setIsCopied] = React.useState(false);

	const handleCopy = () => {
		navigator.clipboard
			.writeText(code)
			.then(() => {
				setIsCopied(true);
				setTimeout(() => setIsCopied(false), 2000);
			})
			.catch((err) => {
				console.error("Failed to copy code block:", err);
			});
	};

	return (
		<button
			type="button"
			className={concat(BASE_CLASSNAME, "codeblock-copy-button")}
			onClick={handleCopy}
			title={isCopied ? "Copied!" : "Copy code"}
			aria-label={isCopied ? "Copied!" : "Copy code"}
		>
			{isCopied ? (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="20 6 9 17 4 12"></polyline>
				</svg>
			) : (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect
						x="9"
						y="9"
						width="13"
						height="13"
						rx="2"
						ry="2"
					></rect>
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
				</svg>
			)}
			<span className={concat(BASE_CLASSNAME, "codeblock-copy-label")}>
				{isCopied ? "Copied!" : "Copy"}
			</span>
		</button>
	);
};

interface AnchorProps {
	node?: unknown;
	href?: string;
	children?: React.ReactNode;
}

const WIKILINK_SCHEME = "obsidian-wikilink://";
const WIKILINK_REGEX = /\[\[([^\]|]+)(\|([^\]]+))?\]\]/g;

/**
 * Converts [[Note Name]] / [[Note Name|Alias]] wikilink syntax into a
 * regular markdown link pointing at a custom `obsidian-wikilink://` scheme,
 * so ReactMarkdown parses it as a normal link node that our custom `a`
 * renderer below can intercept and turn into a real Obsidian navigation
 * (instead of a dead/external-looking link). Code fences are left
 * untouched so literal [[...]] content shown in a code block (e.g. a note
 * preview) isn't rewritten.
 */
const linkifyWikiLinks = (text: string): string => {
	const segments = text.split(/(```[\s\S]*?```)/g);
	return segments
		.map((segment) => {
			if (segment.startsWith("```")) return segment;
			return segment.replace(
				WIKILINK_REGEX,
				(_match, target: string, _pipe, alias?: string) => {
					const display = (alias || target).trim();
					const encoded = encodeURIComponent(target.trim());
					return `[${display}](${WIKILINK_SCHEME}${encoded})`;
				},
			);
		})
		.join("");
};

// Conversational filler the model sometimes appends after the actual note
// content (e.g. "If you want, I can also make it more like..."). Stripped
// from the trailing paragraph only, and only when there's no code fence to
// unambiguously isolate the real content.
const TRAILING_FILLER_REGEX =
	/^(if you want|let me know|happy to|i can also|would you like|want me to)/i;

/**
 * Extracts the content to write back to a note from an assistant reply.
 * If the reply contains exactly one fenced code block, its contents are
 * used (this is the common case for "rewrite this note" style requests).
 * Otherwise we fall back to the raw message text, trimming any obvious
 * conversational intro/outro the model added around the actual content.
 */
const extractApplyContent = (message: string): string => {
	const codeBlockRegex = /```[^\n]*\n([\s\S]*?)```/g;
	const blocks: string[] = [];
	let match;

	while ((match = codeBlockRegex.exec(message)) !== null) {
		blocks.push(match[1].replace(/\n$/, ""));
	}

	if (blocks.length === 1) {
		return blocks[0];
	}

	let content = message.trim();

	// If there's an explanatory line before the note's frontmatter (e.g.
	// "Here's the cleaned-up file content for [[Note]]:"), drop everything
	// before the first "---" delimiter.
	const lines = content.split("\n");
	const frontmatterStart = lines.findIndex((line) => line.trim() === "---");
	if (frontmatterStart > 0) {
		content = lines.slice(frontmatterStart).join("\n").trim();
	}

	// Drop a trailing conversational paragraph (separated by a blank line)
	// if it reads like meta-commentary rather than note content.
	const paragraphs = content.split(/\n\s*\n/);
	if (paragraphs.length > 1) {
		const lastParagraph = paragraphs[paragraphs.length - 1].trim();
		if (TRAILING_FILLER_REGEX.test(lastParagraph)) {
			paragraphs.pop();
			content = paragraphs.join("\n\n").trim();
		}
	}

	return content;
};

const ChatMessage: React.FC<MessageProps> = (props) => {
	const { className, icon, name, message, linkedNotes, role } = props;
	const plugin = usePlugin();
	const { activeFile } = useCopilotStore();
	const [isCopied, setIsCopied] = React.useState(false);
	const [isApplied, setIsApplied] = React.useState(false);

	const isDarkTheme = useMemo(() => {
		return document.body.classList.contains("theme-dark");
	}, [plugin?.app]);

	const isMarkdownEnabled = plugin?.settings?.enableMarkdownRendering ?? true;

	const handleCopyMessage = () => {
		navigator.clipboard
			.writeText(message)
			.then(() => {
				setIsCopied(true);
				setTimeout(() => {
					setIsCopied(false);
				}, 2000);
			})
			.catch((err) => {
				console.error("Failed to copy message: ", err);
			});
	};

	const applyTargetNote = linkedNotes?.[0] ?? activeFile;

	// Opens a note by exact vault path (used for the "Linked Notes" chips,
	// where we already know the precise file).
	const openNoteByPath = (path: string, displayName: string) => {
		if (!plugin) return;
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			plugin.app.workspace.getLeaf(false).openFile(file);
		} else {
			new Notice(`Could not find note: ${displayName}`);
		}
	};

	// Opens a note by name (used for [[wikilinks]] inside the assistant's
	// own reply text, where we only have a name, not a verified path —
	// openLinkText does Obsidian's normal fuzzy/basename resolution).
	const openNoteByName = (name: string) => {
		if (!plugin) return;
		plugin.app.workspace.openLinkText(name, "", false);
	};

	const writeToNote = async () => {
		if (!plugin || !applyTargetNote) return;

		const file = plugin.app.vault.getAbstractFileByPath(
			applyTargetNote.path,
		);

		if (!(file instanceof TFile) || file.extension !== "md") {
			new Notice(`Could not find note: ${applyTargetNote.filename}`);
			return;
		}

		try {
			const newContent = extractApplyContent(message);
			await plugin.app.vault.modify(file, newContent);
			new Notice(`Updated ${applyTargetNote.filename}`);
			setIsApplied(true);
			setTimeout(() => setIsApplied(false), 2000);
		} catch (error) {
			console.error("Failed to apply response to note:", error);
			new Notice(`Failed to update ${applyTargetNote.filename}`);
		}
	};

	const handleApplyToNote = () => {
		if (!plugin || !applyTargetNote) {
			new Notice("No note is open to apply this response to.");
			return;
		}

		new ConfirmModal(
			plugin.app,
			`Replace the contents of "${applyTargetNote.filename}" with this response? You can undo this with Ctrl+Z in the note afterwards.`,
			() => {
				writeToNote();
			},
			"Replace note",
		).open();
	};

	return (
		<div
			className={cx(concat(BASE_CLASSNAME, "container"), className || "")}
		>
			<div className={concat(BASE_CLASSNAME, "info")}>
				<div
					className={concat(BASE_CLASSNAME, "icon")}
					dangerouslySetInnerHTML={{ __html: icon }}
				/>
				<div className={concat(BASE_CLASSNAME, "name")}>{name}</div>
				{role === "assistant" && (
					<button
						className={concat(BASE_CLASSNAME, "apply-button")}
						onClick={handleApplyToNote}
						title={
							isApplied
								? "Applied!"
								: applyTargetNote
									? `Apply to ${applyTargetNote.filename}`
									: "No note open to apply to"
						}
						aria-label={
							isApplied
								? "Applied!"
								: applyTargetNote
									? `Apply to ${applyTargetNote.filename}`
									: "No note open to apply to"
						}
						disabled={!applyTargetNote}
					>
						{isApplied ? (
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
						) : (
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M12 20h9"></path>
								<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
							</svg>
						)}
					</button>
				)}
				<button
					className={concat(BASE_CLASSNAME, "copy-button")}
					onClick={handleCopyMessage}
					title={isCopied ? "Copied!" : "Copy message"}
					aria-label={isCopied ? "Copied!" : "Copy message"}
				>
					{isCopied ? (
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="20 6 9 17 4 12"></polyline>
						</svg>
					) : (
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect
								x="9"
								y="9"
								width="13"
								height="13"
								rx="2"
								ry="2"
							></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
					)}
				</button>
			</div>
			<div className={concat(BASE_CLASSNAME, "message")}>
				{isMarkdownEnabled ? (
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						components={{
							p({ children }) {
								return (
									<p style={{ whiteSpace: "pre-wrap" }}>
										{children}
									</p>
								);
							},
							code({
								className,
								inline,
								children,
								...props
							}: CodeProps) {
								const match = /language-(\w+)/.exec(
									className || "",
								);
								const language = match ? match[1] : "";
								const codeContent = String(
									children || "",
								).replace(/\n$/, "");

								// Handle Mermaid diagrams
								if (
									!inline &&
									(language === "mermaid" ||
										language === "mmd")
								) {
									return (
										<MermaidDiagram
											chart={codeContent}
											isDarkTheme={isDarkTheme}
										/>
									);
								}

								// Handle other code blocks with syntax highlighting
								return !inline && match ? (
									<div
										className={concat(
											BASE_CLASSNAME,
											"codeblock-container",
										)}
									>
										<CodeBlockCopyButton
											code={codeContent}
										/>
										<SyntaxHighlighter
											language={language}
											style={
												isDarkTheme
													? vscDarkPlus
													: (oneLight as Record<
															string,
															React.CSSProperties
														>)
											}
											PreTag="div"
											className={`theme-${
												isDarkTheme ? "dark" : "light"
											}`}
											customStyle={{
												background:
													"var(--code-background)",
												borderRadius: "4px",
											}}
											{...props}
										>
											{codeContent}
										</SyntaxHighlighter>
									</div>
								) : !inline ? (
									<div
										className={concat(
											BASE_CLASSNAME,
											"codeblock-container",
										)}
									>
										<CodeBlockCopyButton code={codeContent} />
										<pre>
											<code className={className} {...props}>
												{children}
											</code>
										</pre>
									</div>
								) : (
									<code className={className} {...props}>
										{children}
									</code>
								);
							},
							a({ href, children }: AnchorProps) {
								if (
									href &&
									href.startsWith(WIKILINK_SCHEME)
								) {
									const noteName = decodeURIComponent(
										href.slice(WIKILINK_SCHEME.length),
									);
									return (
										<a
											href="#"
											className="internal-link"
											onClick={(e) => {
												e.preventDefault();
												openNoteByName(noteName);
											}}
										>
											{children}
										</a>
									);
								}
								return (
									<a
										href={href}
										target="_blank"
										rel="noopener noreferrer"
									>
										{children}
									</a>
								);
							},
						}}
					>
						{linkifyWikiLinks(message)}
					</ReactMarkdown>
				) : (
					<div
						className={concat(BASE_CLASSNAME, "plain-text")}
						style={{ whiteSpace: "pre-wrap" }}
					>
						{message}
					</div>
				)}

				{linkedNotes && linkedNotes.length > 0 && (
					<div className={concat(BASE_CLASSNAME, "linked-notes")}>
						<div
							className={concat(
								BASE_CLASSNAME,
								"linked-notes-title",
							)}
						>
							Linked Notes:
						</div>
						<div
							className={concat(
								BASE_CLASSNAME,
								"linked-notes-list",
							)}
						>
							{linkedNotes.map((note, index) => (
									<button
									key={index}
										type="button"
										className={concat(
											BASE_CLASSNAME,
											"linked-note",
										)}
										onClick={() =>
											openNoteByPath(
												note.path,
												note.filename,
											)
										}
										title={`Open ${note.filename}`}
									>
										<span
											className={concat(
												BASE_CLASSNAME,
												"linked-note-filename",
											)}
										>
											[[{note.filename}]]
										</span>
									</button>
								))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
};

export default ChatMessage;
