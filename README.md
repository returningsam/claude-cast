<p align="center">
  <img src="assets/command-icon.png" alt="ClaudeCast Icon" width="128" height="128">
</p>

<h1 align="center">ClaudeCast</h1>

<p align="center">
  <strong>Discover, resume, and automate Claude Code sessions</strong><br>
  Deep full-text search, one-keystroke resume, agentic loops, usage analytics, and quick prompts. Bridges Claude Code's agentic CLI with Raycast's instant-access UI.
</p>

![ClaudeCast Main Menu](metadata/claudecast-10.png)

---

## About this fork

Fork of [qazi0/claude-cast](https://github.com/qazi0/claude-cast) that can report
**subscription usage, not just dollar costs**.

Upstream reported only API list-rate dollar estimates — what the usage would
have cost pay-as-you-go, which is not what a subscription bills. This fork adds
a **Usage Display** preference with two modes:

- **Subscription usage (%)** — default. Live utilization of the rolling 5h / 7d
  windows behind Claude Code's `/usage`, historical stats in tokens, and the 5h
  percentage in the menu bar. Extra-usage credits appear only once actually
  spent, since that is the one figure genuinely charged.
- **API usage ($)** — upstream's behavior. List-rate cost estimates throughout,
  with the limits section hidden.

The modes are not two views of one number: limits are live and account-wide with
no history, costs are historical and per-project with no live equivalent.

---

## Features

### Launch Project
Fast project switching for Claude Code. Browse all your projects with favorites, recents, and session counts.

- Discovers projects from Claude Code history
- Integrates with VS Code recent workspaces
- Launch new session or continue existing
- Open in VS Code or Finder
- Manage favorites

### Deep Search Sessions
Full-text search across every Claude Code conversation on disk.

- Streams JSONL files incrementally so results appear as they are found
- Match snippets show ~15 words of context around the query, with the match bolded
- Debounced search with cancellation when the query changes
- Resume, fork, or delete any matched session in place
- Cleans `<local-command-*>` and short slash-only prompts out of the result list

### Browse Sessions
Find and resume any Claude Code conversation across all projects.

- Filter by project
- Inline conversation preview with the most recent 20 messages and a "Showing last N of M messages" notice for long sessions
- Resume, fork, or delete sessions
- Session metadata: project, turn count, model, and last-modified
- Restores the original permission mode and model on resume

### Agentic Workflows
Curated collection of production-tested prompts with variable substitution.

![Agentic Workflows - Categories](metadata/claudecast-8.png)

**Categories:**
- Planning & Architecture
- Test-Driven Development
- Code Review & Security
- Refactoring
- Debugging
- Documentation
- Advanced Multi-Step Workflows

![Agentic Workflows - More Prompts](metadata/claudecast-9.png)

### Ralph Loop
Autonomous agentic execution that breaks down complex tasks and runs them with fresh context per iteration.

![Ralph Loop](metadata/claudecast-1.png)

**How it works:**
1. Describe your task and requirements
2. Claude creates a plan with atomic, self-contained tasks
3. Each task runs in a fresh Claude session (~176K tokens available)
4. Watch Claude work with full TUI visibility
5. Resume anytime if max iterations reached

**Features:**
- Fresh context per task prevents degradation at high token counts
- Full terminal UI visibility during execution
- Graceful stop with `touch .ralph/stop`
- Resume with `bash .ralph/resume.sh 10`

### Git Actions
Git-aware Claude Code workflows for common tasks.

![Git Actions Menu](metadata/claudecast-7.png)

- Review staged changes
- Generate commit messages
- Explain recent diffs
- Review unstaged changes
- Summarize branch changes

![Git Actions Result](metadata/claudecast-6.png)

### Ask Claude Code
Quick prompt with automatic context capture from VS Code. Select text anywhere, hit the hotkey, and get answers without opening a terminal.

- Auto-detects current project from VS Code
- Captures selected text and clipboard
- Shows git branch context
- Supports all Claude models (Sonnet, Opus, Haiku)
- Continue conversation in terminal

### Transform Selection
One-keystroke code transformations from any app.

![Transform Selection Menu](metadata/claudecast-3.png)

- Explain code
- Explain regex
- Find bugs
- Convert to another language
- Add TypeScript types
- Optimize performance
- Add comments
- Write tests

![Transform Selection Result](metadata/claudecast-5.png)

### Quick Continue
One keystroke to continue your last Claude Code session. No UI - just launches directly.

### Menu Bar Monitor
Real-time Claude Code status in your menu bar.

- Active session indicator
- Title shows how much of the rolling 5-hour limit is used — or today's cost in
  API mode — falling back to today's token count when limits are unavailable
- Every limit window listed with its reset time, colored by headroom
- Today's session and token counts
- Quick access to all commands

Its **Show 5h Limit in Menu Bar** preference replaces upstream's "Show Today's
Cost" and is on by default (upstream's was off).

### Usage Dashboard
Live subscription limits above historical token usage, with an SVG bar chart.
Switches to list-rate cost estimates in API mode.

- Subscription limits section: every rolling window with a usage bar and reset time
- Range tabs adapt the chart granularity: Today/Week (daily bars), Month (weekly), All Time (up to 12 monthly bars)
- Per-range totals, token breakdown (input, output, cache read, cache write)
- Top projects as colored tags; "Usage by Project" and "Top Sessions" tables
- Streaming-chunk dedup so cumulative usage reports are not double-counted
- Extra-usage credits shown only once actually spent — the one real dollar figure

## Installation

### Prerequisites

1. **Claude Code CLI**: Install the Claude Code CLI tool
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Raycast**: Download from [raycast.com](https://raycast.com)

### Install Extension

Building the extension installs it — `ray build` writes the compiled bundle
straight into `~/.config/raycast/extensions/`, so there is no import step and no
dev server left running.

```bash
git clone https://github.com/returningsam/claude-cast
cd claude-cast
npm ci
npm run reinstall
```

Which script to use after an edit:

| Changed | Run |
|---------|-----|
| Anything under `src/` | `npm run build` |
| `package.json` (preferences, commands) | `npm run reinstall` |

`ray build` writes the bundle and manifest but does not tell Raycast to re-read
the manifest, so a new or renamed preference never shows up in the UI — Raycast
keeps serving the schema from the last `ray develop` run. `npm run reinstall`
cycles `ray develop` briefly to re-register, then installs a production build.

Use `npm run dev` for hot-reload while working; stop it before the final build,
since its watcher overwrites the production bundle.

## Setup

### OAuth Token

Two things need a token: the API features (Ask Claude Code, Transform Selection,
Git Actions) which run the CLI inside Raycast's sandbox, and — new in this fork —
the subscription limits lookup.

The limits lookup usually needs no setup. It resolves a token in this order:

1. the **OAuth Token** preference below
2. `CLAUDE_CODE_OAUTH_TOKEN` in the environment
3. the `Claude Code-credentials` login-keychain item Claude Code already writes

Step 3 means it generally works out of the box, though the first lookup may raise
a one-time macOS keychain prompt. Setting the preference skips that. If no token
resolves, the limits section explains why instead of failing silently.

To set the preference explicitly:

1. Generate a long-lived OAuth token:
   ```bash
   claude setup-token
   ```

2. Copy the token and add it to ClaudeCast preferences:
   - Open Raycast → Search "ClaudeCast" → Press `⌘,`
   - Paste the token in the "OAuth Token" field

### Configuration

Open Raycast preferences and configure ClaudeCast:

- **Usage Display**: Subscription usage (%) or API usage ($). Controls the Usage Dashboard and the menu bar together.
- **Default Model**: Choose between Sonnet (balanced), Opus (most capable), or Haiku (fastest)
- **Terminal Application**: Pick from Terminal, iTerm, Warp, kitty, Ghostty, or cmux. Each launcher uses the terminal's native AppleScript or CLI for reliable launches.
- **Open In**: Choose New Window or New Tab. Honored by Terminal, iTerm, kitty, Ghostty, and cmux. Warp always opens a new window.
- **Claude Code Path**: Optionally specify a custom path to the Claude CLI binary
- **Anthropic API Key / OAuth Token**: For API features (Ask Claude Code, Git Actions, Transform Selection, Agentic Workflows). Either preference works. The auth gate also accepts `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` env vars, or existing `claude auth login` credentials.

## Usage

### Keyboard Shortcuts (Suggested)

Set these in Raycast preferences:

| Command | Suggested Shortcut |
|---------|-------------------|
| Ask Claude Code | `⌘⇧C` |
| Quick Continue | `⌘⌥R` |
| Browse Sessions | `⌘⌥S` |
| Launch Project | `⌘⌥L` |
| Git Actions | `⌘⇧G` |
| Agentic Workflows | `⌘⌥P` |
| Transform Selection | `⌘⇧T` |

### Tips

1. **Context Capture**: For best results, select code in VS Code before triggering Ask Claude Code
2. **Project Detection**: Keep VS Code open in your project for automatic project detection
3. **Quick Continue**: Use this when you step away and want to resume your last conversation
4. **Agentic Workflows**: Start with built-in prompts, then create custom ones for your workflows
5. **Git Actions**: Stage your changes first, then use "Write Commit Message" for AI-generated commits

## Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build for production
npm run build

# Lint code
npm run lint

# Fix lint issues
npm run fix-lint

# Run the parser and pricing tests (no network or token needed)
npm test

# Rebuild AND re-register the manifest — needed after editing package.json
npm run reinstall
```

`test/` is new in this fork. It bundles the usage modules with `@raycast/api`
stubbed so they can be exercised outside Raycast, covering both shapes of the
usage API response, unknown future limit windows, malformed payloads, auth
failures, and the model pricing table.

## Project Structure

```
claude-cast/
├── src/
│   ├── ask-claude.tsx            # Quick Prompt command
│   ├── browse-sessions.tsx       # Session Browser
│   ├── deep-search-sessions.tsx  # Full-text Deep Search
│   ├── launch-project.tsx        # Project Launcher
│   ├── quick-continue.tsx        # Quick Continue
│   ├── git-actions.tsx           # Git Actions
│   ├── prompt-library.tsx        # Agentic Workflows
│   ├── transform-selection.tsx   # Transform Selection
│   ├── menu-bar-monitor.tsx      # Menu Bar Monitor
│   ├── usage-dashboard.tsx       # Usage Dashboard
│   └── lib/
│       ├── claude-cli.ts         # Claude CLI integration and auth gate
│       ├── session-parser.ts     # JSONL session parsing and streaming usage scanner
│       ├── project-discovery.ts  # Project detection
│       ├── context-capture.ts    # VS Code context capture
│       ├── terminal.ts           # Terminal launch utilities (Terminal, iTerm, Warp, kitty, Ghostty, cmux)
│       ├── svg-chart.ts          # SVG bar chart for the Usage Dashboard
│       ├── prompts.ts            # Built-in prompts
│       ├── usage-stats.ts        # Token/cost statistics from local session files
│       ├── subscription-usage.ts # Live 5h/7d limit lookup (this fork)
│       ├── pricing.ts            # API list-rate table, used only in API mode
│       └── usage-mode.ts         # Subscription vs API display mode (this fork)
├── scripts/
│   └── reinstall.mjs           # Re-register the manifest, then build
├── test/
│   ├── parser.test.mjs         # Usage parser and pricing tests
│   └── stub-raycast.js         # @raycast/api stub so modules run under node
├── assets/
│   └── command-icon.png        # Extension icon
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Credits

Built with [Raycast](https://raycast.com) and [Claude Code](https://anthropic.com/claude-code).
