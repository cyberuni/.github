// End-to-end: builds a throwaway git repo with a base and a head commit, fakes the
// installed node_modules on each side, and runs `cli.mjs plan` and `cli.mjs check`
// the way the workflow does.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

function write(root, files) {
	for (const [f, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true })
		writeFileSync(join(root, f), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
	}
}

function git(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()
}

function commit(cwd, msg, author = 'renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>') {
	git(cwd, 'add', '-A')
	git(cwd, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', msg, `--author=${author}`)
}

const pkgJson = (deps, extra = {}) => ({ name: 'lib-a', version: '1.0.0', exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' } }, engines: { node: '>=20' }, dependencies: deps, ...extra })

// Sets up repo + base worktree. `head` describes the head side: dependency version,
// its d.ts, engines and peers, and the chunk name the package's own build emits.
function fixture({ base, head, labels = ['dep-changeset:auto'], humanChangeset = false, pr = 7, checkEnv = {} }) {
	const root = mkdtempSync(join(tmpdir(), 'dep-changeset-'))
	const repo = join(root, 'repo')
	mkdirSync(repo)
	git(repo, 'init', '-q', '-b', 'main')
	write(repo, {
		'.gitignore': 'node_modules\n',
		'package.json': { name: 'root', private: true },
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'packages/a/package.json': pkgJson({ dep: base.range }),
		'packages/a/test/fixture/package.json': { name: 'fixture', dependencies: { dep: base.range } },
		'.changeset/config.json': {},
	})
	commit(repo, 'base', 'Person <person@example.com>')
	git(repo, 'checkout', '-q', '-b', 'renovate/dep')
	write(repo, { 'packages/a/package.json': pkgJson({ dep: head.range }), 'packages/a/test/fixture/package.json': { name: 'fixture', dependencies: { dep: head.range } } })
	commit(repo, 'bump dep')
	if (humanChangeset) {
		write(repo, { '.changeset/human.md': "---\n'lib-a': minor\n---\n\nBump dep.\n" })
		commit(repo, 'changeset', 'Person <person@example.com>')
	}
	const baseDir = join(root, 'base')
	git(repo, 'worktree', 'add', '-q', '--detach', baseDir, 'main')
	for (const [dir, side] of [
		[baseDir, base],
		[repo, head],
	]) {
		// The package's own build output: it re-exports a type from `dep`.
		write(dir, {
			[`packages/a/dist/${side.chunk ?? 'types-AAAAAAAA'}.d.mts`]: "import type { Options } from 'dep';\nexport interface Config { options: Options }\n",
			'packages/a/dist/index.d.mts': `export type { Config } from './${side.chunk ?? 'types-AAAAAAAA'}.mjs';\nexport declare function run(): void;\n`,
			'packages/a/dist/index.mjs': 'export function run() {}\n',
			'packages/a/node_modules/dep/package.json': {
				name: 'dep',
				version: side.version,
				types: './index.d.ts',
				engines: side.engines ? { node: side.engines } : undefined,
				peerDependencies: side.peers,
			},
			'packages/a/node_modules/dep/index.d.ts': side.dts ?? 'export interface Options { a: string }\n',
		})
	}
	const out = join(root, 'out')
	const env = { ...process.env, DEP_CHANGESET_OUT: out, BASE_REF: 'main', PR_NUMBER: String(pr), LABELS: JSON.stringify(labels), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' }
	const run = (cmd, extra = {}) => execFileSync('node', [CLI, cmd], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' })
	const outputs = (text) => Object.fromEntries([...text.matchAll(/^([a-z-]+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
	const planned = outputs(run('plan'))
	let checked = {}
	if (planned['needs-checks'] === 'true') checked = outputs(run('check', { BASE_DIR: baseDir, HEAD_DIR: repo, ...checkEnv }))
	const decision = JSON.parse(readFileSync(join(out, 'decision.json'), 'utf8'))
	const report = readFileSync(join(out, 'report.md'), 'utf8')
	rmSync(root, { recursive: true, force: true })
	return { planned, checked, decision, report }
}

const same = { range: '^1.0.0', version: '1.0.0', engines: '>=18' }

test('a clean in-major bump writes a patch changeset', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0' } })
	assert.equal(r.planned.mode, 'auto')
	assert.equal(r.decision.decision, 'write', r.report)
	assert.deepEqual(r.decision.targets, ['lib-a'])
})

test('a renamed hashed chunk alone does not trip the type check', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0', chunk: 'types-BxYz12_3' } })
	assert.equal(r.decision.decision, 'write', r.report)
})

test('a change in a referenced dependency type trips the type check', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0', dts: 'export interface Options { a: number }\n' } })
	assert.equal(r.decision.decision, 'fail')
	assert.equal(r.decision.findings[0].check, 'types')
	assert.match(r.report, /\+ export interface Options \{ a: number; \}/)
})

test('a raised engines floor trips', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0', engines: '>=22' } })
	assert.equal(r.decision.decision, 'fail')
	assert.equal(r.decision.findings[0].check, 'engines')
})

test('a new peer dependency trips', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0', peers: { react: '^18' } } })
	assert.equal(r.decision.decision, 'fail')
	assert.equal(r.decision.findings[0].check, 'peers')
})

test('a human-labeled PR fails without a person-written changeset, and passes with one', () => {
	const head = { ...same, range: '^2.0.0', version: '2.0.0' }
	const blocked = fixture({ base: same, head, labels: ['dep-changeset:human'] })
	assert.equal(blocked.decision.decision, 'fail')
	assert.equal(blocked.planned['needs-checks'], 'false')
	const ok = fixture({ base: same, head, labels: ['dep-changeset:human'], humanChangeset: true })
	assert.equal(ok.decision.decision, 'pass', ok.report)
})

test('an auto label on a major escalates to human without building', () => {
	const r = fixture({ base: same, head: { ...same, range: '^2.0.0', version: '2.0.0' } })
	assert.equal(r.planned.mode, 'human')
	assert.equal(r.decision.decision, 'fail')
})

test('a setup failure fails closed', () => {
	const r = fixture({ base: same, head: { ...same, range: '^1.1.0', version: '1.1.0' }, checkEnv: { SETUP_FAILED: 'true' } })
	assert.equal(r.decision.decision, 'fail')
	assert.equal(r.decision.findings[0].check, 'setup')
})

// P9 on a Version Packages PR. `gh` is replaced by a stub that fails, so authorship falls
// back to the git author of the commit that added each changeset.
function releaseFixture({ author, level = 'major', to = '2.0.0' }) {
	const root = mkdtempSync(join(tmpdir(), 'dep-changeset-rg-'))
	const repo = join(root, 'repo')
	const bin = join(root, 'bin')
	write(root, { 'bin/gh': '#!/bin/sh\nexit 1\n' })
	execFileSync('chmod', ['+x', join(bin, 'gh')])
	mkdirSync(repo)
	git(repo, 'init', '-q', '-b', 'main')
	write(repo, { 'package.json': { name: 'lib-a', version: '1.0.0' }, '.changeset/config.json': {} })
	commit(repo, 'init', 'Person <person@example.com>')
	write(repo, { '.changeset/renovate-3.md': `---\n'lib-a': ${level}\n---\n\nx\n` })
	commit(repo, 'changeset', author)
	git(repo, 'checkout', '-q', '-b', 'changeset-release/main')
	rmSync(join(repo, '.changeset/renovate-3.md'))
	write(repo, { 'package.json': { name: 'lib-a', version: to } })
	commit(repo, 'version packages', 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>')
	let code = 0
	let stdout = ''
	try {
		stdout = execFileSync('node', [CLI, 'release-guard'], {
			cwd: repo,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_REF: 'main', GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: '' },
		})
	} catch (e) {
		code = e.status
		stdout = e.stdout
	}
	rmSync(root, { recursive: true, force: true })
	return { code, stdout }
}

test('release guard: a bot-written major fails', () => {
	const r = releaseFixture({ author: 'renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>' })
	assert.equal(r.code, 1, r.stdout)
	assert.match(r.stdout, /`lib-a` 1\.0\.0 → 2\.0\.0 \(a bot wrote `major`/)
})

test('release guard: a person-written major passes', () => {
	const r = releaseFixture({ author: 'Person <person@example.com>' })
	assert.equal(r.code, 0, r.stdout)
})

test('release guard: a bot-written patch passes', () => {
	const r = releaseFixture({ author: 'renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>', level: 'patch', to: '1.0.1' })
	assert.equal(r.code, 0, r.stdout)
})
