# Changelog

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
