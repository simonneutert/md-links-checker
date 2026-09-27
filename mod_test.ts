import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkLinks, markdownFiles, slug } from "./mod.ts";

Deno.test("slug follows GitHub's heading anchors", () => {
  assertEquals(slug("5. An app on JSR"), "5-an-app-on-jsr");
  assertEquals(slug("`.env` files and `:include`"), "env-files-and-include");
  assertEquals(
    slug("dbb's ClojureScript namespaces"),
    "dbbs-clojurescript-namespaces",
  );
});

Deno.test("checkLinks reports missing files and anchors only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "a.md"),
      [
        "# Top",
        "[ok](./b.md#real-heading) [ok](#top) [ok](./sub/) [web](https://x.test/nope)",
        "[gone](./gone.md) [bad](./b.md#nope) [bad](#fenced)",
        "```sh",
        "# Fenced",
        "[skipped](./also-gone.md)",
        "```",
      ].join("\n"),
    );
    await Deno.writeTextFile(join(dir, "b.md"), "## Real heading\n");
    await Deno.mkdir(join(dir, "sub"));
    const file = join(dir, "a.md");
    assertEquals(await checkLinks([file]), [
      { file, link: "./gone.md", reason: "missing file" },
      { file, link: "./b.md#nope", reason: "missing anchor" },
      { file, link: "#fenced", reason: "missing anchor" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdownFiles skips what Git ignores unless told not to", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await new Deno.Command("git", { args: ["init", "-q"], cwd: dir }).output();
    await Deno.writeTextFile(join(dir, ".gitignore"), "dist/\n");
    await Deno.mkdir(join(dir, "dist"));
    await Deno.writeTextFile(join(dir, "dist", "out.md"), "");
    await Deno.writeTextFile(join(dir, "kept.md"), "");
    const walk = async (gitignore: boolean) =>
      (await Array.fromAsync(markdownFiles(dir, { gitignore }))).sort();
    assertEquals(await walk(true), [join(dir, "kept.md")]);
    assertEquals(await walk(false), [
      join(dir, "dist", "out.md"),
      join(dir, "kept.md"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
