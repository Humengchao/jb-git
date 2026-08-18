# JB Git

JB Git is a VS Code extension project that brings an IntelliJ IDEA-inspired Git workspace to VS Code.

The implementation is intentionally layered:

- Git Core executes the user's system `git` binary with safe argument arrays.
- Repository state is parsed from machine-readable Git output and refreshed incrementally.
- The extension host owns Git operations; the UI is built with VS Code Tree Views and, later, Webviews.
- Changelists, Shelf, Log Graph, and conflict workflows are added in later milestones.

## Current status

The first milestone provides repository discovery, status parsing, a Local Changes tree, branch information, and safe stage/unstage/discard/fetch/checkout/init commands.

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch the Extension Development Host.

## Scope and attribution

The feature behavior is informed by the public IntelliJ Community Git/VCS implementation and documentation. This project is an independent TypeScript implementation; it does not copy JetBrains source code, UI assets, or trademarks.

