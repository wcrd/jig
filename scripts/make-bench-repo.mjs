// Builds a large jj repo for benchmarking the UI: a few thousand commits on
// a trunk with feature branches forking off and merging back, some left
// open with bookmarks, and one very large file so the diff view has work to
// do. History is written with `git fast-import`, then jj takes it over as a
// colocated repo. By default it lives next to the Jig checkout, at
// ../jig-bench/repo; pass a directory to put it elsewhere.
//
//   node scripts/make-bench-repo.mjs [directory] [commits]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, "../../jig-bench"));
const target = Number(process.argv[3] ?? 4000);

// Only ever delete a directory this script made.
if (existsSync(root) && !existsSync(join(root, ".jig-bench"))) {
  console.error(`${root} exists and isn't a bench repo; refusing to delete it`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, ".jig-bench"), "");
const repo = join(root, "repo");

// A small seeded generator, so every run builds the same history.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (items) => items[Math.floor(random() * items.length)];

const AUTHORS = ["Alice Chen", "Bob Okafor", "Carol Díaz", "Sam Rivera", "Dana Park", "Eve Moreau", "Femi Adeyemi", "Grace Liu"];
const DIRS = ["src", "src/store", "src/ui", "src/net", "lib", "lib/parse", "docs", "tests", "tools"];
const EXTS = [".rs", ".ts", ".py", ".md", ".toml"];
const FILES = Array.from({ length: 240 }, (_, i) => `${pick(DIRS)}/module_${i}${pick(EXTS)}`);
const VERBS = ["Add", "Fix", "Refactor", "Remove", "Speed up", "Document", "Rename", "Test", "Simplify", "Handle"];
const NOUNS = ["parser", "cache", "sidebar", "retry loop", "config loader", "error paths", "index", "renderer", "scheduler", "auth flow"];
const PREFIXES = ["", "", "feat: ", "fix: ", "refactor: ", "docs: ", "test: "];

/** A file's text at a version: a base from its path, with edits that depend on the version. */
function content(path, version) {
  let h = 0;
  for (const c of path) h = (h * 31 + c.charCodeAt(0)) | 0;
  const lines = Array.from({ length: 120 + (Math.abs(h) % 200) }, (_, i) => `// ${path} line ${i}: value = ${(h ^ (i * 2654435761)) & 0xffff}`);
  for (let k = 0; k < 4; k++) {
    const at = Math.abs((version * 7919 + k * 104729 + h) | 0) % lines.length;
    lines[at] = `// ${path} line ${at}: changed in version ${version}`;
  }
  return `${lines.join("\n")}\n`;
}

/** A 20,000-line file, changed in a few places at each version. */
function hugeContent(version) {
  const lines = Array.from({ length: 20000 }, (_, i) => `fn item_${i}() -> u64 { ${i} * 31 + ${i % 97} }`);
  for (let k = 0; k < 40; k++) lines[(k * 487 + version * 13) % lines.length] = `fn item_changed_${k}() -> u64 { ${version} }`;
  return `${lines.join("\n")}\n`;
}

const out = [];
let mark = 0;
let time = Math.floor(Date.now() / 1000) - target * 1800;
const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;

/** Writes a commit; `changes` maps paths to text. Returns its mark. */
function commit(ref, parents, message, changes) {
  const blobs = Object.entries(changes).map(([path, text]) => {
    out.push(`blob\nmark :${++mark}\n${data(text)}`);
    return [path, mark];
  });
  const author = pick(AUTHORS);
  const email = `${author.split(" ")[0].toLowerCase()}@example.com`;
  time += 600 + Math.floor(random() * 3000);
  const coauthor = random() < 0.05 ? "\n\nCo-Authored-By: Claude <noreply@anthropic.com>" : "";
  let text = `commit ${ref}\nmark :${++mark}\n`;
  text += `author ${author} <${email}> ${time} +0000\ncommitter ${author} <${email}> ${time} +0000\n`;
  text += data(`${message}${random() < 0.2 ? "\n\nA longer body explaining the change.\nIt wraps onto a second line." : ""}${coauthor}`);
  if (parents[0]) text += `from :${parents[0]}\n`;
  for (const p of parents.slice(1)) text += `merge :${p}\n`;
  for (const [path, blob] of blobs) text += `M 100644 :${blob} ${path}\n`;
  out.push(text);
  return mark;
}

const message = () => `${pick(PREFIXES)}${pick(VERBS)} ${pick(NOUNS)}`;
const touch = (count) => {
  const changes = {};
  for (let i = 0; i < count; i++) {
    const path = pick(FILES);
    changes[path] = content(path, mark + i);
  }
  return changes;
};

// Trunk starts with every file.
let trunk = commit("refs/heads/main", [], "Initial import", Object.fromEntries(FILES.map((f) => [f, content(f, 0)])));
let made = 1;
/** Feature branches being worked on at once, which is what makes the graph wide. */
const active = [];
const open = [];
let branchNo = 0;
while (made < target) {
  const roll = random();
  if (roll < 0.35) {
    // A commit on trunk; one in a few hundred touches the huge file.
    const changes = touch(1 + Math.floor(random() * 3));
    if (made % 400 === 1) changes["data/huge.rs"] = hugeContent(made);
    trunk = commit("refs/heads/main", [trunk], message(), changes);
  } else if (roll < 0.45 && active.length < 8) {
    // A new branch off trunk.
    const name = `feature/${pick(NOUNS).replace(/ /g, "-")}-${++branchNo}`;
    active.push({ name, tip: commit(`refs/heads/${name}`, [trunk], message(), touch(1)), length: 1 });
  } else if (active.length > 0) {
    const index = Math.floor(random() * active.length);
    const branch = active[index];
    if (branch.length < 3 || random() < 0.8) {
      branch.tip = commit(`refs/heads/${branch.name}`, [branch.tip], message(), touch(1 + Math.floor(random() * 2)));
      branch.length++;
    } else {
      // Done: merged back, or left open with its bookmark.
      active.splice(index, 1);
      if (random() < 0.85 || open.length > 30) {
        trunk = commit("refs/heads/main", [trunk, branch.tip], `Merge ${branch.name}`, touch(1));
        out.push(`reset refs/heads/${branch.name}\nfrom 0000000000000000000000000000000000000000\n`);
      } else {
        open.push(branch.name);
        continue;
      }
    }
  } else {
    continue;
  }
  made++;
}
open.push(...active.map((b) => b.name));
// The newest commit changes the huge file, so it's among the fixture's diffs.
commit("refs/heads/main", [trunk], "Regenerate the item table", { "data/huge.rs": hugeContent(made) });
made++;

execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
const result = spawnSync("git", ["fast-import", "--quiet"], { cwd: repo, input: out.join(""), maxBuffer: 1 << 30 });
if (result.status !== 0) {
  console.error(result.stderr.toString());
  process.exit(1);
}
// Deleted branch refs can linger as all-zero refs; drop any that did.
for (const ref of execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean)) {
  if (!execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo, encoding: "utf8" }).trim()) execFileSync("git", ["update-ref", "-d", ref], { cwd: repo });
}
execFileSync("git", ["reset", "--quiet", "--hard", "main"], { cwd: repo });
execFileSync("jj", ["git", "init", "--quiet", "--colocate"], { cwd: repo });
console.log(`${made} commits, ${open.length} open branches, in ${repo}`);
