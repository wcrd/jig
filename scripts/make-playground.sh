#!/usr/bin/env bash
# Builds a throwaway jj repo for trying Jig against. By default it lives
# next to the Jig checkout, at ../jig-playground/repo, with a local
# "remote" at ../jig-playground/origin.git so fetch and push work offline.
# Pass a directory to put it elsewhere. Re-run it to reset everything.
#
#   scripts/make-playground.sh [directory]
#
# It covers what the UI needs to show: several authors, merges, tags, synced
# and unsynced bookmarks, an untracked remote bookmark, a mutable stack with
# an AI co-author, a rename, large and binary files, a conflict, a divergent
# change, a second workspace and uncommitted changes in @.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/jig-playground}"
# Only ever delete a directory this script made.
if [ -e "$ROOT" ] && [ ! -e "$ROOT/.jig-playground" ]; then
  echo "$ROOT exists and isn't a playground; refusing to delete it" >&2
  exit 1
fi
rm -rf "$ROOT"
mkdir -p "$ROOT"
touch "$ROOT/.jig-playground"
cd "$ROOT"

# Deterministic timestamps and change IDs, spread over the last month.
BASE=$(( $(date +%s) - 30 * 86400 ))
STEP=0
tick() {
  STEP=$((STEP + 1))
  export JJ_TIMESTAMP
  JJ_TIMESTAMP=$(date -u -r $((BASE + STEP * 5400)) +%Y-%m-%dT%H:%M:%S+00:00)
  export JJ_RANDOMNESS_SEED=$STEP
}

name_of() {
  case $1 in
    alice) echo "Alice Chen" ;;
    bob) echo "Bob Okafor" ;;
    carol) echo "Carol Díaz" ;;
    dev) echo "Sam Rivera" ;;
  esac
}

# Runs jj as one of the authors.
as() {
  local who=$1
  shift
  tick
  jj --quiet --config "user.name=$(name_of "$who")" --config "user.email=$who@example.com" "$@"
}

write() { mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" >"$1"; }

git init --quiet --bare origin.git
jj git init --quiet repo
cd repo
jj git remote add origin ../origin.git

# --- trunk -------------------------------------------------------------------

write README.md "# Playground

A pretend project for trying out Jig."
write Cargo.toml '[package]
name = "playground"
version = "0.1.0"
edition = "2024"'
write src/main.rs 'fn main() {
    println!("{}", playground::greet("world"));
}'
write src/lib.rs 'mod util;

pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}'
write src/util.rs 'pub fn clamp(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}'
write .editorconfig 'root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
insert_final_newline = true
trim_trailing_whitespace = true
max_line_length = 120

[*.md]
trim_trailing_whitespace = false

[*.toml]
indent_size = 2

[Makefile]
indent_style = tab'
write rustfmt.toml 'edition = "2024"
max_width = 120
use_small_heuristics = "Default"
imports_granularity = "Crate"
group_imports = "StdExternalCrate"'
# jj git init made @ with the real user's identity; give it to Alice.
as alice metaedit --update-author
as alice commit -m "Initial project layout"

mkdir -p data
seq -f "line %g of a large generated data file" 1 6000 >data/big.txt
printf '\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10' >assets.png
as bob commit -m "Add sample data and a logo"

for i in 1 2 3 4 5 6; do
  printf '\npub fn helper_%s(x: i32) -> i32 {\n    x * %s\n}\n' "$i" "$i" >>src/util.rs
  who=$([ $((i % 2)) = 0 ] && echo carol || echo alice)
  as "$who" commit -m "Add helper_$i

Small utility used by the upcoming features."
done
as alice tag set v1.0.0 -r @-

# A release branch off an older trunk commit.
as bob new 'description(substring:"helper_3")' -m "Backport: fix clamp for reversed bounds"
write src/util.rs "$(cat src/util.rs)
// clamp now tolerates min > max"
as bob new -m "Release 1.0.1"
as bob bookmark create release/1.x -r @-
as bob tag set v1.0.1 -r release/1.x

# A feature branch merged back into trunk.
as carol new 'description(substring:"helper_6")' -m "Login: add form"
write src/login.rs 'pub struct LoginForm {
    pub user: String,
}'
as carol commit -m "Login: add form"
write src/login.rs "$(cat src/login.rs)

impl LoginForm {
    pub fn is_valid(&self) -> bool {
        !self.user.is_empty()
    }
}"
as carol commit -m "Login: validate the form"
as carol bookmark create feat/login -r @-
as alice new 'description(substring:"helper_6")' feat/login -m "Merge branch 'feat/login'"
as alice bookmark create main -r @
as alice new -m "Trunk: tidy README"
write README.md "$(cat README.md)

See CONTRIBUTING.md for how to help."
as alice commit -m "Trunk: tidy README"
as alice bookmark set main -r @-

# Publish. main, release/1.x and feat/login exist on the remote.
# (--allow-new is deprecated in favour of auto-tracking config, but still the
# simplest way to publish new bookmarks from a script.)
as alice git push --quiet --bookmark main --bookmark release/1.x --bookmark feat/login --allow-new 2>/dev/null

# Someone else pushes a branch we haven't tracked.
git clone --quiet ../origin.git ../other-clone
(
  cd ../other-clone
  git -c user.name="Dana Park" -c user.email=dana@example.com checkout --quiet -b experiment/cache
  printf 'pub struct Cache;\n' >src/cache.rs
  git add src/cache.rs
  GIT_AUTHOR_DATE="$(date -u -r $((BASE + 60 * 5400)))" GIT_COMMITTER_DATE="$(date -u -r $((BASE + 60 * 5400)))" \
    git -c user.name="Dana Park" -c user.email=dana@example.com commit --quiet -m "Experiment: add a cache"
  git push --quiet origin experiment/cache
)
rm -rf ../other-clone
as alice git fetch --quiet

# main moves ahead of origin (shows as main*).
as alice new main -m "Trunk: bump version"
sed -i '' 's/0.1.0/0.2.0/' Cargo.toml
as alice commit -m "Trunk: bump version"
as alice bookmark set main -r @-

# --- mutable work on top of trunk --------------------------------------------

as dev new main -m "Sidebar: scaffold the component"
write src/sidebar.rs 'pub struct Sidebar {
    pub items: Vec<String>,
}'
as dev commit -m "Sidebar: scaffold the component

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
mv src/util.rs src/helpers.rs
sed -i '' 's/mod util;/mod helpers;/' src/lib.rs
as dev commit -m "Rename util to helpers"
write src/sidebar.rs "$(cat src/sidebar.rs)

impl Sidebar {
    pub fn add(&mut self, item: &str) {
        self.items.push(item.to_string());
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}"
write src/main.rs 'fn main() {
    println!("{}", playground::greet("sidebar"));
}'
as dev commit -m "Sidebar: add items

Lets the sidebar hold a list of entries and report its size. The main
entry point now greets the sidebar instead of the world, which is a
placeholder until the real wiring lands.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Co-Authored-By: Carol Díaz <carol@example.com>"
as dev bookmark create feat/ui/sidebar -r @-

# A small fix on its own branch, and an empty change.
as dev new main -m "Fix typo in greeting"
sed -i '' 's/Hello/Helo/' src/lib.rs
sed -i '' 's/Helo/Hello there/' src/lib.rs
as dev commit -m "Fix typo in greeting"
as dev bookmark create fix/greeting -r @-
as dev new main -m "Placeholder for later"

# Two changes that conflict in several places across two files, merged.
as bob new main -m "Use 80 columns"
write .editorconfig 'root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
insert_final_newline = true
trim_trailing_whitespace = true
max_line_length = 80

[*.md]
trim_trailing_whitespace = false
max_line_length = 72

[*.toml]
indent_size = 2

[Makefile]
indent_style = tab'
write rustfmt.toml 'edition = "2024"
max_width = 80
use_small_heuristics = "Default"
comment_width = 72
imports_granularity = "Crate"
group_imports = "StdExternalCrate"'
as bob commit -m "Use 80 columns"
as bob bookmark create style/80 -r @-
as carol new main -m "Use 100 columns"
write .editorconfig 'root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
insert_final_newline = true
trim_trailing_whitespace = true
max_line_length = 100

[*.md]
trim_trailing_whitespace = false
max_line_length = off

[*.toml]
indent_size = 2

[Makefile]
indent_style = tab

[*.{yml,yaml}]
indent_size = 2'
write rustfmt.toml 'edition = "2024"
max_width = 100
use_small_heuristics = "Max"
imports_granularity = "Crate"
group_imports = "StdExternalCrate"'
as carol commit -m "Use 100 columns"
as carol new style/80 @- -m "Merge the style changes"

# A divergent change: the same change rewritten twice concurrently.
as dev new main -m "Docs: draft"
write CONTRIBUTING.md 'Please open an issue first.'
as dev commit -m "Docs: draft"
DOCS=$(jj log --no-graph -r @- -T 'change_id.short()')
OP=$(jj op log --no-graph -n 1 -T 'self.id().short()')
as dev describe "$DOCS" -m "Docs: contributing guide"
as carol --at-op "$OP" describe "$DOCS" -m "Docs: how to contribute" 2>/dev/null

# A second workspace with its own working-copy commit.
as dev workspace add --quiet --name review ../repo-review -r main

# Finish on top of the sidebar work, with uncommitted changes in @.
as dev new feat/ui/sidebar
write src/sidebar.rs "$(cat src/sidebar.rs)
// TODO: render the sidebar"
jj --quiet status >/dev/null

# A change across several files, for the full-size diff screenshot. It comes
# last so the change IDs above stay put, and @ goes back to the sidebar.
WC=$(jj log --no-graph -r @ -T 'change_id.short()')
as bob new main -m "Login: require a password and lock out repeated failures"
write src/login.rs 'use std::time::{Duration, Instant};

/// Failed attempts allowed before the form locks.
const MAX_ATTEMPTS: u32 = 5;
/// How long the form stays locked.
const LOCKOUT: Duration = Duration::from_secs(30);

pub struct LoginForm {
    pub username: String,
    pub password: String,
    attempts: u32,
    locked_until: Option<Instant>,
}

#[derive(Debug, PartialEq)]
pub enum LoginError {
    MissingUsername,
    PasswordTooShort,
    Locked(Duration),
}

impl LoginForm {
    pub fn new(username: &str, password: &str) -> Self {
        Self {
            username: username.trim().to_string(),
            password: password.to_string(),
            attempts: 0,
            locked_until: None,
        }
    }

    pub fn validate(&self) -> Result<(), LoginError> {
        if self.username.is_empty() {
            return Err(LoginError::MissingUsername);
        }
        if self.password.len() < 8 {
            return Err(LoginError::PasswordTooShort);
        }
        Ok(())
    }

    /// Records a failed attempt, locking the form after too many.
    pub fn fail(&mut self, now: Instant) {
        self.attempts += 1;
        if self.attempts >= MAX_ATTEMPTS {
            self.locked_until = Some(now + LOCKOUT);
            self.attempts = 0;
        }
    }

    pub fn check_lock(&self, now: Instant) -> Result<(), LoginError> {
        match self.locked_until {
            Some(until) if until > now => Err(LoginError::Locked(until - now)),
            _ => Ok(()),
        }
    }
}'
write src/lib.rs 'pub mod login;
mod util;

pub use login::{LoginError, LoginForm};

pub fn greet(name: &str) -> String {
    format!("Hello, {name}! Please sign in.")
}'
write src/main.rs 'use playground::LoginForm;

fn main() {
    let mut args = std::env::args().skip(1);
    let username = args.next().unwrap_or_default();
    let password = args.next().unwrap_or_default();
    println!("{}", playground::greet(&username));
    match LoginForm::new(&username, &password).validate() {
        Ok(()) => println!("Signed in"),
        Err(err) => eprintln!("Sign-in failed: {err:?}"),
    }
}'
write tests/login.rs 'use playground::{LoginError, LoginForm};
use std::time::Instant;

#[test]
fn rejects_short_passwords() {
    let form = LoginForm::new("alice", "hunter2");
    assert_eq!(form.validate(), Err(LoginError::PasswordTooShort));
}

#[test]
fn locks_after_five_failures() {
    let mut form = LoginForm::new("alice", "correct horse");
    let now = Instant::now();
    for _ in 0..5 {
        form.fail(now);
    }
    assert!(matches!(form.check_lock(now), Err(LoginError::Locked(_))));
}'
write README.md "$(cat README.md)

## Signing in

Run \`cargo run -- <username> <password>\`. Passwords need at least eight
characters, and five failed attempts lock the form for thirty seconds."
as bob edit "$WC"

echo "Playground ready: $ROOT/repo"
echo "Open it in Jig with ⌘T, or: JIG_REPO=$ROOT/repo npm run tauri dev"
