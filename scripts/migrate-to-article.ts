/**
 * One-shot migration: `content/wiki/<slug>.md` + `content/img/<file>`
 *   → `content/article/<uuid>/index.mdx` + `content/article/<uuid>/assets/<file>`
 *
 * Contract:
 * - **All-or-nothing.** Every staged change is computed and verified first.
 *   If any post references an image that doesn't exist in `content/img/`, the
 *   run aborts *before writing or deleting anything* — no partial state, no
 *   silent data loss.
 * - **Idempotent.** Posts whose slug already exists under `content/article/`
 *   are skipped, so a re-run after a partial/interrupted migration finishes
 *   the job instead of duplicating directories.
 * - The legacy `wiki/` / `img/` dirs and stale manifests are removed only
 *   once every post has been written successfully.
 */
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "../content");
const WIKI_DIR = path.join(CONTENT_DIR, "wiki");
const IMG_DIR = path.join(CONTENT_DIR, "img");
const ARTICLE_DIR = path.join(CONTENT_DIR, "article");

const IMG_REF = /(!\[[^\]]*\]\()\/img\/([^\s)"]+)/g;

// Orphan `pending:<id>` placeholders that leaked into a committed body (an
// old editor bug). They never resolve, so the migration drops the whole
// image node rather than carry dead markup forward.
const LEGACY_PENDING_IMG =
    /!\[[^\]]*\]\(pending\\?:[a-f0-9-]+(?:\s+"[^"]*")?\)/g;

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/** Slugs already present under content/article (for idempotent re-runs). */
async function migratedSlugs(): Promise<Set<string>> {
    const slugs = new Set<string>();
    if (!(await exists(ARTICLE_DIR))) return slugs;
    const entries = await fs.readdir(ARTICLE_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const indexPath = path.join(ARTICLE_DIR, entry.name, "index.mdx");
        try {
            const raw = await fs.readFile(indexPath, "utf-8");
            const slug = matter(raw).data.slug as string | undefined;
            if (slug) slugs.add(slug);
        } catch {
            // partially-written dir — ignore, it'll be re-driven by slug
        }
    }
    return slugs;
}

interface StagedPost {
    uuid: string;
    slug: string;
    sourceFile: string;
    indexMd: string;
    /** [absolute source image, absolute dest image] */
    copies: Array<[string, string]>;
}

async function migrate() {
    if (!(await exists(WIKI_DIR))) {
        console.info("no content/wiki — nothing to migrate");
        return;
    }
    const done = await migratedSlugs();
    const files = (await fs.readdir(WIKI_DIR)).filter((f) => f.endsWith(".md"));

    const staged: StagedPost[] = [];
    const errors: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
        const raw = await fs.readFile(path.join(WIKI_DIR, file), "utf-8");
        const { data, content } = matter(raw);
        const slug =
            (data.slug as string | undefined) ?? path.basename(file, ".md");
        if (done.has(slug)) {
            console.info(`skip ${file}: slug "${slug}" already migrated`);
            skipped.push(file);
            continue;
        }
        const uuid = (data.uuid as string | undefined) ?? crypto.randomUUID();
        const assetsDir = path.join(ARTICLE_DIR, uuid, "assets");

        const copies: Array<[string, string]> = [];
        const body = content
            .replace(LEGACY_PENDING_IMG, "")
            .replace(IMG_REF, (_m, prefix: string, name: string) => {
                copies.push([
                    path.join(IMG_DIR, name),
                    path.join(assetsDir, name),
                ]);
                return `${prefix}/article/${uuid}/assets/${name}`;
            });

        // Backfill required frontmatter the old layout didn't enforce.
        const frontmatter = {
            ...data,
            slug,
            uuid,
            date: (data.date as string | undefined) || todayIso(),
        };

        for (const [from] of copies) {
            if (!(await exists(from))) {
                errors.push(
                    `${file}: referenced image not found: ${path.relative(CONTENT_DIR, from)}`,
                );
            }
        }

        staged.push({
            uuid,
            slug,
            sourceFile: file,
            indexMd: matter.stringify(body, frontmatter),
            copies,
        });
    }

    if (errors.length > 0) {
        console.error("migration aborted — no files were changed:");
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }

    // Phase 2: all staged posts verified — now write.
    for (const post of staged) {
        const dir = path.join(ARTICLE_DIR, post.uuid);
        await fs.mkdir(dir, { recursive: true });
        if (post.copies.length > 0) {
            await fs.mkdir(path.join(dir, "assets"), { recursive: true });
        }
        for (const [from, to] of post.copies) await fs.copyFile(from, to);
        await fs.writeFile(path.join(dir, "index.mdx"), post.indexMd);
        console.info(
            `migrated ${post.sourceFile} → article/${post.uuid}/index.mdx`,
        );
    }

    // Phase 3: drop legacy only on a clean full migration. If any post was
    // skipped because its slug already exists under content/article, we
    // cannot prove that existing article is the *same* post (slug ≠ identity
    // — uuid is). Keep the legacy tree for manual review instead of risking a
    // silent delete of a different article's source.
    if (skipped.length > 0) {
        console.warn(
            `kept legacy wiki/, img/ — ${skipped.length} post(s) skipped by slug; review and remove manually: ${skipped.join(", ")}`,
        );
        return;
    }
    await fs.rm(WIKI_DIR, { recursive: true, force: true });
    await fs.rm(IMG_DIR, { recursive: true, force: true });
    await fs.rm(path.join(CONTENT_DIR, "wiki.json"), { force: true });
    await fs.rm(path.join(CONTENT_DIR, "img.json"), { force: true });
    console.info("removed legacy wiki/, img/, wiki.json, img.json");
}

migrate().catch((err) => {
    console.error(err);
    process.exit(1);
});
