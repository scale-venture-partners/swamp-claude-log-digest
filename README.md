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
     `skillsOutDir`. Existing skills in `skillsDir` are passed in, and a
     candidate is dropped if its name collides with one of them or if Claude
     marks it as overlapping an existing skill's scope.
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
| `includeProjects` | no | `""` | comma-separated globs (`*` wildcard); when set, only projects whose dir name or label matches are gathered |
| `excludeProjects` | no | `""` | comma-separated globs; matching projects are skipped (e.g. `-Users-me` to drop sessions run from your home dir) |
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

## Development

Requires [Deno](https://docs.deno.com/runtime/getting_started/installation/)
(no other toolchain — linting, type-checking, and testing all run on Deno's
built-in tools).

```bash
deno task check      # type-check
deno task fmt:check  # deno fmt --check
deno task lint       # deno lint
deno task test       # deno test (unit + integration, real git, stubbed network)
deno task verify     # all of the above, in order

./scripts/install-hooks.sh  # once per clone: installs the pre-commit hook
```

The pre-commit hook runs `deno task verify` before every commit. Tests use a
real temporary git repository for `publish` (real `git`, a faked `gh`
executable on a throwaway `PATH` entry) and a stubbed `fetch` for Claude API
calls — no network access or real GitHub PRs are involved.

### Trying it from a local checkout

Load the extension into any swamp repo straight from this checkout, no publish
needed — edits here are picked up on the next method run:

```bash
swamp extension source add /path/to/swamp-claude-log-digest
swamp model type describe @scale-venture-partners/claude-log-digest
```

### Publishing

The model lives under `extensions/models/` and the repo carries a `.swamp.yaml`
marker, which is the layout `swamp extension quality` and `swamp extension push`
expect. Before pushing, bump `version` in `manifest.yaml` and confirm the
rubric still passes:

```bash
swamp extension quality manifest.yaml   # local self-check, no network
swamp auth login
swamp extension push manifest.yaml
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
