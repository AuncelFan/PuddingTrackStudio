import { spawn } from 'node:child_process';

const processes = [
  spawn('uv', ['run', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload'], { stdio: 'inherit' }),
  spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let exiting = false;
const stop = () => {
  if (exiting) return;
  exiting = true;
  for (const child of processes) child.kill('SIGTERM');
};
for (const child of processes) {
  child.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
  child.on('exit', code => { stop(); if (code) process.exitCode = code; });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
