import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ARTIFACT_DESTINATIONS, ARTIFACT_VARIABLES, CONFIG_SECTIONS } from "@jaira/shared/browser";
import { execDistroOf, type Writer } from "@jaira/ui/configWriter";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { Txt } from "../../primitives";
import { Field, FieldGrid } from "../form/Field";
import { Chip, FormInput, NumInput } from "../form/inputs";
import { SchemaForm } from "../form/SchemaForm";
import { SelectInput } from "./fields";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings' config sections: one declared block of `settings.json` as a section of rows
 * (`ConfigBlockSection`, over the schema form), and the two blocks with a control of their own — where
 * commands run, and where artifacts land. They write through `configWriter.ts`. How the artifacts'
 * destination looks:
 *
 *   its stack            column, gap 10, as wide as its widest line (the chips)
 *   the chips            row, wraps, gap 6
 *   a variable           data 11/12, in the hint under the box
 */

/** One declared block (`CONFIG_SECTIONS`) as a section of rows; each field is written at its own path. */
export function ConfigBlockSection({ writer, block, title }: { writer: Writer; block: string; title?: string }): JSX.Element | null {
  const section = CONFIG_SECTIONS.find((s) => s.key === block);
  if (section === undefined) return null;
  return (
    <SettingsSection id={section.key} title={title ?? section.title} info={section.hint}>
      <SchemaForm
        schema={section.schema as Schema}
        value={writer.effective[section.key]}
        onChange={(next) => writer.set(section.key, next)}
        ctx={{ path: section.key, disabled: writer.locked, isSet: writer.stated, setAt: writer.set }}
      />
    </SettingsSection>
  );
}

/** Where a produced file lands — a template, offered as presets plus the variables it may use. */
export function Artifacts({ effective, locked, set, layer }: Writer): JSX.Element {
  const artifacts = (effective["artifacts"] ?? {}) as Record<string, unknown>;
  const destination = typeof artifacts["destination"] === "string" ? (artifacts["destination"] as string) : "";
  return (
    <SettingsSection
      id="artifacts"
      title="Artifacts"
      info="Where a file an agent produces actually lands. A path template rather than a mode, because which backend and how the path is derived are independent questions and an enum conflates them."
    >
      <FieldGrid>
        <Field label="Destination" param="artifacts.destination" hint="Pick one, or write a template of your own." wide layer={layer("artifacts.destination")}>
          <View flexDirection="column" gap={10}>
            <View flexDirection="row" flexWrap="wrap" gap={6}>
              {ARTIFACT_DESTINATIONS.map((option) => (
                <Chip key={option.value} active={destination === option.value} disabled={locked} title={option.what} onPress={() => set("artifacts.destination", option.value)}>
                  {option.label}
                </Chip>
              ))}
            </View>
            <FormInput value={destination} mono placeholder="$JAIRA/artifacts/$TASK_ID/$RELPATH" disabled={locked} onChange={(v) => set("artifacts.destination", v === "" ? undefined : v)} />
            <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }}>
              {"Variables: "}
              {ARTIFACT_VARIABLES.map((v) => (
                <Txt key={v} spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" }}>{`${v} `}</Txt>
              ))}
            </Txt>
          </View>
        </Field>
        <Field label="Artifact directory" param="artifacts.dir" hint="What $ARTIFACT_DIR expands to, inside the root's system/ directory." layer={layer("artifacts.dir")}>
          <FormInput value={typeof artifacts["dir"] === "string" ? (artifacts["dir"] as string) : ""} mono placeholder="artifacts" disabled={locked} onChange={(v) => set("artifacts.dir", v === "" ? undefined : v)} />
        </Field>
        <Field
          label="Keep inline below"
          param="artifacts.inlineMaxBytes"
          hint="Content smaller than this rides along in bindings and prompts rather than being read back. Larger is fewer reads and bigger prompts."
          layer={layer("artifacts.inlineMaxBytes")}
        >
          <NumInput value={typeof artifacts["inlineMaxBytes"] === "number" ? (artifacts["inlineMaxBytes"] as number) : undefined} disabled={locked} onChange={(n) => set("artifacts.inlineMaxBytes", n)} />
        </Field>
        <Field
          label="Ask above"
          param="artifacts.askAboveBytes"
          hint="Producing an artifact bigger than this many bytes asks you first. There is no ceiling on size — this is a question, not a refusal; 0 turns it off."
          layer={layer("artifacts.askAboveBytes")}
        >
          <NumInput value={typeof artifacts["askAboveBytes"] === "number" ? (artifacts["askAboveBytes"] as number) : undefined} disabled={locked} onChange={(n) => set("artifacts.askAboveBytes", n)} />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** `"windows" | { wsl: string }` — its own control, because no object schema describes it honestly. */
export function ExecEnvironment({ effective, locked, set, layer }: Writer): JSX.Element {
  const { value, distro } = execDistroOf(effective);
  return (
    <SettingsSection
      id="exec-environment"
      title="Where commands run"
      info="Natively, or inside a WSL distro — which is where git and every agent then run too. Deliberately not Windows git against \\wsl$, which is slow and permission-fragile."
    >
      <FieldGrid>
        <Field label="Environment" param="execEnvironment" hint="Naming a distro runs everything inside it." layer={layer("execEnvironment")}>
          <SelectInput
            fill
            value={distro === "" ? "windows" : "wsl"}
            options={[
              ["natively on Windows", "windows"],
              ["inside a WSL distro", "wsl"],
            ]}
            disabled={locked}
            onChange={(v) => set("execEnvironment", v === "windows" ? "windows" : { wsl: distro || "Ubuntu" })}
          />
        </Field>
        {distro !== "" || (typeof value === "object" && value !== null) ? (
          <Field label="Distro" param="execEnvironment.wsl" hint="As `wsl -l` lists it.">
            <FormInput value={distro} mono placeholder="Ubuntu" disabled={locked} onChange={(v) => set("execEnvironment", { wsl: v })} />
          </Field>
        ) : null}
      </FieldGrid>
    </SettingsSection>
  );
}
