import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { ModuleApproval } from "@jaira/shared/browser";
import type { ApprovalSurfaceProps } from "@jaira/ui/approvalSurfaceTypes";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { ApprovalSurface } from "./ApprovalSurface";
import { GateTitle } from "./GateTitle";
import { ModalBox } from "./Modal";

const SUB = { voice: "app", scale: 11 / 12.5, color: "dim" } as const;

/**
 * A command approval no conversation can host (a request that names no task) in a modal — the task's id
 * over it, when there is one, then the surface. Not dismissed by the scrim: it is answered.
 */
export function ApprovalDialog({ staged = false, ...props }: ApprovalSurfaceProps & { staged?: boolean }): JSX.Element {
  return (
    <ModalBox staged={staged} label="Approve this command?">
      {props.pending.taskId !== undefined ? <Txt spec={SUB}>{props.pending.taskId}</Txt> : null}
      <ApprovalSurface {...props} />
    </ModalBox>
  );
}

/**
 * The js/ts modules a workflow is about to call, before anything has run — each file's source in full,
 * and Approve and run or Cancel. How it looks:
 *
 *   the dialog           the wide one (`ModalBox`)
 *   its head             the heading with its shield (`GateTitle`); the lines under it app 11/12.5 --dim
 *   a file's source      --bg, 1px --line, radius 8, padding 10, 12 above (and 1em below), data 12/12,
 *                        pre-wrap, at most 320 tall, scrolling
 *   the buttons          row, wrapping, gap 8, 14 above: a plain one, then a `danger` one; the error --bad
 */
export function ModuleApprovalDialog({
  files,
  error,
  onApprove,
  onCancel,
  staged = false,
}: {
  files: readonly ModuleApproval[];
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
  staged?: boolean;
}): JSX.Element {
  const t = useTokens();
  const changed = files.filter((f) => f.previousHash !== undefined).length;
  const em = Number(t.scaled("size-data", 1)) || 12;
  return (
    <ModalBox wide staged={staged} testID="module-approval" label="Run this workflow's TypeScript?">
      <GateTitle icon="shield">Run this workflow&apos;s TypeScript?</GateTitle>
      <Txt spec={SUB}>
        {files.length === 1 ? "1 file" : `${files.length} files`}
        {changed > 0 ? ` · ${changed} changed since you approved it` : ""} · nothing has run yet
      </Txt>
      {files.map((file, i) => (
        // A file's line stands under the previous source's 1em (inside the file's box: a flex item's own
        // children's margins do not collapse out of it).
        <View key={file.file} flexDirection="column" marginTop={i > 0 ? em : 0}>
          <Txt spec={SUB}>
            {/* A text node per piece, as the reference pictures have them: Chromium shapes each run apart. */}
            {file.file}
            {" —"}
            {" "}
            {file.previousHash !== undefined ? "changed since you approved it" : "never approved"}
            {file.symbols !== undefined && file.symbols.length > 0 ? ` · calls ${file.symbols.join(", ")}` : ""}
          </Txt>
          <View
            marginTop={12}
            padding={10}
            maxHeight={320}
            backgroundColor={t.v("bg") as never}
            borderRadius={8}
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
            {...((isWeb ? { overflow: "auto" } : { overflow: "hidden" }) as object)}
          >
            <Txt spec={{ voice: "data", scale: 1 }} {...((isWeb ? { whiteSpace: "pre-wrap" } : {}) as object)}>
              {file.source}
            </Txt>
          </View>
        </View>
      ))}
      {/* The wide dialog is a flex column, so nothing collapses: the last source's 1em stands, and 14 more. */}
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={files.length > 0 ? em + 14 : 14}>
        <Button onPress={onApprove}>Approve and run</Button>
        <Button kind="danger" onPress={onCancel}>
          Cancel
        </Button>
      </View>
      {error ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} marginTop={11}>
          {error}
        </Txt>
      ) : null}
    </ModalBox>
  );
}
