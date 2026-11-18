/**
 * Installing tools — the agents JaiRA drives, the git programs, and what a project's setup asks for —
 * the way the machine already installs them.
 *
 *  - `catalog`: what each tool is called by each installer ({@link ToolPackage}).
 *  - `locate`: where its binary is and which installers are here — file checks, one `sh` in WSL.
 *  - `origin`: how it got there, read off where it lives.
 *  - `plan`: what installs, updates or brings it to a version from here.
 *  - `run`: running one of those, its output streamed.
 *  - `version`: what it says it is, and whether that is what was asked.
 *  - `tool`: a setup's request — {@link checkTool} looks, {@link ensureTool} installs.
 */
export * from "./catalog";
export * from "./locate";
export * from "./origin";
export * from "./plan";
export * from "./run";
export * from "./version";
export * from "./tool";
