import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import matter from "gray-matter";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTENT_DIR = path.join(__dirname, "../content");
const ARTICLE_DIR = path.join(CONTENT_DIR, "article");
const CATEGORIES_DIR = path.join(CONTENT_DIR, "categories");

/** Committer name convention: `"<display name> (<player uuid>)"`. */
const COMMITTER_PLAYER_REGEX = /\(([0-9a-f-]{36})\)\s*$/i;

interface HistoryEntry {
    date: string;
    player: string | null;
    source: "imported" | "git";
    commit?: string;
}

interface ArticleInfo {
    title: string;
    slug: string;
    uuid: string;
    category: string;
    description: string;
    thumbnail: { imageId: string; blurhash64: string } | null;
    created: string | null;
    updated: string | null;
    history: HistoryEntry[];
}

function toUrlSlug(str: string): string {
    return encodeURIComponent(
        str
            .normalize("NFKC")
            .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
                String.fromCharCode(s.charCodeAt(0) - 0xfee0),
            )
            .replace(/\s+/g, "-")
            .replace(/[　]/g, "-")
            .replace(/--+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase(),
    );
}

function toIsoDate(value: unknown): string | null {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") {
        const t = Date.parse(value);
        if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
    return null;
}

async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, value: unknown) {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Frontmatter `modified` — the edit history imported from the pre-git system.
 * Git commits are the primary history; these entries only cover what happened
 * before the migration.
 */
function importedHistory(data: Record<string, unknown>): HistoryEntry[] {
    const modified = data.modified;
    if (!Array.isArray(modified)) return [];
    const entries: HistoryEntry[] = [];
    for (const raw of modified) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as { date?: unknown; player?: unknown };
        const date = toIsoDate(entry.date);
        if (!date) continue;
        entries.push({
            date,
            player: typeof entry.player === "string" ? entry.player : null,
            source: "imported",
        });
    }
    return entries;
}

/**
 * Commits that touched the article directory, oldest first. The player uuid
 * is recovered from the committer-name convention `"name (<uuid>)"`
 * (`makeCommitter`'s default format). Requires a full clone — in Actions,
 * check out with `fetch-depth: 0`.
 */
async function gitHistory(articleDirName: string): Promise<HistoryEntry[]> {
    try {
        const { stdout } = await execFileAsync(
            "git",
            [
                "log",
                "--format=%H%x09%aI%x09%an",
                "--",
                path.join("article", articleDirName),
            ],
            { cwd: CONTENT_DIR },
        );
        return stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [commit, rawDate, name] = line.split("\t");
                return {
                    date: toIsoDate(rawDate) ?? "",
                    player:
                        COMMITTER_PLAYER_REGEX.exec(name ?? "")?.[1] ?? null,
                    source: "git" as const,
                    commit,
                };
            })
            .filter((e) => e.date)
            .reverse();
    } catch {
        // Not a git checkout (or git unavailable) — imported history only.
        return [];
    }
}

function readThumbnail(
    data: Record<string, unknown>,
): ArticleInfo["thumbnail"] {
    const thumbnail = data.thumbnail;
    if (typeof thumbnail !== "object" || thumbnail === null) return null;
    const { imageId, blurhash64 } = thumbnail as {
        imageId?: unknown;
        blurhash64?: unknown;
    };
    if (typeof imageId !== "string" || !imageId) return null;
    return {
        imageId,
        blurhash64: typeof blurhash64 === "string" ? blurhash64 : "",
    };
}

/**
 * Scan `content/article/<uuid>/index.mdx` and emit:
 *   - `article/<uuid>/info.json` — per-article metadata with the merged
 *     history (frontmatter `modified` + git commits) baked in
 *   - `article.json`  — manifest of every article (info minus `history`)
 *   - `slug-index.json` — slug → uuid map, so `getPostBySlug` can resolve a
 *     slug without scanning the manifest
 */
async function generateArticleLists() {
    await ensureDir(ARTICLE_DIR);
    const entries = await fs.readdir(ARTICLE_DIR, { withFileTypes: true });
    const manifest: Array<Omit<ArticleInfo, "history">> = [];
    const slugIndex: Record<string, string> = {};
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const indexPath = path.join(ARTICLE_DIR, entry.name, "index.mdx");
        let raw: string;
        try {
            raw = await fs.readFile(indexPath, "utf-8");
        } catch {
            console.warn(`skip ${entry.name}: missing index.mdx`);
            continue;
        }
        const { data } = matter(raw);
        if (!data.uuid) {
            console.warn(`uuid missing in ${entry.name}/index.mdx`);
        }
        if (!data.slug) {
            console.warn(`slug missing in ${entry.name}/index.mdx`);
        }

        const history = [
            ...importedHistory(data),
            ...(await gitHistory(entry.name)),
        ].sort((a, b) => a.date.localeCompare(b.date));

        const info: ArticleInfo = {
            title: data.title ?? "",
            slug: toUrlSlug(data.slug ?? entry.name),
            uuid: data.uuid ?? entry.name,
            category: data.category ?? "",
            description: data.description ?? "",
            thumbnail: readThumbnail(data),
            created: history[0]?.date ?? null,
            updated: history[history.length - 1]?.date ?? null,
            history,
        };

        await writeJson(path.join(ARTICLE_DIR, entry.name, "info.json"), info);
        const { history: _history, ...summary } = info;
        manifest.push(summary);
        slugIndex[info.slug] = info.uuid;
    }
    await writeJson(path.join(CONTENT_DIR, "article.json"), manifest);
    await writeJson(path.join(CONTENT_DIR, "slug-index.json"), slugIndex);
    console.info(`article.json: ${manifest.length} posts`);
}

async function generateCategoriesList() {
    await ensureDir(CATEGORIES_DIR);
    const files = await fs.readdir(CATEGORIES_DIR);
    const categories: Array<Record<string, unknown>> = [];
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(CATEGORIES_DIR, file), "utf-8");
        categories.push(JSON.parse(raw));
    }
    await writeJson(path.join(CONTENT_DIR, "categories.json"), categories);
    console.info(`categories.json: ${categories.length} categories`);
}

async function main() {
    await generateArticleLists();
    await generateCategoriesList();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
