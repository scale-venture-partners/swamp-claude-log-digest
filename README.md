# @scale-venture-partners/claude-log-digest

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
swamp extension pull @scale-venture-partners/claude-log-digest
```

## Configure

Store your Anthropic API key in a vault:

```bash
swamp vault create local_encryption secrets
printf '%s' "$ANTHROPIC_API_KEY" | swamp vault put secrets ANTHROPIC_API_KEY
```

Create a model instance and set its global arguments
(`swamp model create @scale-venture-partners/claude-log-digest claude-log-digest`, then
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
| `skillsRepoPath` | no | `skills` | path, relative to the target repo root, that skills are committed into — see [Plugin-based skills repos](#plugin-based-skills-repos) |
| `baseBranch` | no | `main` | branch the PR is based on |
| `branchPrefix` | no | `claude-digest/skills` | new branch name prefix |
| `committerName` / `committerEmail` | no | `claude-log-digest` / `claude-log-digest@users.noreply.github.com` | commit author |

## Example

Inside an existing swamp repo (`swamp repo init` if you don't have one yet):

```bash
# 1. Install the extension
swamp extension pull @scale-venture-partners/claude-log-digest

# 2. Store your Anthropic API key in a vault
swamp vault create local_encryption secrets
printf '%s' "$ANTHROPIC_API_KEY" | swamp vault put secrets ANTHROPIC_API_KEY

# 3. Create a model instance with your paths
swamp model create @scale-venture-partners/claude-log-digest claude-log-digest \
  --global-arg apiKey='${{ vault.get(secrets, ANTHROPIC_API_KEY) }}' \
  --global-arg skillsDir=/path/to/your-skills-repo/skills \
  --global-arg skillsOutDir=/path/to/this-swamp-repo/.swamp/work/proposed-skills \
  --global-arg digestOut=/path/to/this-swamp-repo/.swamp/work/digest.md \
  --global-arg targetRepoPath=/path/to/your-skills-repo \
  --global-arg targetRepoSlug=your-org/your-skills-repo

# 4. Gather the last 7 days of transcripts (free — no LLM calls) and inspect them
swamp model method run claude-log-digest gather
swamp data get claude-log-digest manifest --json

# 5. Summarize the work and distill proposed skills with Claude
swamp model method run claude-log-digest analyze
swamp data get claude-log-digest digest --json      # the update + proposed skills
cat /path/to/this-swamp-repo/.swamp/work/digest.md  # same thing, human-readable

# 6. Open a PR against your skills repo with whatever was proposed
swamp model method run claude-log-digest publish
```

`publish` exits cleanly with no PR if nothing was staged, or if the staged
skills produce no diff against `baseBranch`. Skip step 6 (and
`targetRepoPath`/`targetRepoSlug`) if you just want the digest, not a PR.

To automate the full pipeline, wire `gather -> analyze -> publish` into a
swamp workflow.

## Plugin-based skills repos

Some skills repos aren't flat — they group skills under
[Claude Code plugins](https://docs.claude.com/en/docs/claude-code/plugins),
e.g.:

```
your-skills-repo/
  plugins/
    your-plugin/
      .claude-plugin/plugin.json
      skills/
        some-skill/SKILL.md
```

Point both `skillsDir` (dedupe scanning) and `skillsRepoPath` (where
`publish` commits new skills) at the plugin's `skills/` directory:

```bash
swamp model edit claude-log-digest
```

```yaml
globalArguments:
  skillsDir: /path/to/your-skills-repo/plugins/your-plugin/skills
  skillsRepoPath: plugins/your-plugin/skills
```

A new skill is picked up by the plugin as soon as its `SKILL.md` lands under
that directory — no `plugin.json` edit needed, since plugins discover skills
by directory convention rather than an explicit list.

## Requirements

- `git` and [`gh`](https://cli.github.com/) on `PATH`; `gh` authenticated
  with push/PR access to the target repo (only needed for `publish`).
- An Anthropic API key.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
