import { fork } from "node:child_process";

function observeChild(modulePath, args) {
  const child = fork(modulePath, args, {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    child.once("message", (message) => {
      if (message?.type !== "ready") {
        reject(new Error(`Unexpected child readiness message: ${JSON.stringify(message)}`));
        return;
      }
      ready = true;
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!ready) reject(new Error(
        `Barrier child exited before ready (${signal ?? code ?? "unknown"}): ${stderr}`,
      ));
    });
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `Barrier child failed (${signal ?? code ?? "unknown"}): ${stderr}`,
      ));
    });
  });
  return { child, readyPromise, exitPromise };
}

export async function runBarrierChildren(modulePath, argumentLists) {
  const children = argumentLists.map((args) => observeChild(modulePath, args));
  try {
    await Promise.all(children.map((entry) => entry.readyPromise));
    for (const { child } of children) child.send({ type: "start" });
    await Promise.all(children.map((entry) => entry.exitPromise));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}
