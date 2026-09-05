import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("drains an in-flight scheduled job on SIGTERM before closing SQLite", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shutdown-process-"));
  const code = `
    import {buildApp} from './src/server/app.ts';
    const {app,ctx}=await buildApp({serveStatic:false,registerJobs:false});
    const keepAlive=setInterval(()=>{},1000);
    process.on('SIGTERM',()=>void app.close().then(()=>{clearInterval(keepAlive);process.stdout.write(ctx.sqlite.open ? 'db-open' : 'db-closed');}));
    ctx.scheduler.registerJob({name:'fixture',intervalMs:60000,run:async(signal)=>{
      process.stdout.write('job-active');
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      ctx.sqlite.prepare('select 1').get();
      process.stdout.write('job-drained');
    }});
    void ctx.scheduler.trigger('fixture');
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      LOG_LEVEL: "error",
      BEASTY_ARR_FORBID_LIVE_AI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (output === "job-active") child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode, errors).toBe(0);
    expect(output).toBe("job-activejob-draineddb-closed");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 10_000);
