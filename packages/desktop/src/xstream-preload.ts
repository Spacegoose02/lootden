import { contextBridge, ipcRenderer } from "electron";

// The Xbox stream window (setup/xstream.html). It only talks to the main process, which holds
// the Microsoft sign-in and the stream session: the page never sees a token.
const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`gm:xstream:${name}`, ...args);

contextBridge.exposeInMainWorld("lootdenXstream", {
  info: call("info"),
  start: call("start"),
  sdp: call("sdp"),
  ice: call("ice"),
  keepalive: call("keepalive"),
  setFit: call("setFit"),
  fullscreen: call("fullscreen"),
  close: call("close"),
  onState: (cb: (state: string) => void) => ipcRenderer.on("gm:xstream:state", (_e, s: string) => cb(s)),
});
