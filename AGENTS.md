<!-- rkm:begin -->
<!-- rkm:branch "_rkm" -->
## Repository knowledge (RKM)

Specs, decisions, todos, bugs, roadmaps, process notes and contributor guides
are **not in this checkout**. They live on `_rkm` in a separate checkout
shared by this clone's code workspaces.
RKM paths elsewhere in this file, such as `rkm/spec/x.md`, refer to that bundle.

```bash
export RKM_ACTOR="agent/model"   # replace with your agent/model identity
B=$(rkm path)                    # locate the bundle
rg "search term" "$B"            # search knowledge
jj -R "$B/.." status           # review pending edits
rkm conventions                  # read and follow the full rules
```

Read `$B/index.md` and relevant specs, decisions and process notes before working.
Create, rename, retype, close and delete through `rkm`; edit bodies by hand.
`rkm commit` commits everything pending in the bundle, including other sessions'
edits. Review its status first. Knowledge commits stay separate from code
commits and are never merged into them.
When code finishes a todo or fixes a bug, run `rkm close <id> --note
"<commit-or-change-id>"` in the same session.
Push policy: Push only when explicitly authorized.
Missing configured checkouts are recreated from existing history. A new clone
needs the fetched knowledge branch and a global workspace parent or explicit
setup location; unavailable history or an occupied location requires action.
Keep repository-specific rules outside this managed section.
<!-- rkm:end -->
