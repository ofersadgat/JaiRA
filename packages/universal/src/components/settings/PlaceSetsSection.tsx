import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { PathWrite } from "@jaira/shared/browser";
import { placeSetNameProblem, placeSetRowsOf, placeSetWriteOf, placesOfText, type PlaceSetRow } from "@jaira/ui/placeSetsModel";
import { Press, Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { TextField } from "./fields";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings → Tools → Place sets (decision 0034): named groups of places the permission board draws as
 * one chip — `credentials` for the places secrets live, `project files` for `$PROJECT`, the machine's
 * projects folder as `root folder`. Right after Tool mapping. A set's places are edited as text, one per
 * comma or line; a set that ships is replaced in the page's layer and Reset puts it back; a set of the
 * person's own is added by name and removed. The rows are `placeSetsModel.ts`'s.
 *
 * How it looks:
 *
 *   a row          row, gap 10, min height 34, a --panel-2 line under it
 *   its name       app 12/600, 150 wide; under it, its word app 10 --tok-hint (built in · set here · this machine)
 *   a place        data 10.5, --panel-2, radius 5, padding 2 6
 *   editing        a mono text box over the row's places, Save and Cancel after it
 *   a new set      a name box, a places box and Add, under the rows
 */
export function PlaceSetsSection({ effective, layerDoc, projectsFolder, locked, onWrite }: { effective: unknown; layerDoc: unknown; projectsFolder: string | undefined; locked: boolean; onWrite: (writes: PathWrite[]) => void }): JSX.Element {
  const t = useTokens();
  const rows = placeSetRowsOf(effective, layerDoc, projectsFolder);
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined);
  const [name, setName] = useState("");
  const [places, setPlaces] = useState("");
  const problem = name.trim() === "" && places.trim() === "" ? undefined : (placeSetNameProblem(name, rows) ?? (placesOfText(places).length === 0 ? "a set needs at least one place" : undefined));
  return (
    <SettingsSection
      id="place-sets"
      title="Place sets"
      info="Named groups of places the permission board shows as one chip. A chip for a set stands for every place in it, and moving it moves them all."
      wide
    >
      {rows.map((row) => (
        <SetRow
          key={row.id}
          t={t}
          row={row}
          locked={locked}
          editing={editing?.id === row.id ? editing.text : undefined}
          onEdit={(text) => setEditing(text === undefined ? undefined : { id: row.id, text })}
          onSave={(text) => {
            onWrite([placeSetWriteOf(row.id, placesOfText(text))]);
            setEditing(undefined);
          }}
          onReset={() => onWrite([placeSetWriteOf(row.id, undefined)])}
        />
      ))}
      {!locked ? (
        <View flexDirection="row" alignItems="center" gap={8} paddingTop={10} flexWrap="wrap">
          <TextField value={name} onChange={setName} placeholder="New set's name" width={150} label="New set's name" />
          <TextField value={places} onChange={setPlaces} placeholder="Places, one per comma: ~/.npmrc, **/secrets/**" mono width={360} label="New set's places" />
          <Press
            onPress={() => {
              if (problem !== undefined || name.trim() === "") return;
              onWrite([placeSetWriteOf(name, placesOfText(places))]);
              setName("");
              setPlaces("");
            }}
            disabled={problem !== undefined || name.trim() === ""}
            label="Add the set"
            grow={false}
            box={({ hovered }) => ({ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 7, backgroundColor: hovered ? t.tint("accent", 14) : t.tint("accent", 9) })}
          >
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 500, color: "accent" }}>Add</Txt>
          </Press>
          {problem !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{problem}</Txt> : null}
        </View>
      ) : null}
    </SettingsSection>
  );
}

function SetRow({ t, row, locked, editing, onEdit, onSave, onReset }: { t: Tokens; row: PlaceSetRow; locked: boolean; editing: string | undefined; onEdit: (text: string | undefined) => void; onSave: (text: string) => void; onReset: () => void }): JSX.Element {
  const word = row.fixed ? "this machine's projects folder" : row.stated ? "set here" : row.builtin ? "built in" : "set in a layer under this";
  const action = (words: string, onPress: () => void): JSX.Element => (
    <Press onPress={onPress} label={`${words} ${row.label}`} grow={false} box={({ hovered }) => ({ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: hovered ? t.tint("accent", 9) : "transparent" })}>
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "accent" }}>{words}</Txt>
    </Press>
  );
  return (
    <View flexDirection="row" alignItems="center" gap={10} minHeight={34} paddingVertical={5} borderBottomWidth={1} borderBottomColor={t.v("panel-2") as never}>
      <View width={150} flexShrink={0}>
        <View flexDirection="row" alignItems="center" gap={5}>
          <Icon name="layers" size={11} color={String(t.v("accent"))} />
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600 }} ellip>
            {row.label}
          </Txt>
        </View>
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: row.stated ? "accent" : "tok-hint" }}>{word}</Txt>
      </View>
      {editing !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={6} flex={1} minWidth={0}>
          <TextField value={editing} onChange={(text) => onEdit(text)} mono width="100%" label={`${row.label}'s places`} autoFocus onSubmit={() => onSave(editing)} />
          {action("Save", () => onSave(editing))}
          {action("Cancel", () => onEdit(undefined))}
        </View>
      ) : (
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={4} flex={1} minWidth={0}>
          {row.places.map((place) => (
            <View key={place} paddingVertical={2} paddingHorizontal={6} borderRadius={5} backgroundColor={t.v("panel-2") as never}>
              <Txt spec={{ voice: "data", scale: 10.5 / 12 }}>{place}</Txt>
            </View>
          ))}
        </View>
      )}
      {editing === undefined && !locked && !row.fixed ? (
        <View flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
          {action("Edit", () => onEdit(row.places.join(", ")))}
          {row.stated ? action(row.builtin ? "Reset" : "Remove", onReset) : null}
        </View>
      ) : null}
    </View>
  );
}
