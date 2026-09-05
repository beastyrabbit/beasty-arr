import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("closes SSE and drains an in-flight scheduled job on SIGTERM before closing SQLite", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shutdown-process-"));
  const code = `
    import {buildApp} from './src/server/app.ts';
    const {app,ctx}=await buildApp({env:{LOG_LEVEL:'error'},serveStatic:false,registerJobs:false});
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();
    const response=await fetch('http://127.0.0.1:'+address.port+'/api/events');
    const reader=response.body.getReader();
    await reader.read();
    const streamEnded=(async()=>{while(!(await reader.read()).done){}process.stdout.write('sse-ended');})();
    const keepAlive=setInterval(()=>{},1000);
    process.on('SIGTERM',()=>void app.close().then(async()=>{await streamEnded;clearInterval(keepAlive);process.stdout.write(ctx.sqlite.open ? 'db-open' : 'db-closed');}));
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
    expect(output).toContain("job-drained");
    expect(output).toContain("sse-ended");
    expect(output.endsWith("db-closed")).toBe(true);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 10_000);
