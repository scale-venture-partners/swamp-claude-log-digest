# @wdm0006/claude-log-digest

A [swamp](https://github.com/swamp-club/swamp) extension that reads your
recent Claude Code session transcripts, summarizes what you worked on, and
distills reusable agent skills from the work — optionally opened as a pull
request against a skills repo.

## What it does

1. **`gather`** — reads `*.jsonl` transcripts under `~/.claude/projects/`
   from the last N days and condenses each project to its user/assistant
   turns, capped per project. No LLM calls; cheap to run and inspect before
   paying for `analyze`.
2. **`analyze`** — map-reduces the manifest with Claude:
   - one summary per project,
   - an overall digest (a status-update-style writeup),
   - 2-5 proposed skills, each written as a `SKILL.md` draft into
     `skillsOutDir` (existing skills in `skillsDir` are passed in so it
     won't propose duplicates).
3. **`publish`** — opens a PR against `targetRepoPath`/`targetRepoSlug` with
   the staged skills, via a throwaway git worktree (your working checkout is
   never touched, and it's removed when the run finishes).

## Install

```bash
swamp extension pull @wdm0006/claude-log-digest
```

## Configure

Store your Anthropic API key in a vault:

```bash
swamp vault create local_encryption secrets
printf '%s' "$ANTHROPIC_API_KEY" | swamp vault put secrets ANTHROPIC_API_KEY
```

Create a model instance and set its global arguments
(`swamp model create @wdm0006/claude-log-digest claude-log-digest`, then
`swamp model edit claude-log-digest`):

| Arg | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | `${{ vault.get(secrets, ANTHROPIC_API_KEY) }}` |
| `model` | no | `claude-sonnet-5` | pin to whatever's current — model IDs retire over time |
| `maxTokens` | no | `4096` | headroom for summaries and skill bodies |
| `days` | no | `7` | lookback window for transcripts |
| `skillsDir` | no | `""` | existing skills dir, scanned to avoid duplicate proposals |
| `skillsOutDir` | no | `""` | staging dir for proposed `SKILL.md` files (cleared each `analyze` run); `publish` reads from here |
| `digestOut` | no | `""` | markdown file path; used as the PR body by `publish` if present |
| `maxProjects` / `maxCharsPerProject` / `maxSkills` | no | `25` / `48000` / `5` | corpus and output caps |
| `targetRepoPath` | to publish | `""` | local checkout of the repo to PR into |
| `targetRepoSlug` | to publish | `""` | `owner/repo`, passed to `gh pr create --repo` |
| `baseBranch` | no | `main` | branch the PR is based on |
| `branchPrefix` | no | `claude-digest/skills` | new branch name prefix |
| `committerName` / `committerEmail` | no | `claude-log-digest` / `claude-log-digest@users.noreply.github.com` | commit author |

## Run it

```bash
swamp model method run claude-log-digest gather    # free — inspect the manifest first
swamp model method run claude-log-digest analyze   # ~(projects + 2 + skills) Claude calls
swamp model method run claude-log-digest publish   # opens the PR
```

`publish` exits cleanly with no PR if nothing was staged, or if the staged
skills produce no diff against `baseBranch`.

To automate the full pipeline, wire `gather -> analyze -> publish` into a
swamp workflow.

## Requirements

- `git` and [`gh`](https://cli.github.com/) on `PATH`; `gh` authenticated
  with push/PR access to the target repo (only needed for `publish`).
- An Anthropic API key.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
