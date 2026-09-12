#!/usr/bin/env node
/**
 * Set environment variables and run a command, on any platform.
 *
 * Usage: node scripts/with-env.mjs KEY=value [KEY=value ...] -- <command> [args]
 *
 * `KEY=value command` is shell syntax that does not exist on Windows, and
 * cross-env would be a dependency for four characters of behaviour. SurahSpot's
 * development is partly on Windows, so the npm scripts route through this
 * instead of assuming a POSIX shell.
 */

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const separator = args.indexOf("--");

if (separator === -1) {
  console.error("Usage: node scripts/with-env.mjs KEY=value ... -- <command> [args]");
  process.exit(64);
}

const assignments = args.slice(0, separator);
const [command, ...commandArgs] = args.slice(separator + 1);

if (!command) {
  console.error("No command given after --.");
  process.exit(64);
}

const env = { ...process.env };
for (const assignment of assignments) {
  const index = assignment.indexOf("=");
  if (index <= 0) {
    console.error(`Malformed assignment "${assignment}". Expected KEY=value.`);
    process.exit(64);
  }
  env[assignment.slice(0, index)] = assignment.slice(index + 1);
}

// shell:true so npm-installed binaries resolve through .cmd shims on Windows.
const child = spawn(command, commandArgs, { stdio: "inherit", env, shell: true });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Could not start "${command}":`, error.message);
  process.exit(1);
});
