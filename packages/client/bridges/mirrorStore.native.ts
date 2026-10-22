import { Directory, File, Paths } from "expo-file-system";
import type { MirrorStore } from "@jaira/ui/syncMirror";

/**
 * Where a phone keeps its mirror (decision 0018 §7, `syncMirror.ts`): a folder of its own in the app's
 * documents — not its caches, which the system may empty, since with no limit the mirror is a permanent
 * store. One file per kept thing.
 */
function folder(): Directory {
  const dir = new Directory(Paths.document, "jaira-mirror");
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export const mirrorStore: MirrorStore | undefined = {
  async list() {
    return folder()
      .list()
      .flatMap((entry) => (entry instanceof File ? [{ name: entry.name, size: entry.size ?? 0, at: entry.modificationTime ?? 0 }] : []));
  },
  async read(name) {
    const file = new File(folder(), name);
    return file.exists ? file.text() : null;
  },
  async write(name, text) {
    const file = new File(folder(), name);
    if (!file.exists) file.create();
    file.write(text);
  },
  async remove(name) {
    const file = new File(folder(), name);
    if (file.exists) file.delete();
  },
};
