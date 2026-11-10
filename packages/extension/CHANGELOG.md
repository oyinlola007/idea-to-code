# Changelog

## 1.0.1

- **A message sent before choosing a model is answered once one works,** including when you come back from Settings without changing anything, such as after allowing idea-to-code to use your editor's models.
- **Sending the message again replaces the one that never reached a model,** so it no longer shows twice with a leftover "Choose a model" button.

## 1.0.0

The first public release.

- **Plan as nested flowcharts.** Features on the overview, each with its own flow, and steps that open into flows of their own. Progress rolls up from the steps you mark done.
- **Plan in the sidebar chat**, with your editor's models or your own Anthropic, OpenAI, Google or OpenAI-compatible key. Your first message starts the plan.
- **Plan with your coding agent** through the bundled MCP server: Claude Code, Codex, Copilot, Cursor and others read and change the plan through checked tools, and every change is pointed out on the chart.
- **Link steps to the code that builds them**, and see when a linked file goes missing.
- **History and Undo** for every change, by you or any agent, kept outside your project.
- **Share a plan** as a single web page anyone can open.
- Works in VS Code, Cursor and VSCodium, in light, dark and high-contrast themes.
