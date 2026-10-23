# Agent Hub: a live monitor pane for Claude Code

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757.svg)](#install)
[![Release](https://img.shields.io/github/v/release/quang2512/agent-hub)](https://github.com/quang2512/agent-hub/releases)

**Agent Hub is a Claude Code plugin that monitors your session live, in a pane beside the transcript:** how full the context window is, the task checklist with the tool calls under each item, every subagent's progress, the background shells it spawns and their output, tokens and cost, and your 5-hour and 7-day usage limits with when they reset. Use it to watch multi-agent runs, spot a stuck subagent, and see how close you are to compaction or a rate limit.

<!-- Screenshot: add docs/screenshot.png (a real capture of the pane) and uncomment.
![Agent Hub pane in Claude Code: context window bar, task checklist, subagent cards and 5h/7d usage limits](docs/screenshot.png)
-->

```
 ▐▛███▜▌   ▟▛▜▙▗█▀▀▘█▛▀▘█▙ █▌▀▜█▀▘ ▐█ █▌█▌▐█▐█▀█▖
▝▜█████▛▘  █▙▟█▐█▗▄▖█▛▀ █▛██▌ ▐█   ▐█▀█▌█▌▐█▐█▀█▖
  ▘▘ ▝▝    █▌▐█▝█▄█▌█▙▄▖█▌▝█▌ ▐█   ▐█ █▌▜▙▟▛▐█▄█▘
──────────────────────────────────────────────────────
Context: 23% · 230k / 1.0M tok
████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
──────────────────────────────────────────────────────
Tasks: 1 in progress · 2 pending · 1 done · 7 tools
✳ Writing the parser… (1:12 · 7 tools)
  ⎿ ✔ Read the spec
    ■ Write the parser
        Read src/parse.ts · Edit src/parse.ts · Bash npm test
    □ Add tests
    □ Update the docs
──────────────────────────────────────────────────────
Subagents: 1 running · 1 done · 31 tools · 48k tok · $0.42
╭─ ● Explore ───────────────────────── 0:42 · 13k tok ─╮
│ map the routes                                       │
│   Grep "router" · Read src/routes.ts · Glob src/**   │
╰──────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────
Shells: 1 running · 1 done
╭─ ⠹ Start the dev server ─────────────── main · 2:04 ─╮
│ $ npm run dev                                        │
│   VITE v6.0.7  ready in 412 ms                       │
│   ➜  Local:   http://localhost:5173/                 │
│ 10:42:07 [vite] page reload src/App.tsx              │
│ 10:42:31 [vite] hmr update /src/ui/Hud.tsx           │
│                                                      │
╰──────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────
5h 40% · ↻ 14:30   7d 12% · ↻ Thu 09:00
```

- **Context**: how full the session's context window is, as one bar the width of the pane (red from 80%).
- **Tasks**: the main conversation's checklist, with the tool calls made under the item in progress. A finished item folds to a count.
- **Subagents**: one card per subagent of the latest prompt, plus any still running: its type, elapsed time, tokens, the steps it has taken and, if it keeps one, its checklist. A finished card folds to one line.
- **Shells**: every shell the session spawns, as subagents are: a Bash command the main conversation or a subagent runs in the background, or moves there (Ctrl+B, a timeout). Each gets a small terminal, the command pinned on top and the latest lines of its output scrolling under it, until it exits with its code. Commands run in the foreground are left to the transcript. Output is read from the log Claude Code writes for the command, with colours and anything that looks like a secret removed. Enter on a shell opens it whole: every line of the command, its last 40 lines of output, and every shell of the session.
- **Usage**, at the foot: the account's 5-hour and 7-day limits on one line, how much of each is used and when it resets (↻; only when signed in with a Claude subscription).

## Requirements

- Claude Code **2.1.302 or later**: Agent Hub is a hooks module ("mod") and needs a build that runs function-hook plugins. Check yours with `claude --version`.
- A terminal session. The pane docks beside the transcript in fullscreen from 110 columns and sits above the prompt otherwise.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-hub --marketplace quang2512/agent-hub
```

Answer `y` to add the marketplace, then pick a scope (user scope is the first choice).

From a shell:

```
claude plugin install agent-hub --marketplace quang2512/agent-hub
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `quang2512/agent-hub`, then **Add plugin**.

## Use

The pane opens by itself when a session starts and the terminal is wide enough; `/agent-hub` opens it and gives it the keyboard at any width.

| Key | Where | Does |
| --- | --- | --- |
| ↑ ↓ / Tab | list | move between cards |
| Enter | list | open a subagent's detail: every step and its status, or a shell's: its whole command and output |
| `e` | list | compact / expanded cards |
| `a` | list | all subagents of the session / only the latest prompt's |
| `m` | list | show the main conversation |
| `b` | detail | back to the list |
| `v` | detail | view the subagent's transcript |
| `s` `s` | detail | stop the subagent, or a running shell (press twice within 3 s) |
| Message box | detail | send the subagent a message |

A card warns when a subagent may be stuck: no step for two minutes, the same call repeated, or several errors in a row.

### Checklists for subagents

Subagents have no checklist tool of their own, so Agent Hub registers one, `mcp__agent-hub__checklist`. A subagent that calls it shows its checklist inside its card, with its calls under the item in progress. Ask for it in the prompt you give the subagent, for example: *"Keep a checklist with the checklist tool."*

### Remote control from a phone

Works when you sign in with an API key, where Claude Code's own Remote Control is not available. `/agent-hub-remote` (or ask Claude to use the `mcp__agent-hub__remote` tool) starts a small local server and a [localhost.run](https://localhost.run) tunnel over `ssh`, then shows a link and its QR code in the pane's **Remote** group. Scan the code with the phone's camera, or open the link, and the page shows the pane's groups at once, with no reminder or password page in front: a box whose prompts go to the session as if typed at the terminal, and the conversation to review. Run `/agent-hub-remote` again, or press **stop remote**, to close it.

- Needs `node` and `ssh` on the PATH (macOS has `ssh`); no account, nothing to install.
- The QR code is drawn with half blocks, light on dark whatever the theme; **hide QR** folds it away, and a pane too narrow for it says so instead. A terminal with extra line spacing breaks the code up: open the link instead.
- If the page cannot reach the session for over a minute (the remote stopped, the tunnel dropped, or the session ended), it turns into an Oops page that says to run `/agent-hub-remote` again and open the new link, and stops asking the old address. A phone that was asleep checks first, so waking it does not show Oops by mistake.
- The tunnel's address is new at each start, and localhost.run's free tier may change it while it runs: the pane then shows the new link.
- The link carries a secret token, kept across sessions. Anyone with the link can prompt the session, so keep it to yourself.
- Type `/` for the session's commands and `@` for the project's files (as git lists them); a pick fills the box. A command runs as if typed at the terminal and its output is the answer; one that draws a picker there (`/model`, `/resume`, `/config`…) says so instead. The files a prompt mentions with `@` go to the model beside it, as Claude Code does for a typed prompt (text files inside the project, 100 kB each).
- The title stays at the top with one line that sums the pane's groups up (context, tasks, agents, shells; lit while something runs). Tap it to open the groups under it, scrolling on their own in at most half the screen, and again to fold them; the phone keeps your choice.
- Under them runs the conversation: the session's latest 30 turns, each prompt (typed at the terminal or on the phone) with the assistant's text under it, tool calls left out. The turn running shows Claude Code's spinner under what it has written so far; a prompt you sent waits at the foot until the session takes it. Answers are formatted as Markdown (headings, lists, code, tables, links; no images) and take the room they need, the page scrolling; it stays at the foot while you are there. The renderer loads from cdnjs; without it answers show as plain text.
- Permission prompts are answered at the terminal, not on the phone: run in a mode that needs none if you will be away.

## FAQ

**`/agent-hub` says "Unknown command" after installing.** Run `/reload-plugins --force` (without `--force` the reload is only offered), or start a new session. A plugin installed at local scope is enabled only in the project you installed it from.

**The usage line does not show.** Claude Code reports the 5-hour and 7-day windows only when you sign in with a Claude subscription (Pro or Max). With an API key or a gateway there is nothing to show, so the line stays hidden.

**Does it slow Claude down or send data anywhere?** No. It reads the session's own events and draws them; nothing leaves your machine.

**How do I update it?** `claude plugin update agent-hub`, then `/reload-plugins --force`.

## Develop

```
git clone https://github.com/quang2512/agent-hub
claude --plugin-dir ./agent-hub        # load it for one session, reloading on save
claude plugin validate ./agent-hub     # what the engine sees and would refuse
claude plugin test ./agent-hub         # the hooks/*.test.ts(x) suites
```

Once Claude Code has loaded the plugin it writes the API types to `.claude-plugin/types/`, and `npx tsc -p ./agent-hub` type-checks it.

Layout:

- `hooks/register.tsx`: the hooks and the pane
- `hooks/roster.ts`, `steps.ts`, `plan.ts`: subagent roster, step log, checklists and tokens
- `hooks/card.ts`, `layout.ts`: the hand-laid cards
- `types/index.d.ts`: the state the pane keeps

## License

MIT
