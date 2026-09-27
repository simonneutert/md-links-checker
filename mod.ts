/**
 * Checks relative links in Markdown files: the target must exist, and a
 * `#anchor` into a Markdown file must match one of its headings.
 * Links with a scheme (`https:`, `mailto:`, `jsr:`) are not checked.
 *
 * Directories are walked for `.md` files. Inside a Git repository, files Git
 * ignores are skipped (git needs run permission); pass `--no-gitignore` to walk
 * everything. Files named on the command line are always checked.
 *
 * ```sh
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker README.md docs
 * deno run -R jsr:@simonneutert/md-links-checker --no-gitignore docs
 * ```
 *
 * @module
 */
import { dirname, join, resolve } from "@std/path";

/** A link whose target file or anchor does not exist. */
export interface Problem {
  file: string;
  link: string;
  reason: "missing file" | "missing anchor";
}

/** The anchor GitHub gives a heading. */
// ponytail: GitHub's rules minus duplicate headings (`-1` suffixes); add them
// when a doc repeats a heading it links to.
export function slug(heading: string): string {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");
}

/** The Markdown outside fenced code blocks, line by line. */
function prose(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else return !fenced;
    return false;
  });
}

const LINK = /\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Checks every relative link in `files`, which are Markdown file paths. */
export async function checkLinks(files: string[]): Promise<Problem[]> {
  const anchors = new Map<string, Set<string> | null>();
  async function anchorsOf(path: string): Promise<Set<string> | null> {
    if (!anchors.has(path)) {
      try {
        const text = await Deno.readTextFile(path);
        anchors.set(
          path,
          new Set(
            prose(text).flatMap((line) => {
              const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
              return m ? [slug(m[1])] : [];
            }),
          ),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        anchors.set(path, null);
      }
    }
    return anchors.get(path)!;
  }

  const problems: Problem[] = [];
  for (const file of files) {
    const lines = prose(await Deno.readTextFile(file));
    for (const [, link] of lines.join("\n").matchAll(LINK)) {
      if (SCHEME.test(link)) continue;
      const [path, anchor] = link.split("#", 2);
      const target = path
        ? resolve(dirname(file), decodeURIComponent(path))
        : resolve(file);
      if (anchor !== undefined && target.endsWith(".md")) {
        const found = await anchorsOf(target);
        if (found === null) {
          problems.push({ file, link, reason: "missing file" });
        } else if (!found.has(anchor.toLowerCase())) {
          problems.push({ file, link, reason: "missing anchor" });
        }
        continue;
      }
      if (!await exists(target)) {
        problems.push({ file, link, reason: "missing file" });
      }
    }
  }
  return problems;
}

/** The files Git sees in `dir`, tracked or not ignored, or `null` when `dir`
 * is not in a Git repository or git is not installed. */
async function gitFiles(dir: string): Promise<string[] | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd: dir,
      stderr: "null",
    }).output();
    if (!success) return null;
    return new TextDecoder().decode(stdout).split("\0").filter(Boolean)
      .map((file) => join(dir, file));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** The `.md` files at `path`. A directory is walked, skipping what Git ignores
 * unless `gitignore` is `false`; outside Git, dot folders and `node_modules`
 * are skipped instead. */
export async function* markdownFiles(
  path: string,
  { gitignore = true } = {},
): AsyncGenerator<string> {
  if ((await Deno.stat(path)).isFile) {
    yield path;
    return;
  }
  const listed = gitignore ? await gitFiles(path) : null;
  if (listed) {
    for (const file of listed) {
      // --cached also lists tracked files deleted from the working tree.
      if (file.endsWith(".md") && await exists(file)) yield file;
    }
    return;
  }
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        yield* markdownFiles(child, { gitignore: false });
      }
    } else if (entry.isFile && entry.name.endsWith(".md")) yield child;
  }
}

if (import.meta.main) {
  const gitignore = !Deno.args.includes("--no-gitignore");
  const paths = Deno.args.filter((arg) => arg !== "--no-gitignore");
  const unknown = paths.find((arg) => arg.startsWith("-"));
  if (unknown) {
    console.error(`Unknown option: ${unknown}`);
    Deno.exit(2);
  }
  const files: string[] = [];
  for (const path of paths.length ? paths : ["."]) {
    for await (const file of markdownFiles(path, { gitignore })) {
      files.push(file);
    }
  }
  const problems = await checkLinks(files);
  for (const { file, link, reason } of problems) {
    console.error(`${file}: ${link} (${reason})`);
  }
  console.log(`Checked ${files.length} file${files.length === 1 ? "" : "s"}`);
  if (problems.length) Deno.exit(1);
}
