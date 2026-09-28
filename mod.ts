/**
 * Checks relative links in Markdown files, inline, reference definitions and
 * HTML `<a href>`: the target must exist, and a `#anchor` into a Markdown file
 * must match one of its headings. An empty link (`[text]()`) is reported too.
 * Links with a scheme (`https:`, `mailto:`, `jsr:`) are not checked, nor are
 * links in fenced code blocks, code spans or HTML comments.
 *
 * Directories are walked for `.md` and `.markdown` files. Inside a Git
 * repository, files Git ignores are skipped (git needs `--allow-run=git`);
 * outside one, or with `--no-gitignore`, dot folders and `node_modules` are
 * skipped instead. Git is optional. Files named on the command line are always
 * checked.
 *
 * `--external` lists the links with a scheme without checking them; `--json`
 * prints the result as JSON on stdout.
 *
 * ```sh
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker README.md docs
 * deno run -R jsr:@simonneutert/md-links-checker --no-gitignore docs
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --external docs
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --json docs
 * ```
 *
 * @module
 */
import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";

/** A link whose target file or anchor does not exist. `"wrong case"` is a file
 * that only exists on a case-insensitive file system, like macOS's default:
 * `./readme.md` for `README.md` breaks on Linux and GitHub. `"empty link"` is
 * a link with no target, like `[text]()`, usually a forgotten placeholder. */
export interface Problem {
  file: string;
  /** The line the link is on, from 1. */
  line: number;
  link: string;
  reason: "missing file" | "wrong case" | "missing anchor" | "empty link";
}

/** The anchor GitHub gives a heading, from its text: links and HTML tags
 * count by their text, images not at all. Repeats get `-1`, `-2`, … in
 * `checkLinks`. */
export function slug(heading: string): string {
  return heading.trim()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");
}

/** The lines of `markdown`, with fenced code blocks and HTML comments blanked
 * out. A fence closes only with the same character, at least as long as it
 * opened. */
function prose(markdown: string): string[] {
  let fence = "";
  const lines = markdown.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (!fence) {
      fence = marker ?? "";
      return marker ? "" : line;
    }
    if (
      marker?.[0] === fence[0] && marker.length >= fence.length &&
      line.trim() === marker
    ) fence = "";
    return "";
  });
  return lines.join("\n")
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""))
    .split("\n");
}

const HTML_ID = /<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi;

/** The text of the heading that ends at `line`: ATX (`## A`), or setext (`A`
 * on `previous`, underlined with `===` or `---`). */
function heading(line: string, previous: string): string | undefined {
  const atx = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
  if (atx) return atx[1];
  if (!/^ {0,3}(=+|-+)\s*$/.test(line) || !previous.trim()) return;
  // Under a heading, list item or quote, `---` is a rule, not an underline.
  if (!/^\s*(#|[-*+>]\s|\d+[.)]\s)/.test(previous)) return previous;
}

/** The anchors in `markdown`: its headings, where repeats get `-1`, `-2`, …
 * like GitHub, and HTML `id` and `name` attributes (`<a id="x">`). */
function anchorsIn(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const ids: string[] = [];
  const lines = prose(markdown);
  lines.forEach((line, i) => {
    for (const [, id] of line.matchAll(HTML_ID)) ids.push(id.toLowerCase());
    const text = heading(line, lines[i - 1] ?? "");
    if (text === undefined) return;
    const base = slug(text);
    let anchor = base;
    while (counts.has(anchor)) {
      const n = counts.get(base)! + 1;
      counts.set(base, n);
      anchor = `${base}-${n}`;
    }
    counts.set(anchor, 0);
  });
  return new Set([...counts.keys(), ...ids]);
}

/** A Markdown file name: `.md` or `.markdown`, in any case. */
const MARKDOWN = /\.(md|markdown)$/i;

/** An inline link, `](./a.md "title")` or `](<./a b.md>)`, with one level of
 * parentheses in the URL (`](https://x.test/Foo_(bar))`), or empty (`]()`). */
const LINK =
  /\]\((?:<([^>\n]*)>|((?:[^()\s]|\([^()\s]*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** A reference definition, `[ref]: ./a.md "title"`, but not a `[^1]:` footnote. */
const REFERENCE = /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
/** An autolink, `<https://x.test>`, but not `](<…>)` or `]: <…>`. */
const AUTOLINK = /(?<!\]\(|\]:[ \t]*)<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi;
/** An HTML link, `<a href="./a.md">` or `<a class="x" href='./a.md'>`. */
const HREF = /<a\s(?:[^>]*\s)?href=(?:"([^"]*)"|'([^']*)')/gi;
/** A link with a scheme (`https:`) or to another host (`//x.test`). */
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** The links in a Markdown file with their line, in order, skipping fenced
 * code blocks, code spans and HTML comments. */
async function links(
  file: string,
): Promise<{ line: number; link: string }[]> {
  const text = prose(await Deno.readTextFile(file))
    .map((line) => line.replace(/(`+).*?\1/g, ""))
    .join("\n");
  const matches = [LINK, REFERENCE, AUTOLINK, HREF]
    .flatMap((pattern) => [...text.matchAll(pattern)])
    .sort((a, b) => a.index - b.index);
  let line = 1;
  let counted = 0;
  return matches.map((match) => {
    for (; counted < match.index; counted++) if (text[counted] === "\n") line++;
    // Each pattern captures the link in one of its groups.
    return { line, link: match.slice(1).find((g) => g !== undefined)! };
  });
}

/** `decodeURIComponent`, or `text` as is when it has a stray `%`. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The external links (`https:`, `mailto:`, `//x.test`, …) in `files`, which
 * `checkLinks` does not check. */
export async function externalLinks(
  files: string[],
): Promise<{ file: string; line: number; link: string }[]> {
  const found = [];
  for (const file of files) {
    for (const { line, link } of await links(file)) {
      if (EXTERNAL.test(link)) found.push({ file, line, link });
    }
  }
  return found;
}

/** Checks every relative link in `files`, which are Markdown file paths.
 * Links starting with `/` resolve from `root`, the current directory by
 * default. */
export async function checkLinks(
  files: string[],
  { root = Deno.cwd() } = {},
): Promise<Problem[]> {
  const anchors = new Map<string, Set<string> | null>();
  async function anchorsOf(path: string): Promise<Set<string> | null> {
    if (!anchors.has(path)) {
      try {
        anchors.set(path, anchorsIn(await Deno.readTextFile(path)));
      } catch (error) {
        // A directory named `x.md` has no anchors either.
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof Deno.errors.IsADirectory)
        ) throw error;
        anchors.set(path, null);
      }
    }
    return anchors.get(path)!;
  }

  const names = new Map<string, Set<string>>();
  /** Whether the existing `target` is spelled as on disk below `base`. */
  async function sameCase(base: string, target: string): Promise<boolean> {
    let dir = resolve(base);
    // A link to `base` itself (`./`, `/`) has no parts to compare.
    const parts = relative(dir, target).split(SEPARATOR).filter(Boolean);
    for (const part of parts) {
      if (part === "..") {
        dir = dirname(dir);
        continue;
      }
      if (!names.has(dir)) {
        const entries = await Array.fromAsync(Deno.readDir(dir));
        // macOS may store `é` decomposed; compare the characters, not bytes.
        names.set(dir, new Set(entries.map((e) => e.name.normalize())));
      }
      if (!names.get(dir)!.has(part.normalize())) return false;
      dir = join(dir, part);
    }
    return true;
  }

  /** What is wrong with the relative `link` in `file`, if anything. */
  async function check(
    file: string,
    link: string,
  ): Promise<Problem["reason"] | undefined> {
    if (!link) return "empty link";
    // Drop a query, as in `./a.md?plain=1#setup`.
    const [path, anchor] = link.replace(/^([^#?]*)\?[^#]*/, "$1").split("#", 2);
    const base = path.startsWith("/") ? root : dirname(file);
    const target = path ? resolve(base, `./${decode(path)}`) : resolve(file);
    if (!await exists(target)) return "missing file";
    if (path && !await sameCase(base, target)) return "wrong case";
    // A bare `#` links to the top of the page, so `anchor` is not empty.
    if (!anchor || !MARKDOWN.test(target)) return;
    const found = await anchorsOf(target);
    if (found === null) return "missing file";
    if (!found.has(decode(anchor).toLowerCase())) return "missing anchor";
  }

  const problems: Problem[] = [];
  for (const file of files) {
    for (const { line, link } of await links(file)) {
      if (EXTERNAL.test(link)) continue;
      const reason = await check(file, link);
      if (reason) problems.push({ file, line, link, reason });
    }
  }
  return problems;
}

/** The output of `git` run in `dir`, or `null` when it fails or git is not
 * installed. */
async function git(dir: string, ...args: string[]): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args,
      cwd: dir,
      stderr: "null",
    }).output();
    return success ? new TextDecoder().decode(stdout) : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** The files Git sees in `dir`, tracked or not ignored, or `null` when `dir`
 * is not in a Git repository or git is not installed. */
async function gitFiles(dir: string): Promise<string[] | null> {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const listed = await git(dir, ...args);
  if (listed === null) return null;
  return listed.split("\0").filter(Boolean).map((file) => join(dir, file));
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    // `a.md/x.md` fails with NotADirectory, as `a.md` is a file.
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}

/** The Markdown files (`.md`, `.markdown`) at `path`. A directory is walked,
 * skipping what Git ignores unless `gitignore` is `false`; outside Git, dot
 * folders and `node_modules` are skipped instead. */
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
      if (MARKDOWN.test(file) && await exists(file)) yield file;
    }
    return;
  }
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        yield* markdownFiles(child, { gitignore: false });
      }
    } else if (entry.isFile && MARKDOWN.test(entry.name)) yield child;
  }
}

if (import.meta.main) {
  const flags = ["--no-gitignore", "--json", "--external"];
  const gitignore = !Deno.args.includes("--no-gitignore");
  const json = Deno.args.includes("--json");
  const paths = Deno.args.filter((arg) => !flags.includes(arg));
  const unknown = paths.find((arg) => arg.startsWith("-"));
  if (unknown) {
    console.error(`Unknown option: ${unknown}`);
    Deno.exit(2);
  }
  // A Set, so a file named twice (`README.md .`) is checked once.
  const found = new Set<string>();
  for (const path of paths.length ? paths : ["."]) {
    if (!await exists(path)) {
      console.error(`No such file or directory: ${path}`);
      Deno.exit(2);
    }
    for await (const file of markdownFiles(path, { gitignore })) {
      found.add(normalize(file));
    }
  }
  const files = [...found];
  // `/` links resolve from the repository root, or the current directory.
  const top = gitignore ? await git(".", "rev-parse", "--show-toplevel") : null;
  const root = top?.trim() || Deno.cwd();
  const problems = await checkLinks(files, { root });
  const external = Deno.args.includes("--external")
    ? await externalLinks(files)
    : undefined;
  if (json) {
    // JSON.stringify drops `external` when it is undefined.
    console.log(
      JSON.stringify({ checked: files, problems, external }, null, 2),
    );
    Deno.exit(problems.length ? 1 : 0);
  }
  // `file:line:` lets editors and terminals jump to the link.
  for (const { file, line, link } of external ?? []) {
    console.log(`${file}:${line}: ${link}`);
  }
  for (const { file, line, link, reason } of problems) {
    console.error(`${file}:${line}: ${link} (${reason})`);
  }
  console.log(`Checked ${files.length} file${files.length === 1 ? "" : "s"}`);
  if (problems.length) Deno.exit(1);
}
