/**
 * For documentation that lives in a repository, read on GitHub, GitLab or
 * Bitbucket. Checks relative links in Markdown and MDX files: inline links,
 * images, reference definitions, HTML `<a href>` and, in MDX, JSX `<a href>`
 * and `<Link to>`. The target must exist, and a `#anchor` into a Markdown file
 * must match one of its headings or an HTML `id`; into an HTML file, an `id`
 * or `<a name>`. Empty links (`[text]()`) and references to a missing
 * definition (`[text][nope]`) are reported too. Links with a scheme (`https:`,
 * `mailto:`, `jsr:`) are not checked.
 *
 * Files are parsed as CommonMark with GitHub's extensions, so code, comments,
 * front matter and HTML blocks are skipped as GitHub skips them. `.mdx` files
 * are parsed as MDX. `--flavor` picks the heading anchors: `github` (the
 * default, also GitLab's), `bitbucket`, or `docusaurus`, which reads every
 * file as MDX and adds custom heading ids (`## Foo {#bar}`).
 *
 * Directories are walked for `.md`, `.mdx` and `.markdown` files. Inside a Git
 * repository, files Git ignores are skipped (git needs `--allow-run=git`);
 * outside one, or with `--no-gitignore`, dot folders and `node_modules` are
 * skipped instead. Git is optional. Files named on the command line are always
 * checked; an HTML file named there has its `<a href>` links checked.
 *
 * `--external` lists the links with a scheme without checking them; `--json`
 * prints the result as JSON on stdout. `--root <dir>` sets where links starting
 * with `/` resolve from: for a static site, check the posts against the build
 * output (`--root dist`, `_site` for Jekyll, `public` for Hugo) after building.
 * A `#anchor` into an HTML file, or a folder with an `index.html`, must match
 * an `id` in it exactly, as browsers match it.
 *
 * ```sh
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker README.md docs
 * deno run -R jsr:@simonneutert/md-links-checker --no-gitignore docs
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --external docs
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --json docs
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --root dist posts
 * deno run -R --allow-run=git jsr:@simonneutert/md-links-checker --flavor docusaurus docs
 * ```
 *
 * @module
 */
import { comment, commentFromMarkdown } from "@slorber/remark-comment";
import { parseArgs } from "@std/cli/parse-args";
import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { slug as githubSlug } from "github-slugger";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { toString } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { mdx as mdxSyntax } from "micromark-extension-mdx";
import { parseEntities } from "parse-entities";

/** A broken link. `"wrong case"` is a file that only exists on a
 * case-insensitive file system, like macOS's default: `./readme.md` for
 * `README.md` breaks on Linux and GitHub. `"empty link"` is a link with no
 * target, like `[text]()`, usually a forgotten placeholder. */
export interface Problem {
  /** The Markdown file the link is in, as passed to `checkLinks`. */
  file: string;
  /** The line the link is on, from 1. */
  line: number;
  /** The column the link starts at, from 1. */
  column: number;
  /** The link as written, like `./a.md#setup`; for `"undefined reference"`
   * the reference (`[text][nope]`), for `"invalid MDX"` the parser's error. */
  link: string;
  /** What is wrong with the link. */
  reason:
    | "missing file"
    | "wrong case"
    | "missing anchor"
    | "empty link"
    | "undefined reference"
    | "invalid MDX";
}

/** Whose heading anchors to match. GitLab's are GitHub's. `docusaurus` also
 * reads `.md` files as MDX, as Docusaurus does by default, and allows custom
 * heading ids (`## Foo {#bar}`). */
export type Flavor = "github" | "gitlab" | "bitbucket" | "docusaurus";

/** The anchor `flavor` gives a heading with the plain text `text`, before
 * repeated headings get `-1` (`_1` on Bitbucket), `-2`, … */
export function slug(text: string, flavor: Flavor = "github"): string {
  if (flavor !== "bitbucket") return githubSlug(text);
  // ponytail: Bitbucket documents no rules; these follow the bitbucket-slug
  // package, which found them by trial.
  return "markdown-header-" +
    text.normalize("NFD").replace(/\p{M}/gu, "")
      .replace(/ -+ /g, " ")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replaceAll(" ", "-");
}

/** A position in a file, both from 1. */
interface At {
  line: number;
  column: number;
}

/** A link and where it starts. */
interface Link extends At {
  link: string;
}

/** The mdast node fields this module reads. */
interface Node {
  type: string;
  children?: Node[];
  value?: unknown;
  url?: string;
  name?: string | null;
  attributes?: { name?: string; value?: unknown }[];
  position?: { start: At & { offset?: number }; end: { offset?: number } };
}

/** What a file holds: its links, its anchors, and the problems found while
 * reading it (undefined references, invalid MDX). */
interface Parsed {
  links: Link[];
  anchors: Set<string>;
  problems: (Link & { reason: Problem["reason"] })[];
}

/** An HTML comment. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** An HTML start tag and its attributes, as in `<a id="x" title='>'>`. */
const TAG = /<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi;
/** An HTML attribute, `id="x"`, `id='x'`, unquoted as minified HTML writes it
 * (`id=x`), or without a value. It follows a space or, as browsers allow and
 * minifiers write, a quoted value (`class="h"id="x"`). */
const ATTRIBUTE =
  /(?:\s|(?<=["']))([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** An HTML link, `<a href="./a.md">` or `<a class="x" href='./a.md'>`. */
const HREF = /<a\s(?:[^>]*\s)?href=(?:"([^"]*)"|'([^']*)')/gi;
/** A full or collapsed reference, `[text][label]` or `[label][]`, not escaped
 * and not right after a word or `]`, as in `m[0][1]`. The parser leaves one as
 * text when its label has no definition. */
const REFERENCE = /(?<![\\\w\]])\[([^[\]\n]+)\]\[([^[\]\n]*)\]/g;
/** A Docusaurus heading id at the end of a heading, by the type of the
 * heading's last node: `{#bar}` and `{/* #bar *\/}` (or `{#bar}` in MDX). */
const CUSTOM_ID: Record<string, RegExp> = {
  text: /\{#([^\s{}]+)\}\s*$/,
  mdxTextExpression: /^\s*(?:\/\*\s*)?#([^\s*]+)\s*(?:\*\/)?\s*$/,
};

/** `commentFromMarkdown`, which its types call a value but is a function. */
const commentFromMarkdownFn = commentFromMarkdown as unknown as () =>
  typeof commentFromMarkdown;

/** Where `index` in `source` is, when `source` starts at `start`. */
function at(start: At, source: string, index: number): At {
  const lines = source.slice(0, index).split("\n");
  return lines.length === 1
    ? { line: start.line, column: start.column + index }
    : { line: start.line + lines.length - 1, column: lines.at(-1)!.length + 1 };
}

/** The links, anchors and problems in `markdown`, parsed as CommonMark with
 * GitHub's extensions and front matter, or as MDX when `mdx` is set. */
function parse(markdown: string, mdx: boolean, flavor: Flavor): Parsed {
  const parsed: Parsed = { links: [], anchors: new Set(), problems: [] };
  let tree: Node;
  try {
    // MDX has no HTML comments, but Docusaurus accepts them and drops them,
    // with the same extension (after MDX's, or MDX's rejects `<!`).
    tree = fromMarkdown(markdown, {
      extensions: [
        frontmatter(["yaml", "toml"]),
        gfm(),
        ...(mdx ? [mdxSyntax(), comment] : []),
      ],
      mdastExtensions: [
        frontmatterFromMarkdown(["yaml", "toml"]),
        gfmFromMarkdown(),
        ...(mdx ? [mdxFromMarkdown(), commentFromMarkdownFn()] : []),
      ],
    }) as unknown as Node;
  } catch (error) {
    // micromark's errors carry where they happened.
    const { line = 1, column = 1, reason = String(error) } = error as Partial<
      At & { reason: string }
    >;
    parsed.problems.push({ line, column, link: reason, reason: "invalid MDX" });
    return parsed;
  }

  const counts = new Map<string, number>();
  const suffix = flavor === "bitbucket" ? "_" : "-";
  function heading(node: Node) {
    const last = node.children?.at(-1);
    const pattern = flavor === "docusaurus" && CUSTOM_ID[last?.type ?? ""];
    const custom = pattern && String(last?.value).match(pattern)?.[1];
    if (custom) {
      // A custom id replaces the anchor and takes no part in the count.
      parsed.anchors.add(custom.toLowerCase());
      return;
    }
    const text = toString(node as never, {
      includeImageAlt: false,
      includeHtml: false,
    });
    const base = slug(text, flavor);
    let anchor = base;
    while (counts.has(anchor)) {
      const n = counts.get(base)! + 1;
      counts.set(base, n);
      anchor = `${base}${suffix}${n}`;
    }
    counts.set(anchor, 0);
    parsed.anchors.add(anchor);
  }

  function visit(node: Node) {
    const { line = 1, column = 1 } = node.position?.start ?? {};
    const start = { line, column };
    const source = markdown.slice(
      node.position?.start.offset,
      node.position?.end.offset,
    );
    switch (node.type) {
      case "link":
      case "image":
      case "definition":
        parsed.links.push({ ...start, link: node.url ?? "" });
        break;
      case "heading":
        heading(node);
        break;
      case "html": {
        const html = uncomment(source);
        parsed.links.push(...hrefs(html, start));
        for (const id of htmlIds(html)) parsed.anchors.add(id.toLowerCase());
        break;
      }
      case "text":
        for (const match of source.matchAll(REFERENCE)) {
          if (match[1].startsWith("^")) continue; // a footnote
          parsed.problems.push({
            ...at(start, source, match.index),
            link: match[0],
            reason: "undefined reference",
          });
        }
        break;
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        for (const { name, value } of node.attributes ?? []) {
          if (typeof value !== "string") continue;
          if (name === "id" || (node.name === "a" && name === "name")) {
            parsed.anchors.add(value.toLowerCase());
          }
          if (
            (node.name === "a" && name === "href") ||
            (node.name === "Link" && name === "to")
          ) parsed.links.push({ ...start, link: value });
        }
    }
    node.children?.forEach(visit);
  }
  visit(tree);
  return parsed;
}

/** `html` with its comments blanked out, keeping lines and columns. */
function uncomment(html: string): string {
  return html.replace(HTML_COMMENT, (c) => c.replace(/[^\n]/g, " "));
}

/** The `<a href>` links in `html`, which starts at `start`. */
function hrefs(html: string, start: At): Link[] {
  return [...html.matchAll(HREF)].map((match) => ({
    ...at(start, html, match.index),
    link: match[1] ?? match[2],
  }));
}

/** The `id`s, and the `name`s of `<a>`s, in `html`, with character references
 * decoded as browsers decode them (`q&amp;a` is `q&a`); browsers jump to no
 * other `name`. */
function htmlIds(html: string): string[] {
  const ids = [];
  for (const [, tag, attributes] of html.matchAll(TAG)) {
    for (const [, name, ...value] of attributes.matchAll(ATTRIBUTE)) {
      const id = value.find(Boolean);
      const key = name.toLowerCase();
      if (id && (key === "id" || (key === "name" && /^a$/i.test(tag)))) {
        ids.push(parseEntities(id, { attribute: true }));
      }
    }
  }
  return ids;
}

/** A Markdown file name: `.md`, `.mdx` or `.markdown`, in any case. */
const MARKDOWN = /\.(md|mdx|markdown)$/i;
/** An HTML file name, `.html` or `.htm`. */
const HTML = /\.html?$/i;
/** An MDX file name. */
const MDX = /\.mdx$/i;
/** A link with a scheme (`https:`) or to another host (`//x.test`). */
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** The parsed Markdown file `file`, read as MDX for `.mdx` files or with the
 * `docusaurus` flavor; for an HTML file, its `<a href>`s and ids as written. */
async function read(file: string, flavor: Flavor): Promise<Parsed> {
  const text = await Deno.readTextFile(file);
  if (HTML.test(file)) {
    const html = uncomment(text);
    const links = hrefs(html, { line: 1, column: 1 });
    return { links, anchors: new Set(htmlIds(html)), problems: [] };
  }
  const mdx = flavor === "docusaurus" || MDX.test(file);
  return parse(text, mdx, flavor);
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
  { flavor = "github" as Flavor } = {},
): Promise<{ file: string; line: number; column: number; link: string }[]> {
  const found = [];
  for (const file of files) {
    for (const link of (await read(file, flavor)).links) {
      if (EXTERNAL.test(link.link)) found.push({ file, ...link });
    }
  }
  return found;
}

/** Checks every relative link in `files`, which are Markdown file paths.
 * Links starting with `/` resolve from `root`, the current directory by
 * default; anchors follow `flavor`, GitHub's by default. */
export async function checkLinks(
  files: string[],
  { root = Deno.cwd(), flavor = "github" as Flavor } = {},
): Promise<Problem[]> {
  const parsed = new Map<string, Parsed | null>();
  /** The parsed existing `path`, or `null` when it is a directory named like
   * `x.md`. Windows fails to read one with PermissionDenied, not
   * IsADirectory, so ask first. */
  async function parsedOf(path: string): Promise<Parsed | null> {
    if (!parsed.has(path)) {
      const file = (await Deno.stat(path)).isFile;
      parsed.set(path, file ? await read(path, flavor) : null);
    }
    return parsed.get(path)!;
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
    if (!anchor) return;
    // A folder is served as its index.html, like `/posts/foo/` on a site,
    // spelled so, as Linux servers need. A folder named `x.md` is no page.
    const index = join(target, "index.html");
    const page = !MARKDOWN.test(target) && await exists(index) &&
        await sameCase(target, index)
      ? index
      : target;
    if (!MARKDOWN.test(page) && !HTML.test(page)) return;
    const found = await parsedOf(page);
    if (found === null) return "missing file";
    const id = decode(anchor);
    const ok = HTML.test(page)
      // Browsers match an id exactly, and `#top` is the top of any page.
      ? found.anchors.has(id) || id.toLowerCase() === "top"
      : found.anchors.has(id.toLowerCase());
    if (!ok) return "missing anchor";
  }

  const problems: Problem[] = [];
  for (const file of files) {
    const { links, problems: own } = (await parsedOf(resolve(file)))!;
    const found = own.map((problem) => ({ file, ...problem }));
    for (const { link, ...where } of links) {
      if (EXTERNAL.test(link)) continue;
      const reason = await check(file, link);
      if (reason) found.push({ file, ...where, link, reason });
    }
    found.sort((a, b) => a.line - b.line || a.column - b.column);
    problems.push(...found);
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

/** The Markdown files (`.md`, `.mdx`, `.markdown`) at `path`. A directory is
 * walked, skipping what Git ignores unless `gitignore` is `false`; outside Git,
 * dot folders and `node_modules` are skipped instead. */
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

const USAGE = `Usage: md-links-checker [options] [paths...]

Checks relative links and #anchors in Markdown files. Paths default to ".".

Options:
  --root <dir>      Resolve links starting with / from <dir>
  --flavor <name>   Heading anchors of github (default; also GitLab's),
                    gitlab, bitbucket or docusaurus
  --external        Also list external links (https:, mailto:, …)
  --json            Print the result as JSON
  --no-gitignore    Walk directories without Git
  -h, --help        Show this help

Exits with 1 when a link is broken, 2 on a bad argument.`;

if (import.meta.main) {
  let unknown: string | undefined;
  const args = parseArgs(Deno.args, {
    // `_` as a string keeps a file named `007` from turning into 7.
    string: ["root", "flavor", "_"],
    boolean: ["json", "external", "gitignore", "help"],
    negatable: ["gitignore"],
    default: { gitignore: true, flavor: "github" },
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) unknown ??= arg;
      return !unknown;
    },
  });
  if (args.help) {
    console.log(USAGE);
    Deno.exit(0);
  }
  if (unknown) {
    console.error(`Unknown option: ${unknown}\n\n${USAGE}`);
    Deno.exit(2);
  }
  const { gitignore, json } = args;
  const flavor = args.flavor as Flavor;
  if (!["github", "gitlab", "bitbucket", "docusaurus"].includes(flavor)) {
    console.error(`Unknown flavor: ${flavor}\n\n${USAGE}`);
    Deno.exit(2);
  }
  let root = args.root;
  if (root !== undefined) {
    const stat = await Deno.stat(root).catch(() => null);
    if (!stat?.isDirectory) {
      console.error(`Not a directory: ${root}`);
      Deno.exit(2);
    }
  }
  const paths = args._.map(String);
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
  // `/` links resolve from --root, the repository root, or the current
  // directory.
  if (root === undefined) {
    const top = gitignore
      ? await git(".", "rev-parse", "--show-toplevel")
      : null;
    root = top?.trim() || Deno.cwd();
  }
  const problems = await checkLinks(files, { root, flavor });
  const external = args.external
    ? await externalLinks(files, { flavor })
    : undefined;
  if (json) {
    // JSON.stringify drops `external` when it is undefined.
    console.log(
      JSON.stringify({ checked: files, problems, external }, null, 2),
    );
    Deno.exit(problems.length ? 1 : 0);
  }
  // `file:line:column:` lets editors and terminals jump to the link.
  for (const { file, line, column, link } of external ?? []) {
    console.log(`${file}:${line}:${column}: ${link}`);
  }
  for (const { file, line, column, link, reason } of problems) {
    console.error(`${file}:${line}:${column}: ${link} (${reason})`);
  }
  console.log(`Checked ${files.length} file${files.length === 1 ? "" : "s"}`);
  if (problems.length) Deno.exit(1);
}
