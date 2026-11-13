// The workflows that load these scripts check them out bare, so a job that runs
// cli.mjs without installing the scripts' own dependencies fails on the first import
// (cyberlegion#256: the write job hit "Cannot find package 'semver'"). Checked on the
// workflow text, since no fixture runs the workflows themselves.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '../../workflows')

// Splits a workflow into its jobs by the two-space-indented keys under `jobs:`.
function jobs(file) {
	const text = readFileSync(join(WORKFLOWS, file), 'utf8')
	const body = text.slice(text.indexOf('\njobs:\n'))
	const out = {}
	let name
	for (const line of body.split('\n').slice(2)) {
		const m = /^ {2}([\w-]+):\s*$/.exec(line)
		if (m) name = m[1]
		else if (name) out[name] = `${out[name] ?? ''}${line}\n`
	}
	return out
}

for (const file of ['dep-changeset.yml', 'dep-changeset-release-guard.yml']) {
	test(`${file}: every job that runs cli.mjs installs the scripts' dependencies first`, () => {
		const found = jobs(file)
		assert.ok(Object.keys(found).length > 0, `no jobs parsed from ${file}`)
		for (const [name, text] of Object.entries(found)) {
			const run = text.search(/node "[^"\n]*cli\.mjs"/)
			if (run === -1) continue
			const install = text.search(/npm ci [^\n]*--prefix "[^"\n]*dep-changeset"/)
			assert.ok(install !== -1 && install < run, `job \`${name}\` runs cli.mjs without an npm ci of the scripts before it`)
		}
	})
}
