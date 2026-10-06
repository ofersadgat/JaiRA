import { useState, type ComponentType, type JSX } from "react";
import { CONFIG_SECTIONS } from "@jaira/shared/browser";
import type { Schema, SchemaFormContext } from "@jaira/ui/schemaForm/types";
import { FormRowsContext, SchemaForm, Select, SelectInput, SettingsGroup } from "@jaira/universal";

/**
 * The schema form's field kinds as specimens (decision 0015): `SchemaForm`, drawn from a fixture and
 * holding its own value, so every kind can be seen and pressed.
 *
 *  - `form-fields` — a form as a run's inputs or a gate draws it: required marks, the switch of an
 *    optional member (one left out), every leaf control, a union's shape chips, and a complaint under
 *    its box; `form-lists` — the same form's list of values, list of rows that open and close, map
 *    and nested object.
 *  - `form-rows` — the same renderer on a Settings page: layered (no switches, a ↺ where the layer
 *    states a value), each field a settings row inside a card.
 *  - `selects` — Chromium's menulist, as a config box (`SelectInput` with `fill`: as wide as the column,
 *    as a field, disabled) and as the plain `Select` the Logs bar uses: the text's inset and line, and
 *    the arrow (`MenulistArrow`), one for both.
 */

const FIELDS: Schema = {
  type: "object",
  required: ["title", "count"],
  properties: {
    title: { type: "string", title: "title", description: "What the task is called. Shown on its card and in the inbox." },
    count: { type: "integer", title: "count", minimum: 0, description: "How many drafts to write." },
    ratio: { type: "number", title: "ratio", minimum: 0, maximum: 1 },
    strict: { type: "boolean", title: "strict", description: "Refuse anything the schema does not name." },
    depth: { type: "boolean", title: "go deeper" },
    mode: { type: "string", enum: ["fast", "careful", "thorough"], title: "mode" },
    notes: { type: "string", contentMediaType: "text/plain", title: "notes", description: "Anything the drafter should know." },
    seed: { title: "seed", description: "Any value: a word, a number, a list." },
    target: {
      title: "target",
      anyOf: [
        { type: "string" },
        { type: "object", properties: { path: { type: "string", title: "path" }, line: { type: "integer", title: "line" } } },
      ],
    },
    tags: { type: "array", title: "tags", items: { type: "string" } },
    steps: {
      type: "array",
      title: "steps",
      items: { type: "object", properties: { id: { type: "string", title: "id" }, timeout: { type: "integer", title: "timeout" } } },
    },
    env: { type: "object", title: "environment", additionalProperties: { type: "string" } },
    limits: {
      type: "object",
      title: "limits",
      properties: { attempts: { type: "integer", title: "attempts" }, wait: { type: "number", title: "wait (s)" } },
    },
  },
};

const FIELDS_VALUE = {
  title: "Plan the checkout",
  count: -1,
  ratio: 0.5,
  strict: true,
  mode: "careful",
  notes: "Keep the old flow working.",
  seed: "significant",
  target: "src/checkout.ts",
  tags: ["lint", "sync"],
  steps: [{ id: "draft", timeout: 3600 }],
  env: { NODE_ENV: "test" },
  limits: { attempts: 3, wait: 1.5 },
};

const FIELDS_CTX: Omit<SchemaFormContext, "path"> = {
  errors: [{ path: "count", message: "must be at least 0" }],
};

/** Two Settings blocks, merged, on the Shared layer, which states two of their values. */
const ROWS = ["archive", "storage"].map((key) => CONFIG_SECTIONS.find((s) => s.key === key)!);
const ROWS_VALUE: Record<string, unknown> = {
  archive: { auto: true, keep: 5, failedAfterDays: 2, succeededAfterDays: 1 },
  storage: { journal: "db", conversations: "file", tasks: "db", artifacts: "file", format: "claude" },
};
const STATED = new Set(["archive.keep", "storage.conversations"]);

function useValue<T>(initial: T): [T, (next: T) => void] {
  return useState<T>(initial);
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [key, ...rest] = path.split(".");
  const next = { ...doc };
  if (rest.length === 0) {
    if (value === undefined) delete next[key!];
    else next[key!] = value;
  } else next[key!] = setPath((doc[key!] ?? {}) as Record<string, unknown>, rest.join("."), value);
  return next;
}

/** The fixture cut in two, each shorter than the window (a taller capture tiles): the leaves, and the lists and objects. */
const LEAVES = ["title", "count", "ratio", "strict", "depth", "mode", "notes", "seed", "target"];
function part(keys: readonly string[] | null): Schema {
  const props = FIELDS["properties"] as Record<string, Schema>;
  const kept = Object.keys(props).filter((k) => (keys === null ? !LEAVES.includes(k) : keys.includes(k)));
  return { ...FIELDS, properties: Object.fromEntries(kept.map((k) => [k, props[k]!])), required: (FIELDS["required"] as string[]).filter((k) => kept.includes(k)) };
}

function fieldsOf(keys: readonly string[] | null): ComponentType {
  const schema = part(keys);
  return function Fields() {
    const [value, setValue] = useValue<unknown>(FIELDS_VALUE);
    return <SchemaForm schema={schema} value={value} onChange={setValue} ctx={{ path: "", ...FIELDS_CTX }} />;
  };
}

function RnRows(): JSX.Element {
  const [doc, setDoc] = useValue<Record<string, unknown>>(ROWS_VALUE);
  return (
    <FormRowsContext.Provider value={true}>
      <SettingsGroup>
        {ROWS.map((section) => (
          <SchemaForm key={section.key} schema={section.schema as Schema} value={doc[section.key]} onChange={(next) => setDoc({ ...doc, [section.key]: next })} ctx={rowsCtx(section.key, doc, setDoc)} />
        ))}
      </SettingsGroup>
    </FormRowsContext.Provider>
  );
}

/** Layered, as a Settings page's form is: each field written at its own path, and ↺ where the layer states one. */
function rowsCtx(path: string, doc: Record<string, unknown>, setDoc: (next: Record<string, unknown>) => void): SchemaFormContext {
  return { path, isSet: (p) => STATED.has(p), setAt: (p, v) => setDoc(setPath(doc, p, v)) };
}

const CHOICES: Array<[string, string]> = [
  ["natively on Windows", "native"],
  ["in WSL: Ubuntu-24.04", "wsl"],
  ["a longer choice than the others", "long"],
];

function RnSelects(): JSX.Element {
  const [value, setValue] = useValue("native");
  const plain = CHOICES.map(([label, v]) => ({ label, value: v }));
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, padding: 12 }}>
      <SelectInput value={value} options={CHOICES} onChange={setValue} fill />
      <div style={{ width: 272 }}>
        <SelectInput value={value} options={CHOICES} onChange={setValue} fill />
      </div>
      <SelectInput value={value} options={CHOICES} onChange={setValue} disabled fill />
      {/* As the Logs bar sets it: as wide as its words, 150 at least. */}
      <Select value={value} options={plain} onChange={setValue} minWidth={150} />
    </div>
  );
}

const RnFields = fieldsOf(LEAVES);
const RnLists = fieldsOf(null);

export const FORM_SPECIMENS = {
  // A run's inputs or a gate's form: the side panel's width.
  "form-fields": {
    width: 440,
    rn: () => <RnFields />,
  },
  // The same form's lists (of values, and of rows that open and close), a map and a nested object.
  "form-lists": {
    width: 440,
    rn: () => <RnLists />,
  },
  // The menulists: the config box three ways, and the plain `Select`.
  selects: {
    width: 400,
    rn: () => <RnSelects />,
  },
  // A Settings page's card of rows (`SettingsGroup`), at the page's readable width.
  "form-rows": {
    width: 740,
    rn: () => <RnRows />,
  },
};
