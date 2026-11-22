/**
 * A tool call's processes as terminals (decision 0028, amended 2026-11-21): every process a wrapped
 * tool's `run` starts through `NodeExec` is a terminal of its own, linked to the call, watched and
 * stoppable — and nothing else is. Real processes: `node -e`, so it runs on every platform.
 */
import { describe, expect, it } from "vitest";
import type { Tool } from "@declarative-ai/exec";
import { NodeExec } from "../src/exec";
import { commandLineOf, outsideToolCall, withProcessTerminals } from "../src/toolProcesses";
import type { ShellCallIo, ShellTerminals } from "../src/tools";

interface Opened {
  call: Parameters<ShellTerminals["open"]>[0];
  output: string;
  io?: ShellCallIo;
  end?: { exitCode: number | null; signal: string | null; timedOut: boolean; stopped: boolean };
}

function keeper(): { terminals: ShellTerminals; opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    opened,
    terminals: {
      open: (call) => {
        const one: Opened = { call, output: "" };
        opened.push(one);
        return {
          output: (text) => (one.output += text),
          attach: (io) => (one.io = io),
          ended: (end) => (one.end = end),
        };
      },
    },
  };
}

const node = process.execPath;
const exec = new NodeExec();
// A tool whose run is whatever the case needs — an exec result is no JSON value, and the wrapper passes it through.
const toolOf = (run: (...args: never[]) => unknown): Tool => ({ description: "t", inputSchema: { type: "object" }, readOnly: true, run }) as unknown as Tool;
const call = (tool: Tool, ctx: object = { toolCallId: "toolu_1" }) => (tool as unknown as { run: (input: unknown, ctx: unknown) => Promise<unknown> }).run({}, ctx);

describe("a tool call's processes", () => {
  it("are a terminal each, linked to the call, streamed and ended — and the tool's result is its own", async () => {
    const { terminals, opened } = keeper();
    const tool = withProcessTerminals(
      "git_push",
      toolOf(async () => {
        const a = await exec.run(node, ["-e", "process.stdout.write('one\\n'); process.stderr.write('two\\n')"]);
        const b = await exec.run(node, ["-e", "process.exit(3)"]);
        return { a: a.stdout, b: b.code };
      }),
      terminals,
    );
    expect(await call(tool)).toEqual({ a: "one\n", b: 3 });
    expect(opened.map((one) => one.call)).toEqual([
      expect.objectContaining({ callId: "toolu_1~1", tool: "git_push", call: "toolu_1", dialect: "posix" }),
      expect.objectContaining({ callId: "toolu_1~2", tool: "git_push", call: "toolu_1" }),
    ]);
    expect(opened[0]!.call.command).toContain("-e");
    expect(opened[0]!.output).toContain("one\n");
    expect(opened[0]!.output).toContain("two\n");
    expect(opened[0]!.end).toEqual({ exitCode: 0, signal: null, timedOut: false, stopped: false });
    expect(opened[1]!.end).toMatchObject({ exitCode: 3, stopped: false });
  });

  it("can be stopped from the terminal, and cannot be typed into", async () => {
    const { terminals, opened } = keeper();
    const tool = withProcessTerminals("wait", toolOf(async () => (await exec.run(node, ["-e", "setTimeout(() => {}, 60000)"])).aborted), terminals);
    const pending = call(tool);
    while (opened[0]?.io === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opened[0].io.type("y\n")).toBe(false);
    opened[0].io.stop();
    expect(await pending).toBe(true);
    expect(opened[0].end).toMatchObject({ stopped: true });
  }, 20_000);

  it("are not kept outside a call, for an interactive exec, once the call has answered, or outside it on purpose", async () => {
    const { terminals, opened } = keeper();
    await exec.run(node, ["-e", "0"]);
    let later: (() => Promise<unknown>) | undefined;
    const tool = withProcessTerminals(
      "start",
      toolOf(async () => {
        await exec.run(node, ["-e", "0"], { interactive: () => undefined });
        await outsideToolCall(() => exec.run(node, ["-e", "0"]));
        later = () => exec.run(node, ["-e", "0"]);
        return "ok";
      }),
      terminals,
    );
    await call(tool);
    await later!();
    expect(opened).toEqual([]);
  });

  it("are named by the tool when the call has no id", async () => {
    const { terminals, opened } = keeper();
    await call(withProcessTerminals("list_pipelines", toolOf(async () => exec.run(node, ["-e", "0"])), terminals), {});
    expect(opened[0]?.call).toMatchObject({ callId: "list_pipelines~1", tool: "list_pipelines" });
    expect(opened[0]?.call.call).toBeUndefined();
  });
});

describe("commandLineOf", () => {
  it("leaves plain words as they are and quotes the rest", () => {
    expect(commandLineOf("git", ["push", "https://github.com/a/b.git", "refs/heads/x:refs/heads/x"])).toBe("git push https://github.com/a/b.git refs/heads/x:refs/heads/x");
    expect(commandLineOf("git", ["commit", "-m", "it's done", ""])).toBe("git commit -m 'it'\\''s done' ''");
  });
});
