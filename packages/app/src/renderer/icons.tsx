/**
 * The line icons the transcript reads with.
 *
 * Inline SVG rather than a font or an icon package: the renderer already ships a sanitiser and a
 * markdown parser, and a whole dependency for nine glyphs is a bad trade — especially in a
 * privileged renderer, where every package added is a package that can reach the preload bridge.
 *
 * They are all 24×24, all stroked with `currentColor`, and none of them carry a fill. That is what
 * lets a row say what it is by colouring one span: a failed call turns its icon red without knowing
 * which icon it drew.
 *
 * Icons here NEVER appear alone. Every one of them sits beside the word it illustrates — a terminal
 * next to `bash`, an eye next to `Read` — because a transcript is read at a glance for shape and
 * then in words for fact, and a glyph on its own is a guess.
 */
import type { JSX } from "react";
import { brandHex, brandMark, brandOf } from "./brands";
import type { WorkIconName } from "./transcript";

/**
 * The path data, one entry per glyph.
 *
 * The names come from `transcript.ts` rather than being declared here, so the exhaustiveness check
 * runs in the direction that matters: the model decides what a row can BE, and this table fails to
 * compile if it cannot draw one of them. A view is allowed to know about the model. Not the reverse.
 */
const PATHS: Record<WorkIconName | "chevron" | "check" | "cross" | "send" | "model" | "shield" | "anthropic" | "openai" | "lock" | "unlocked" | "star" | "pencil" | "plan", string[]> = {
  terminal: ["M4 17l6-6-6-6", "M12 19h8"],
  read: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  write: ["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"],
  web: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M2 12h20", "M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "m21 21-4.3-4.3"],
  agent: ["M5 8h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z", "M12 8V4", "M9 13v2", "M15 13v2"],
  tool: ["M14.6 6.3a1 1 0 0 0 0 1.4l1.7 1.7a1 1 0 0 0 1.4 0l4-4a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z"],
  think: ["m12 3 1.8 4.4L18 9.2l-4.2 1.8L12 15.4l-1.8-4.4L6 9.2l4.2-1.8Z", "M18.5 15.5 19.4 18l2.1.9-2.1.9-.9 2.2-.9-2.2-2.1-.9 2.1-.9Z"],
  note: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5", "M12 8h.01"],
  alert: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 8v5", "M12 16.5h.01"],
  chevron: ["m6 9 6 6 6-6"],
  send: ["M12 19V5", "m5 12 7-7 7 7"],
  // A model is a box of weights you pick between; a shield is the permission posture; a spark is how
  // hard it thinks. Each sits beside its own word, never alone — see the module header.
  model: ["m12 3 8 4.5v9L12 21l-8-4.5v-9Z", "M12 12l8-4.5", "M12 12v9", "M12 12 4 7.5"],
  shield: ["M12 3l7 3v6c0 4-3 6.6-7 9-4-2.4-7-5-7-9V6Z"],
  // The permission postures, each drawn as what it MEANS rather than as a rank. A shut lock is
  // "ask me every time"; the same lock with its shackle open is "go ahead"; a star is the approver
  // deciding per call; an eye reads and cannot write; a pencil writes without asking; a ruled page
  // is plan-only. Somebody scanning these is asking what the agent may DO, not which tier it is on.
  lock: ["M6 11h12v9H6z", "M9 11V7a3 3 0 0 1 6 0v4"],
  unlocked: ["M6 11h12v9H6z", "M9 11V7a3 3 0 0 1 5.9-.7"],
  star: ["m12 3 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8Z"],
  pencil: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z", "M14.5 6.5 17.5 9.5"],
  plan: ["M6 3h9l4 4v14H6z", "M9 9h6", "M9 13h6", "M9 17h4"],
  // Anthropic's mark, taken from the vetted `simple-icons` set that findmyprompt generates its
  // provider glyphs from — traced by hand it would be a worse copy of a logo people know exactly.
  // Used for the routes that ARE Anthropic: the provider, and `claude-cli`, which is the same
  // company's agent on a subscription.
  // OpenAI's mark, restored from its canonical path the way findmyprompt does — simple-icons no
  // longer ships it for trademark reasons. Used for the OpenAI routes and for `codex-cli`, which is
  // the same company's agent.
  openai: ["M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"],
  anthropic: ["M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"],
  check: ["M20 6 9 17l-5-5"],
  cross: ["M18 6 6 18", "M6 6l12 12"],
};

/**
 * One glyph.
 *
 * `aria-hidden`, always: the word beside it is the accessible name, and a screen reader announcing
 * "image, terminal" before the word `bash` is noise rather than help.
 */
export function Icon({ name, className }: { name: keyof typeof PATHS; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={name === "anthropic" || name === "openai" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "anthropic" || name === "openai" ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * A company's mark — the real logo, or a brand-tinted initial when there is none.
 *
 * Never nothing. A catalog carries fifty vendors and the picker's columns are read by scanning the
 * left edge; a row with no glyph breaks that scan and reads as a different KIND of row rather than as
 * a company we happen to have no logo for. The badge says "a vendor" honestly, where a hand-traced
 * approximation of a logo people know would just be wrong.
 *
 * `currentColor` is deliberately NOT used for the real marks: a brand is its colour as much as its
 * shape, and a monochrome Anthropic mark beside a monochrome Google one loses the thing that makes
 * either recognisable at 12px.
 */
export function BrandIcon({ name, className }: { name: string; className?: string }): JSX.Element {
  const company = brandOf(name);
  const mark = brandMark(company);
  if (mark !== undefined) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill={mark.hex} aria-hidden>
        <path d={mark.path} />
      </svg>
    );
  }
  const hex = brandHex(company);
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill={hex ?? "currentColor"} opacity={hex === undefined ? 0.18 : 0.9} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="600"
        fill={hex === undefined ? "currentColor" : "#fff"}
        fontFamily="system-ui, sans-serif"
      >
        {company.charAt(0).toUpperCase()}
      </text>
    </svg>
  );
}
