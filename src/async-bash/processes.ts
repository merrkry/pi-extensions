import { NodeFileSystem, NodeStream } from "@effect/platform-node";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Exit, FileSystem, Option, Scope, Stream } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { Output, type Page } from "./output.ts";

// Match Pi's bash output cadence to keep streaming updates inexpensive.
const OUTPUT_UPDATE_INTERVAL_MS = 100;
const OUTPUT_IDLE_AFTER_EXIT_MS = 100;
/**
 * Bounds capture after the process group exits, for processes outside the group that still hold
 * the output pipes. No group member writes by then, and backpressure kept the backlog to the pipe
 * and stream buffers, which drain in milliseconds, so the deadline never cuts off group output.
 */
const MAX_CAPTURE_AFTER_TREE_EXIT_MS = 1_000;
export const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_INTERVAL_MS = 100;
/**
 * How long a wait that saw the command running continues after its shell exits, so that a command
 * whose descendants are about to exit, or whose capture is ending, still returns its final state.
 * Background processes that outlive it, such as a server, then end the wait as `draining` instead
 * of holding it to its limit.
 */
const SHELL_EXIT_GRACE_MS = MAX_CAPTURE_AFTER_TREE_EXIT_MS + 1_000;
/**
 * A wait ends early once it has seen the command produce no output while its processes used no CPU
 * or I/O for this long: a stalled command needs a decision, and a long wait sized for slow work
 * would otherwise hide it until the wait runs out. It ends early once per quiet stretch, so a wait
 * the caller repeats on purpose runs its full length. Linux only.
 */
export const QUIET_WAKE_MS = 30_000;
const ACTIVITY_SAMPLE_INTERVAL_MS = 1_000;
// CPU use below this share of one core, e.g. a background thread's periodic timer, counts as quiet.
const QUIET_CPU_SHARE = 0.01;
// Linux reports CPU time in USER_HZ, which is 100 on every architecture Node supports.
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Finished sessions kept once their final state has been returned; starting a command removes
 * those seen longest ago with their logs, even when the model never paged their omitted output. Retention is
 * bounded automatically rather than by a release action, so the model never manages lifetimes and
 * no call can leave a session half released. The prompt guidelines state the bound.
 */
export const MAX_REPORTED_SESSIONS = 64;
/**
 * Whether procfs shows this process, and with it the sessions' processes: Linux, unless a sandbox
 * or container left /proc unmounted or empty. Process lists, quiet wake, and exit checks that skip
 * zombies rely on it.
 */
export const PROCFS = process.platform === "linux" && existsSync(`/proc/${process.pid}/stat`);
// Remembers removed ids so later calls can tell them from mistyped ones.
const MAX_REMOVED_IDS = 1024;
// Bounds input queued for a command that is not reading stdin.
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
const EXIT_FAILURE = 1;
// Bash represents signal termination as 128 + the signal number.
const SHELL_SIGNAL_EXIT_BASE = 128;

type Outcome =
  | { state: "exited"; exit_code: number; signal?: NodeJS.Signals }
  | { state: "failed"; error: string };

const preserveOutput = () => {};

export interface Command {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellPath?: string;
  shellCommandPrefix?: string;
  /** Stops the process group once the session has run this long. */
  timeoutMs?: number;
}

/** Why the session's process group was stopped. */
export type StopReason = "kill" | "timeout";

/** `draining`: the shell has exited, but its process group or output capture has not finished. */
export type TaskState = "running" | "draining" | "exited" | "failed";

export type TaskSummary = {
  session_id: string;
  state: TaskState;
  command: string;
  cwd: string;
  pid?: number;
  exit_code?: number;
  signal?: NodeJS.Signals;
  error?: string;
  /** A pipe failure after stdin accepted input; part of that input may have been delivered. */
  input_error?: string;
  /** Set once a kill or the timeout started stopping the process group. */
  stopped_by?: StopReason;
  stdin: "open" | "closed";
  total_bytes: number;
  /** Since the command started, until it finished. */
  runtime_seconds: number;
  /** The time limit set with the command, if any. */
  timeout_seconds?: number;
  /**
   * Up to a few processes still running in the group, where procfs shows them, in results a call
   * returns; empty once the group has exited, on every system.
   */
  processes?: Member[];
  /** Since the last output, or since the start when there was none. */
  idle_seconds: number;
  full_output_path: string;
};

/** What a result returned to the caller showed. */
type Shown = Pick<TaskSummary, "state" | "input_error"> & { cursor_bytes?: number };

const seconds = (milliseconds: number) => Math.round(milliseconds / 1000);

/** A process still running in a session's process group. */
export type Member = { pid: number; command: string; state: string };

export type ProcessResult = TaskSummary &
  Page & {
    /** Why this write call wrote nothing. */
    input_refused?: string;
    /** Set when the wait ended early because the command was quiet this long; see QUIET_WAKE_MS. */
    quiet_seconds?: number;
  };

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

function terminateTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    return Effect.callback<void, Error>((resume) => {
      if (!child.pid) return resume(Effect.void);
      const killer = spawn(
        join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(child.pid)],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", (error) => resume(Effect.fail(error)));
      killer.once("close", (code) => {
        // The command may have exited before taskkill reaches it.
        resume(
          code === 0 || child.exitCode !== null || child.signalCode !== null
            ? Effect.void
            : Effect.fail(new Error(`taskkill failed for PID ${child.pid}: exit code ${code}`)),
        );
      });
    });
  }
  // ESRCH: the group has exited. EPERM: only another user's processes remain, which no signal
  // reaches; like members KILL cannot end, they are left to the monitor.
  return Effect.try(() => {
    if (child.pid) process.kill(-child.pid, signal);
  }).pipe(
    Effect.catchIf(
      (error) => {
        const code = errorCode(error.cause);
        return code === "ESRCH" || code === "EPERM";
      },
      () => Effect.void,
    ),
  );
}

/**
 * Whether a process in the group can still run. A zombie keeps its group signalable until its
 * parent reaps it, and the reaper of an orphan, such as a container's PID 1, may never do so;
 * Linux exposes process states to skip zombies, while other systems count them as alive. EPERM
 * means the group exists but only has members of another user, e.g. after a setuid program.
 */
function groupAlive(fs: FileSystem.FileSystem, pgid: number) {
  return Effect.gen(function* () {
    const probe = yield* Effect.try(() => {
      process.kill(-pgid, 0);
      return "signalable" as const;
    }).pipe(
      Effect.catchIf(
        (error) => {
          const code = errorCode(error.cause);
          return code === "ESRCH" || code === "EPERM";
        },
        (error) => Effect.succeed(errorCode(error.cause) === "EPERM" ? "foreign" : "gone"),
      ),
    );
    // Only signalable groups can consist of zombies alone; procfs may hide another user's
    // processes, e.g. when mounted with hidepid, so it cannot overrule EPERM.
    if (probe !== "signalable") return probe === "foreign";
    if (!PROCFS) return true;
    const pids = fs
      .readDirectory("/proc")
      .pipe(Effect.map((entries) => entries.filter((entry) => /^\d+$/u.test(entry))));
    // The fields after the parenthesized command name start with state, ppid, and pgrp.
    const stat = (pid: string) =>
      fs
        .readFileString(`/proc/${pid}/stat`)
        .pipe(
          Effect.option,
          Effect.map(Option.map((text) => text.slice(text.lastIndexOf(")") + 2).split(" "))),
        );
    // Without procfs, e.g. in some containers, zombies count as alive as on other systems.
    const listed = yield* Effect.option(pids);
    if (Option.isNone(listed)) return true;
    const before = listed.value;
    for (const pid of before) {
      const fields = yield* stat(pid);
      if (
        Option.isSome(fields) &&
        Number(fields.value[2]) === pgid &&
        !(yield* exited(fs, Number(pid), fields.value[0]!))
      ) {
        return true;
      }
    }
    // A member alive after the scan was either listed before it, and so found live, or appeared
    // during it. Count any process that appeared and is in the group, or has already gone, as live.
    const known = new Set(before);
    for (const pid of yield* pids.pipe(Effect.orElseSucceed(() => [] as string[]))) {
      if (known.has(pid)) continue;
      const fields = yield* stat(pid);
      if (Option.isNone(fields) || Number(fields.value[2]) === pgid) return true;
    }
    return false;
  });
}

const MAX_LISTED_MEMBERS = 4;
const MAX_MEMBER_COMMAND_CHARS = 80;
// Linux process states, as /proc/<pid>/stat reports them for the main thread. A zombie that is
// listed has threads left; see `exited`.
const PROCESS_STATES: Record<string, string> = {
  R: "running",
  S: "sleeping",
  D: "waiting on I/O",
  T: "stopped",
  t: "stopped",
  I: "idle",
  Z: "main thread exited",
};

/**
 * A process's kernel wait channel, without the suffixes compiler optimizations add to function
 * names, such as `.constprop.0`, so the tables below match; empty when it runs or is unreadable.
 */
function waitChannel(fs: FileSystem.FileSystem, pid: number, thread = pid) {
  return fs.readFileString(`/proc/${pid}/task/${thread}/wchan`).pipe(
    Effect.map((text) => {
      const name = text.trim();
      return name === "0"
        ? ""
        : name.replace(/(?:\.(?:constprop|isra|part|cold|lto_priv)\.\d+)+$/u, "");
    }),
    Effect.orElseSucceed(() => ""),
  );
}

// Wait channels of a process blocked reading a pipe, socket, or terminal.
const READ_WAIT_CHANNELS = new Set([
  "pipe_read",
  "anon_pipe_read",
  "pipe_wait_readable",
  "sk_wait_data",
  "unix_stream_read_generic",
  "unix_stream_data_wait",
  "n_tty_read",
]);

// Wait channels of a process waiting for a child to exit.
const CHILD_WAIT_CHANNELS = new Set(["do_wait", "kernel_wait4"]);

/**
 * What common kernel wait channels mean for a blocked command; others show by their kernel name.
 * Names differ between kernel versions, so several map to one meaning.
 */
const WAIT_CHANNELS: Record<string, string> = {
  wait_for_partner: "opening a FIFO that no process has opened from the other end",
  pipe_read: "reading from a pipe",
  anon_pipe_read: "reading from a pipe",
  pipe_wait_readable: "reading from a pipe",
  pipe_write: "writing to a full pipe",
  anon_pipe_write: "writing to a full pipe",
  pipe_wait_writable: "writing to a full pipe",
  do_wait: "waiting for a child process to exit",
  kernel_wait4: "waiting for a child process to exit",
  hrtimer_nanosleep: "sleeping on a timer",
  do_nanosleep: "sleeping on a timer",
  futex_wait_queue: "waiting on a lock or condition variable",
  futex_wait_queue_me: "waiting on a lock or condition variable",
  futex_do_wait: "waiting on a lock or condition variable",
  do_select: "waiting for I/O in select",
  do_sys_poll: "waiting for I/O in poll",
  poll_schedule_timeout: "waiting for I/O in select or poll",
  do_epoll_wait: "waiting for I/O in epoll",
  ep_poll: "waiting for I/O in epoll",
  inet_csk_accept: "waiting for a network connection",
  sk_wait_data: "reading from a socket",
  unix_stream_read_generic: "reading from a socket",
  unix_stream_data_wait: "reading from a socket",
  n_tty_read: "reading from a terminal",
  locks_lock_inode_wait: "waiting for a file lock",
  flock_lock_inode_wait: "waiting for a file lock",
  posix_lock_inode_wait: "waiting for a file lock",
  sigsuspend: "waiting for a signal",
  do_sigtimedwait: "waiting for a signal",
};

/**
 * System calls that wait for input, by the numbers /proc/<pid>/syscall reports. `reads` read from
 * the file descriptor in their first argument: read, readv, pread64, recvfrom, and recvmsg.
 * `splices`, splice, does too, as GNU cat does, but can also block on its output, so it counts only
 * in a wait channel that reads. `selects`, select and pselect6, take one more than the highest descriptor
 * they watch, so 1 means stdin alone, as in Bash's `read -t`. Other architectures skip the check
 * for reads from stdin.
 */
const INPUT_SYSCALLS: Partial<
  Record<
    NodeJS.Architecture,
    { reads: ReadonlySet<number>; splices: ReadonlySet<number>; selects: ReadonlySet<number> }
  >
> = {
  x64: {
    reads: new Set([0, 19, 17, 45, 47]),
    splices: new Set([275]),
    selects: new Set([23, 270]),
  },
  arm64: { reads: new Set([63, 65, 67, 207, 212]), splices: new Set([76]), selects: new Set([72]) },
};

type ProcStat = {
  pid: number;
  name: string;
  state: string;
  ppid: number;
  pgrp: number;
  /** CPU time in clock ticks, including that of children it has reaped. */
  cpuTicks: number;
};

function parseStat(pid: number, text: string): ProcStat {
  // The fields after the parenthesized command name start with state, ppid, and pgrp; utime,
  // stime, cutime, and cstime are the 12th to 15th.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const [state = "", ppid, pgrp] = fields;
  return {
    pid,
    name: text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")),
    state,
    ppid: Number(ppid),
    pgrp: Number(pgrp),
    cpuTicks: fields.slice(11, 15).reduce((sum, value) => sum + Number(value), 0),
  };
}

/** The processes in a process group, as procfs shows them. Linux only. */
function groupStats(fs: FileSystem.FileSystem, pgid: number) {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
    const stats: ProcStat[] = [];
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const text = yield* fs.readFileString(`/proc/${entry}/stat`).pipe(Effect.option);
      if (Option.isNone(text)) continue;
      const stat = parseStat(Number(entry), text.value);
      if (stat.pgrp === pgid) stats.push(stat);
    }
    return stats;
  });
}

/**
 * What a process group has done so far: which processes it has, their CPU time, and their I/O,
 * undefined when procfs hides the I/O of a live member.
 */
type Activity = { at: number; pids: string; cpuTicks: number; ioBytes: number | undefined };

function sampleActivity(fs: FileSystem.FileSystem, pgid: number) {
  return Effect.gen(function* () {
    const stats = yield* groupStats(fs, pgid);
    let ioBytes: number | undefined = 0;
    for (const stat of stats) {
      // rchar and wchar count bytes passed through read and write calls, including pipes and
      // sockets; procfs hides them for processes the caller may not trace, such as one run with
      // sudo or one that made itself non-dumpable, like ssh.
      const io = yield* fs.readFileString(`/proc/${stat.pid}/io`).pipe(Effect.option);
      if (Option.isNone(io)) {
        if (stat.state !== "Z") ioBytes = undefined;
        continue;
      }
      if (ioBytes === undefined) continue;
      for (const match of io.value.matchAll(/^[rw]char: (\d+)$/gmu)) ioBytes += Number(match[1]);
    }
    return {
      at: performance.now(),
      pids: stats.map((stat) => stat.pid).join(","),
      cpuTicks: stats.reduce((sum, stat) => sum + stat.cpuTicks, 0),
      ioBytes,
    } satisfies Activity;
  });
}

/**
 * Whether the group did anything between two samples, beyond the CPU use QUIET_CPU_SHARE allows.
 * Hidden I/O counts as activity, so a group whose I/O cannot be seen never counts as quiet.
 */
function active(before: Activity, after: Activity) {
  const allowedTicks = ((after.at - before.at) / 1000) * CLOCK_TICKS_PER_SECOND * QUIET_CPU_SHARE;
  return (
    before.pids !== after.pids ||
    after.ioBytes === undefined ||
    after.ioBytes !== before.ioBytes ||
    after.cpuTicks - before.cpuTicks > allowedTicks
  );
}

/**
 * Which input a blocked process waits for: `session` when it reads the session's stdin pipe through
 * any descriptor, `stdin` when it reads other input on descriptor 0, such as a file or FIFO the
 * command redirected. Linux on x64 and arm64 only.
 */
function inputWait(
  fs: FileSystem.FileSystem,
  pid: number,
  thread: number,
  sessionStdin: string | undefined,
) {
  return Effect.gen(function* () {
    const calls = INPUT_SYSCALLS[process.arch];
    if (calls === undefined) return undefined;
    const text = yield* fs
      .readFileString(`/proc/${pid}/task/${thread}/syscall`)
      .pipe(Effect.option);
    if (Option.isNone(text)) return undefined;
    const [number, first, readSet] = text.value.trim().split(" ").map(Number);
    let fd: number | undefined;
    if (calls.reads.has(number!)) fd = first;
    else if (calls.splices.has(number!)) {
      if (READ_WAIT_CHANNELS.has(yield* waitChannel(fs, pid, thread))) fd = first;
    } else if (calls.selects.has(number!) && first === 1 && readSet) fd = 0;
    if (fd === undefined) return undefined;
    const target = yield* fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.option);
    if (sessionStdin !== undefined && Option.getOrUndefined(target) === sessionStdin) {
      return "session" as const;
    }
    return fd === 0 ? ("stdin" as const) : undefined;
  });
}

export const SESSION_INPUT_STATE =
  "waiting for input on the session's stdin, which process write sends and eof closes";
const INPUT_STATES = { session: SESSION_INPUT_STATE, stdin: "waiting for input on its stdin" };

/**
 * The pipe a session's stdin is, as procfs names it, to tell it from other input a process reads,
 * such as a file or FIFO the command redirected. Read synchronously once spawn returns, while the
 * shell is still starting, well before it evaluates the command. Linux only.
 */
function sessionStdin(pid: number | undefined) {
  if (!PROCFS || pid === undefined) return undefined;
  try {
    return readlinkSync(`/proc/${pid}/fd/0`);
  } catch {
    return undefined;
  }
}

/**
 * What a process's threads wait for, beyond the main thread procfs reports for the process: the
 * input any of them reads, and whether a thread other than the main one is running.
 */
function threadWaits(fs: FileSystem.FileSystem, pid: number, stdin: string | undefined) {
  return Effect.gen(function* () {
    let input: "session" | "stdin" | undefined;
    let otherRuns = false;
    const threads = yield* fs
      .readDirectory(`/proc/${pid}/task`)
      .pipe(Effect.orElseSucceed(() => [String(pid)]));
    for (const thread of threads) {
      const text = yield* fs.readFileString(`/proc/${pid}/task/${thread}/stat`).pipe(Effect.option);
      if (Option.isNone(text)) continue;
      const state = parseStat(Number(thread), text.value).state;
      if (state === "R" && thread !== String(pid)) otherRuns = true;
      if ((state === "S" || state === "D") && input !== "session") {
        input = (yield* inputWait(fs, pid, Number(thread), stdin)) ?? input;
      }
    }
    return { input, otherRuns };
  });
}

/**
 * Whether a process has exited, leaving a zombie for its parent to reap. A main thread that ended
 * with pthread_exit also shows as a zombie, while the process's other threads still run.
 */
function exited(fs: FileSystem.FileSystem, pid: number, state: string) {
  if (state !== "Z") return Effect.succeed(false);
  return fs.readDirectory(`/proc/${pid}/task`).pipe(
    Effect.map((threads) => threads.length <= 1),
    Effect.orElseSucceed(() => true),
  );
}

/**
 * Processes still running in a session's process group, so a result can show what it waits on. The
 * shell running the command is left out while it waits for a child, and subshells it forked are
 * named as such rather than by the launcher's argv. Linux only.
 */
function groupMembers(fs: FileSystem.FileSystem, pgid: number, stdin: string | undefined) {
  return Effect.gen(function* () {
    // A zombie has exited; only its parent's wait remains, which kill cannot shorten.
    const live: ProcStat[] = [];
    for (const stat of yield* groupStats(fs, pgid)) {
      if (!(yield* exited(fs, stat.pid, stat.state))) live.push(stat);
    }
    const waits = [];
    for (const stat of live) waits.push({ stat, ...(yield* threadWaits(fs, stat.pid, stdin)) });
    // Processes waiting for the model's input come first, so the listing limit never hides them.
    waits.sort((a, b) => Number(b.input === "session") - Number(a.input === "session"));
    const members: Member[] = [];
    for (const { stat, input, otherRuns } of waits) {
      const blocked = stat.state === "S" || stat.state === "D";
      if (members.length === MAX_LISTED_MEMBERS) break;
      const cmdline = yield* fs
        .readFileString(`/proc/${stat.pid}/cmdline`)
        .pipe(Effect.orElseSucceed(() => ""));
      const argv = cmdline.split("\0").filter(Boolean);
      let command = argv.join(" ") || stat.name;
      const channel = blocked ? yield* waitChannel(fs, stat.pid) : "";
      if (argv.at(-1) === LAUNCH_SCRIPT) {
        // The group leader still running the launcher is the shell, left out while it waits for
        // the other members it started; one a command replaced with exec is the program.
        if (stat.pid !== pgid) command = `${stat.name} (subshell of the command)`;
        else if (live.length > 1 && CHILD_WAIT_CHANNELS.has(channel)) continue;
        else command = `${stat.name} (the command's shell)`;
      }
      if (command.length > MAX_MEMBER_COMMAND_CHARS) {
        command = `${command.slice(0, MAX_MEMBER_COMMAND_CHARS)} …`;
      }
      let state = PROCESS_STATES[stat.state] ?? stat.state;
      if (channel) state = WAIT_CHANNELS[channel] ?? `${state} in ${channel}`;
      // procfs reports the main thread's state; another thread may be the one computing, and any
      // may read input.
      if (otherRuns && stat.state !== "R")
        state = `running in another thread; main thread ${state}`;
      // A program reading the session's stdin waits for input that only the model can send. The
      // session's stdin stays open, so the wait never ends otherwise.
      if (input) state = `${INPUT_STATES[input]}${otherRuns ? "; another thread is running" : ""}`;
      members.push({ pid: stat.pid, command, state });
    }
    return members;
  });
}

/**
 * A session's lifecycle. Each step only moves forward, and only the session's monitor finishes it.
 * `draining`: the shell has exited, but its process group or output capture has not finished;
 * `groupExited` marks that the process group has exited and only output capture remains.
 */
type Phase =
  | { tag: "running" }
  | { tag: "draining"; outcome: Outcome; groupExited?: true }
  | {
      tag: "finished";
      outcome: Outcome;
      finishedAt: number;
      captureError?: string;
      seenAt?: number;
    };

class Task {
  private phase: Phase = { tag: "running" };
  private readonly exited = Deferred.makeUnsafe<Outcome>();
  private readonly finished = Deferred.makeUnsafe<void>();
  private readonly killRequested = Deferred.makeUnsafe<void>();
  private stopReason: StopReason | undefined;
  private readonly startedAt = performance.now();
  /** A stdin failure after a write call accepted input, until a returned result shows it. */
  private inputError: string | undefined;
  /** End of the output that returned results showed, where reads continue by default. */
  private shown = 0;
  /** Bytes written to stdin and not yet flushed; Bun leaves `writableLength` at zero. */
  queuedInput = 0;
  /**
   * Where the last wait that ended early for a quiet stretch saw it end; see QUIET_WAKE_MS. Until
   * output or activity follows, including between waits, no other wait ends early.
   */
  private reportedQuiet: { activity: Activity; outputBytes: number } | undefined;

  constructor(
    readonly id: string,
    readonly command: Command,
    readonly child: ChildProcessWithoutNullStreams,
    readonly output: Output,
    private readonly fs: FileSystem.FileSystem,
    /** See `sessionStdin`. */
    private readonly stdin: string | undefined,
  ) {
    // Node resumes unread stdio on exit. Retain it until Effect attaches its readers.
    child.stdout.on("readable", preserveOutput);
    child.stderr.on("readable", preserveOutput);
    child.once("exit", (code, signal) => {
      let exitCode = code ?? EXIT_FAILURE;
      if (code === null && signal) {
        const signalNumber = constants.signals[signal];
        if (signalNumber !== undefined) exitCode = SHELL_SIGNAL_EXIT_BASE + signalNumber;
      }
      this.exit(
        signal
          ? { state: "exited", exit_code: exitCode, signal }
          : { state: "exited", exit_code: exitCode },
      );
    });
    child.once("error", (error) => this.exit({ state: "failed", error: error.message }));
    // A failed write destroys stdin, which then reports as closed.
    child.stdin.on("error", () => {});
  }

  private exit(outcome: Outcome) {
    if (this.phase.tag !== "running") return;
    this.phase = { tag: "draining", outcome };
    Deferred.doneUnsafe(this.exited, Effect.succeed(outcome));
  }

  get isFinished() {
    return this.phase.tag === "finished";
  }

  get state(): TaskState {
    return this.phase.tag === "finished" ? this.phase.outcome.state : this.phase.tag;
  }

  get stdinOpen() {
    const stdin = this.child.stdin;
    return (
      this.phase.tag === "running" && !stdin.destroyed && !stdin.errored && !stdin.writableEnded
    );
  }

  summary(): TaskSummary {
    const phase = this.phase;
    const now = phase.tag === "finished" ? phase.finishedAt : performance.now();
    const lastOutput = this.output.lastAppendAt ?? this.startedAt;
    const outcome = phase.tag === "running" ? undefined : phase.outcome;
    const error =
      outcome?.state === "failed"
        ? outcome.error
        : phase.tag === "finished" &&
          phase.captureError &&
          `Output capture failed: ${phase.captureError}`;
    return {
      session_id: this.id,
      state: this.state,
      command: this.command.command,
      cwd: this.command.cwd,
      ...(this.child.pid ? { pid: this.child.pid } : {}),
      ...(outcome?.state === "exited"
        ? {
            exit_code: outcome.exit_code,
            ...(outcome.signal ? { signal: outcome.signal } : {}),
          }
        : {}),
      ...(error ? { error } : {}),
      ...(this.inputError ? { input_error: this.inputError } : {}),
      ...(this.stopReason ? { stopped_by: this.stopReason } : {}),
      stdin: this.stdinOpen ? "open" : "closed",
      total_bytes: this.output.totalBytes,
      runtime_seconds: seconds(now - this.startedAt),
      ...(this.command.timeoutMs === undefined
        ? {}
        : { timeout_seconds: this.command.timeoutMs / 1000 }),
      ...(phase.tag === "draining" && phase.groupExited ? { processes: [] } : {}),
      idle_seconds: seconds(Math.max(0, now - lastOutput)),
      full_output_path: this.output.path,
    };
  }

  /**
   * Marks what a result returned to the caller showed. Only the caller knows whether a result
   * reaches it: streaming updates, cancelled calls, and cleanup observe without returning.
   */
  acknowledge(shown: Shown) {
    if (shown.cursor_bytes !== undefined) this.shown = Math.max(this.shown, shown.cursor_bytes);
    if (this.phase.tag === "finished" && (shown.state === "exited" || shown.state === "failed")) {
      this.phase.seenAt ??= performance.now();
    }
    if (shown.input_error !== undefined && this.inputError === shown.input_error) {
      this.inputError = undefined;
    }
  }

  /** Where output continues after what returned results showed. */
  get shownCursor() {
    return this.shown;
  }

  stdinFailed(message: string) {
    this.inputError ??= message;
  }

  /** Whether the caller has yet to see this session's final state or a stdin failure. */
  get unreported() {
    return (
      (this.phase.tag === "finished" && this.phase.seenAt === undefined) ||
      this.inputError !== undefined
    );
  }

  /** When a returned result first showed the final state, for retention by recency. */
  get seenAt() {
    return this.phase.tag === "finished" && !this.unreported ? this.phase.seenAt : undefined;
  }

  /**
   * Reads without marking anything as shown; see `acknowledge`. Results a call returns also list
   * the processes still running in the group, which streaming updates skip to stay cheap.
   */
  observe(cursor: number, from: "cursor" | "end", withProcesses = false) {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        // Observe state before output, so a finished state always comes with the final bytes.
        const phase = this.phase;
        const summary = this.summary();
        const page = yield* this.output.page(cursor, from);
        const pgid = this.child.pid;
        const live = summary.state === "running" || summary.state === "draining";
        const result: ProcessResult = { ...summary, ...page };
        if (
          !withProcesses ||
          !live ||
          summary.processes !== undefined ||
          pgid === undefined ||
          !PROCFS
        ) {
          return result;
        }
        const members = yield* groupMembers(this.fs, pgid, this.stdin);
        // A lifecycle step during the scan, such as the group's exit, which every view and kill
        // count only once the monitor records it, is observed again, so the result shows one
        // moment. The lifecycle has few steps, so this repeats at most a few times.
        if (this.phase !== phase) continue;
        return members.length ? { ...result, processes: members } : result;
      }
    });
  }

  /**
   * Completes with the quiet stretch's length once this wait has seen the command quiet for
   * QUIET_WAKE_MS, unless an earlier wait already ended for the same stretch. Output or activity
   * starts a new stretch.
   */
  private quietStretch(waitMs: number) {
    const pgid = this.child.pid;
    if (!PROCFS || pgid === undefined || waitMs <= QUIET_WAKE_MS) {
      return Effect.never;
    }
    return Effect.gen({ self: this }, function* () {
      let previous = yield* sampleActivity(this.fs, pgid);
      let since = previous.at;
      let outputBytes = this.output.totalBytes;
      // Between waits, CPU use counts against the same share over the whole gap, so a brief burst
      // that leaves the command idle again keeps its stretch; output or I/O ends it.
      const reported = this.reportedQuiet;
      if (
        reported &&
        (reported.outputBytes !== outputBytes || active(reported.activity, previous))
      ) {
        this.reportedQuiet = undefined;
      }
      while (true) {
        yield* Effect.sleep(ACTIVITY_SAMPLE_INTERVAL_MS);
        const sample = yield* sampleActivity(this.fs, pgid);
        if (this.output.totalBytes !== outputBytes || active(previous, sample)) {
          outputBytes = this.output.totalBytes;
          since = sample.at;
          this.reportedQuiet = undefined;
        }
        previous = sample;
        if (this.reportedQuiet === undefined && sample.at - since >= QUIET_WAKE_MS) {
          this.reportedQuiet = { activity: sample, outputBytes };
          return seconds(sample.at - since);
        }
      }
    });
  }

  /**
   * Waits until the command finishes, `until` completes, the command goes quiet, or `waitMs`
   * elapses. A wait that starts while the shell runs also ends shortly after the shell exits,
   * leaving any background processes draining; a wait that starts while they drain lasts until
   * they exit.
   */
  wait(
    waitMs: number,
    cursor: number,
    onUpdate?: (result: ProcessResult) => void,
    until: Effect.Effect<unknown> = Effect.never,
  ) {
    return Effect.gen({ self: this }, function* () {
      const shellExit =
        this.phase.tag === "running"
          ? Deferred.await(this.exited).pipe(Effect.andThen(Effect.sleep(SHELL_EXIT_GRACE_MS)))
          : Effect.never;
      let quietSeconds: number | undefined;
      const quiet = this.quietStretch(waitMs).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            quietSeconds = value;
          }),
        ),
      );
      const finished = Effect.raceAllFirst([
        Deferred.await(this.finished),
        shellExit,
        until,
        quiet,
      ]).pipe(Effect.timeoutOption(waitMs));
      if (!onUpdate) {
        yield* finished;
      } else {
        const output = this.output;
        const observe = () => this.observe(cursor, "end");
        const updates = Effect.gen(function* () {
          let reported = output.totalBytes;
          while (true) {
            yield* Effect.sleep(OUTPUT_UPDATE_INTERVAL_MS);
            if (output.totalBytes === reported) continue;
            reported = output.totalBytes;
            onUpdate(yield* observe());
          }
        });
        yield* Effect.raceFirst(finished, updates);
      }
      const result = yield* this.observe(cursor, "end", true);
      // A command that finished as the wait ended was not stalled.
      const live = result.state === "running" || result.state === "draining";
      return quietSeconds !== undefined && live
        ? { ...result, quiet_seconds: quietSeconds }
        : result;
    });
  }

  /**
   * Requests termination and waits until the session finishes. The monitor carries the
   * termination out, so cancelling this wait never stops a TERM from escalating to KILL.
   */
  kill() {
    return this.requestStop("kill").pipe(Effect.andThen(Deferred.await(this.finished)));
  }

  /**
   * The first request decides the reason; a session whose process group has exited has nothing
   * left to stop.
   */
  private requestStop(reason: StopReason) {
    return Effect.suspend(() => {
      const groupRuns =
        this.phase.tag === "running" || (this.phase.tag === "draining" && !this.phase.groupExited);
      if (!groupRuns) return Effect.void;
      this.stopReason ??= reason;
      return Deferred.succeed(this.killRequested, undefined);
    });
  }

  /**
   * Waits for every process in the shell's process group. Processes that leave the group, e.g.
   * through setsid, escape both this wait and group signals, as they do in Pi's own bash; only
   * their hold on the output pipes is bounded, by MAX_CAPTURE_AFTER_TREE_EXIT_MS.
   */
  private waitForTreeExit() {
    if (process.platform === "win32") return Deferred.await(this.exited).pipe(Effect.asVoid);
    const pid = this.child.pid;
    const fs = this.fs;
    return Effect.gen(function* () {
      while (pid && (yield* groupAlive(fs, pid))) {
        yield* Effect.sleep(TERMINATION_POLL_INTERVAL_MS);
      }
    });
  }

  /**
   * The only driver of the lifecycle: captures output, carries out a requested termination, and
   * finishes the session once its process group has exited and capture has ended. It then closes
   * `scope`, which holds the child process.
   */
  monitor(scope: Scope.Closeable) {
    return Effect.gen({ self: this }, function* () {
      const { child, output } = this;
      const terminated = Deferred.makeUnsafe<void>();
      const treeExited = Deferred.makeUnsafe<void>();
      const captureDeadline = Deferred.makeUnsafe<void>();

      const timeoutMs = this.command.timeoutMs;
      if (timeoutMs !== undefined) {
        // The limit covers the process group. Output still arriving from processes that left it,
        // e.g. through setsid, is not the command running past its limit.
        // Group exit is polled, so the group may have exited just before the limit unnoticed.
        const pid = child.pid;
        const groupStillRuns =
          pid === undefined || process.platform === "win32"
            ? Effect.succeed(true)
            : groupAlive(this.fs, pid);
        yield* Effect.forkChild(
          Effect.raceFirst(
            Effect.sleep(timeoutMs).pipe(
              Effect.andThen(groupStillRuns),
              Effect.flatMap((alive) => (alive ? this.requestStop("timeout") : Effect.void)),
            ),
            Deferred.await(treeExited),
          ),
        );
      }
      yield* Effect.forkChild(
        Deferred.await(this.killRequested).pipe(
          Effect.andThen(terminateTree(child, "SIGTERM")),
          Effect.andThen(this.waitForTreeExit().pipe(Effect.timeoutOption(TERMINATION_GRACE_MS))),
          Effect.flatMap((exited) =>
            Option.isNone(exited) ? terminateTree(child, "SIGKILL") : Effect.void,
          ),
          Effect.ignore,
          Effect.ensuring(Deferred.succeed(terminated, undefined)),
        ),
      );
      yield* Effect.forkChild(
        Effect.gen({ self: this }, function* () {
          yield* Deferred.await(this.exited);
          // After KILL, members still in the group are zombies or unkillable; waiting longer
          // cannot help.
          yield* Effect.raceFirst(this.waitForTreeExit(), Deferred.await(terminated));
          yield* Deferred.succeed(treeExited, undefined);
          if (this.phase.tag === "draining") this.phase = { ...this.phase, groupExited: true };
          yield* Effect.sleep(MAX_CAPTURE_AFTER_TREE_EXIT_MS);
          yield* Deferred.succeed(captureDeadline, undefined);
        }),
      );

      const chunks = Stream.merge(
        NodeStream.fromReadable({
          evaluate: () => {
            child.stdout.off("readable", preserveOutput);
            return child.stdout;
          },
        }).pipe(Stream.map((data) => ({ data, channel: "stdout" as const }))),
        NodeStream.fromReadable({
          evaluate: () => {
            child.stderr.off("readable", preserveOutput);
            return child.stderr;
          },
        }).pipe(Stream.map((data) => ({ data, channel: "stderr" as const }))),
      );
      // Once the process group has exited, an idle pull or the deadline ends capture. Both only
      // stop waiting for writers outside the group; see MAX_CAPTURE_AFTER_TREE_EXIT_MS.
      const read = Stream.transformPull(chunks, (pull) =>
        Effect.succeed(
          Effect.raceFirst(
            pull,
            Effect.raceFirst(
              Deferred.await(treeExited).pipe(
                Effect.andThen(Effect.sleep(OUTPUT_IDLE_AFTER_EXIT_MS)),
              ),
              Deferred.await(captureDeadline),
            ).pipe(Effect.andThen(Cause.done())),
          ),
        ),
      ).pipe(Stream.runForEach(({ data, channel }) => output.append(data, channel)));

      const captureError = yield* Effect.gen(function* () {
        yield* read;
        // Background processes that closed their output still keep the session draining.
        yield* Deferred.await(treeExited);
        yield* output.finish();
        return undefined;
      }).pipe(
        Effect.catchCause((cause) =>
          terminateTree(child, "SIGKILL").pipe(
            Effect.ignore,
            Effect.as(String(Cause.squash(cause))),
          ),
        ),
      );
      const outcome = yield* Deferred.await(this.exited);
      // Shell exit does not end a requested grace period for its descendants.
      if (Deferred.isDoneUnsafe(this.killRequested)) yield* Deferred.await(terminated);
      yield* Scope.close(scope, Exit.void);
      this.phase = {
        tag: "finished",
        outcome,
        finishedAt: performance.now(),
        ...(captureError ? { captureError } : {}),
      };
      yield* Deferred.succeed(this.finished, undefined);
    });
  }
}

// The shell reads the command from here, then removes it from the command's environment.
const COMMAND_VARIABLE = "PI_BASH_COMMAND";
// The shell's last argument, by which process listings recognize it and its subshells.
const LAUNCH_SCRIPT = `__pi_bash_command=$${COMMAND_VARIABLE}; unset ${COMMAND_VARIABLE}; eval "unset __pi_bash_command; $__pi_bash_command"`;

/**
 * How to start a command. The shell evaluates the command from the environment, so the command's
 * text stays out of every argv: `pgrep -f` and `pkill -f` patterns written in a command would
 * otherwise match the shell running it. The launcher is POSIX shell syntax, which the Bash that
 * `shellPath` names accepts.
 */
function launcher(shell: { shell: string; args: string[] }, command: Command) {
  const text = command.shellCommandPrefix
    ? `${command.shellCommandPrefix}\n${command.command}`
    : command.command;
  const env: NodeJS.ProcessEnv = {
    ...command.env,
    TERM: "dumb",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    [COMMAND_VARIABLE]: text,
  };
  return { file: shell.shell, args: [...shell.args, LAUNCH_SCRIPT], env };
}

export const makeProcesses = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.make();
  const tasks = new Map<string, Task>();
  const removed = new Set<string>();
  let closed = false;

  // Pi can exit without session_shutdown, e.g. when its terminal disappears. Exit handlers must be
  // synchronous, so only the shell is reached on Windows, which has no process groups.
  const killOnExit = () => {
    for (const task of tasks.values()) {
      if (task.isFinished || !task.child.pid) continue;
      try {
        process.kill(process.platform === "win32" ? task.child.pid : -task.child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  // Acquired first, so closing the scope removes the handler last: Pi may exit while shutdown is
  // still waiting out a termination grace period.
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("exit", killOnExit)),
    () => Effect.sync(() => process.off("exit", killOnExit)),
  ).pipe(Scope.provide(scope));
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-bash-" }).pipe(
    Scope.provide(scope),
    // Nothing else closes the scope when initialization fails.
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );

  const get = (id: string) =>
    Effect.suspend(() => {
      const task = tasks.get(id);
      if (task) return Effect.succeed(task);
      return Effect.fail(
        new Error(
          removed.has(id)
            ? `Session ${id} was removed to keep the ${MAX_REPORTED_SESSIONS} most recently seen finished sessions`
            : `Unknown session: ${id}`,
        ),
      );
    });

  // Rejects invalid cursors before an action changes anything.
  const checked = (id: string, cursor: number) =>
    get(id).pipe(Effect.tap((task) => task.output.checkCursor(cursor)));

  // Pruning can remove a session's log under an observation that found the session first.
  const live =
    (id: string) =>
    <A>(effect: Effect.Effect<A, Error>) =>
      effect.pipe(
        Effect.catchIf(
          () => removed.has(id) && !tasks.has(id),
          (error) => get(id).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

  // Callers take sessions out of the map before removing their logs, so concurrent removals never
  // claim the same session. An interrupted removal leaves only a file that shutdown removes.
  const removeLogs = (stale: Task[]) =>
    Effect.forEach(stale, (task) => fs.remove(task.output.path).pipe(Effect.ignore), {
      discard: true,
    }).pipe(Effect.uninterruptible);

  const prune = Effect.suspend(() => {
    const seen = [...tasks.values()]
      .filter((task) => task.seenAt !== undefined)
      .sort((a, b) => a.seenAt! - b.seenAt!);
    const stale = seen.slice(0, Math.max(0, seen.length - MAX_REPORTED_SESSIONS));
    for (const task of stale) {
      tasks.delete(task.id);
      removed.add(task.id);
      if (removed.size > MAX_REMOVED_IDS) removed.delete(removed.values().next().value!);
    }
    return removeLogs(stale);
  });

  const refuse = (task: Task, cursor: number, reason: string) =>
    task
      .observe(cursor, "end", true)
      .pipe(Effect.map((result): ProcessResult => ({ ...result, input_refused: reason })));

  return {
    start: (command: Command) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.fail(new Error("Bash session is shutting down"));
        const shell = yield* Effect.try(() => getShellConfig(command.shellPath));
        if (shell.commandTransport === "stdin") {
          return yield* Effect.fail(
            new Error(
              "This bash requires stdin for commands; set shellPath to Git Bash to keep task stdin writable",
            ),
          );
        }
        yield* prune;
        const id = randomUUID();
        const taskScope = yield* Scope.fork(scope);
        const path = join(directory, `${id}.log`);
        const task = yield* Effect.gen(function* () {
          const output = yield* Output.make(fs, path, taskScope);
          return yield* Effect.acquireRelease(
            Effect.try(() => {
              const launch = launcher(shell, command);
              const child = spawn(launch.file, launch.args, {
                cwd: command.cwd,
                env: launch.env,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
              });
              return new Task(id, command, child, output, fs, sessionStdin(child.pid));
            }),
            (task) =>
              terminateTree(task.child, "SIGKILL").pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    task.child.stdin.destroy();
                    task.child.stdout.destroy();
                    task.child.stderr.destroy();
                  }),
                ),
                Effect.orDie,
              ),
          ).pipe(Scope.provide(taskScope));
        }).pipe(
          Effect.onError((cause) =>
            Scope.close(taskScope, Exit.failCause(cause)).pipe(
              Effect.andThen(fs.remove(path).pipe(Effect.ignore)),
            ),
          ),
        );
        tasks.set(id, task);
        // The monitor owns the task scope once the command has started.
        yield* Effect.forkIn(task.monitor(taskScope), scope);
        return task;
      }).pipe(Effect.uninterruptible),

    poll: (
      id: string,
      waitMs: number,
      cursor: number,
      onUpdate?: (result: ProcessResult) => void,
    ) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => task.wait(waitMs, cursor, onUpdate)),
        live(id),
      ),

    read: (id: string, cursor: number) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => task.observe(cursor, "cursor", true)),
        live(id),
      ),

    write: (
      id: string,
      chars: string,
      eof: boolean,
      waitMs: number,
      cursor: number,
      onUpdate?: (result: ProcessResult) => void,
    ) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => {
          if (!task.stdinOpen) {
            return refuse(task, cursor, "stdin is closed");
          }
          const queued = task.queuedInput;
          const bytes = Buffer.byteLength(chars);
          if (queued + bytes > MAX_QUEUED_INPUT_BYTES) {
            return refuse(
              task,
              cursor,
              `${bytes} more bytes would exceed ${MAX_QUEUED_INPUT_BYTES} bytes of stdin the command has not read; ${queued} are queued`,
            );
          }
          // The pipe can fail after accepting input, e.g. once the command closes stdin, by which
          // time the command may have read part of it. Results report the failure until one is
          // acknowledged, even when it arrives after this call returns. Bun reports no failure
          // when the pipe has no reader; the input is then lost silently.
          const rejected = Deferred.makeUnsafe<void>();
          const settled = (error?: Error | null) => {
            if (!error) return;
            task.stdinFailed(error.message);
            Deferred.doneUnsafe(rejected, Effect.void);
          };
          if (chars) {
            task.queuedInput += bytes;
            task.child.stdin.write(chars, (error) => {
              task.queuedInput -= bytes;
              settled(error);
            });
          }
          if (eof) task.child.stdin.end(settled);
          return task.wait(waitMs, cursor, onUpdate, Deferred.await(rejected));
        }),
        live(id),
      ),

    /** Stops a session; `waitMs` bounds the wait for it to finish, which goes on regardless. */
    kill: (id: string, cursor: number, waitMs?: number) =>
      checked(id, cursor).pipe(
        Effect.tap((task) =>
          waitMs === undefined ? task.kill() : task.kill().pipe(Effect.timeoutOption(waitMs)),
        ),
        Effect.flatMap((task) => task.observe(cursor, "end", true)),
        live(id),
      ),

    /** Removes a finished session whose whole output the caller has already received. */
    discard: (id: string) =>
      Effect.suspend(() => {
        const task = tasks.get(id);
        // Pruning may already have removed it.
        if (!task) return Effect.void;
        if (!task.isFinished) return Effect.die(new Error(`${id} is running`));
        tasks.delete(id);
        return removeLogs([task]);
      }),

    list: Effect.sync(() => [...tasks.values()].map((task) => task.summary())),

    /** Records what a result returned to the caller showed; the session may be gone by then. */
    acknowledge: (shown: Shown & Pick<TaskSummary, "session_id">) =>
      Effect.sync(() => tasks.get(shown.session_id)?.acknowledge(shown)),

    /** Where output continues after what returned results showed. */
    shownCursor: (id: string) => get(id).pipe(Effect.map((task) => task.shownCursor)),

    /** Sessions that still need the caller's attention. */
    pending: Effect.sync(() => {
      const running: TaskSummary[] = [];
      const unreported: TaskSummary[] = [];
      for (const task of tasks.values()) {
        if (!task.isFinished) running.push(task.summary());
        else if (task.unreported) unreported.push(task.summary());
      }
      return { running, unreported };
    }),

    shutdown: Effect.gen(function* () {
      closed = true;
      yield* Effect.forEach(tasks.values(), (task) => task.kill(), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Scope.close(scope, Exit.void);
      tasks.clear();
    }),
  };
}).pipe(Effect.provide(NodeFileSystem.layer));

export type Processes = Effect.Success<typeof makeProcesses>;
