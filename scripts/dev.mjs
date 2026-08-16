import { spawn } from 'node:child_process'
import process from 'node:process'

const children = []

function start(label, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, env: process.env })
  children.push(child)
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}`)
      shutdown(code)
    }
  })
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

start('api', process.execPath, ['server/index.mjs'])
start('web', process.execPath, ['node_modules/vite/bin/vite.js'])
