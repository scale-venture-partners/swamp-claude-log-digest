import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  callClaude,
  condenseProject,
  copyDirRecursive,
  fileExists,
  type GlobalArgs,
  GlobalArgsSchema,
  labelFor,
  lineText,
  model,
  parseJsonArray,
  readExistingSkills,
  run,
  slugify,
} from "../models/claude-log-digest.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeArgs(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return GlobalArgsSchema.parse({ apiKey: "test-key", ...overrides });
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function makeContext(opts: {
  globalArgs?: GlobalArgs;
  resources?: Record<string, Record<string, unknown> | null>;
} = {}) {
  const written: Written[] = [];
  const context = {
    globalArgs: opts.globalArgs ?? makeArgs(),
    signal: undefined as AbortSignal | undefined,
    logger: { info: (_m: string, _p?: unknown) => {} },
    readResource: (name: string) =>
      Promise.resolve(opts.resources?.[name] ?? null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

function userLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** Replace globalThis.fetch for the duration of a test; returns recorded calls + a restore fn. */
function stubFetch(
  handler: (
    body: Record<string, unknown>,
  ) => { status: number; json?: unknown; text?: string },
) {
  const original = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push(body);
    const res = handler(body);
    return Promise.resolve(
      new Response(
        res.json !== undefined ? JSON.stringify(res.json) : (res.text ?? ""),
        { status: res.status },
      ),
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** A bare "origin" repo plus a working clone, with one commit on `main`. */
async function setupGitRepos() {
  const tmp = await Deno.makeTempDir({ prefix: "claude-log-digest-git-" });
  const originDir = `${tmp}/origin.git`;
  const workDir = `${tmp}/work`;
  await run([
    "git",
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    originDir,
  ], tmp);
  await run(["git", "clone", "--quiet", originDir, workDir], tmp);
  await Deno.writeTextFile(`${workDir}/README.md`, "# test repo\n");
  const gitc = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
  await run(["git", ...gitc, "add", "README.md"], workDir);
  await run(["git", ...gitc, "commit", "-q", "-m", "init"], workDir);
  await run(["git", "push", "-q", "origin", "main"], workDir);
  return {
    tmp,
    originDir,
    workDir,
    cleanup: () => Deno.remove(tmp, { recursive: true }).catch(() => {}),
  };
}

/** A fake `gh` executable (on a throwaway PATH entry) that just echoes a PR URL. */
async function fakeGh(prUrl: string) {
  const binDir = await Deno.makeTempDir({ prefix: "fake-gh-bin-" });
  await Deno.writeTextFile(`${binDir}/gh`, `#!/bin/sh\necho "${prUrl}"\n`);
  await Deno.chmod(`${binDir}/gh`, 0o755);
  return {
    binDir,
    cleanup: () => Deno.remove(binDir, { recursive: true }).catch(() => {}),
  };
}

async function withPrependedPath<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${original}`);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", original);
  }
}

// ---------------------------------------------------------------------------
// GlobalArgsSchema
// ---------------------------------------------------------------------------

Deno.test("GlobalArgsSchema fills in expected defaults", () => {
  const args = GlobalArgsSchema.parse({ apiKey: "key" });
  assertEquals(args.model, "claude-sonnet-5");
  assertEquals(args.days, 7);
  assertEquals(args.maxTokens, 4096);
  assertEquals(args.skillsRepoPath, "skills");
  assertEquals(args.baseBranch, "main");
  assertEquals(args.branchPrefix, "claude-digest/skills");
  assertEquals(
    args.committerEmail,
    "claude-log-digest@users.noreply.github.com",
  );
});

// ---------------------------------------------------------------------------
// lineText
// ---------------------------------------------------------------------------

Deno.test("lineText", async (t) => {
  await t.step("returns null for non-object input", () => {
    assertEquals(lineText(null), null);
    assertEquals(lineText("hello"), null);
    assertEquals(lineText(42), null);
  });

  await t.step("returns null for roles other than user/assistant", () => {
    assertEquals(
      lineText({ type: "tool_result", message: { content: "x" } }),
      null,
    );
    assertEquals(lineText({ type: "system", message: { content: "x" } }), null);
  });

  await t.step("returns null when message is missing", () => {
    assertEquals(lineText({ type: "user" }), null);
  });

  await t.step("extracts string content", () => {
    assertEquals(
      lineText({ type: "user", message: { content: "hi there" } }),
      { role: "user", text: "hi there" },
    );
  });

  await t.step("extracts and concatenates array text blocks", () => {
    const result = lineText({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "part one " },
          { type: "tool_use", input: { ignored: true } },
          { type: "text", text: "part two" },
        ],
      },
    });
    assertEquals(result, { role: "assistant", text: "part one part two" });
  });

  await t.step("trims whitespace and drops empty turns", () => {
    assertEquals(lineText({ type: "user", message: { content: "   " } }), null);
    assertEquals(
      lineText({ type: "user", message: { content: "  hi  " } }),
      { role: "user", text: "hi" },
    );
  });

  await t.step("drops tool-result echoes that look like JSON", () => {
    assertEquals(
      lineText({ type: "user", message: { content: '[{"a":1}]' } }),
      null,
    );
    assertEquals(
      lineText({ type: "user", message: { content: '{"a":1}' } }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

Deno.test("labelFor", async (t) => {
  await t.step("extracts the repo name after Documents-GitHub", () => {
    assertEquals(
      labelFor("-Users-will-Documents-GitHub-some-repo"),
      "some-repo",
    );
  });

  await t.step("labels the GitHub root itself", () => {
    assertEquals(labelFor("-Users-will-Documents-GitHub"), "GitHub (root)");
  });

  await t.step("falls back to slash-joining for non-matching slugs", () => {
    assertEquals(labelFor("-foo-bar-baz"), "foo/bar/baz");
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

Deno.test("slugify", async (t) => {
  await t.step("lowercases and dashes non-alphanumeric runs", () => {
    assertEquals(slugify("My Cool Skill!!"), "my-cool-skill");
  });

  await t.step("strips leading/trailing dashes", () => {
    assertEquals(slugify("--already-kebab--"), "already-kebab");
  });

  await t.step("caps length at 64 chars", () => {
    const long = "a".repeat(100);
    assertEquals(slugify(long).length, 64);
  });

  await t.step("falls back to 'skill' when nothing survives", () => {
    assertEquals(slugify("!!!"), "skill");
    assertEquals(slugify(""), "skill");
  });
});

// ---------------------------------------------------------------------------
// parseJsonArray
// ---------------------------------------------------------------------------

Deno.test("parseJsonArray", async (t) => {
  await t.step("parses a direct JSON array", () => {
    assertEquals(parseJsonArray('[{"a":1}]'), [{ a: 1 }]);
  });

  await t.step("extracts an array from a markdown code fence", () => {
    assertEquals(
      parseJsonArray('Here you go:\n```json\n[{"a":1}]\n```\n'),
      [{ a: 1 }],
    );
  });

  await t.step("extracts an array embedded in prose", () => {
    assertEquals(
      parseJsonArray('Sure, the result is [{"a":1},{"b":2}] as requested.'),
      [{ a: 1 }, { b: 2 }],
    );
  });

  await t.step("returns [] for a JSON object (not an array)", () => {
    assertEquals(parseJsonArray('{"a":1}'), []);
  });

  await t.step("returns [] for unparseable garbage", () => {
    assertEquals(parseJsonArray("not json at all"), []);
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------

Deno.test("fileExists", async (t) => {
  await t.step("true for an existing file", async () => {
    const dir = await Deno.makeTempDir();
    const file = `${dir}/f.txt`;
    await Deno.writeTextFile(file, "x");
    assertEquals(await fileExists(file), true);
    await Deno.remove(dir, { recursive: true });
  });

  await t.step("false for a missing path", async () => {
    assertEquals(await fileExists("/definitely/does/not/exist"), false);
  });
});

// ---------------------------------------------------------------------------
// copyDirRecursive
// ---------------------------------------------------------------------------

Deno.test("copyDirRecursive copies nested files and directories", async () => {
  const src = await Deno.makeTempDir();
  const dest = await Deno.makeTempDir();
  await Deno.mkdir(`${src}/nested`, { recursive: true });
  await Deno.writeTextFile(`${src}/top.txt`, "top");
  await Deno.writeTextFile(`${src}/nested/deep.txt`, "deep");

  await copyDirRecursive(src, `${dest}/copied`);

  assertEquals(await Deno.readTextFile(`${dest}/copied/top.txt`), "top");
  assertEquals(
    await Deno.readTextFile(`${dest}/copied/nested/deep.txt`),
    "deep",
  );

  await Deno.remove(src, { recursive: true });
  await Deno.remove(dest, { recursive: true });
});

// ---------------------------------------------------------------------------
// condenseProject
// ---------------------------------------------------------------------------

Deno.test("condenseProject", async (t) => {
  await t.step("condenses recent sessions, excludes stale ones", async () => {
    const dir = await Deno.makeTempDir();
    const now = new Date();
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    await Deno.writeTextFile(
      `${dir}/recent.jsonl`,
      [userLine("do the thing"), assistantLine("done")].join("\n"),
    );
    await Deno.writeTextFile(`${dir}/stale.jsonl`, userLine("old work"));
    await Deno.utime(`${dir}/stale.jsonl`, old, old);

    const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const result = await condenseProject(dir, cutoff, 48000);

    assertEquals(result.sessions, 1);
    assertStringIncludes(result.content, "USER: do the thing");
    assertStringIncludes(result.content, "ASSISTANT: done");
    assert(!result.content.includes("old work"));
    assertEquals(result.chars, result.content.length);

    await Deno.remove(dir, { recursive: true });
  });

  await t.step("truncates assistant turns to 280 chars", async () => {
    const dir = await Deno.makeTempDir();
    const longReply = "x".repeat(500);
    await Deno.writeTextFile(`${dir}/s.jsonl`, assistantLine(longReply));

    const result = await condenseProject(dir, 0, 48000);
    assertStringIncludes(result.content, `ASSISTANT: ${"x".repeat(280)}`);
    assert(!result.content.includes("x".repeat(281)));

    await Deno.remove(dir, { recursive: true });
  });

  await t.step(
    "truncates the overall content to maxChars, keeping the tail",
    async () => {
      const dir = await Deno.makeTempDir();
      await Deno.writeTextFile(`${dir}/a.jsonl`, userLine("a".repeat(60)));
      await Deno.writeTextFile(`${dir}/b.jsonl`, userLine("b".repeat(60)));

      const full = await condenseProject(dir, 0, 1_000_000);
      const capped = await condenseProject(dir, 0, 50);

      assertStringIncludes(
        capped.content,
        "…[earlier transcripts truncated]…\n",
      );
      assertEquals(
        capped.content.slice(capped.content.indexOf("\n") + 1),
        full.content.slice(-50),
      );

      await Deno.remove(dir, { recursive: true });
    },
  );

  await t.step("skips malformed JSON lines without throwing", async () => {
    const dir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      `${dir}/s.jsonl`,
      ["not json", userLine("good line")].join("\n"),
    );
    const result = await condenseProject(dir, 0, 48000);
    assertStringIncludes(result.content, "good line");

    await Deno.remove(dir, { recursive: true });
  });

  await t.step("returns zeroed result for an empty directory", async () => {
    const dir = await Deno.makeTempDir();
    const result = await condenseProject(dir, 0, 48000);
    assertEquals(result, { sessions: 0, chars: 0, content: "" });
    await Deno.remove(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// callClaude
// ---------------------------------------------------------------------------

Deno.test("callClaude", async (t) => {
  await t.step("sends the expected request shape", async () => {
    const { calls, restore } = stubFetch(() => ({
      status: 200,
      json: { content: [{ type: "text", text: "ok" }] },
    }));
    try {
      const args = makeArgs({ model: "claude-test-model", maxTokens: 123 });
      await callClaude(args, "the prompt", "the system prompt");
      assertEquals(calls.length, 1);
      assertEquals(calls[0].model, "claude-test-model");
      assertEquals(calls[0].max_tokens, 123);
      assertEquals(calls[0].system, "the system prompt");
      assertEquals(calls[0].messages, [{
        role: "user",
        content: "the prompt",
      }]);
    } finally {
      restore();
    }
  });

  await t.step(
    "concatenates only text blocks, ignoring thinking blocks",
    async () => {
      // Real-world case: some models return a leading `thinking` block even
      // without an explicit thinking request — must not leak into the result.
      const { restore } = stubFetch(() => ({
        status: 200,
        json: {
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "the real answer" },
          ],
        },
      }));
      try {
        const text = await callClaude(makeArgs(), "p", "s");
        assertEquals(text, "the real answer");
      } finally {
        restore();
      }
    },
  );

  await t.step("throws with status and body on a non-ok response", async () => {
    const { restore } = stubFetch(() => ({
      status: 429,
      text: "rate limited",
    }));
    try {
      await assertRejects(
        () => callClaude(makeArgs(), "p", "s"),
        Error,
        "429",
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// readExistingSkills
// ---------------------------------------------------------------------------

Deno.test("readExistingSkills", async (t) => {
  await t.step("returns [] for an empty skillsDir argument", async () => {
    assertEquals(await readExistingSkills(""), []);
  });

  await t.step("returns [] for a missing directory", async () => {
    assertEquals(await readExistingSkills("/definitely/missing"), []);
  });

  await t.step("parses name/description from frontmatter", async () => {
    const dir = await Deno.makeTempDir();
    await Deno.mkdir(`${dir}/skill-a`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/skill-a/SKILL.md`,
      '---\nname: skill-a\ndescription: "does a thing"\n---\n\nbody',
    );
    // No frontmatter: falls back to the directory name, empty description.
    await Deno.mkdir(`${dir}/skill-b`, { recursive: true });
    await Deno.writeTextFile(`${dir}/skill-b/SKILL.md`, "just a body");

    const result = await readExistingSkills(dir);
    assertEquals(result.length, 2);
    assert(
      result.some((s) =>
        s.name === "skill-a" && s.description === "does a thing"
      ),
    );
    assert(result.some((s) => s.name === "skill-b" && s.description === ""));

    await Deno.remove(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// gather (model.methods.gather)
// ---------------------------------------------------------------------------

Deno.test("gather", async (t) => {
  await t.step(
    "condenses projects, sorts by size, and caps count",
    async () => {
      const projectsDir = await Deno.makeTempDir();
      await Deno.mkdir(`${projectsDir}/-small-proj`, { recursive: true });
      await Deno.writeTextFile(
        `${projectsDir}/-small-proj/s.jsonl`,
        userLine("short"),
      );
      await Deno.mkdir(`${projectsDir}/-big-proj`, { recursive: true });
      await Deno.writeTextFile(
        `${projectsDir}/-big-proj/s.jsonl`,
        userLine("a much longer message than the other project has"),
      );
      // An empty project (no readable turns) should be excluded entirely.
      await Deno.mkdir(`${projectsDir}/-empty-proj`, { recursive: true });
      await Deno.writeTextFile(
        `${projectsDir}/-empty-proj/s.jsonl`,
        "not json",
      );

      const args = makeArgs({ projectsDir, maxProjects: 1 });
      const { context, written } = makeContext({ globalArgs: args });

      await model.methods.gather.execute({}, context);

      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "manifest");
      const manifest = written[0].data;
      assertEquals(manifest.projectCount, 1);
      // maxProjects: 1 keeps only the larger project.
      // deno-lint-ignore no-explicit-any
      const projects = manifest.projects as any[];
      assertEquals(projects[0].name, "-big-proj");

      await Deno.remove(projectsDir, { recursive: true });
    },
  );

  await t.step(
    "falls back to $HOME/.claude/projects when projectsDir is unset",
    async () => {
      const fakeHome = await Deno.makeTempDir();
      await Deno.mkdir(`${fakeHome}/.claude/projects/-proj`, {
        recursive: true,
      });
      await Deno.writeTextFile(
        `${fakeHome}/.claude/projects/-proj/s.jsonl`,
        userLine("hello from fake home"),
      );

      const originalHome = Deno.env.get("HOME") ?? "";
      Deno.env.set("HOME", fakeHome);
      try {
        const { context, written } = makeContext({ globalArgs: makeArgs() });
        await model.methods.gather.execute({}, context);
        assertEquals(written[0].data.projectCount, 1);
      } finally {
        Deno.env.set("HOME", originalHome);
        await Deno.remove(fakeHome, { recursive: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// analyze (model.methods.analyze)
// ---------------------------------------------------------------------------

Deno.test("analyze", async (t) => {
  await t.step("throws when no manifest has been gathered", async () => {
    const { context } = makeContext();
    await assertRejects(
      () => model.methods.analyze.execute({}, context),
      Error,
      "gather",
    );
  });

  await t.step("throws when the manifest has no projects", async () => {
    const { context } = makeContext({
      resources: {
        manifest: {
          generatedAt: new Date(0).toISOString(),
          days: 7,
          projectCount: 0,
          projects: [],
        },
      },
    });
    await assertRejects(
      () => model.methods.analyze.execute({}, context),
      Error,
      "no projects",
    );
  });

  await t.step(
    "summarizes, distills a skill, and writes all resources + files",
    async () => {
      const skillsOutDir = await Deno.makeTempDir({ prefix: "skills-out-" });
      const skillsDir = await Deno.makeTempDir({ prefix: "skills-dir-" });
      const digestOut = `${await Deno.makeTempDir()}/digest.md`;

      // A stale draft from a "previous run" that must be cleared.
      await Deno.mkdir(`${skillsOutDir}/stale-skill`, { recursive: true });
      await Deno.writeTextFile(`${skillsOutDir}/stale-skill/SKILL.md`, "stale");

      const responses = [
        { content: [{ type: "text", text: "- did project work" }] }, // map: summarize
        {
          content: [{ type: "text", text: "## Update\nDid stuff this week." }],
        }, // reduce
        {
          content: [{
            type: "text",
            text:
              '[{"name":"My New Skill","description":"desc","rationale":"why"}]',
          }],
        }, // distill
        {
          content: [{ type: "text", text: "# my-new-skill\nStep 1. Step 2." }],
        }, // skill body
      ];
      let call = 0;
      const { restore } = stubFetch(() => ({
        status: 200,
        json: responses[call++],
      }));

      try {
        const args = makeArgs({
          skillsOutDir,
          skillsDir,
          digestOut,
          maxSkills: 5,
        });
        const { context, written } = makeContext({
          globalArgs: args,
          resources: {
            manifest: {
              generatedAt: new Date(0).toISOString(),
              days: 7,
              projectCount: 1,
              projects: [{
                name: "-proj",
                label: "proj",
                sessions: 1,
                chars: 10,
                content: "USER: do the thing",
              }],
            },
          },
        });

        await model.methods.analyze.execute({}, context);
        assertEquals(call, 4);

        // Stale draft removed; new one written.
        assertEquals(await fileExists(`${skillsOutDir}/stale-skill`), false);
        const skillMd = await Deno.readTextFile(
          `${skillsOutDir}/my-new-skill/SKILL.md`,
        );
        assertStringIncludes(skillMd, "name: my-new-skill");
        assertStringIncludes(skillMd, JSON.stringify("desc"));
        assertStringIncludes(skillMd, "# my-new-skill\nStep 1. Step 2.");

        const digestWrite = written.find((w) => w.spec === "digest");
        assert(digestWrite);
        assertEquals(
          digestWrite!.data.update,
          "## Update\nDid stuff this week.",
        );
        // deno-lint-ignore no-explicit-any
        const proposed = digestWrite!.data.proposedSkills as any[];
        assertEquals(proposed.length, 1);
        assertEquals(proposed[0].name, "my-new-skill");

        const skillWrite = written.find((w) => w.spec === "skill");
        assert(skillWrite);

        const digestFile = await Deno.readTextFile(digestOut);
        assertStringIncludes(digestFile, "## Claude work digest");
        assertStringIncludes(digestFile, "my-new-skill");
      } finally {
        restore();
        await Deno.remove(skillsOutDir, { recursive: true }).catch(() => {});
        await Deno.remove(skillsDir, { recursive: true }).catch(() => {});
      }
    },
  );
});

// ---------------------------------------------------------------------------
// publish (model.methods.publish)
// ---------------------------------------------------------------------------

Deno.test("publish", async (t) => {
  await t.step(
    "requires skillsOutDir, targetRepoPath, and targetRepoSlug",
    async () => {
      const { context: c1 } = makeContext({ globalArgs: makeArgs() });
      await assertRejects(
        () => model.methods.publish.execute({}, c1),
        Error,
        "skillsOutDir",
      );

      const { context: c2 } = makeContext({
        globalArgs: makeArgs({ skillsOutDir: "/tmp/whatever" }),
      });
      await assertRejects(
        () => model.methods.publish.execute({}, c2),
        Error,
        "targetRepoPath",
      );

      const { context: c3 } = makeContext({
        globalArgs: makeArgs({
          skillsOutDir: "/tmp/whatever",
          targetRepoPath: "/tmp/whatever-repo",
        }),
      });
      await assertRejects(
        () => model.methods.publish.execute({}, c3),
        Error,
        "targetRepoSlug",
      );
    },
  );

  await t.step("no-op when nothing is staged", async () => {
    const skillsOutDir = await Deno.makeTempDir();
    const args = makeArgs({
      skillsOutDir,
      targetRepoPath: "/does/not/exist",
      targetRepoSlug: "example/skills",
    });
    const { context, written } = makeContext({ globalArgs: args });

    await model.methods.publish.execute({}, context);
    assertEquals(written[0].data, {
      published: false,
      reason: "nothing staged",
    });

    await Deno.remove(skillsOutDir, { recursive: true });
  });

  await t.step(
    "no-op when staged skills produce no diff against base",
    async () => {
      const { workDir, cleanup } = await setupGitRepos();
      const skillsOutDir = await Deno.makeTempDir({ prefix: "skills-out-" });
      try {
        const skillContent = "---\nname: dup-skill\n---\n\nbody\n";

        // Seed main with the same skill already present.
        await Deno.mkdir(`${workDir}/skills/dup-skill`, { recursive: true });
        await Deno.writeTextFile(
          `${workDir}/skills/dup-skill/SKILL.md`,
          skillContent,
        );
        const gitc = ["-c", "user.name=test", "-c", "user.email=t@example.com"];
        await run(["git", ...gitc, "add", "skills/"], workDir);
        await run(["git", ...gitc, "commit", "-q", "-m", "seed"], workDir);
        await run(["git", "push", "-q", "origin", "main"], workDir);

        // Stage the identical skill for publish.
        await Deno.mkdir(`${skillsOutDir}/dup-skill`, { recursive: true });
        await Deno.writeTextFile(
          `${skillsOutDir}/dup-skill/SKILL.md`,
          skillContent,
        );

        const args = makeArgs({
          skillsOutDir,
          targetRepoPath: workDir,
          targetRepoSlug: "example/skills",
        });
        const { context, written } = makeContext({ globalArgs: args });

        await model.methods.publish.execute({}, context);
        assertEquals(written[0].data, {
          published: false,
          reason: "no diff against base branch",
        });
      } finally {
        await cleanup();
        await Deno.remove(skillsOutDir, { recursive: true }).catch(() => {});
      }
    },
  );

  await t.step(
    "opens a PR with the staged skills at a configurable path",
    async () => {
      const { tmp, originDir, workDir, cleanup } = await setupGitRepos();
      const { binDir, cleanup: cleanupGh } = await fakeGh(
        "https://github.com/example/skills/pull/1",
      );
      const skillsOutDir = await Deno.makeTempDir({ prefix: "skills-out-" });
      try {
        await Deno.mkdir(`${skillsOutDir}/my-skill`, { recursive: true });
        await Deno.writeTextFile(
          `${skillsOutDir}/my-skill/SKILL.md`,
          "---\nname: my-skill\n---\n\n# my-skill\n",
        );

        const args = makeArgs({
          skillsOutDir,
          targetRepoPath: workDir,
          targetRepoSlug: "example/skills",
          skillsRepoPath: "plugins/svp-sdlc/skills",
          branchPrefix: "test-digest",
        });
        const { context, written } = makeContext({ globalArgs: args });

        await withPrependedPath(
          binDir,
          () => model.methods.publish.execute({}, context),
        );

        assertEquals(written.length, 1);
        assertEquals(written[0].data.published, true);
        assertEquals(
          written[0].data.url,
          "https://github.com/example/skills/pull/1",
        );
        assertMatch(String(written[0].data.branch), /^test-digest-\d+$/);

        // The pushed branch really contains the skill at the configured path.
        const branch = String(written[0].data.branch);
        const show = await run(
          [
            "git",
            `--git-dir=${originDir}`,
            "show",
            `${branch}:plugins/svp-sdlc/skills/my-skill/SKILL.md`,
          ],
          tmp,
        );
        assertEquals(show.code, 0);
        assertStringIncludes(show.stdout, "# my-skill");

        // The scratch worktree is cleaned up — only the main `workDir` checkout remains.
        const worktrees = await run(["git", "worktree", "list"], workDir);
        assertEquals(
          worktrees.stdout.trim().split("\n").filter(Boolean).length,
          1,
        );
      } finally {
        await cleanup();
        await cleanupGh();
        await Deno.remove(skillsOutDir, { recursive: true }).catch(() => {});
      }
    },
  );

  await t.step(
    "is robust to GIT_* env vars leaked from an outer git hook",
    async () => {
      // Regression test: a real git hook sets GIT_INDEX_FILE (as a relative
      // path) and GIT_AUTHOR_*, which — if inherited — break `git worktree
      // add` outright and silently override our explicit commit identity.
      const { tmp, originDir, workDir, cleanup } = await setupGitRepos();
      const { binDir, cleanup: cleanupGh } = await fakeGh(
        "https://github.com/example/skills/pull/2",
      );
      const skillsOutDir = await Deno.makeTempDir({ prefix: "skills-out-" });
      const leaked: Record<string, string> = {
        GIT_INDEX_FILE: ".git/index",
        GIT_AUTHOR_NAME: "someone-else",
        GIT_AUTHOR_EMAIL: "someone-else@example.com",
      };
      for (const [k, v] of Object.entries(leaked)) Deno.env.set(k, v);
      try {
        await Deno.mkdir(`${skillsOutDir}/my-skill`, { recursive: true });
        await Deno.writeTextFile(
          `${skillsOutDir}/my-skill/SKILL.md`,
          "---\nname: my-skill\n---\n\n# my-skill\n",
        );

        const args = makeArgs({
          skillsOutDir,
          targetRepoPath: workDir,
          targetRepoSlug: "example/skills",
          committerName: "claude-log-digest",
          committerEmail: "claude-log-digest@users.noreply.github.com",
        });
        const { context, written } = makeContext({ globalArgs: args });

        await withPrependedPath(
          binDir,
          () => model.methods.publish.execute({}, context),
        );

        assertEquals(written[0].data.published, true);

        const branch = String(written[0].data.branch);
        const show = await run(
          [
            "git",
            `--git-dir=${originDir}`,
            "show",
            "-s",
            "--format=%an <%ae>",
            branch,
          ],
          tmp,
        );
        assertEquals(
          show.stdout,
          "claude-log-digest <claude-log-digest@users.noreply.github.com>",
        );
      } finally {
        for (const k of Object.keys(leaked)) Deno.env.delete(k);
        await cleanup();
        await cleanupGh();
        await Deno.remove(skillsOutDir, { recursive: true }).catch(() => {});
      }
    },
  );
});
