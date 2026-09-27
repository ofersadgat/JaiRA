/**
 * The `jaira` command on this machine's PATH (decision 0011 §7): whether it is there, and putting it
 * there where the installer could not.
 *
 * The installer puts it there on Windows (a `jaira.cmd` in `%LOCALAPPDATA%\Microsoft\WindowsApps`) and
 * with the Linux `.deb` (`/usr/bin/jaira`). A macOS app is dragged into place, so About offers "Install
 * the jaira command", which links `/usr/local/bin/jaira` with an administrator prompt (VS Code's `code`
 * does the same); on Windows the same action writes the forwarding script again, for a copy that was not
 * installed by the installer. The AppImage has no fixed place for a command to run from. Either way the
 * command is the wrapper in `<resources>/bin` (`packages/app/packageCli.mjs`), which runs the CLI on this
 * app's own Electron.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliCommandStatus } from "@jaira/shared";

export interface CliCommandContext {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** `process.resourcesPath`. */
  resources: string;
  /** `%LOCALAPPDATA%` on Windows. */
  localAppData?: string;
  /** Set when running from an AppImage (`APPIMAGE`). */
  appImage?: string;
}

const MAC_LINK = "/usr/local/bin/jaira";
const DEB_LINK = "/usr/bin/jaira";

function wrapperOf(context: CliCommandContext): string {
  return join(context.resources, "bin", context.platform === "win32" ? "jaira.cmd" : "jaira");
}

function windowsShim(context: CliCommandContext): string | undefined {
  return context.localAppData !== undefined ? join(context.localAppData, "Microsoft", "WindowsApps", "jaira.cmd") : undefined;
}

const linksTo = (link: string, target: string): boolean => {
  try {
    return readlinkSync(link) === target;
  } catch {
    return false;
  }
};

export function cliCommandStatus(context: CliCommandContext): CliCommandStatus {
  if (!context.packaged) return { state: "development", reason: "a development build: run `npm run jaira` in the checkout", canInstall: false };
  const wrapper = wrapperOf(context);
  if (context.platform === "win32") {
    const shim = windowsShim(context);
    const installed = shim !== undefined && existsSync(shim) && readFileSync(shim, "utf8").includes(wrapper);
    return installed ? { state: "installed", path: shim, canInstall: true } : { state: "missing", canInstall: shim !== undefined };
  }
  if (context.platform === "darwin") {
    return linksTo(MAC_LINK, wrapper) ? { state: "installed", path: MAC_LINK, canInstall: true } : { state: "missing", canInstall: true };
  }
  if (context.appImage !== undefined) {
    return { state: "unavailable", reason: "the AppImage has no fixed place to run the command from; the .deb installs it", canInstall: false };
  }
  return linksTo(DEB_LINK, wrapper) || existsSync(DEB_LINK)
    ? { state: "installed", path: DEB_LINK, canInstall: false }
    : { state: "missing", reason: "reinstall the .deb to put it back", canInstall: false };
}

/** Put the command on the PATH where this platform lets the app do it; then say where it stands. */
export async function installCliCommand(context: CliCommandContext): Promise<CliCommandStatus> {
  const status = cliCommandStatus(context);
  if (!status.canInstall) return status;
  const wrapper = wrapperOf(context);
  if (context.platform === "win32") {
    const shim = windowsShim(context)!;
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, `@echo off\r\nrem Installed by JaiRA: the jaira command.\r\n"${wrapper}" %*\r\n`);
  } else if (context.platform === "darwin") {
    // One administrator prompt, macOS's own, for writing into /usr/local/bin.
    const script = `do shell script "mkdir -p /usr/local/bin && ln -sf " & quoted form of "${wrapper.replace(/"/g, '\\"')}" & " ${MAC_LINK}" with administrator privileges`;
    await new Promise<void>((resolve, reject) => execFile("osascript", ["-e", script], (error) => (error ? reject(error) : resolve())));
  }
  return cliCommandStatus(context);
}
