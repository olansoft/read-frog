import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(".github/scripts/fork/sync-upstream.sh")
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}
function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "readfrog-sync-"))
  try {
    const upstream = join(root, "upstream")
    const remote = join(root, "fork.git")
    const fork = join(root, "fork")
    const bin = join(root, "bin")
    mkdirSync(upstream)
    mkdirSync(bin)
    git(upstream, "init", "-b", "main")
    git(upstream, "config", "user.name", "Test")
    git(upstream, "config", "user.email", "test@example.com")
    mkdirSync(join(upstream, ".github/workflows"), { recursive: true })
    writeFileSync(join(upstream, ".github/workflows/upstream.yml"), "original workflow\n")
    writeFileSync(join(upstream, "source.txt"), "base\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "base")
    git(root, "init", "--bare", remote)
    git(root, "clone", upstream, fork)
    git(fork, "remote", "set-url", "origin", remote)
    git(fork, "config", "user.name", "Test")
    git(fork, "config", "user.email", "test@example.com")
    git(fork, "config", `url.${upstream}.insteadOf`, "https://github.com/mengxi-ream/read-frog.git")
    git(fork, "switch", "-c", "feature/notion-note-storage")
    writeFileSync(join(fork, "notion.txt"), "fork feature\n")
    git(fork, "add", ".")
    git(fork, "commit", "-m", "notion feature")
    git(fork, "push", "origin", "feature/notion-note-storage")
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'{"id":123,"tag_name":"v1.0.1"}\\n\'\n', {
      mode: 0o755,
    })
    const output = join(root, "output")
    const summary = join(root, "summary")
    const run = () => {
      writeFileSync(output, "")
      return spawnSync("bash", [script], {
        cwd: fork,
        encoding: "utf8",
        env: {
          ...process.env,
          HUSKY: "0",
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      })
    }
    const release = () => {
      git(upstream, "add", ".")
      git(upstream, "commit", "-m", "upstream release")
      git(upstream, "tag", "v1.0.1")
    }
    callback({ upstream, remote, fork, output, run, release })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("merges released source while preserving the fork workflows and Notion changes", () =>
  fixture(({ upstream, fork, output, run, release }) => {
    writeFileSync(join(upstream, "source.txt"), "released source\n")
    writeFileSync(join(upstream, ".github/workflows/upstream.yml"), "changed workflow\n")
    writeFileSync(join(upstream, ".github/workflows/new.yml"), "new upstream workflow\n")
    release()
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(fork, "source.txt"), "utf8"), "released source\n")
    assert.equal(readFileSync(join(fork, "notion.txt"), "utf8"), "fork feature\n")
    assert.equal(
      readFileSync(join(fork, ".github/workflows/upstream.yml"), "utf8"),
      "original workflow\n",
    )
    assert.equal(git(fork, "ls-files", ".github/workflows/new.yml"), "")
    assert.match(readFileSync(output, "utf8"), /updated=true/)
  }))

test("does not push when released source conflicts with fork changes", () =>
  fixture(({ upstream, remote, fork, run, release }) => {
    writeFileSync(join(fork, "source.txt"), "notion source\n")
    git(fork, "add", ".")
    git(fork, "commit", "-m", "fork source")
    git(fork, "push", "origin", "feature/notion-note-storage")
    const previous = git(remote, "rev-parse", "refs/heads/feature/notion-note-storage")
    writeFileSync(join(upstream, "source.txt"), "upstream source\n")
    release()
    assert.notEqual(run().status, 0)
    assert.equal(git(remote, "rev-parse", "refs/heads/feature/notion-note-storage"), previous)
    assert.equal(git(fork, "status", "--porcelain"), "")
  }))

test("skips upstream releases only after a successful-build marker exists", () =>
  fixture(({ upstream, remote, fork, output, run, release }) => {
    writeFileSync(join(upstream, "source.txt"), "release\n")
    release()
    assert.equal(run().status, 0)
    // A previous failed build leaves no marker, so the next poll requests a retry.
    assert.equal(run().status, 0)
    assert.match(readFileSync(output, "utf8"), /updated=true/)
    git(fork, "tag", "notion-upstream-release-123")
    git(fork, "push", "origin", "refs/tags/notion-upstream-release-123")
    const previous = git(remote, "rev-parse", "refs/heads/feature/notion-note-storage")
    assert.equal(run().status, 0)
    assert.match(readFileSync(output, "utf8"), /updated=false/)
    assert.equal(git(remote, "rev-parse", "refs/heads/feature/notion-note-storage"), previous)
  }))
