import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { checkLinks, externalLinks, markdownFiles, slug } from "./mod.ts";

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

/** The problems in `dir/a.md`, as `line: link (reason)`. */
async function problems(dir: string): Promise<string[]> {
  const found = await checkLinks([join(dir, "a.md")], { root: dir });
  return found.map(({ line, link, reason }) => `${line}: ${link} (${reason})`);
}

Deno.test("slug follows GitHub's heading anchors", () => {
  assertEquals(slug("5. An app on JSR"), "5-an-app-on-jsr");
  assertEquals(slug("`.env` files and `:include`"), "env-files-and-include");
  assertEquals(
    slug("dbb's ClojureScript namespaces"),
    "dbbs-clojurescript-namespaces",
  );
  assertEquals(
    slug("[Setup](./a.md) and [ref][r] ![logo](./x.png) <kbd>Ctrl</kbd>"),
    "setup-and-ref--ctrl",
  );
});

Deno.test("checkLinks reports links to missing files", async () => {
  const a = [
    "[ok](./b.md) [ok](./sub/) [gone](./gone.md)",
    "[ok](<./sub/a b.md> 'Title') [gone](<./c d.md>)",
    "[ok](./sub/a_(b).md) [gone](./100%.md)",
    "[ok](./b.md?plain=1) [gone](./gone.md?plain=1)",
    "[ok](/sub/) [ok](/b.md) [gone](/sub/gone.md) [ok](/) [ok](./) [ok](.)",
    "[gone](./dir.md#x) [gone](./b.md/x.md)",
  ];
  await withFiles({
    "a.md": a.join("\n"),
    "b.md": "",
    "sub/a b.md": "",
    "sub/a_(b).md": "",
    "dir.md/": "",
  }, async (dir) => {
    assertEquals(await problems(dir), [
      "1: ./gone.md (missing file)",
      "2: ./c d.md (missing file)",
      "3: ./100%.md (missing file)",
      "4: ./gone.md?plain=1 (missing file)",
      "5: /sub/gone.md (missing file)",
      "6: ./dir.md#x (missing file)",
      "6: ./b.md/x.md (missing file)",
    ]);
  });
});

Deno.test("checkLinks matches anchors like GitHub", async () => {
  const a = [
    "# Top",
    "[ok](#top) [ok](#) [bad](#nope)",
    "[ok](./b.md#real-heading) [ok](./b.md#real-heading-1)",
    "[ok](./b.md#real-heading-2) [bad](./b.md#real-heading-3)",
    "[ok](./b.md#setext) [ok](./b.md#caf%C3%A9)",
    "[ok](./b.md#Custom-Id) [ok](./b.md#old-name) [bad](./b.md#in-code)",
    "[ok](./b.md?plain=1#setext) [bad](./b.md?x#nope)",
    "[ok](./c.markdown#c) [bad](./c.markdown#nope) [ok](./d.txt#any)",
  ];
  const b = [
    "## Real heading 1",
    "## Real heading",
    "## Real heading", // real-heading-2, as real-heading-1 is taken
    "Setext",
    "------",
    "# Café",
    '<a id="Custom-Id"></a> <a name="old-name"></a>',
    "```html",
    '<a id="in-code"></a>',
    "```",
  ];
  await withFiles({
    "a.md": a.join("\n"),
    "b.md": b.join("\n"),
    "c.markdown": "# C\n",
    "d.txt": "",
  }, async (dir) => {
    assertEquals(await problems(dir), [
      "2: #nope (missing anchor)",
      "4: ./b.md#real-heading-3 (missing anchor)",
      "6: ./b.md#in-code (missing anchor)",
      "7: ./b.md?x#nope (missing anchor)",
      "8: ./c.markdown#nope (missing anchor)",
    ]);
  });
});

Deno.test("checkLinks reads reference definitions and HTML links", async () => {
  const a = [
    "[ok]: ./b.md",
    '[gone]: <./ref-gone.md> "Title"',
    "[^1]: A footnote, not a link",
    '<a href="./b.md">ok</a> <a class="x"',
    "href='./href-gone.md'>gone</a>",
    '<p data-href="./not-a-link.md">',
  ];
  await withFiles({ "a.md": a.join("\n"), "b.md": "" }, async (dir) => {
    assertEquals(await problems(dir), [
      "2: ./ref-gone.md (missing file)",
      "4: ./href-gone.md (missing file)",
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
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    assertEquals(await problems(dir), [
      "4: #commented-out (missing anchor)",
      "4: #fenced (missing anchor)",
      "11: ./gone.md (missing file)",
    ]);
  });
});

Deno.test("checkLinks reports empty links", async () => {
  const a = [
    "[empty]() [empty](<>) [empty]( ) [gone](./gone.md )",
    '[empty]: <> <a href="">empty</a>',
    "[ok](#) `[code]()` [text] [ok][text]",
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    assertEquals(await problems(dir), [
      "1:  (empty link)",
      "1:  (empty link)",
      "1:  (empty link)",
      "1: ./gone.md (missing file)",
      "2:  (empty link)",
      "2:  (empty link)",
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
      `1: ./sub/Guide.md (${reason})`,
      `1: ./Sub/guide.md#setup (${reason})`,
    ]);
  });
});

Deno.test("externalLinks lists links with a scheme or to another host", async () => {
  const a = [
    "[web](https://x.test/nope) [ok](./a.md) [web](https://x.test/Foo_(bar))",
    "[web](//x.test/host) <https://x.test/auto> [web](<https://x.test/angled>)",
    '<a href="https://x.test/html">web</a> [mail](mailto:a@x.test) <not a link>',
    "[web]: https://x.test/ref",
    "`[code](https://x.test/code)`",
  ];
  await withFiles({ "a.md": a.join("\n") }, async (dir) => {
    const file = join(dir, "a.md");
    assertEquals(await externalLinks([file]), [
      { file, line: 1, link: "https://x.test/nope" },
      { file, line: 1, link: "https://x.test/Foo_(bar)" },
      { file, line: 2, link: "//x.test/host" },
      { file, line: 2, link: "https://x.test/auto" },
      { file, line: 2, link: "https://x.test/angled" },
      { file, line: 3, link: "https://x.test/html" },
      { file, line: 3, link: "mailto:a@x.test" },
      { file, line: 4, link: "https://x.test/ref" },
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
  }, async (dir) => {
    await new Deno.Command("git", { args: ["init", "-q"], cwd: dir }).output();
    const walk = async (gitignore: boolean) =>
      (await Array.fromAsync(markdownFiles(dir, { gitignore }))).sort();
    assertEquals(await walk(true), [
      join(dir, "Notes.MD"),
      join(dir, "guide.markdown"),
      join(dir, "kept.md"),
    ]);
    assertEquals(await walk(false), [
      join(dir, "Notes.MD"),
      join(dir, "dist", "out.md"),
      join(dir, "guide.markdown"),
      join(dir, "kept.md"),
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
      stdout: `${file}:1: https://x.test\nChecked 1 file\n`,
      stderr: `${file}:1: ./gone.md (missing file)\n`,
    });
  });
});

Deno.test("the CLI prints JSON on request", async () => {
  await withFiles({ "a.md": a }, async (dir) => {
    const file = join(dir, "a.md");
    const result = {
      checked: [file],
      problems: [{ file, line: 1, link: "./gone.md", reason: "missing file" }],
    };
    const json = await cli("--json", file);
    assertEquals(json.code, 1);
    assertEquals(JSON.parse(json.stdout), result);
    const both = await cli("--json", "--external", file);
    assertEquals(JSON.parse(both.stdout), {
      ...result,
      external: [{ file, line: 1, link: "https://x.test" }],
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
    assertEquals(await cli("--nope"), {
      code: 2,
      stdout: "",
      stderr: "Unknown option: --nope\n",
    });
  });
});
