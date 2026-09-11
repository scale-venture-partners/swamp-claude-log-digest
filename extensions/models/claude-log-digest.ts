/**
 * Swamp extension: claude-log-digest.
 *
 * Reads recent Claude Code session transcripts (the `*.jsonl` files under
 * `~/.claude/projects/`), condenses them per project, and uses Anthropic's
 * Messages API to summarize the work and propose reusable agent skills.
 *
 * Three methods:
 *  - `gather`  — read + condense recent transcripts -> one `manifest` resource.
 *  - `analyze` — map-reduce the manifest with Claude -> `digest` resource,
 *                per-project `summary` resources, proposed `skill` resources,
 *                and SKILL.md files written into `skillsOutDir`.
 *  - `publish` — open a PR against a target repo with the staged skills, via
 *                a throwaway git worktree.
 *
 * @module
 */
// swamp's bundler inlines npm deps by scanning for inline "npm:" specifiers
// at push time — this can't be moved to deno.json's import map.
// deno-lint-ignore no-import-prefix
import { z } from "npm:zod@4";

/** Global arguments accepted by every method on this model. */
export const GlobalArgsSchema = z.object({
  apiKey: z.string().describe("Anthropic API key").meta({ sensitive: true }),
  model: z.string().default("claude-sonnet-5").describe(
    "Claude model ID for analysis. Pin this explicitly — model IDs retire " +
      "over time, so there's no default that stays correct forever.",
  ),
  maxTokens: z.number().int().positive().default(4096).describe(
    "Max tokens per Claude response",
  ),
  days: z.number().int().positive().default(7).describe(
    "How many days back to include transcripts",
  ),
  projectsDir: z.string().default("").describe(
    "Claude projects dir; defaults to $HOME/.claude/projects",
  ),
  includeProjects: z.string().default("").describe(
    "Comma-separated glob patterns (`*` matches anything). When set, only " +
      "projects whose directory name or label matches one of them are " +
      "gathered, e.g. '*-Documents-GitHub-*'. Empty means every project.",
  ),
  excludeProjects: z.string().default("").describe(
    "Comma-separated glob patterns (`*` matches anything). Projects whose " +
      "directory name or label matches one of them are skipped, e.g. " +
      "'-Users-me,*scratch*'. Applied after includeProjects.",
  ),
  skillsDir: z.string().default("").describe(
    "Existing skills dir, scanned to avoid proposing duplicates",
  ),
  skillsOutDir: z.string().default("").describe(
    "Directory to write proposed <name>/SKILL.md files into; also the " +
      "input `publish` stages from",
  ),
  digestOut: z.string().default("").describe(
    "Optional file path to write the concise update markdown; used as the " +
      "PR body by `publish` if present",
  ),
  maxCharsPerProject: z.number().int().positive().default(48000).describe(
    "Per-project character cap on condensed transcript text",
  ),
  maxProjects: z.number().int().positive().default(25).describe(
    "Max number of active projects to include",
  ),
  maxSkills: z.number().int().nonnegative().default(5).describe(
    "Max number of skills to propose",
  ),
  targetRepoPath: z.string().default("").describe(
    "Local checkout of the repo to open a skills PR against (required by `publish`)",
  ),
  targetRepoSlug: z.string().default("").describe(
    "'owner/repo' slug passed to `gh pr create --repo` (required by `publish`)",
  ),
  skillsRepoPath: z.string().default("skills").describe(
    "Path, relative to the target repo root, that proposed skills are " +
      "committed into. Use the default 'skills' for a flat skills repo, or " +
      "something like 'plugins/<plugin-name>/skills' for a repo that " +
      "organizes skills into Claude Code plugins.",
  ),
  baseBranch: z.string().default("main").describe(
    "Branch the new branch and PR are based on",
  ),
  branchPrefix: z.string().default("claude-digest/skills").describe(
    "Prefix for the branch `publish` creates each run",
  ),
  committerName: z.string().default("claude-log-digest").describe(
    "Git commit author name used for the skills commit",
  ),
  committerEmail: z.string().default(
    "claude-log-digest@users.noreply.github.com",
  ).describe("Git commit author email used for the skills commit"),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProjectSchema = z.object({
  name: z.string(),
  label: z.string(),
  sessions: z.number(),
  chars: z.number(),
  content: z.string(),
});

const ManifestSchema = z.object({
  generatedAt: z.string(),
  days: z.number(),
  projectCount: z.number(),
  projects: z.array(ProjectSchema),
});

const SummarySchema = z.object({
  project: z.string(),
  label: z.string(),
  summary: z.string(),
});

const ProposedSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  rationale: z.string(),
});

const DigestSchema = z.object({
  generatedAt: z.string(),
  days: z.number(),
  projectCount: z.number(),
  update: z.string(),
  projectSummaries: z.array(z.object({
    project: z.string(),
    summary: z.string(),
  })),
  proposedSkills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
  })),
});

const SkillResourceSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string(),
});

const PublishResultSchema = z.object({
  published: z.boolean(),
  url: z.string().optional(),
  branch: z.string().optional(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract readable text from one transcript JSONL line (user or assistant). */
export function lineText(obj: unknown): { role: string; text: string } | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const role = o.type;
  if (role !== "user" && role !== "assistant") return null;
  const msg = o.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block && typeof block === "object" &&
        (block as Record<string, unknown>).type === "text"
      ) {
        text += String((block as Record<string, unknown>).text ?? "");
      }
    }
  }
  text = text.trim();
  // Drop tool-result echoes and empty turns.
  if (!text || text.startsWith("[{") || text.startsWith('{"')) return null;
  return { role: role as string, text };
}

/** Turn a project dir slug into a friendlier label. */
export function labelFor(slug: string): string {
  // Claude Code slugs its project dirs from the absolute path, e.g.
  // "-Users-will-Documents-GitHub-some-repo" -> "some-repo".
  const m = slug.match(/Documents-GitHub-?(.*)$/);
  if (m) return m[1] ? m[1] : "GitHub (root)";
  return slug.replace(/^-/, "").replace(/-/g, "/");
}

/** Split a comma-separated pattern list, dropping blanks. */
export function parsePatterns(csv: string): string[] {
  return csv.split(",").map((p) => p.trim()).filter(Boolean);
}

/** Whether any glob pattern (`*` = any run of characters) matches any value. */
export function matchesAny(patterns: string[], values: string[]): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(
      "^" +
        pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    return values.some((v) => re.test(v));
  });
}

/** Condense one project's recent transcripts into a single capped string. */
export async function condenseProject(
  dir: string,
  cutoffMs: number,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ sessions: number; chars: number; content: string }> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
    const full = `${dir}/${entry.name}`;
    try {
      const st = await Deno.stat(full);
      if (st.mtime && st.mtime.getTime() >= cutoffMs) files.push(full);
    } catch { /* ignore */ }
  }
  const parts: string[] = [];
  for (const file of files) {
    if (signal?.aborted) break;
    let raw = "";
    try {
      raw = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const t = lineText(obj);
      if (!t) continue;
      // Keep user turns in full (they capture intent); trim assistant noise.
      const snippet = t.role === "user" ? t.text : t.text.slice(0, 280);
      turns.push(`${t.role === "user" ? "USER" : "ASSISTANT"}: ${snippet}`);
    }
    if (turns.length === 0) continue;
    parts.push(`--- session ---\n${turns.join("\n")}`);
  }
  let content = parts.join("\n\n");
  if (content.length > maxChars) {
    // Keep the most recent material (end of the concatenation).
    content = "…[earlier transcripts truncated]…\n" +
      content.slice(content.length - maxChars);
  }
  return { sessions: files.length, chars: content.length, content };
}

/** Call the Anthropic Messages API and return the concatenated text blocks. */
export async function callClaude(
  args: GlobalArgs,
  prompt: string,
  system: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  }
  const result = await res.json();
  return (result.content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

/** Read existing skill name+description pairs for dedupe context. */
export async function readExistingSkills(
  skillsDir: string,
): Promise<Array<{ name: string; description: string }>> {
  if (!skillsDir) return [];
  const out: Array<{ name: string; description: string }> = [];
  try {
    for await (const entry of Deno.readDir(skillsDir)) {
      if (!entry.isDirectory) continue;
      let raw = "";
      try {
        raw = await Deno.readTextFile(`${skillsDir}/${entry.name}/SKILL.md`);
      } catch {
        continue;
      }
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      let name = entry.name;
      let description = "";
      if (fm) {
        const nameM = fm[1].match(/^name:\s*(.+)$/m);
        const descM = fm[1].match(/^description:\s*(.+)$/m);
        if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, "");
        if (descM) {
          description = descM[1].trim().replace(/^["']|["']$/g, "").slice(
            0,
            200,
          );
        }
      }
      out.push({ name, description });
    }
  } catch { /* skillsDir missing */ }
  return out;
}

/** Best-effort extraction of a JSON array from a model response. */
export function parseJsonArray(text: string): unknown[] {
  let t = text.trim();
  try {
    const direct = JSON.parse(t);
    if (Array.isArray(direct)) return direct;
  } catch { /* fall through to extraction */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Turn a proposed skill name into a filesystem-safe, kebab-case slug. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 64) || "skill";
}

/**
 * Drop distill candidates that duplicate an existing skill, then cap the rest.
 * A slug collision must never reach `publish`: it copies staged directories
 * over the target repo's, so a re-proposed name would overwrite that skill.
 */
export function filterCandidates(
  candidates: Array<Record<string, unknown>>,
  existing: Array<{ name: string }>,
  maxSkills: number,
): {
  kept: Array<Record<string, unknown>>;
  dropped: Array<{ name: string; reason: string }>;
} {
  const existingSlugs = new Set(existing.map((s) => slugify(s.name)));
  const kept: Array<Record<string, unknown>> = [];
  const dropped: Array<{ name: string; reason: string }> = [];
  for (const c of candidates) {
    const name = String(c.name);
    const overlapsRaw = typeof c.overlaps === "string" ? c.overlaps.trim() : "";
    const overlaps = /^(none|null|n\/a|-)$/i.test(overlapsRaw)
      ? ""
      : overlapsRaw;
    if (existingSlugs.has(slugify(name))) {
      dropped.push({ name, reason: "name collides with an existing skill" });
    } else if (overlaps) {
      dropped.push({ name, reason: `overlaps existing skill "${overlaps}"` });
    } else {
      kept.push(c);
    }
  }
  return { kept: kept.slice(0, maxSkills), dropped };
}

/** Whether a path exists (file or directory). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively copy a directory (Deno has no built-in for this). */
export async function copyDirRecursive(
  src: string,
  dest: string,
): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = `${src}/${entry.name}`;
    const d = `${dest}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile) {
      await Deno.copyFile(s, d);
    }
  }
}

// Git sets these for hook processes (pointing at the repo running the hook)
// and Deno.Command inherits them. If `run` is itself invoked from inside
// another git hook, they leak into these subprocesses and misdirect them —
// e.g. a relative GIT_INDEX_FILE breaks `git worktree add` entirely, and
// inherited GIT_AUTHOR_* silently overrides our explicit `-c user.*` commit
// identity. Clear them so every git/gh call here resolves purely from `cwd`.
const GIT_ENV_VARS_TO_CLEAR = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
];

/** Run a subprocess and capture its output. */
export async function run(
  cmd: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  for (const key of GIT_ENV_VARS_TO_CLEAR) Deno.env.delete(key);
  const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Swamp model: summarize recent Claude Code work and distill reusable skills. */
export const model = {
  type: "@scale-venture-partners/claude-log-digest",
  version: "2026.09.11.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    manifest: {
      description: "Condensed per-project transcript corpus for the window",
      schema: ManifestSchema,
      lifetime: "7d",
      garbageCollection: 5,
    },
    digest: {
      description: "Concise work update plus proposed-skill metadata",
      schema: DigestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Per-project work summary (factory: one per project)",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    skill: {
      description: "A proposed skill with full SKILL.md body (factory)",
      schema: SkillResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    publishResult: {
      description: "Outcome of the most recent `publish` run",
      schema: PublishResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    gather: {
      description:
        "Read and condense recent Claude transcripts into a manifest resource",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger: { info: (m: string, p?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const g = context.globalArgs;
        const home = Deno.env.get("HOME") ?? "";
        const projectsDir = g.projectsDir || `${home}/.claude/projects`;
        const cutoffMs = Date.now() - g.days * 24 * 60 * 60 * 1000;
        const include = parsePatterns(g.includeProjects);
        const exclude = parsePatterns(g.excludeProjects);

        const projects: Array<z.infer<typeof ProjectSchema>> = [];
        let filtered = 0;
        for await (const entry of Deno.readDir(projectsDir)) {
          if (!entry.isDirectory) continue;
          const label = labelFor(entry.name);
          const keys = [entry.name, label];
          if (
            (include.length > 0 && !matchesAny(include, keys)) ||
            matchesAny(exclude, keys)
          ) {
            filtered++;
            continue;
          }
          const dir = `${projectsDir}/${entry.name}`;
          const { sessions, chars, content } = await condenseProject(
            dir,
            cutoffMs,
            g.maxCharsPerProject,
            context.signal,
          );
          if (sessions === 0 || chars === 0) continue;
          projects.push({ name: entry.name, label, sessions, chars, content });
        }
        // Most active first; cap count.
        projects.sort((a, b) => b.chars - a.chars);
        const capped = projects.slice(0, g.maxProjects);
        context.logger.info(
          "Condensed {n} active projects ({total} total chars); " +
            "{filtered} skipped by include/exclude patterns",
          {
            n: capped.length,
            total: capped.reduce((s, p) => s + p.chars, 0),
            filtered,
          },
        );

        const handle = await context.writeResource("manifest", "manifest", {
          generatedAt: new Date().toISOString(),
          days: g.days,
          projectCount: capped.length,
          projects: capped,
        });
        return { dataHandles: [handle] };
      },
    },

    analyze: {
      description:
        "Map-reduce the manifest with Claude: write a digest and propose skills",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger: { info: (m: string, p?: unknown) => void };
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const g = context.globalArgs;
        const raw = await context.readResource("manifest");
        if (!raw) {
          throw new Error("No manifest found — run the `gather` method first");
        }
        const manifest = ManifestSchema.parse(raw);
        if (manifest.projects.length === 0) {
          throw new Error("Manifest has no projects to analyze");
        }

        // ---- MAP: per-project summaries ----
        const summaries: Array<z.infer<typeof SummarySchema>> = [];
        for (const p of manifest.projects) {
          if (context.signal?.aborted) break;
          context.logger.info("Summarizing project {label}", {
            label: p.label,
          });
          const summary = await callClaude(
            g,
            `Project: ${p.label}\n\nBelow are condensed excerpts from the ` +
              `last ${manifest.days} days of Claude Code sessions in this ` +
              `project (USER turns are the human's requests; ASSISTANT turns ` +
              `are truncated).\n\n${p.content}\n\n` +
              `Summarize what was actually worked on in 2-5 terse bullet ` +
              `points. Focus on concrete tasks, features, fixes, and ` +
              `decisions — not pleasantries. Start each bullet with "- ".`,
            "You are a precise engineering-activity summarizer. Output only " +
              "bullet points, no preamble.",
            context.signal,
          );
          summaries.push({
            project: p.name,
            label: p.label,
            summary: summary.trim(),
          });
        }

        // ---- REDUCE: overall concise update ----
        const combined = summaries.map((s) => `## ${s.label}\n${s.summary}`)
          .join(
            "\n\n",
          );
        const update = (await callClaude(
          g,
          `Here are per-project summaries of the last ${manifest.days} days ` +
            `of engineering work across ${summaries.length} projects:\n\n` +
            `${combined}\n\n` +
            `Write a concise status update (the kind you'd post to a team ` +
            `channel). Lead with a 1-2 sentence overview, then group the most ` +
            `important threads under short headers. Keep it tight — under ` +
            `300 words. Markdown.`,
          "You are writing a crisp weekly engineering update. No filler.",
          context.signal,
        )).trim();

        // ---- DISTILL: a JSON call picks WHICH skills, then one plain-markdown
        // call per skill writes its body. Markdown embedded in JSON corrupts parsing.
        const existing = await readExistingSkills(g.skillsDir);
        const existingList = existing.length
          ? existing.map((s) => `- ${s.name}: ${s.description}`).join("\n")
          : "(none provided)";
        const distillRaw = await callClaude(
          g,
          `Across the last ${manifest.days} days, here is the work done:\n\n` +
            `${combined}\n\n` +
            `These reusable agent "skills" ALREADY EXIST:\n${existingList}\n\n` +
            `Propose 2-${g.maxSkills} NEW reusable skills distilled from ` +
            `recurring or generalizable procedures in the work above — the kind ` +
            `that would save time in future sessions. Skip a candidate if it is ` +
            `too one-off to reuse. Compare every candidate against the existing ` +
            `skills by SCOPE, not name: if an existing skill already covers the ` +
            `same procedure, or the candidate is a narrower special case of one, ` +
            `put that existing skill's name in "overlaps" instead of leaving it ` +
            `empty.\n\n` +
            `Return ONLY a compact JSON array (no prose, no markdown bodies). ` +
            `Each element exactly:\n` +
            `{"name": "kebab-case-name", "description": "one sentence: what it ` +
            `does and when to use it", "rationale": "why it is worth a skill", ` +
            `"overlaps": "name of the existing skill it duplicates, or \\"\\""}`,
          "You distill reusable agent skills. Output only a compact JSON array " +
            "of {name, description, rationale, overlaps} — no skill bodies, " +
            "no prose.",
          context.signal,
        );
        const parsedCandidates = parseJsonArray(distillRaw)
          .map((x) => x as Record<string, unknown>)
          .filter((x) =>
            x && typeof x.name === "string" && typeof x.description === "string"
          );
        const { kept: candidates, dropped } = filterCandidates(
          parsedCandidates,
          existing,
          g.maxSkills,
        );
        for (const d of dropped) {
          context.logger.info("Dropped candidate {name}: {reason}", d);
        }
        context.logger.info(
          "Distill returned {raw} chars, parsed {n} candidates, kept {kept}",
          {
            raw: distillRaw.length,
            n: parsedCandidates.length,
            kept: candidates.length,
          },
        );

        const proposed: Array<Record<string, unknown>> = [];
        for (const c of candidates) {
          if (context.signal?.aborted) break;
          const body = (await callClaude(
            g,
            `Write the body of a reusable agent skill named "${c.name}".\n` +
              `Purpose: ${c.description}\n` +
              `Context (recent work it was distilled from):\n${combined}\n\n` +
              `Output ONLY the markdown body that goes AFTER the YAML ` +
              `frontmatter — start with "# ${c.name}". Give concrete, ` +
              `ordered steps an agent should follow, generalized beyond this ` +
              `week's specifics. No frontmatter, no code fences around the ` +
              `whole thing.`,
            "You write clear, actionable agent skill instructions in markdown.",
            context.signal,
          )).trim();
          proposed.push({ ...c, body });
        }

        // ---- WRITE: SKILL.md files + skill resources ----
        // Clear stale drafts from prior runs so a `publish` reflects only this run.
        if (g.skillsOutDir) {
          await Deno.remove(g.skillsOutDir, { recursive: true }).catch(
            () => {},
          );
          await Deno.mkdir(g.skillsOutDir, { recursive: true }).catch(() => {});
        }
        const handles: Array<{ name: string }> = [];
        const proposedMeta: Array<z.infer<typeof ProposedSkillSchema>> = [];
        for (const p of proposed) {
          const name = slugify(String(p.name));
          const description = String(p.description ?? "").trim();
          const body = String(p.body ?? "").trim();
          const rationale = String(p.rationale ?? "").trim();
          const relPath = `${name}/SKILL.md`;
          const fileBody = `---\nname: ${name}\ndescription: ${
            JSON.stringify(description)
          }\n---\n\n${body}\n`;
          if (g.skillsOutDir) {
            const dir = `${g.skillsOutDir}/${name}`;
            await Deno.mkdir(dir, { recursive: true });
            await Deno.writeTextFile(`${dir}/SKILL.md`, fileBody);
          }
          proposedMeta.push({ name, description, path: relPath, rationale });
          handles.push(
            await context.writeResource("skill", `skill-${name}`, {
              name,
              description,
              body: fileBody,
              path: relPath,
            }),
          );
        }
        context.logger.info("Proposed {n} skills", { n: proposedMeta.length });

        for (const s of summaries) {
          handles.push(
            await context.writeResource("summary", `summary-${s.project}`, s),
          );
        }

        if (g.digestOut) {
          const md = `## Claude work digest\n\n${update}\n\n` +
            (proposedMeta.length
              ? `## Proposed skills\n\n` +
                proposedMeta.map((p) =>
                  `- **${p.name}** — ${p.description}\n  - _why:_ ${p.rationale}`
                ).join("\n") + "\n"
              : "## Proposed skills\n\n_None this run._\n");
          await Deno.mkdir(g.digestOut.replace(/\/[^/]*$/, ""), {
            recursive: true,
          })
            .catch(() => {});
          await Deno.writeTextFile(g.digestOut, md);
        }

        handles.push(
          await context.writeResource("digest", "digest", {
            generatedAt: new Date().toISOString(),
            days: manifest.days,
            projectCount: summaries.length,
            update,
            projectSummaries: summaries.map((s) => ({
              project: s.label,
              summary: s.summary,
            })),
            proposedSkills: proposedMeta.map((p) => ({
              name: p.name,
              description: p.description,
              path: p.path,
            })),
          }),
        );

        return { dataHandles: handles };
      },
    },

    publish: {
      description:
        "Open a PR against targetRepoPath/targetRepoSlug with the staged skills",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (m: string, p?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const g = context.globalArgs;
        if (!g.skillsOutDir) {
          throw new Error("skillsOutDir is required to publish");
        }
        if (!g.targetRepoPath) {
          throw new Error("targetRepoPath is required to publish");
        }
        if (!g.targetRepoSlug) {
          throw new Error(
            'targetRepoSlug is required to publish (e.g. "owner/repo")',
          );
        }

        const writeNoOp = (reason: string) =>
          context.writeResource("publishResult", "publishResult", {
            published: false,
            reason,
          });

        let staged: Deno.DirEntry[] = [];
        try {
          staged = await Array.fromAsync(Deno.readDir(g.skillsOutDir));
        } catch { /* skillsOutDir missing */ }
        if (staged.length === 0) {
          context.logger.info(
            "No proposed skills staged — nothing to publish.",
          );
          return { dataHandles: [await writeNoOp("nothing staged")] };
        }

        const branch = `${g.branchPrefix}-${Date.now()}`;
        const worktreeDir = await Deno.makeTempDir({
          prefix: "claude-log-digest-",
        });

        try {
          let res = await run(
            ["git", "fetch", "--quiet", "origin", g.baseBranch],
            g.targetRepoPath,
          );
          if (res.code !== 0) {
            throw new Error(`git fetch failed: ${res.stderr}`);
          }

          res = await run(
            [
              "git",
              "worktree",
              "add",
              "-q",
              "-b",
              branch,
              worktreeDir,
              `origin/${g.baseBranch}`,
            ],
            g.targetRepoPath,
          );
          if (res.code !== 0) {
            throw new Error(`git worktree add failed: ${res.stderr}`);
          }

          const repoRelPath = g.skillsRepoPath.replace(/^\/|\/$/g, "");
          const skillsDest = `${worktreeDir}/${repoRelPath}`;
          await Deno.mkdir(skillsDest, { recursive: true });
          for (const entry of staged) {
            if (!entry.isDirectory) continue;
            await copyDirRecursive(
              `${g.skillsOutDir}/${entry.name}`,
              `${skillsDest}/${entry.name}`,
            );
          }

          await run(["git", "add", repoRelPath], worktreeDir);
          const diff = await run(
            ["git", "diff", "--cached", "--quiet"],
            worktreeDir,
          );
          if (diff.code === 0) {
            context.logger.info(
              "No new skill files versus {base} — nothing to publish.",
              { base: g.baseBranch },
            );
            return {
              dataHandles: [await writeNoOp("no diff against base branch")],
            };
          }

          res = await run(
            [
              "git",
              "-c",
              `user.name=${g.committerName}`,
              "-c",
              `user.email=${g.committerEmail}`,
              "commit",
              "-q",
              "-m",
              "Add distilled skills from claude-log-digest",
            ],
            worktreeDir,
          );
          if (res.code !== 0) {
            throw new Error(`git commit failed: ${res.stderr}`);
          }

          res = await run(
            ["git", "push", "-q", "-u", "origin", branch],
            worktreeDir,
          );
          if (res.code !== 0) throw new Error(`git push failed: ${res.stderr}`);

          const hasDigest = g.digestOut && await fileExists(g.digestOut);
          const title = `Distilled skills from claude-log-digest (${
            new Date().toISOString().slice(0, 10)
          })`;
          const prArgs = [
            "gh",
            "pr",
            "create",
            "--repo",
            g.targetRepoSlug,
            "--base",
            g.baseBranch,
            "--head",
            branch,
            "--title",
            title,
            hasDigest ? "--body-file" : "--body",
            hasDigest
              ? g.digestOut
              : "Distilled skills from the claude-log-digest extension.",
          ];
          res = await run(prArgs, worktreeDir);
          if (res.code !== 0) {
            throw new Error(`gh pr create failed: ${res.stderr}`);
          }

          const url = res.stdout;
          context.logger.info("Opened PR: {url}", { url });
          return {
            dataHandles: [
              await context.writeResource("publishResult", "publishResult", {
                published: true,
                url,
                branch,
              }),
            ],
          };
        } finally {
          await run(
            ["git", "worktree", "remove", "--force", worktreeDir],
            g.targetRepoPath,
          ).catch(() => {});
        }
      },
    },
  },
};
