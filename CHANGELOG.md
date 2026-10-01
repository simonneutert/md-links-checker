# Changelog

## 0.3.0 (2026-10-01)

Markdown is now parsed with [micromark](https://github.com/micromark/micromark)
(CommonMark, GitHub's extensions, front matter, MDX) instead of patterns, so
links and headings are found the way GitHub finds them.

### Breaking

- Problems and external links have a `column`, and the output reads
  `file:line:column:`.
- `slug(text, flavor)` takes a heading's plain text, not its Markdown.
- `{#id}` and comment ids on headings only count with `--flavor docusaurus`.
  GitHub doesn't support them: `## Setup {#install}` is `#setup-install` there.
- A reference without a definition (`[text][nope]`, but not `m[0][1]`) is
  reported as `undefined reference`, and an `.mdx` file the MDX parser rejects
  as `invalid MDX`.
- `[ref]: <url> text` with text after the URL is no longer a definition, as in
  CommonMark.
- Bare URLs (`https://x.test`, `www.x.test`) are listed by `--external`, as
  GitHub links them.

### Added

- `--flavor github|gitlab|bitbucket|docusaurus` picks the heading anchors.
  GitLab's are GitHub's. `bitbucket` adds the `markdown-header-` prefix.
  `docusaurus` reads every file as MDX, as Docusaurus does, and adds custom
  heading ids: `## Setup {#install}` and `## Setup {/* #install */}`. HTML
  comments are dropped in MDX, as by Docusaurus 3 by default, so
  `## Setup <!-- #install -->` is `#setup`.
- Directories are walked for `.mdx` files too, which are parsed as MDX: JSX
  links (`<a href>`, `<Link to>`), `id`s and `<a name>`s are read, `{/* … */}`
  comments are skipped, and indented lines are not code.
- Images (`![alt](./a.png)`) are checked.
- `--help` (`-h`). An unknown option prints the usage too. Flags are parsed with
  `@std/cli`, so `--` ends the options: `-- -draft.md` checks a file named
  `-draft.md`.

### Fixed

- Front matter, YAML (`---`) or TOML (`+++`), was read as Markdown: its closing
  `---` turned the line above into a heading (`id: intro` became `#id-intro`),
  and links in it were checked.
- A file starting with a byte order mark lost its first heading as an anchor.
- Escaped links (`\[x](./a.md)`), links in HTML blocks and links in code blocks
  inside quotes or list items were checked.
- `` `<!--` `` in a code span hid the links up to a later `-->`.
- Headings indented by up to three spaces, in quotes, with entities
  (`A &amp; B`) or `_emphasis_` got no or the wrong anchor.
- Definitions in quotes (`> [ref]: ./a.md`) and multi-line links were missed.
- Reading a directory named like `x.md` for anchors crashed on Windows.

### Other

- The README states who the checker is for: documentation in a repository, read
  on GitHub, GitLab or Bitbucket, and how to check a
  [Docusaurus](https://docusaurus.io) site.
- The JSR package no longer ships the tests and the lockfile.
- CI runs the tests on Linux, macOS and Windows, and `deno doc --lint`.
  Publishing checks that the tag matches `deno.json`. `deno task test` fails
  below 80% coverage.

## 0.2.1 (2026-09-29)

- Links inside indented code blocks (four spaces, after a blank line) are no
  longer checked. Inside list items they still are.

## 0.2.0 (2026-09-28)

- Added `--root <dir>` (or `--root=<dir>`), which sets where links starting with
  `/` resolve from. For a static site, pass the build output (`--root dist`). A
  root that is not a directory exits with `2`.
- The README shows how to check a
  [deno based quickblog](https://github.com/simonneutert/deno-quickblog) or
  [Jekyll](https://jekyllrb.com/) site.

## 0.1.1 (2026-09-28)

- Added `--external`, which lists links with a scheme (`https:`, `mailto:`, …).
  It only lists them; checking them is out of scope.
- Added `--json`, which prints checked files, problems and (with `--external`)
  external links as JSON on stdout.
- Added `externalLinks()` to the library.
- Problems and external links carry their line: the output reads
  `docs/a.md:12: ./gone.md (missing file)`, and `Problem` has a `line` field.
  Links are reported in the order they appear in the file.
- Autolinks (`<https://x.test>`) are listed with `--external`.
- HTML links (`<a href="./a.md">`) are now checked, and listed with `--external`
  when they are external.
- Reference-style link definitions (`[ref]: ./a.md`) are now checked. Footnotes
  (`[^1]:`) are skipped.
- Links to repeated headings now match GitHub's anchors (`#setup-1`, …).
- Links inside inline code spans are no longer checked.
- Links and headings inside HTML comments (`<!-- … -->`) are ignored.
- Setext headings (`Title` underlined with `===` or `---`) are now anchors.
- HTML `id` and `name` attributes (`<a id="x">`) are now anchors.
- Changed: every run now needs `--allow-run=git` unless `--no-gitignore` is
  passed, also when only files are named, to find the repository root.
- Links starting with `/` resolve from the repository root (`checkLinks` takes a
  `root` option), and `//x.test` links count as external.
- `.markdown` files, and extensions in any case (`README.MD`), count as
  Markdown.
- The README lists the requirements (Deno 2, optional Git, permissions) and the
  limitations of the checker.
- Empty links (`[text]()`, `[text](<>)`, `<a href="">`) are reported as
  `empty link`.
- Fixed: a link with a space before the closing parenthesis (`[a](./a.md )`) was
  skipped.
- Fixed: on macOS, a link spelled with the wrong case (`./readme.md` for
  `README.md`) passed, although it breaks on Linux and GitHub. It is now
  reported as `wrong case`.
- Fixed: a stray `%` in a link (`./100%.md`) crashed the checker.
- Fixed: `[top](#)` was reported as a missing anchor.
- Fixed: percent-encoded anchors (`#caf%C3%A9`) didn't match their heading.
- Fixed: a 3-backtick fence inside a 4-backtick fence ended the code block
  early.
- Fixed: links in angle brackets with spaces (`<./a b.md>`) or with a `'title'`
  were skipped.
- Fixed: a path that doesn't exist crashed with a stack trace; it now exits with
  `2`.
- Fixed: parentheses in a URL (`https://x.test/Foo_(bar)`) cut the link short.
- Fixed: a query (`./a.md?plain=1`) was reported as a missing file.
- Fixed: headings containing links, images or HTML tags (`## [Setup](./a.md)`)
  got the wrong anchor.
- Fixed: an anchor link to a directory named like a Markdown file (`./dir.md#x`)
  crashed the checker.
- Fixed: a link that goes through a file (`./a.md/x.md`) crashed the checker.
- Fixed: a file named twice on the command line was checked twice.

## 0.1.0 (2026-09-27)

- First release: checks relative links and `#anchors` in Markdown files.
