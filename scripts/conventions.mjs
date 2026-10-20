#!/usr/bin/env node
// Pull request conventions for home-compute.
//
//   node scripts/conventions.mjs commits
//     PR_TITLE, BASE_SHA, HEAD_SHA: the title and every non-merge commit
//     subject in BASE_SHA..HEAD_SHA must be a Conventional Commit.
//   node scripts/conventions.mjs body
//     PR_BODY must contain Summary, Why, What changed, and Testing, each
//     with real text (the template's comments do not count).
//   node scripts/conventions.mjs merge-strategy
//     GITHUB_REPOSITORY and GITHUB_TOKEN: the repository must allow merge
//     commits only, with the pull request title and body as the merge commit.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TYPES = Object.freeze([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);

/** Subject line, including the type prefix. Matches @commitlint/config-conventional's header-max-length. */
export const HEADER_MAX = 100;

/** Description after the colon, so `fix: x` is not a commit message. */
export const DESCRIPTION_MIN = 10;

/** Visible text required in each pull request section. */
export const SECTION_MIN = 40;

/** Letters or numbers required in that text, so a line of punctuation cannot pass. */
export const SECTION_LETTERS = 24;

export const SECTIONS = Object.freeze(["Summary", "Why", "What changed", "Testing"]);

const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9._/-]+\\))?(!)?: (.+)$`);

const FILLERS = /\b(n\/a|none|tbd|todo|wip|fixme|placeholder)\b/gi;

export function checkSubject(subject, label) {
  if (subject == null || String(subject).trim() === "") return [`${label} is empty.`];
  const text = String(subject);
  if (text.includes("\n")) return [`${label} must be a single line.`];
  const errors = [];
  if (text !== text.trim()) errors.push(`${label} has leading or trailing whitespace.`);
  if ([...text].length > HEADER_MAX) {
    errors.push(`${label} is ${[...text].length} characters; the maximum is ${HEADER_MAX}.`);
  }
  const match = SUBJECT.exec(text.trim());
  if (!match) {
    errors.push(
      `${label} must be a Conventional Commit: \`type(scope): description\`. ` +
        `Types: ${TYPES.join(", ")}. Scope is optional, a breaking change is \`type!:\` or \`type(scope)!:\`. ` +
        "Example: `feat: run job images without Docker`.",
    );
    return errors;
  }
  const description = match[4];
  if (description !== description.trim()) errors.push(`${label} has extra space around the description.`);
  if (description.trim().endsWith(".")) errors.push(`${label} must not end with a period.`);
  if ([...description.trim()].length < DESCRIPTION_MIN) {
    errors.push(`${label} description must be at least ${DESCRIPTION_MIN} characters.`);
  }
  return errors;
}

export function listCommits(base, head, cwd = process.cwd()) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["log", "--reverse", "--no-merges", `--format=%H%x1f%s`, `${base}..${head}`],
      { cwd, encoding: "utf8" },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`Could not list commits ${base}..${head}: ${detail}`);
  }
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const split = line.indexOf("\x1f");
      return { sha: line.slice(0, split), subject: line.slice(split + 1) };
    });
}

export function checkCommits({ title, commits }) {
  const errors = [...checkSubject(title, "Pull request title")];
  if (commits.length === 0) errors.push("Pull request has no non-merge commits to check.");
  for (const commit of commits) {
    const short = commit.sha.slice(0, 7);
    errors.push(...checkSubject(commit.subject, `Commit ${short} ("${commit.subject}")`));
  }
  return errors;
}

/** Hide headings that sit inside a fence or an HTML comment, keeping indexes aligned with `text`. */
function maskNonHeadings(text) {
  const blank = (block) => block.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

export function visibleText(section) {
  return section
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionIssue(name, visible) {
  const stripped = visible.replace(FILLERS, " ").replace(/\s+/g, " ").trim();
  const letters = stripped.replace(/[^0-9A-Za-z]/g, "").length;
  if (stripped.length < SECTION_MIN || letters < SECTION_LETTERS) {
    return (
      `Section "## ${name}" needs at least ${SECTION_MIN} characters of text, ` +
      `including ${SECTION_LETTERS} letters or numbers ` +
      `(it has ${stripped.length} characters and ${letters} letters or numbers). ` +
      "Placeholder words (n/a, none, tbd, todo, wip) do not count."
    );
  }
  return null;
}

export function checkBody(body) {
  if (body == null || String(body).trim() === "") {
    return ["Pull request description is empty. Fill in .github/pull_request_template.md."];
  }
  const text = String(body).replace(/\r\n/g, "\n");
  const headings = [];
  const re = /^##[ \t]+([^\n]+)$/gm;
  let match;
  const masked = maskNonHeadings(text);
  while ((match = re.exec(masked))) {
    headings.push({
      title: match[1].trim(),
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }
  const errors = [];
  for (const name of SECTIONS) {
    const found = headings.filter((heading) => heading.title === name);
    if (found.length === 0) errors.push(`Missing section "## ${name}".`);
    if (found.length > 1) errors.push(`Section "## ${name}" appears more than once.`);
  }
  const positions = SECTIONS.map((name) => headings.findIndex((heading) => heading.title === name));
  if (positions.every((position) => position >= 0)) {
    const sorted = [...positions].sort((a, b) => a - b);
    if (positions.some((position, index) => position !== sorted[index])) {
      errors.push("Sections must appear in this order: Summary, Why, What changed, Testing.");
    }
  }
  for (const [index, name] of SECTIONS.entries()) {
    const position = positions[index];
    if (position < 0) continue;
    const heading = headings[position];
    const next = headings[position + 1];
    const raw = text.slice(heading.contentStart, next ? next.start : text.length);
    const issue = sectionIssue(name, visibleText(raw));
    if (issue) errors.push(issue);
  }
  return errors;
}

export const MERGE_SETTINGS = Object.freeze({
  allow_merge_commit: true,
  allow_squash_merge: false,
  allow_rebase_merge: false,
  merge_commit_title: "PR_TITLE",
  merge_commit_message: "PR_BODY",
});

export function checkMergeSettings(repo) {
  const keys = Object.keys(MERGE_SETTINGS);
  if (keys.every((key) => repo?.[key] === undefined)) {
    return [
      "GitHub omitted the merge settings. Reading them requires a token with contents: write (push access); a read-only token does not receive allow_merge_commit or the related fields.",
    ];
  }
  const errors = [];
  for (const [key, expected] of Object.entries(MERGE_SETTINGS)) {
    if (repo?.[key] !== expected) {
      errors.push(`${key} is ${JSON.stringify(repo?.[key])}; expected ${JSON.stringify(expected)}.`);
    }
  }
  return errors;
}

export function mergeSettingsCommand(repository) {
  return `gh api --method PATCH repos/${repository} --input - <<'EOF'
{
  "allow_merge_commit": true,
  "allow_squash_merge": false,
  "allow_rebase_merge": false,
  "merge_commit_title": "PR_TITLE",
  "merge_commit_message": "PR_BODY"
}
EOF`;
}

async function loadRepository(repository, token) {
  if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "home-compute-conventions",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API answered ${response.status} reading ${repository}.`);
  return response.json();
}

function finish(errors, success) {
  if (errors.length > 0) {
    for (const error of errors) console.error(`conventions: ${error}`);
    process.exit(1);
  }
  console.log(success);
}

async function main() {
  const command = process.argv[2];
  if (command === "commits") {
    const base = process.env.BASE_SHA;
    const head = process.env.HEAD_SHA;
    const title = process.env.PR_TITLE ?? "";
    if (!base || !head) {
      finish([...checkSubject(title, "Pull request title"), "BASE_SHA and HEAD_SHA are required."], "");
      return;
    }
    try {
      const commits = listCommits(base, head);
      finish(checkCommits({ title, commits }), `conventions: pull request title and ${commits.length} commit subject(s) match.`);
    } catch (error) {
      finish([...checkSubject(title, "Pull request title"), error instanceof Error ? error.message : String(error)], "");
    }
    return;
  }
  if (command === "body") {
    const errors = checkBody(process.env.PR_BODY ?? "");
    finish(errors, "conventions: pull request description has Summary, Why, What changed, and Testing.");
    return;
  }
  if (command === "merge-strategy") {
    const repository = process.env.GITHUB_REPOSITORY;
    try {
      const repo = await loadRepository(repository, process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
      const errors = checkMergeSettings(repo);
      if (errors.length > 0) {
        console.error("conventions: repository merge settings do not match the policy.");
        for (const error of errors) console.error(`conventions: ${error}`);
        console.error("conventions: an owner with admin access applies them with:");
        console.error(mergeSettingsCommand(repository));
        process.exit(1);
      }
      console.log("conventions: merge commits only; the merge commit uses the pull request title and body.");
    } catch (error) {
      console.error(`conventions: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    return;
  }
  console.error("Usage: node scripts/conventions.mjs <commits|body|merge-strategy>");
  process.exit(2);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  await main();
}
