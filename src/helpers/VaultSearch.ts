import { App, TFile, parseYaml } from "obsidian";

export interface VaultSearchResult {
	path: string;
	filename: string;
	content: string;
	score: number;
}

// Common English (and a few note-taking) stopwords excluded from search
// terms so short/common words don't dominate scoring or waste tokens.
const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"and", "or", "but", "if", "then", "than", "so", "to", "of", "in", "on",
	"at", "for", "with", "about", "as", "by", "from", "into", "that", "this",
	"these", "those", "it", "its", "my", "your", "our", "their", "his", "her",
	"what", "when", "where", "who", "why", "how", "do", "does", "did",
	"can", "could", "should", "would", "will", "shall", "have", "has", "had",
	"me", "you", "we", "they", "he", "she", "i", "not", "please", "find",
	"tell", "give", "show", "review", "clean", "up", "notes", "note",
]);

const tokenize = (text: string): string[] => {
	return text
		.toLowerCase()
		.replace(/\[\[.*?\]\]/g, " ") // strip explicit [[links]] from scoring
		.match(/[a-z0-9][a-z0-9'-]{2,}/g)
		?.filter((word) => !STOPWORDS.has(word)) ?? [];
};

const MAX_CONTENT_CHARS = 4000;
const isTemplatePath = (path: string, excludeFolders: string[]): boolean =>
	excludeFolders.some((folder) =>
		path.toLowerCase().startsWith(`${folder.toLowerCase()}/`),
	);

/**
 * Searches all markdown notes in the vault for the terms in `query` and
 * returns the highest-scoring matches, so Copilot Chat can ground its
 * answer in the user's own notes (e.g. internal process docs) instead of
 * guessing from general/public knowledge.
 *
 * Scoring is a simple term-frequency heuristic: each occurrence of a query
 * term in the note body counts once, with a flat bonus for matches in the
 * filename. This is best suited for prose-heavy notes (meeting
 * transcripts, write-ups) — for questions about structured, frontmatter-
 * driven data (which notes have X property, which are type Y), prefer
 * `buildVaultIndex` instead, which lets the model reason directly over
 * every note's actual properties rather than guessing from word overlap.
 */
export const searchVaultForQuery = async (
	app: App,
	query: string,
	options?: {
		limit?: number;
		excludeFolders?: string[];
		excludePaths?: Set<string>;
	},
): Promise<VaultSearchResult[]> => {
	const limit = options?.limit ?? 5;
	const excludeFolders = options?.excludeFolders ?? ["templates"];
	const excludePaths = options?.excludePaths ?? new Set<string>();

	const terms = tokenize(query);
	if (terms.length === 0) return [];

	const files = app.vault
		.getMarkdownFiles()
		.filter(
			(file) =>
				!excludePaths.has(file.path) &&
				!isTemplatePath(file.path, excludeFolders),
		);

	const scored: VaultSearchResult[] = [];

	for (const file of files) {
		let content: string;
		try {
			// cachedRead avoids a disk hit for files already open/cached by
			// Obsidian, which keeps scanning the whole vault fast.
			content = await app.vault.cachedRead(file);
		} catch {
			continue;
		}

		const lowerContent = content.toLowerCase();
		const lowerName = file.basename.toLowerCase();

		let score = 0;
		for (const term of terms) {
			const nameMatches = lowerName.includes(term) ? 1 : 0;
			score += nameMatches * 5;

			let fromIndex = 0;
			while (true) {
				const idx = lowerContent.indexOf(term, fromIndex);
				if (idx === -1) break;
				score += 1;
				fromIndex = idx + term.length;
			}
		}

		if (score > 0) {
			scored.push({
				path: file.path,
				filename: file.basename,
				content:
					content.length > MAX_CONTENT_CHARS
						? `${content.slice(0, MAX_CONTENT_CHARS)}\n...(truncated)`
						: content,
				score,
			});
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
};

export const dedupeFileRefs = <
	T extends { path: string },
>(
	refs: T[],
): T[] => {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const ref of refs) {
		if (seen.has(ref.path)) continue;
		seen.add(ref.path);
		result.push(ref);
	}
	return result;
};

const FRONTMATTER_BLOCK_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Manually reads and parses a note's frontmatter via its raw content,
 * instead of Obsidian's `metadataCache`. Used as a fallback when the cache
 * hasn't indexed a file yet (e.g. right after Obsidian starts, before all
 * vault files have been processed) so a structured scan done moments after
 * launch doesn't silently miss notes and return incomplete/empty results.
 */
const readFrontmatterDirectly = async (
	app: App,
	file: TFile,
): Promise<Record<string, unknown> | null> => {
	try {
		const content = await app.vault.cachedRead(file);
		const match = content.match(FRONTMATTER_BLOCK_REGEX);
		if (!match) return null;
		const parsed = parseYaml(match[1]);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
};

/**
 * Reads a note's frontmatter, preferring Obsidian's metadata cache (fast,
 * no disk read) and falling back to parsing the raw file content directly
 * when the cache hasn't indexed the file yet.
 */
const getFrontmatter = async (
	app: App,
	file: TFile,
): Promise<Record<string, unknown> | null> => {
	const cached = app.metadataCache.getFileCache(file)?.frontmatter;
	if (cached) return cached;
	return readFrontmatterDirectly(app, file);
};

const IGNORED_INDEX_KEYS = new Set([
	"position",
	"icon",
	"cssclasses",
	"banner",
	"banner_x",
	"banner_y",
]);

// Minimal display-string helper for date-like frontmatter fields (used
// only for sorting the index by recency).
const toDateDisplayString = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return toDateDisplayString(value[0]);
	if (typeof value === "object") return "";
	return String(value).trim();
};

const formatScalarForIndex = (
	value: unknown,
	knownBasenames: Set<string>,
): string => {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);

	const str = String(value).trim();
	if (!str) return "";

	// Already a [[wikilink]] (optionally with |alias) — keep as-is so it
	// stays clickable.
	if (/^\[\[.*\]\]$/.test(str)) return str;

	// If the raw value happens to match an existing note's basename
	// exactly, treat it as an implicit link (common pattern: `Company:
	// Acme Corp` as plain text rather than `[[Acme Corp]]`) so the model
	// can still produce a clickable reference for it.
	if (knownBasenames.has(str.toLowerCase())) return `[[${str}]]`;

	return str;
};

const formatValueForIndex = (
	value: unknown,
	knownBasenames: Set<string>,
): string => {
	if (Array.isArray(value)) {
		return value
			.map((v) => formatScalarForIndex(v, knownBasenames))
			.filter(Boolean)
			.join(", ");
	}
	return formatScalarForIndex(value, knownBasenames);
};

const parseDateLike = (value: string): number => {
	const t = Date.parse(value);
	return Number.isNaN(t) ? 0 : t;
};

const MAX_INDEX_CHARS = 18000;

/**
 * Builds a general-purpose, vault-wide index of every note's own
 * frontmatter properties — dynamically discovering whatever property
 * names actually exist in THIS vault (e.g. Type, Company, Status,
 * Occurrence, Stage, Due Date, Industry, ...) rather than assuming any
 * fixed schema. This lets the model reason over arbitrary structured
 * questions itself ("which X have open Y", "find the weekly meeting note
 * for Z", "what trainings are due") without needing a hand-written
 * detector per question type — the model sees the real properties and
 * filters/groups them the same way a person would read a table.
 *
 * Only notes that have at least one frontmatter property are included
 * (pure prose notes are already covered by `searchVaultForQuery`). Columns
 * are the most commonly-used property keys across the vault, capped to
 * keep the table a reasonable size; `Type` is always included first when
 * present anywhere, since it's the most common category discriminator.
 * Rows are sorted by the most recent date-like value found (Updated /
 * Modified / Created / file mtime), newest first, and the whole table is
 * capped to a safe character budget so it never blows out the model's
 * context regardless of vault size.
 *
 * Values that reference another note (either already a [[wikilink]], or a
 * plain string that exactly matches another note's name) are emitted as
 * [[wikilinks]] so the chat UI can render them as clickable links.
 *
 * Returns null if no notes in the vault have any frontmatter at all.
 */
export const buildVaultIndex = async (
	app: App,
	options?: {
		maxRows?: number;
		maxColumns?: number;
		excludeFolders?: string[];
	},
): Promise<{
	summary: string;
	rowCount: number;
	truncated: boolean;
} | null> => {
	const excludeFolders = options?.excludeFolders ?? ["templates"];
	const maxRows = options?.maxRows ?? 250;
	const maxColumns = options?.maxColumns ?? 7;

	const files = app.vault
		.getMarkdownFiles()
		.filter((file) => !isTemplatePath(file.path, excludeFolders));

	const knownBasenames = new Set(
		files.map((f) => f.basename.toLowerCase()),
	);

	const entries: { file: TFile; frontmatter: Record<string, unknown> }[] =
		[];
	const keyFrequency = new Map<string, number>();

	for (const file of files) {
		const frontmatter = await getFrontmatter(app, file);
		if (!frontmatter) continue;

		const tags = formatValueForIndex(frontmatter.tags, knownBasenames);
		if (tags.toLowerCase().includes("template")) continue;

		entries.push({ file, frontmatter });
		for (const key of Object.keys(frontmatter)) {
			if (IGNORED_INDEX_KEYS.has(key.toLowerCase())) continue;
			keyFrequency.set(key, (keyFrequency.get(key) ?? 0) + 1);
		}
	}

	if (entries.length === 0) return null;

	// Pick the most broadly-used property keys as columns, always leading
	// with "Type" when present since it's the most common discriminator
	// for "what kind of note is this" across typical PKM vaults.
	const sortedKeys = Array.from(keyFrequency.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([key]) => key);
	const typeKey = sortedKeys.find((k) => k.toLowerCase() === "type");
	const otherKeys = sortedKeys.filter((k) => k !== typeKey);
	const columns = [...(typeKey ? [typeKey] : []), ...otherKeys].slice(
		0,
		maxColumns,
	);

	const rows = entries.map(({ file, frontmatter }) => {
		const values = columns.map(
			(col) =>
				formatValueForIndex(frontmatter[col], knownBasenames) || "—",
		);
		const dateCandidate =
			toDateDisplayString(frontmatter.Updated) ||
			toDateDisplayString(frontmatter.Modified) ||
			toDateDisplayString(frontmatter.Created) ||
			(file.stat?.mtime
				? new Date(file.stat.mtime).toISOString().slice(0, 10)
				: "");
		return {
			name: `[[${file.basename}]]`,
			values,
			sortKey: parseDateLike(dateCandidate) || file.stat?.mtime || 0,
		};
	});

	rows.sort((a, b) => b.sortKey - a.sortKey);

	let limited = rows.slice(0, maxRows);
	const buildTable = (rowSet: typeof rows): string => {
		const tableHeader = `| Note | ${columns.join(" | ")} |\n| --- | ${columns
			.map(() => "---")
			.join(" | ")} |`;
		const tableRows = rowSet
			.map((r) => `| ${r.name} | ${r.values.join(" | ")} |`)
			.join("\n");
		return `${tableHeader}\n${tableRows}`;
	};

	let table = buildTable(limited);
	let truncated = rows.length > limited.length;

	// Safety valve: if the table is still too large for a large vault even
	// after the row cap, keep trimming rows until it fits a sane budget
	// rather than ever sending an unbounded amount of context.
	while (table.length > MAX_INDEX_CHARS && limited.length > 10) {
		limited = limited.slice(0, Math.floor(limited.length * 0.75));
		table = buildTable(limited);
		truncated = true;
	}

	const truncatedNote = truncated
		? ` (showing ${limited.length} of ${entries.length} most recently updated)`
		: ` (${entries.length} total)`;

	const header = `Vault index — every note's own frontmatter properties${truncatedNote}, sorted most-recently-updated first. This is ground truth directly from the vault — use it to answer ANY question about structured note properties (status, type, company, dates, etc.) by reading/filtering this table yourself, instead of guessing or inferring from other notes. Values that reference another note use [[wikilink]] syntax — always preserve that exact [[...]] syntax when you repeat them in your reply, so the user can click through to open the note:`;

	return {
		summary: `${header}\n${table}`,
		rowCount: limited.length,
		truncated,
	};
};


