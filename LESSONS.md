# Lessons from real use

Every mistake made with agent-memory in real work becomes an entry here, and then a fix with a
test that fails without it. The tool gets better from what actually went wrong, not from guesses.

## Where the mistakes show up

- `agent-memory guard-log` lists what the shell guard did:
  - `guard: blocked ...`: a block. If it was right, nothing to do. If it was wrong, it is a lesson.
  - `guard: let through by asm-ok (<reason>) ...`: a session said the changes were its own. Read the
    reasons: a reason that keeps coming back is a block the guard should not have made.
  - `guard: let through ... with N recent change(s) nobody here claimed`: changes no session was
    known to own. If someone lost work right after one of these, the guard missed a conflict.
- A session that loses or overwrites another one's work, a hook that slows or breaks a session, a
  briefing that misleads: all of it is a lesson, even when the guard log is silent.

## How to write one

```
## YYYY-MM-DD: <what went wrong, in one line>
What happened: the facts, with commands and files.
Why the tool allowed it (or got in the way): the rule or the gap.
Fix: what changed, in which version.
Test: the test that fails without the fix.
```

---

## 2026-11-08: asm-ok was written where the guard had blocked nothing

What happened: in the Projetos-GitLab workspace, session CC-58964925 ended `git add -A` and
`git switch -q prod` with `# asm-ok: ...` although the guard had blocked nothing (the journal has
no "guard: blocked" line before them; one reason was even "pasta limpa", clean folder). guard-log
printed "guard: let through by asm-ok (...)" for both, which reads as if the guard would have
blocked. Reasons that keep coming back are how a wrong block is found, so asm-ok where nothing was
blocked poisons that analysis.

Why the tool allowed it: the guard recorded every command carrying asm-ok the same way, without
checking whether its rule would have blocked it at all.

Fix (1.5.0): guardShell now runs the same rule for a command carrying asm-ok. When it would have
blocked, the note says "guard: let through by asm-ok (<reason>), would have blocked: <summary>".
When it would not, the note says "guard: asm-ok not needed (<reason>): <command>". The command is
never blocked while asm-ok is present.

Test: `tests/shellguard.test.ts`, "asm-ok with no other session in the checkout is noted as not
needed" and "asm-ok in the incident of 2026-11-07 scenario is noted as would have blocked".

## 2026-11-07: a branch was switched under another session

What happened: two Claude Code sessions worked in the same checkout. Session A had uncommitted
edits (one of them from 4 minutes before) on its branch. Session B ran
`git checkout -b fix/... origin/prod` in the same folder: A's edits moved to B's new branch and A's
next commit would have gone to the wrong place. B noticed only because `git status` showed files it
had not touched, switched back within a minute and messaged A.

Why the tool allowed it: the hooks watched only the edit tools (Write, Edit, MultiEdit,
NotebookEdit). A branch switch is a shell command, and in practice sessions also edit files through
the shell (sed, heredocs), so neither the switch nor A's edits were seen.

Fix (1.5.0): the shell guard. `pre-shell` and `post-shell` hooks on Bash and PowerShell remember
which checkout each session works in and which files its own commands wrote. A git command that
moves a checkout (checkout, switch, stash, reset, restore, pull, merge, rebase, clean, cherry-pick,
revert, am) or sweeps everything into a commit (`add -A`, `add .`, `commit -a`) is refused while
another session works there and there are recent changes this session did not make, or while
another session just moved the branch. `# asm-ok: <why>` at the end lets it through, on record.

Test: `tests/shellguard.test.ts`, "the incident of 2026-11-07".

## 2026-11-07: testing the hooks by hand proved nothing three times

What happened: a manual check of the hooks reported "nothing blocked" three times, and each time
the tool was fine and the check was wrong:

1. `node dist/index.js hook ...` runs the library entry, which prints nothing. The CLI is
   `dist/cli/main.js`.
2. The payload used Git Bash paths (`/c/Users/...`). Claude Code on Windows sends `C:\Users\...`;
   Node reads `/c/Users` as `C:\c\Users`, finds no `.agents/`, and the hook quietly does nothing.
3. A bash heredoc built the JSON, and Git Bash dropped the backslashes of the Windows paths.

Why it matters: a check that cannot fail is worse than no check. A hook that finds no project exits
0 by design (it must never block an editor by mistake), so a wrong payload looks like a pass.

Fix: test hooks the way Claude Code calls them: a Node script that spawns
`node dist/cli/main.js hook claude <event>` and writes `JSON.stringify(payload)` to its stdin, with
paths from `path.join`. Before trusting a "nothing blocked", make the same check block once on
purpose.

Test: not a code change; the unit tests call `runClaudeHook` with `path.join` paths for this reason.

## 2026-11-07: a deleted session still counted as present

What happened: while wiring the shell guard into a real workspace, a throwaway session was used to
test the hooks and then unregistered. Its edit left an INTENT event in the journal, and the guard
read the journal without asking whether that session still existed: for the next 30 minutes it
would have counted as "another session in jva-editora" and could have blocked a real one.

Why: presence came from two places, agent states and journal events, and only the first one knew
about sessions that ended. A journal outlives the sessions that wrote it.

Fix (1.5.0, before release): only sessions that still have a state and did not end (SessionEnd)
count as present, whether seen through the state or through the journal.

Test: `tests/shellguard.test.ts`, "a session that was unregistered blocks nobody".
