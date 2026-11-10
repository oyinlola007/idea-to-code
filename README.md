# idea-to-code

Plan software as nested flowcharts, with any coding agent.

- [The extension](packages/extension/README.md), for VS Code, Cursor and VSCodium: how to plan and connect your agent.
- [The MCP server](packages/mcp/README.md), `idea-to-code-mcp` on npm: its tools and what happens on each change.

## Install from source

```bash
pnpm install
pnpm package
code --install-extension packages/extension/idea-to-code-0.0.0.vsix
```

Use `cursor` or `codium` in place of `code` for the other editors.

## Develop

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build   # the full check
```

How the code is laid out, and the rules for changing it, are in [AGENTS.md](AGENTS.md).

## License

MIT
