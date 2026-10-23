# work-graph

A Claude Code mod that adds a **Work** pane: the agents of the session as an org chart of cards, the tasks with what blocks them, and the git worktrees with their pull requests.

![The Work pane with demo data](docs/panel.svg)

## What it shows

**Agents.** A card for the main session, joined by connector lines to a card per agent, with subagents hanging under their parent. Each card has:

- status: running, starting, needs you, idle, done, error, refused, stopped. An idle teammate shows how its last turn ended.
- model, agent type and the plugin the agent comes from (`Opus 5.5 · poteto-agent · pstack`)
- what it is doing now (`▸ Edit api.ts`), or the first line of its last answer
- estimated cost, tokens, context in use, time spent, tool calls and files edited
- the pull request it opened with `gh pr create`

The header carries the agent counts and the session cost as `/cost` reports it.

**Tasks.** Tasks created with `TaskCreate` as cards, each blocked task under the task that blocks it, with done, running, blocked and ready states.

**Worktrees.** The worktrees with uncommitted changes or a branch of their own, with the number of changed files and the branch's pull request: number, open, draft, merged or closed, and CI checks. Detached and clean worktrees are folded into one line.

**Notifications.** A notification, through the channel Claude Code is set to use, when an agent starts waiting on you, and when the CI checks of an open PR turn red. Where the session cannot raise one, as in the desktop app, it shows as a toast. A PR that was already failing when the mod loaded stays quiet, and turning notifications off in Claude Code turns these off too.

**For the model.** The mod registers a `work_status` tool that returns the same picture as JSON: agents with their status, branch, current tool and PR; tasks with the open tasks they wait on; worktrees with their changed files, PR and checks. The main session and its agents can call it before taking a task or a worktree, to see what is blocked and what another agent already holds.

## Install

At the prompt of a Claude Code session:

```
/plugin install work-graph --marketplace mariano-aguero/claude-work-graph
```

From a shell:

```
claude plugin install work-graph --marketplace mariano-aguero/claude-work-graph
```

The first time, Claude Code asks to add the `mariano-aguero/claude-work-graph` marketplace. Answer `y`, then keep the user scope so the mod loads in every session you start. It runs in the current session right away, with no restart.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `mariano-aguero/claude-work-graph`, then Add plugin. A mod installed from a terminal at the user scope also loads in the desktop app's local Code sessions, so either road works.

The pane opens by itself when a session starts. `/work` opens it at any time. In a fullscreen terminal at least 110 columns wide it docks beside the transcript; otherwise it sits above the prompt.

To check the install, `claude plugin list` should show `work-graph`, and `/work` should answer `Work pane opened.` If the pane stays empty or never shows, start a session with `claude --debug`: the mod's errors are logged on lines starting with `work-graph:`.

To get a new version, run `claude plugin update work-graph`, then `/reload-plugins` in an open session. To remove it, `claude plugin uninstall work-graph`.

## Requirements

- Claude Code with mod support (function hooks).
- `git` for the worktree list.
- `gh`, signed in, for pull requests. Without it the pane shows worktrees without PRs.

## Notes

- Per-agent cost is an estimate: tokens times the model's list price, cache writes at 1.25x input. The header total is the session's own figure.
- Figures count from the moment the mod loads; earlier turns are not seen.
- A teammate running in a terminal pane of its own is a separate process: its card shows its status, not its usage.
- Pull requests are fetched once a minute with a single `gh pr list --author @me`.

## Development

```
claude plugin validate .
claude plugin test .
```

To run a local copy, start a session with `claude --plugin-dir <path to this folder>`.
