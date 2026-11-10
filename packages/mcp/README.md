# idea-to-code-mcp

An MCP server for planning software as nested flowcharts with your coding agent. The plan lives in your project as YAML (`plan/map.yaml` and `plan/features/*.yaml`). The [idea-to-code](https://github.com/oyinlola007/idea-to-code) extension draws it as a chart in VS Code, Cursor and VSCodium.

With this server, Claude Code, Cursor, Copilot or any other MCP client reads and changes the plan through checked tools, instead of editing the YAML by hand.

## Setup

**Claude Code**

```bash
claude mcp add --scope user idea-to-code -- npx -y idea-to-code-mcp
```

**Codex**

```bash
codex mcp add idea-to-code -- npx -y idea-to-code-mcp
```

**VS Code**: nothing to do. The idea-to-code extension offers the server to Copilot.

**Cursor**, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "idea-to-code": { "command": "npx", "args": ["-y", "idea-to-code-mcp", "--root", "${workspaceFolder}"] } } }
```

**Any other client**: run `npx -y idea-to-code-mcp` over stdio. The server works on the nearest folder with a `plan/`, from where it starts up to your home folder. With no plan yet, a new one goes at the top of the git repository. To choose the folder yourself, pass `--root <folder>`.

## Tools

| Tool                                                   | What it does                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `get_outline`, `list_features`, `get_flow`             | Read the whole plan, the features, or one flow in full.                          |
| `get_current_view`                                     | Which part of the chart the user has open, so "here" and "this step" make sense. |
| `validate`                                             | Every problem in the plan, with file, line and reason.                           |
| `init_plan`                                            | Starts a plan in a project that has none.                                        |
| `add_feature`, `fill_flow`, `add_node`, `set_status` … | Every change the app itself can make: features, flows, steps, links, progress.   |

## What happens on each change

1. **It's checked.** A change that would break the plan is refused with the reason, so the agent fixes its call and tries again. The files are left as they were.
2. **It's saved** in the plan's canonical layout, one field per line, so diffs stay readable.
3. **It's recorded** in the plan's history under the agent's name, such as "Claude Code". Edits made by hand since the last change are recorded first, as edits of their own.
4. **It shows on the chart.** If the extension is open, it takes you to where the change landed. History in the app lists every change, and Undo reverses it.

## Safety

- It writes only inside `plan/`. Paths that leave the project, including through symbolic links, are refused.
- Plan text comes back marked as data, so text written into the plan can't pass as instructions to the agent.
- It makes no network requests.

## Where history lives

History is kept outside your project, so it never clutters the repository:

- macOS: `~/Library/Application Support/idea-to-code`
- Linux: `$XDG_DATA_HOME/idea-to-code`, or `~/.local/share/idea-to-code`
- Windows: `%APPDATA%\idea-to-code`

Set `IDEA_TO_CODE_DATA` to use another folder.

Requires Node.js 20 or later.
