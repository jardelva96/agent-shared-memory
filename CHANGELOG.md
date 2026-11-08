# Changelog

## 1.5.0

### The shell guard

Two sessions in the same checkout: one switched the branch while the other had uncommitted work
on it (see LESSONS.md, 2026-11-07). The hooks saw only the edit tools, and both the switch and the
other session's edits went through the shell.

- `pre-shell` and `post-shell` hooks on Bash and PowerShell. Before a command, the session's
  checkouts are noted (following `cd`, `Set-Location` and `git -C`); after a command that may
  write, the files it wrote become the session's own.
- A git command that moves a checkout (checkout, switch, stash, reset, restore, pull, merge,
  rebase, clean, cherry-pick, revert, am) or sweeps everything into a commit (`add -A`,
  `add .`, `commit -a`) is refused while another session works in that checkout and there are
  recent changes this session did not make, or while another session just moved the branch. The
  message lists the files, their age and the sessions seen there.
- `# asm-ok: <why>` at the end of the command lets it through; the reason is kept. guard-log tells
  an asm-ok the guard would have blocked from one that was not needed (`asm-ok not needed`).
- `agent-memory guard-log` lists every block, every asm-ok and every change let through that no
  session claimed: the record to learn from.
- A session that ended (SessionEnd) blocks nobody.
- Quoted text and heredocs are not read as commands. What other sessions see of a command is only
  the programs it ran (`cd && git push`), never its arguments, so a token on a command line is
  not copied anywhere.
- Config: `guardMinutes` (default 30; 0 turns it off) and `primeRules`, which replaces the default
  rules in the session briefing.
- `setup claude --hooks-only` installs the hooks without the MCP server.
- LESSONS.md: every mistake met in real use, why it happened, the fix and its test.

### Sessions that never ended

- A session silent for longer than `forgetOfflineAfterHours` (default 24; 0 keeps them all) that
  holds no claimed task and no reservation is forgotten when a session starts, at most once an
  hour. Its history and journal stay. `agent-memory forget-idle` runs the sweep now.

## 1.4.0

Measured with `bench/desempenho.mjs` (no model involved) on Windows, Node 24.

### Faster

- Every write waited up to 150 ms for files that had never been written (reservations, facts, a
  read cursor), taking it for a file in the middle of being replaced. A write took 203 ms in
  1.3.0; it takes 13 to 17 ms now, and stays there with 8,000 events in the journal.
- Closed tasks are archived: past `maxClosedTasks` (default 200), the oldest move to
  `.agents/tasks/archive/`, unless open work still points at them. With 3,020 tasks on disk,
  claiming a task went from 1.6 s to 27 ms and the session briefing (`prime`) from 1.6 s to
  13 ms. Archived tasks are still read by id and still satisfy dependencies; `task list --all`
  lists them.
- `find`, `refs` and `rename` read the project in parallel and no longer check the size of
  every file: 0.51 s to 0.15 s across 609 files.
- Agent states are read in parallel.
- A write that finds the panel (`SHARED_MEMORY.md`) being regenerated leaves a mark and moves on,
  instead of waiting its turn; the process regenerating it renders again, and a read renders first
  when a mark is left. With 40 agent processes writing at once: 62 to about 120 writes/s, the
  median write from 167 to 60 ms, and the panel still ends up to date.
- A busy lock is retried after about a millisecond, doubling from there, instead of 15 to 50 ms:
  with 5 agents, 109 to 131 writes/s.
- The CLI loads the dashboard, the MCP server, the runner, the watcher and the symbol tools only
  for the command that uses them: a Claude Code hook, which runs on every edit, takes 108 ms
  instead of 143 ms.
- The test suite runs in 9 s instead of 67 s, since the tests waited on the same delays.

### Fixed

- `rename` also renamed longer names that contain the word: renaming `total` turned `subtotal`
  into `subsum`.
- The dashboard no longer scrolls sideways on a phone; the agents table scrolls in its own box.
- Review and queue messages were in Portuguese; they are in English like the rest.

### Inside

- The review gate (panels, votes, rejections) moved from `service.ts` to `reviews.ts`.

## 1.3.0

Every number below was measured on real code (TypeScript, C# and Python projects, about 760
files) against the compilers' own spans, or with free models from three providers working as
agents. The harness is in `bench/`.

### Several machines, live

- `agent-memory hub` shares one memory over HTTP, behind a token, answering only a closed list
  of coordination operations (status, records, messages, the queue, reservations, facts). On
  the other machines `--remote URL --token T`, or `AGENT_MEMORY_REMOTE` and
  `AGENT_MEMORY_TOKEN`, make the CLI, the MCP server and the editor hooks use it. Code is still
  read and edited locally; a file reserved on one machine is refused on another the moment the
  reservation is granted, not after a sync.

### Edits that cannot break a file

- An edit by symbol that would turn a file that parsed into one that does not is refused, with
  the line, and nothing is written: Node checks JavaScript, the project's own TypeScript checks
  TypeScript, Python's ast checks Python, and a bracket-and-string balance check covers the
  rest. In a measured race an agent wrote a regex without its closing slash into a shared file
  and every test of both agents stopped loading.
- `rename <Name> <NewName>` / `memory_rename`: a plan of every line first, `--apply` to write.
  Strings and comments keep the old word; a name declared more than once is refused, since its
  uses cannot be told apart without a type checker.

### An agent that cannot work right now does not fail its task

- An executor that exits 75 (EX_TEMPFAIL: out of quota, rate limited) has its task handed back
  to the queue for another agent, and that runner stops. Measured: an agent ran out of its daily
  quota after writing correct code (10 of 10 hidden tests), and closing the task as FAILED threw
  the work away. The attempt still counts, so a task every agent hands back is dead-lettered.

### Seeing what happened

- `task show <id>` / `memory_task_show`: a task, every review and verdict, and each journal
  entry that names it.
- The live dashboard shows reserved files and project facts.

### Work by symbol, without a language server

- `symbols <file>` / `memory_symbols`: what a file declares, with line ranges. Measured against
  the compilers: it finds 98.5% of TypeScript, 99.8% of Python and 99.96% of C# declarations
  outside function bodies, and 99.6% to 100% of what it lists is a real declaration.
- `find <Name|Type.member>` / `memory_find_symbol` and `refs <Name>` / `memory_references`:
  where a symbol is declared across the project, and where it is used outside strings and
  comments. Dependencies and build output are skipped.
- `memory_replace_symbol` and `memory_insert_symbol`: change one function, method, class or
  property in place. The file is re-read under a lock at the moment of the edit, so changes
  other agents made elsewhere in the file survive. In a measured race, two agents rewriting
  the same file from their own earlier reads erased each other's work; by symbol, both keep it.
- A pointer to a member (`file::Type.member`) is now looked for inside that type first. A
  member's bare name is often also a local somewhere else in the file.

### Pointers return the right code

`memory_read_pointer` returned the exact asked-for declaration 43% of the time in C#, 70% in
TypeScript and 91% in Python. Now 99.4%, 99.3% and 98.8%, and a slice of the wrong code fell from
up to 25% to 0.3% or less. Fixed:

- a type used in a signature outranked its own declaration;
- C# and Java bodies that open on the next line came back as a bare signature;
- `bool Name()` and `string? Name` were read as calls;
- a name inside quotes, a brace inside a regex and `#` read as a comment threw the count off;
- TypeScript without semicolons, multi-line strings and Python constants ran into the next
  declaration;
- decorators on the declaration line (`@IsString() title!: string`) hid the declaration.

### Files are reserved, and the reservation holds where writes happen

- `reserve` / `memory_reserve`: claim files, folders (`src/auth/`) or globs before changing
  them, exclusive or shared, for a limited time. All of them or none. They expire on their own
  and are released when the agent leaves.
- `setup claude`: installs Claude Code hooks and the MCP server in one step.
  - SessionStart hands the agent a briefing (`prime`): how to work here, project facts, who is
    active, which files are reserved, what work is ready.
  - PreToolUse refuses a write to a file another agent reserved, and stops a write once when
    another agent changed the file since, so it is re-read first.
  - PostToolUse records the change, which tells every other agent on the file that its copy is
    stale. SessionEnd releases the session's reservations.
- `setup git`: a pre-commit guard that refuses a commit touching files another agent reserved.

### Agents hear about each other in both directions

An overlap used to reach only the agent that arrived second. The one already on the file never
heard of it, and in a measured run it was that agent that wrote last and erased the other's
work. Now everyone on the file gets an `overlap` message when another agent arrives, and again
on every recorded change.

### The queue

- `--priority 0-4` on tasks: the most urgent ready task is handed out first; reviews inherit it.
- `task ready` / `memory_task_ready`: what an agent could claim right now.
- `remember` / `memory_remember`: facts every session starts with, shown in `prime` and in
  `SHARED_MEMORY.md`.

### Measured with real agents (free models, Groq and OpenRouter)

- Two agents implementing two functions of the same file at the same time, eight rounds with
  the same pairs of models: writing whole files, one erased the other's work in 3 of 7 races
  and 73% of the hidden tests passed; editing by symbol, 0 of 8, 96% of the hidden tests
  passed, and 46% fewer tokens were spent, since an agent writes its function, not the file.
- Reading by pointer instead of whole files: the same answers right, with 66% fewer tokens;
  on the Groq free tier, whole files did not fit at all in 30 of 107 runs.
- Finding code nobody pointed at (only the function's name is known): with a text search kit
  against the symbol tools, the same 14 of 15 paired answers right and 75% fewer tokens with
  the symbol tools; on a 97 kB C# file, 2,354 tokens against 60,076.
- The ten coding tasks again, with tasks in separate files: whole-file writes, edits by symbol
  and edits by symbol with review passed 78, 80 and 82 of 91 hidden tests, a difference within
  chance for one run. The failures were free models answering empty and a daily quota running
  out mid-task, which is what the exit-75 hand-back above now recovers.
- The queue, with four agents from two providers: no task claimed twice, no agent reviewing
  its own work, no task started before its dependency, in 40 audited runs.
