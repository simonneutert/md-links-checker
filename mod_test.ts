import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  checkLinks,
  externalLinks,
  type Flavor,
  markdownFiles,
  slug,
} from "./mod.ts";

/** Runs `test` in a temporary directory holding `files`, by path and text. A
 * path ending in `/` is an empty directory. */
async function withFiles(
  files: Record<string, string>,
  test: (dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, path);
      const folder = path.endsWith("/") ? target : dirname(target);
      await Deno.mkdir(folder, { recursive: true });
      if (!path.endsWith("/")) await Deno.writeTextFile(target, text);
    }
    await test(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The problems in `dir/a.md` (or `name`), as `line:column: link (reason)`. */
async function problems(
  dir: string,
  { name = "a.md", flavor = "github" as Flavor } = {},
): Promise<string[]> {
  const found = await checkLinks([join(dir, name)], { root: dir, flavor });
  return found.map(({ line, column, link, reason }) =>
    `${line}:${column}: ${link} (${reason})`
  );
}

Deno.test("slug follows each flavor's heading anchors", () => {
  assertEquals(slug("5. An app on JSR"), "5-an-app-on-jsr");
  assertEquals(
    slug("dbb's ClojureScript namespaces"),
    "dbbs-clojurescript-namespaces",
  );
  assertEquals(slug("A - B & C"), "a---b--c");
  assertEquals(slug("A - B & C", "gitlab"), "a---b--c");
  assertEquals(
    slug("Café: 3.5 - Setup", "bitbucket"),
    "markdown-header-cafe-35-setup",
  );
});

Deno.test("checkLinks reports links to missing files", async () => {
  const a = [
    "[ok](./b.md) [ok](./sub/) [gone](./gone.md)",
    "[ok](<./sub/a b.md> 'Title') [gone](<./c d.md>)",
    "[ok](./sub/a_(b).md) [gone](./100%.md)",
    "[ok](./b.md?plain=1) [gone](./gone.md?plain=1)",
    "[ok](/sub/) [ok](/b.md) [gone](/sub/gone.md) [ok](/) [ok](./) [ok](.)",
    "[gone](./dir.md#x) [gone](./b.md/x.md) ![gone](./gone.png)",
  ];
  await withFiles({
    "a.md": a.join("\n"),
    "b.md": "",
    "sub/a b.md": "",
    "sub/a_(b).md": "",
    "dir.md/": "",
  }, async (dir) => {
    assertEquals(await problems(dir), [
      "1:27: ./gone.md (missing file)",
      "2:30: ./c d.md (missing file)",
      "3:22: ./100%.md (missing file)",
      "4:22: ./gone.md?plain=1 (missing file)",
      "5:25: /sub/gone.md (missing file)",
      "6:1: ./dir.md#x (missing file)",
      "6:20: ./b.md/x.md (missing file)",
      "6:40: ./gone.png (missing file)",
    ]);
    const c = join(dir, "sub", "c.md");
    await Deno.writeTextFile(c, "[ok](../b.md) [gone](../gone.md)");
    assertEquals(await checkLinks([c]), [
      {
        file: c,
        line: 1,
        column: 15,
        link: "../gone.md",
        reason: "missing file",
      },
    ]);
  });
});

Deno.test("checkLinks matches anchors like GitHub", async () => {
  const a = [
    "# Top",
    "[ok](#top) [ok](#) [bad](#nope)",
    "[ok](./b.md#real-heading) [ok](./b.md#real-heading-1)",
    "[ok](./b.md#real-heading-2) [bad](./b.md#real-heading-3)",
    "[ok](./b.md#setext) [ok](./b.md#caf%C3%A9) [ok](./b.md#a--b)",
    "[ok](./b.md#Custom-Id) [ok](./b.md#old-name) [bad](./b.md#in-code)",
    "[ok](./b.md?plain=1#setext) [bad](./b.md?x#nope)",
    "[ok](./c.markdown#c) [bad](./c.markdown#nope) [ok](./d.txt#any)",
    "[ok](./b.md#quoted) [ok](./b.md#indented) [ok](./b.md#setup-and--ctrl-code)",
    "[ok](./b.md#foo-bar) [bad](./b.md#bar) [ok](./bom.md#setup)",
    "[ok](./b.md#snake_case-and-emphasis) [gone](",
    "./gone.md)",
  ];
  const b = [
    "## Real heading 1",
    "## Real heading",
    "## Real heading", // real-heading-2, as real-heading-1 is taken
    "Setext",
    "------",
    "# Café",
    "## A &amp; B",
    '<a id="Custom-Id"></a> <a name="old-name"></a>',
    "```html",
    '<a id="in-code"></a>',
    "```",
    "> ## Quoted",
    "",
    "  ## Indented",
    "## [Setup](./x.md) and ![logo](./x.png) <kbd>Ctrl</kbd> `code`",
    "## Foo {#bar}", // only Docusaurus reads `{#bar}` as an id
    "## snake_case and _emphasis_",
  ];
  await withFiles({
    "a.md": a.join("\n"),
    "b.md": b.join("\n"),
    "c.markdown": "# C\n",
    "d.txt": "",
    "bom.md": "\uFEFF# Setup\n",
  }, async (dir) => {
    assertEquals(await problems(dir), [
      "2:20: #nope (missing anchor)",
      "4:29: ./b.md#real-heading-3 (missing anchor)",
      "6:46: ./b.md#in-code (missing anchor)",
      "7:29: ./b.md?x#nope (missing anchor)",
      "8:22: ./c.markdown#nope (missing anchor)",
      "10:22: ./b.md#bar (missing anchor)",
      "11:38: ./gone.md (missing file)",
    ]);
  });
});

Deno.test("checkLinks follows Bitbucket's anchors with --flavor", async () => {
  const a = "[ok](#markdown-header-setup) [ok](#markdown-header-setup_1) " +
    "[bad](#setup)\n\n# Setup\n# Setup\n";
  await withFiles({ "a.md": a }, async (dir) => {
    assertEquals(await problems(dir, { flavor: "bitbucket" }), [
      "1:61: #setup (missing anchor)",
    ]);
  });
});

Deno.test("checkLinks reads references and HTML links", async () => {
  const a = [
    "[ok]: ./b.md",
    '[gone]: <./ref-gone.md> "Title"',
    "[^1]: A footnote, not a link",
    '<a href="./b.md">ok</a> <a class="x"',
    "href='./href-gone.md'>gone</a>",
    '<p data-href="./not-a-link.md">',
    "",
    "> [quoted]: ./quoted-gone.md",
    "",
    "[x][ok] [x][nope] [nope][] [x] matrix[i] [^1] \\[x][nope] m[0][1] a[i][j][k]",
    "",
    "<div>",
    "[html block, not a link](./gone.md)",
    "</div>",
  ];
  await withFiles({ "a.md": a.join("\n"), "b.md": "" }, async (dir) => {
    assertEquals(await problems(dir), [
      "2:1: ./ref-gone.md (missing file)",
      "4:25: ./href-gone.md (missing file)",
      "8:3: ./quoted-gone.md (missing file)",
      "10:9: [x][nope] (undefined reference)",
      "10:19: [nope][] (undefined reference)",
    ]);
  });
});

Deno.test("checkLinks skips code and HTML comments", async () => {
  const a = [
    '`[code](./gone.md)` ``[code](./gone.md)`` `<a href="./gone.md">`',
    "<!-- [skipped](./gone.md)",
    "# Commented out -->",
    "[bad](#commented-out) [bad](#fenced)",
    "````md",
    "```sh",
    "# Fenced",
    "```",
    "[skipped](./gone.md)",
    "````",
    "[gone](./gone.md)",
    "    [gone](./gone.md) continues the paragraph",
    "",
    "    [skipped](./gone.md) is indented code",
    "",
    "    [skipped](./gone.md)",
    "- item",
    "",
    "    [gone](./gone.md) continues the item",
    "",
    "> ```",
    "> [skipped](./gone.md)",
    "> ```",
    "",
    "`<!--` [gone](./gone.md) `-->` \\[escaped](./gone.md)",
    "",
    "- item",
    "",
    "  ```",
    "  [skipped](./gone.md)",
    "  ```",
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    assertEquals(await problems(dir), [
      "4:1: #commented-out (missing anchor)",
      "4:23: #fenced (missing anchor)",
      "11:1: ./gone.md (missing file)",
      "12:5: ./gone.md (missing file)",
      "19:5: ./gone.md (missing file)",
      "25:8: ./gone.md (missing file)",
    ]);
  });
});

Deno.test("checkLinks reads MDX: JSX links, comments, no indented code", async () => {
  const a = [
    'import Tabs from "@theme/Tabs";',
    "",
    '<TabItem value="a" id="tab">',
    "",
    "    [gone](./gone.md)",
    "",
    '<Link to="./gone-to.md">x</Link> <a href="./gone-href.md">a</a>',
    '<Card href="./not-a-link.md" />',
    "</TabItem>",
    "",
    "`<!--` [gone](./gone-code.md)",
    "Text {/* [skipped](./gone.md) */} <!-- [skipped](./gone.md) -->",
    '[ok](#tab) [ok](#legacy) [bad](#prop) <a name="legacy" /> <Card name="prop" />',
  ];
  await withFiles({ "a.mdx": a.join("\n") }, async (dir) => {
    assertEquals(await problems(dir, { name: "a.mdx" }), [
      "5:5: ./gone.md (missing file)",
      "7:1: ./gone-to.md (missing file)",
      "7:34: ./gone-href.md (missing file)",
      "11:8: ./gone-code.md (missing file)",
      "13:26: #prop (missing anchor)",
    ]);
    // A JSX link carries the same fields as any other.
    const [, jsx] = await checkLinks([join(dir, "a.mdx")]);
    assertEquals(Object.keys(jsx).sort(), [
      "column",
      "file",
      "line",
      "link",
      "reason",
    ]);
    await Deno.writeTextFile(join(dir, "a.mdx"), "# A\n\na < b {oops\n");
    const [invalid] = await checkLinks([join(dir, "a.mdx")]);
    assertEquals([invalid.line, invalid.reason], [3, "invalid MDX"]);
  });
});

Deno.test("checkLinks reads Docusaurus front matter, ids and comments", async () => {
  const a = [
    "---",
    "id: intro",
    "image: ./gone.png",
    "---",
    "[ok](./b.md#bar) [ok](./b.md#baz) [bad](./b.md#qux) [ok](./b.md#foo)",
    "[bad](./b.md#foo-bar) [bad](#id-intro) [ok](./b.md#setext-id)",
    "{/* [skipped](./gone.md)",
    "[skipped](./gone.md) */} [gone](./gone.md)",
  ];
  const b = [
    "## Foo {#bar}",
    "## Foo {/* #baz */}",
    "## Foo <!-- #qux -->", // foo: Docusaurus drops the comment
    "## Foo", // foo-1: custom ids don't count as repeats
    "Setext {#setext-id}",
    "===",
  ];
  await withFiles(
    { "a.md": a.join("\n"), "b.md": b.join("\n") },
    async (dir) => {
      // Docusaurus reads `.md` as MDX, so `{/* … */}` is a comment there.
      assertEquals(await problems(dir, { flavor: "docusaurus" }), [
        "5:35: ./b.md#qux (missing anchor)",
        "6:1: ./b.md#foo-bar (missing anchor)",
        "6:23: #id-intro (missing anchor)",
        "8:26: ./gone.md (missing file)",
      ]);
      // TOML front matter, as Hugo writes it; `---` doesn't close it.
      const toml = "+++\n---\n[skipped](./gone.md)\n+++\n[gone](./gone.md)";
      await Deno.writeTextFile(join(dir, "a.md"), toml);
      assertEquals(await problems(dir), ["5:1: ./gone.md (missing file)"]);
    },
  );
});

Deno.test("checkLinks reports empty links", async () => {
  const a = [
    "[empty]() [empty](<>) [empty]( ) [gone](./gone.md )",
    '<a href="">empty</a> [ok](#) `[code]()`',
    "",
    "[empty]: <>",
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    assertEquals(await problems(dir), [
      "1:1:  (empty link)",
      "1:11:  (empty link)",
      "1:23:  (empty link)",
      "1:34: ./gone.md (missing file)",
      "2:1:  (empty link)",
      "4:1:  (empty link)",
    ]);
  });
});

Deno.test("checkLinks reports links spelled with the wrong case", async () => {
  const a = "[ok](./Sub/Guide.md#setup) [bad](./sub/Guide.md) " +
    "[bad](./Sub/guide.md#setup)";
  await withFiles({ "a.md": a, "Sub/Guide.md": "# Setup\n" }, async (dir) => {
    // macOS finds `sub/guide.md`; Linux, like GitHub, does not.
    const insensitive = await Deno.stat(join(dir, "sub")).then(() => true)
      .catch(() => false);
    const reason = insensitive ? "wrong case" : "missing file";
    assertEquals(await problems(dir), [
      `1:28: ./sub/Guide.md (${reason})`,
      `1:50: ./Sub/guide.md#setup (${reason})`,
    ]);
  });
});

Deno.test("externalLinks lists links with a scheme or to another host", async () => {
  const a = [
    "[web](https://x.test/nope) [ok](./a.md) [web](https://x.test/Foo_(bar))",
    "[web](//x.test/host) <https://x.test/auto> [web](<https://x.test/angled>)",
    '<a href="https://x.test/html">web</a> [mail](mailto:a@x.test) <not a link>',
    "",
    "[web]: https://x.test/ref",
    "",
    "`[code](https://x.test/code)`",
    "",
    "Bare: https://x.test/bare and www.x.test",
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    const file = join(dir, "a.md");
    const links = (await externalLinks([file])).map(({ line, column, link }) =>
      `${line}:${column}: ${link}`
    );
    assertEquals(links, [
      "1:1: https://x.test/nope",
      "1:41: https://x.test/Foo_(bar)",
      "2:1: //x.test/host",
      "2:22: https://x.test/auto",
      "2:44: https://x.test/angled",
      "3:1: https://x.test/html",
      "3:39: mailto:a@x.test",
      "5:1: https://x.test/ref",
      "9:7: https://x.test/bare",
      "9:31: http://www.x.test",
    ]);
    assertEquals(await problems(dir), []);
  });
});

Deno.test("markdownFiles skips what Git ignores unless told not to", async () => {
  await withFiles({
    ".gitignore": "dist/\n",
    "dist/out.md": "",
    "kept.md": "",
    "Notes.MD": "",
    "guide.markdown": "",
    "page.mdx": "",
  }, async (dir) => {
    const walk = async (gitignore: boolean) =>
      (await Array.fromAsync(markdownFiles(dir, { gitignore }))).sort();
    // Outside Git, the walk skips nothing but dot folders and node_modules.
    assertEquals(await walk(true), await walk(false));
    await new Deno.Command("git", { args: ["init", "-q"], cwd: dir }).output();
    assertEquals(await walk(true), [
      join(dir, "Notes.MD"),
      join(dir, "guide.markdown"),
      join(dir, "kept.md"),
      join(dir, "page.mdx"),
    ]);
    assertEquals(await walk(false), [
      join(dir, "Notes.MD"),
      join(dir, "dist", "out.md"),
      join(dir, "guide.markdown"),
      join(dir, "kept.md"),
      join(dir, "page.mdx"),
    ]);
  });
});

/** Runs the CLI without Git, as `deno run -R mod.ts --no-gitignore …args`. */
async function cli(...args: string[]) {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-R", "mod.ts", "--no-gitignore", ...args],
    cwd: new URL(".", import.meta.url),
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code, stdout: decode(stdout), stderr: decode(stderr) };
}

const a = "[web](https://x.test) [gone](./gone.md)\n";

Deno.test("the CLI prints external links, then problems", async () => {
  await withFiles({ "a.md": a }, async (dir) => {
    const file = join(dir, "a.md");
    assertEquals(await cli("--external", file), {
      code: 1,
      stdout: `${file}:1:1: https://x.test\nChecked 1 file\n`,
      stderr: `${file}:1:23: ./gone.md (missing file)\n`,
    });
  });
});

Deno.test("the CLI prints JSON on request", async () => {
  await withFiles({ "a.md": a }, async (dir) => {
    const file = join(dir, "a.md");
    const gone = { file, line: 1, column: 23, link: "./gone.md" };
    const result = {
      checked: [file],
      problems: [{ ...gone, reason: "missing file" }],
    };
    const json = await cli("--json", file);
    assertEquals(json.code, 1);
    assertEquals(JSON.parse(json.stdout), result);
    const both = await cli("--json", "--external", file);
    assertEquals(JSON.parse(both.stdout), {
      ...result,
      external: [{ file, line: 1, column: 1, link: "https://x.test" }],
    });
  });
});

Deno.test("the CLI checks a file once, and exits 2 on a bad argument", async () => {
  await withFiles({ "a.md": a }, async (dir) => {
    const file = join(dir, "a.md");
    assertEquals(
      (await cli("--json", file, file)).stdout,
      (await cli("--json", file)).stdout,
    );
    assertEquals(await cli(join(dir, "nope")), {
      code: 2,
      stdout: "",
      stderr: `No such file or directory: ${join(dir, "nope")}\n`,
    });
    const unknown = await cli("--nope");
    assertEquals(unknown.code, 2);
    assertEquals(unknown.stderr.split("\n")[0], "Unknown option: --nope");
    const flavor = await cli("--flavor", "hugo", file);
    assertEquals(flavor.code, 2);
    assertEquals(flavor.stderr.split("\n")[0], "Unknown flavor: hugo");
    const help = await cli("--help");
    assertEquals(help.code, 0);
    assertEquals(
      help.stdout.split("\n")[0],
      "Usage: md-links-checker [options] [paths...]",
    );
    // After `--`, a file may start with `-`; `007` stays a name.
    assertEquals(
      (await cli("--", "-x.md", "007")).stderr,
      "No such file or directory: -x.md\n",
    );
  });
});

Deno.test("the CLI checks anchors of the --flavor", async () => {
  await withFiles(
    { "a.md": "## Setup {#install}\n[ok](#install)\n" },
    async (dir) => {
      const file = join(dir, "a.md");
      assertEquals((await cli("--flavor", "docusaurus", file)).code, 0);
      assertEquals(
        (await cli(file)).stderr,
        `${file}:2:1: #install (missing anchor)\n`,
      );
    },
  );
});

Deno.test("the CLI resolves / links from --root", async () => {
  const files = {
    "posts/a.md":
      "[img](/images/x.png) [post](/posts/foo/) [gone](/gone.html)\n",
    "dist/images/x.png": "",
    "dist/posts/foo/index.html": "",
  };
  await withFiles(files, async (dir) => {
    const file = join(dir, "posts/a.md");
    const problem = `${file}:1:42: /gone.html (missing file)\n`;
    for (
      const args of [["--root", join(dir, "dist")], [`--root=${dir}/dist`]]
    ) {
      const { code, stderr } = await cli(...args, file);
      assertEquals({ code, stderr }, { code: 1, stderr: problem });
    }
    assertEquals(await cli("--root", join(dir, "nope"), file), {
      code: 2,
      stdout: "",
      stderr: `Not a directory: ${join(dir, "nope")}\n`,
    });
    assertEquals((await cli(file, "--root")).code, 2);
  });
});
