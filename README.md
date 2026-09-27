# md-links-checker

[![JSR](https://jsr.io/badges/@simonneutert/md-links-checker)](https://jsr.io/@simonneutert/md-links-checker)
[![CI](https://github.com/simonneutert/md-links-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/simonneutert/md-links-checker/actions/workflows/ci.yml)

Checks relative links in Markdown files. A link fails when its target file
doesn't exist, or when its `#anchor` doesn't match a heading in the target
Markdown file (using GitHub's anchor rules). Links with a scheme (`https:`,
`mailto:`, `jsr:`, …) and links inside fenced code blocks are ignored.

## Usage

```sh
# Check the current directory
deno run -R --allow-run=git jsr:@simonneutert/md-links-checker

# Check specific files and directories
deno run -R --allow-run=git jsr:@simonneutert/md-links-checker README.md docs

# Walk everything, ignoring .gitignore (no git needed)
deno run -R jsr:@simonneutert/md-links-checker --no-gitignore docs
```

Directories are walked for `.md` files. Inside a Git repository, files Git
ignores are skipped; outside one, dot folders and `node_modules` are skipped.
Files named on the command line are always checked.

Problems are printed to stderr and the process exits with `1`:

```
docs/guide.md: ./setup.md#instal (missing anchor)
docs/guide.md: ../gone.md (missing file)
Checked 12 files
```

## As a library

```ts
import { checkLinks, markdownFiles } from "jsr:@simonneutert/md-links-checker";

const files = await Array.fromAsync(markdownFiles("docs"));
const problems = await checkLinks(files);
```

## Development

```sh
deno task test   # run the tests
deno task dev    # run them in watch mode
```

## License

MIT
