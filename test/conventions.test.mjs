// Conventional Commits, the pull request body, and the merge-commit policy.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HEADER_MAX,
  MERGE_SETTINGS,
  SECTIONS,
  checkBody,
  checkCommits,
  checkMergeSettings,
  checkSubject,
  listCommits,
  mergeSettingsCommand,
  visibleText,
} from "../scripts/conventions.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/conventions.mjs");

const FILLED = `## Summary

A Linux machine can run a job image without a Docker daemon installed.

## Why

Machines that should take work often have no Docker, and a plain process would use the host's files.

## What changed

\`--runtime process\` pulls the image, unpacks it, and runs it under bubblewrap, unshare, or proot.

## Testing

\`npm run check\` passed, and busybox ran under bubblewrap with no Docker daemon.
`;

test("a conventional subject is accepted, including a scope and a breaking marker", () => {
  assert.deepEqual(checkSubject("feat: run job images without Docker", "Title"), []);
  assert.deepEqual(checkSubject("fix(agent): keep image writes inside the rootfs", "Title"), []);
  assert.deepEqual(checkSubject("feat(agent)!: refuse a plain process unless asked", "Title"), []);
});

test("a subject that is not a conventional commit is rejected", () => {
  const errors = checkSubject("Run job images as processes", "Pull request title");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Conventional Commit/);
  assert.match(checkSubject("Feat: run job images without Docker", "Title")[0], /Conventional Commit/);
  assert.match(checkSubject("feat(Agent): run job images without Docker", "Title")[0], /Conventional Commit/);
  assert.match(checkSubject("feature: run job images without Docker", "Title")[0], /Conventional Commit/);
  assert.deepEqual(checkSubject("", "Pull request title"), ["Pull request title is empty."]);
  assert.match(checkSubject("feat: short", "Title")[0], /at least 10 characters/);
  assert.match(checkSubject("feat: run job images without Docker.", "Title")[0], /period/);
  assert.match(checkSubject(`feat: ${"a".repeat(HEADER_MAX)}`, "Title")[0], /maximum is 100/);
});

test("the header limit counts the type prefix and allows a 100-character subject", () => {
  const description = "a".repeat(HEADER_MAX - "feat: ".length);
  assert.equal(`feat: ${description}`.length, HEADER_MAX);
  assert.deepEqual(checkSubject(`feat: ${description}`, "Title"), []);
});

test("commit subjects and the pull request title are checked together, and a merge is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conventions-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=Conventions Test", "-c", "user.email=conventions@example.com", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "feat: start the repository for the convention check");
    const base = git("rev-parse", "HEAD").trim();
    git("commit", "--allow-empty", "-m", "fix: correct the overlap when a run is still going");
    git("checkout", "-b", "side", base);
    git("commit", "--allow-empty", "-m", "Updated the operator notes");
    git("checkout", "main");
    git("merge", "--no-ff", "side", "-m", "Merge branch 'side'");
    const head = git("rev-parse", "HEAD").trim();
    const commits = listCommits(base, head, dir);
    assert.deepEqual(
      commits.map((commit) => commit.subject).sort(),
      ["Updated the operator notes", "fix: correct the overlap when a run is still going"],
    );
    const errors = checkCommits({ title: "feat: check commit subjects on a pull request", commits });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Updated the operator notes/);
    assert.equal(checkCommits({ title: "Add a check", commits: [] }).some((error) => /no non-merge commits/.test(error)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a filled description passes and the section text ignores comments and tags", () => {
  assert.deepEqual(checkBody(FILLED), []);
  assert.equal(visibleText("<!-- hidden -->\n<p>Shown to the reviewer.</p>"), "Shown to the reviewer.");
  const withNoise = FILLED.replace(
    "## Testing\n",
    "## Testing\n\n<!-- still to write -->\n<div><img alt=\"Open in Web\"></div>\n",
  );
  assert.deepEqual(checkBody(withNoise), []);
});

test("an empty template, a missing section, a placeholder, and the wrong order fail", () => {
  assert.match(checkBody("")[0], /empty/);
  assert.match(checkBody("Just a paragraph with no headings at all, long enough to be a mistake.")[0], /Missing section "## Summary"/);
  for (const name of SECTIONS) assert.equal(checkBody(FILLED).includes(`Missing section "## ${name}".`), false);

  const commentsOnly = SECTIONS.map((name) => `## ${name}\n\n<!-- Write ${name} here. -->`).join("\n\n");
  const emptySections = checkBody(commentsOnly);
  for (const name of SECTIONS) assert.ok(emptySections.some((error) => error.includes(`## ${name}`)));

  const placeholder = FILLED.replace(
    "Machines that should take work often have no Docker, and a plain process would use the host's files.",
    "n/a n/a n/a n/a n/a n/a n/a n/a n/a n/a n/a n/a",
  );
  assert.ok(checkBody(placeholder).some((error) => error.includes("## Why")));

  const swapped = FILLED.replace("## Summary", "## TEMP").replace("## Why", "## Summary").replace("## TEMP", "## Why");
  assert.ok(checkBody(swapped).some((error) => /order/.test(error)));

  const duplicated = `## Summary\n\nThis first summary is long enough to be real text for the check.\n\n${FILLED}`;
  assert.ok(checkBody(duplicated).some((error) => /Summary" appears more than once/.test(error)));
});

test("a heading inside a code fence is not a section", () => {
  const body = FILLED.replace(
    "## What changed\n",
    "## What changed\n\n```\n## Summary\n```\n\n",
  );
  assert.deepEqual(checkBody(body), []);
});

test("merge settings pass only for merge commits that use the pull request title and body", () => {
  assert.deepEqual(checkMergeSettings({ ...MERGE_SETTINGS }), []);
  const errors = checkMergeSettings({
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
  });
  assert.equal(errors.length, 4);
  assert.ok(errors.some((error) => /allow_squash_merge/.test(error)));
  const omitted = checkMergeSettings({});
  assert.equal(omitted.length, 1);
  assert.match(omitted[0], /contents: write/);
  const command = mergeSettingsCommand("sprintengine/home-compute");
  for (const [key, value] of Object.entries(MERGE_SETTINGS)) {
    assert.ok(command.includes(`"${key}": ${JSON.stringify(value)}`), key);
  }
});

test("the commits command fails the process when the title is not conventional", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "commits"], {
    encoding: "utf8",
    env: { ...process.env, PR_TITLE: "Add conventions", BASE_SHA: "deadbeef", HEAD_SHA: "deadbeef" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pull request title/);
});

test("the workflow re-checks titles and bodies, and can read merge settings", () => {
  const yaml = readFileSync(path.join(ROOT, ".github/workflows/conventions.yml"), "utf8");
  for (const event of ["opened", "edited", "synchronize", "reopened", "ready_for_review"]) {
    assert.ok(yaml.includes(event), event);
  }
  assert.match(yaml, /name: conventional commits/);
  assert.match(yaml, /name: pull request description/);
  assert.match(yaml, /name: merge strategy/);
  assert.match(yaml, /contents: write/);
  assert.match(yaml, /persist-credentials: false/);
});

test("the template is empty of real text, and CONTRIBUTING documents the merge settings", () => {
  const template = readFileSync(path.join(ROOT, ".github/pull_request_template.md"), "utf8");
  const errors = checkBody(template);
  for (const name of SECTIONS) assert.ok(errors.some((error) => error.includes(`## ${name}`)), errors.join("\n"));
  const doc = readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8");
  for (const [key, value] of Object.entries(MERGE_SETTINGS)) {
    assert.ok(doc.includes(`"${key}": ${JSON.stringify(value)}`), key);
  }
  assert.match(doc, /conventional commits/);
  assert.match(doc, /pull request description/);
  assert.match(doc, /merge strategy/);
});

test("the body command passes a filled description and rejects the empty one", () => {
  const pass = spawnSync(process.execPath, [SCRIPT, "body"], {
    encoding: "utf8",
    env: { ...process.env, PR_BODY: FILLED },
  });
  assert.equal(pass.status, 0, pass.stderr);
  const fail = spawnSync(process.execPath, [SCRIPT, "body"], {
    encoding: "utf8",
    env: { ...process.env, PR_BODY: "" },
  });
  assert.notEqual(fail.status, 0);
  assert.match(fail.stderr, /empty/);
});
