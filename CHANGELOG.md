# Changelog

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
