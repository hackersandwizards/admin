---
name: retro
description: >-
  Review every run in a window, unattended and attended, from its transcript, and edit the artifact
  behind each verified defect ("retro", "weekly retro", "what did the schedules do").
---

# Retro

Every artifact this repository's agents run on is in scope: skills, rules, agent files, memory,
`CLAUDE.md` and the routines themselves. A routine is reachable two ways, its SKILL.md and its
cadence, and a finding can name either.

A finding needs evidence of what happened: a run or a session. Reading the text of an artifact or a
memory file alone finds none, and the only lint here is section 5's prompt audit of this run's own
files.

Runs live in Claude Code transcripts under `~/.claude/projects/<escaped-cwd>/*.jsonl`, one JSON
object per line, session id in the filename. The window covers this repository's runs: the project
directories whose escaped path is this checkout or one of its worktrees, and the routines whose
schedule names this repository as working directory. The argument `all` reads every project
directory. A T3 thread on Codex or agy,
started by hand or as a child of another thread, has no Claude transcript: its record is T3's
database `~/.t3/userdata/statev2.sqlite`, tables `orchestration_v2_projection_threads` (provider,
title, `$.lineage.parentThreadId` in `payload_json`), `orchestration_v2_projection_runs` (status
per run) and `orchestration_v2_projection_messages` (role, `$.text` in `payload_json`). Read it
with `sqlite3 -readonly`, naming the columns, and never select `webhook_token` or `webhook_secret`
from any table.

Everything below is the transcripts: how a run behaved, and in section 4 what people corrected.
Both feed section 5 and one report.

## Finding an unattended run

A run started by hand is reviewed like a scheduled one: the markers below only tell the two apart.

**T3.** A T3 scheduled run's first `user` line starts with `[T3 Code: scheduled task
"scheduled-task:<id>" sent this prompt, not the user typing in this chat.]`, then on its own line
`Scheduled run <name>: read ~/.claude/schedules/<name>.md and carry it out.`, in a transcript whose lines carry
`entrypoint: "t3-code"`. Select candidate files with `rg -l 'Scheduled run '` over the project
directories and apply both properties to the decoded first `user` line. The name in the line is the
schedule; key on `sessionId` as below. A person typing the `Scheduled run` line starts the same run by hand, without the bracketed line.

**Claude Desktop.** A routine start is one harness-written line. Require all four properties:

- `type: "user"`
- the file's first `user` line, whose `parentUuid` is null or names the `attachment` line a
  `SessionStart` hook writes ahead of it
- content **starting with** `<scheduled-task name="NAME" file="/path/to/SKILL.md">`
- content carrying `This is an automated run of a scheduled task.`

Select candidate files by grepping `<scheduled-task name=` and stop the pattern there. The line is
JSON, so its content escapes every `"`, and a grep carrying the quote after `name=` matches nothing
at all. Apply the four properties to the decoded content, never to the raw line.

The marker string on its own is not enough. It also appears on a `queue-operation` duplicate of
every start, on mid-session lines that quote it, and at the head of a hand-typed message that
pastes it. Neither `promptSource` nor `origin.kind` replaces the four properties.

The marker names both the routine and the SKILL.md that owns the behaviour. **Key on `sessionId`,
never on the routine name:** a rename is delete-plus-create, so one job can run under two names
inside one window.

**The attendance cut.** The first `user` line after the marker with `origin.kind == "human"` is
where a person took the run over. A T3 Code session (`entrypoint: "t3-code"`) writes the person's
typed turns with no `origin` field: there they are the plain-text `user` lines, never a tool result
or `<…>`-wrapped command output, a line carrying `isMeta` or `isCompactSummary`, or one starting
`Delegated task node:` or `Update on pull request`, which T3 Code writes itself: 153 of one
session's 825 plain-text lines were typed. The first of them can be a brief an orchestrating agent
wrote: read it before counting it. A message the person types while the agent works is on no `user`
line: it is an `attachment` line whose `attachment.type` is `queued_command` with `humanTurn: true`,
its text in `attachment.prompt`. Count it as a person's turn, for the cut and for section 4: 56
of one window's 178 person turns sat on such lines.

## 1. Window

A date or range argument names the window to review; `all` sets only the scope. Without a date, the start is the earlier of `now - 7 days`
and the `Window start:` the instruction carries. Where it carries `Window start: none` in any form or no such line, take the 7 days and say so; the report names the start it reached.

`git log` is the dedupe, and nothing else is: a second ledger drifts from git. Where the previous retro
ran recently, the window overlaps it almost entirely: read its report out of the corpus first and
start from what it left open. `Window start:` counts only scheduled runs: a retro started by hand shows in `git log`.

Exclude your own session: it carries the marker too.

The scope binds every source below: without `all`, keep only the T3 threads and scheduled tasks
whose project or schedule names this repository, so a dispatch for another repository is neither a
run nor a missed one.

**T3's missed and failed runs.** `sqlite3 -readonly ~/.t3/userdata/statev2.sqlite "select title,
last_run_status, last_run_error, last_run_at, next_run_at from scheduled_tasks"`. A fixed-time run
more than ten minutes late is dropped, not caught up, and shows here as the task's last error. The
table keeps only each task's last run: compare the runs found per schedule against its `cron` line
in `~/.claude/schedules/<name>.md` for the rest of the window, and count a slot with no run while
the task was enabled as missed.

**Claude Desktop's missed runs.** Cross-check against the app's log, `~/Library/Logs/Claude/main*.log`, not `lastRunAt`, which
the app stamps even on a dispatch that never started. Each `Spawning new session for scheduled
task` line is a dispatch. One followed by `Cleared stale pending dispatch` started no session: count
it as a missed run. A run started by hand logs `Confirmed task run` with no dispatch line, which is
no missed run. Any other dispatch without a session in the corpus means the marker query is
broken. Report that, never "nothing to review". Where the log folder is empty or starts after the
window, grep `~/Library/Logs/mole/operations.log` for `Logs/Claude` first. Where it shows the cleaner
removed them, report the cross-check as not possible and compare the cron in Claude Desktop's `list_scheduled_tasks` against the
runs found. A `Not auto-approving` line before the run's attendance cut is a permission prompt
nobody was there to answer, and the run waited on it until the app aborted it, up to seven days.

This machine's logs, database and transcripts hold only the tasks registered here: a colleague's tasks run on
their own machine, so a task absent here is no missed run.

## 2. Read

Three stages. Stop at the first that answers.

0. The `<task-notification>` blocks in the parent session, whose `<result>` is the delegate's own
   self-report including its judgment calls, and whose `<status>` names how it ended. This is the
   primary read, and usually the only one. The blocks sit on four line types, `queue-operation`,
   `user`, `attachment` and `assistant`: extract from all four or you miss whole runs.
   Deduplicate on the `<task-id>` and `<status>` child elements, which the tag carries as elements
   and not as attributes, since a resumed agent notifies again under the same id. Keep every
   distinct `<result>` under each pair, in order: a delegate that waits on its own background work
   notifies `completed` with a one-line note before its report and again after it.
   A background Bash command and a `Monitor` stream notify through the same tag, with the same
   `failed` value. Read `<summary>` first: a delegate's opens `Agent "`, and only a delegate's
   block holds a self-report or grades. A `Monitor` event carries no `<status>` element.
1. `tool_result` with `is_error == true` under `subagents/*.jsonl`, only where stage 0 marked
   something.
2. One named subagent, only where stage 0 or 1 points at it: its `text` blocks, and from its
   `tool_use` blocks the tool name and `file_path` alone, never the whole `.input`.

A T3 thread without a Claude transcript reads the same way: its `orchestration_v2_projection_runs`
status stands for stage 0's `<status>`, its last `assistant` message for the self-report, and a child
thread (`$.lineage.parentThreadId`) for a delegate.

**Never load:** the payload of an `attachment` line, `skill_listing` above all, which bars the body
and not the `<task-notification>` block stage 0 lifts out of it or a queued person's turn; `tool_result` without `is_error`;
`toolUseResult.originalFile`, `.file.content`, `tool-results/*.txt`; `assistant.thinking`. Ignore
`system` lines carrying `api_error`, and every `stop_hook_summary`.

## 3. Grade

> With the information available at run time, would a change to the artifact that owns the
> behaviour have removed the reported obstacle, or prevented the demonstrably wrong result?

- **A, verified defect, gets edited, by its owner (section 5).** Needs a quotable artifact line *and* a quotable run line.
  These qualify: the run names the owning artifact itself, a delegate `failed`, `killed` or
  `stopped` **that never notifies `completed` under the same `task-id` afterwards** (a resumed
  agent leaves its interrupted notification standing), an `is_error` whose cause is an instruction,
  such as a path the skill names and that does not exist, two artifacts contradict each other and
  the run followed the wrong one, a memory line the run relied on and proved false, a run that
  names the instruction that blocked an otherwise permitted step it needed to finish. So does a
  failure that cost a run twice and that the run left unrepaired: the same command or tool failing
  twice, re-deriving what a file, memory or earlier run held, turns without progress on the goal,
  the same sequence of three or more steps by hand, a workaround around a failing script. The same
  failure across several runs ranks above one seen once. Date the line
  first, `git log -S` in its own repository: one repaired after the run that reported it is no
  finding, and most repairs land hours later in the very session the run reported to. Date a rule
  against the records it governs too: a rule written after the records it is said to have failed
  on never bound them. A run that flags its own finding as already fixed is usually right, so
  verify the commit and move on.
- **B, hypothesis, no edit.** A long judgment-calls list, a duration outlier, a report that reads
  uneasy. Becomes a question at the end of the report.
- **C, not the artifact.** Case facts, a foreign system, connection noise. One line, no edit.

Never write the concrete case into the artifact you edit.

An edit to a skill, rule, agent or memory file that a person's correction calls for is allowed in
any run, unattended included, and is graded on its content, never on whether the run's approval
named it.

A hypothesis gets no file of its own. Only the durable part, "this shape is normal for this
routine, do not raise it again", goes in your own memory.

## 4. Every run

Grade every run in the window by section 3, attended sessions included: a person's turns in a run
are evidence, not the end of its review. A turn that corrects, refines or reverses the agent's work
counts as saved when a later commit carries it (`git log -S`). Delegate this read, with a report of counts, session ids, owner and proposed line only.
Grade the previous retro's commits too: one whose named failure recurs in this window is a grade-A
finding against its own line, to correct or revert.

## 5. Act

- One commit per finding, so a bad edit reverts alone, and one sync per hub finding, since a sync
  lands everything new in one commit per repository. The fix is a line in the artifact that owns
  the behaviour, never a new hook or validator.
- **Bidirectional, without a quota.** Ground for deleting: a line the run departed from while
  being right is evidence against the line, not against the run.
- Never create, delete or disable a routine: propose it.
- Before a hub edit, read `git -C ~/.claude status`: commit only what this run authored, leave
  another session's work alone and report it.
- A hub edit's commit in this repository records only the finding, never the hub lines.
- A skill in another repository is out of reach: report its path and the exact proposed line.
- A finding in a file this repository's own rules assign to another owner, without granting this
  run the repair: hand that owner the file, the exact line, the proposed line and the run that
  showed the defect. The owner edits it. Correct the rest directly, and name each repair in a file
  you do not own to its owner.
- Never re-run the run under review. Verification is read-only against artifact and repository.
- Before committing, call `Skill` yourself with `skill: "claude-api"` and
  `args: "prompt-audit <path> ..."` over every file this run edited or flagged: without paths it
  audits the whole working directory. Its high and medium findings join that file's commit or
  handover. A harness without that skill reads the same files for contradiction, ambiguity and a
  missing stop condition itself, and the report says so.

## 6. Report

Re-run the marker scan first: an hourly routine fires mid-run and changes the corpus. Then: runs reviewed, unattended and attended apart, scheduled runs per runner (Claude Desktop, T3)
and missed ones, how many unattended ones a person
took over, counts of A, B and C, and the
commits with the finding each one carries. B findings are the closing questions. `12 reviewed, 0 grade-A, 0 commits`
is a complete run, and so is a week ending with neither an addition nor a deletion. Never
manufacture a finding to justify the run.

**And the person's turns:** how many lessons they held, how many were unsaved, and the
lines handed to an owner, printed every week until the owner acts.

## Nothing leaves the transcript

No message or transcript text goes into a record, and a commit message and a memory line are
records. This corpus holds client data, mail and chat messages
verbatim. Quote the artifact and cite a run by `sessionId` and timestamp. A session the
person declared private yields nothing: no fact, name, quote, session id or inference from it enters
a report, an edit, memory or a commit.
