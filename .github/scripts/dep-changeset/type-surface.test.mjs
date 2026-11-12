import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { snapshot } from './type-surface.mjs'

function surfaceOf(dts) {
	const dir = mkdtempSync(join(tmpdir(), 'type-surface-'))
	try {
		mkdirSync(join(dir, 'dist'))
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', exports: { '.': { types: './dist/index.d.mts' } } }))
		writeFileSync(join(dir, 'dist/index.d.mts'), dts)
		return snapshot(dir).surface
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// What tsdown emitted for cyberlegion before and after a lock-file bump: the bundler
// numbered its two `Exec` aliases in the other order. Nothing a consumer sees changed.
const imported = (n) => `import { Exec, Exec as Exec$${n} } from "cyber-mux";`
const local = (n) => `type Exec$${n} = (cmd: string, args: string[]) => string | null;`

test('a bundler renumbering its $N aliases is not a surface change', () => {
	const base = surfaceOf(
		`${imported(1)}\n${local(2)}\ninterface A { exec?: Exec$1 }\ninterface B { exec?: Exec$2 }\nexport declare const run: Exec$1;\nexport type { A, B };\n`,
	)
	const head = surfaceOf(
		`${imported(2)}\n${local(1)}\ninterface A { exec?: Exec$2 }\ninterface B { exec?: Exec$1 }\nexport declare const run: Exec$2;\nexport type { A, B };\n`,
	)
	assert.deepEqual(head, base)
})

test('an alias that now binds to a different declaration is still a change', () => {
	// A's `exec` moves from the imported Exec to the local one, and B's the other way.
	const base = surfaceOf(`${imported(1)}\n${local(2)}\ninterface A { exec?: Exec$1 }\ninterface B { exec?: Exec$2 }\nexport type { A, B };\n`)
	const head = surfaceOf(`${imported(1)}\n${local(2)}\ninterface A { exec?: Exec$2 }\ninterface B { exec?: Exec$1 }\nexport type { A, B };\n`)
	assert.notDeepEqual(head, base)
})

test('two local declarations sharing a base name keep their numbers', () => {
	// Which local is which cannot be told from the name alone, so a swap must trip.
	const base = surfaceOf('type T$1 = string;\ntype T$2 = number;\nexport interface A { t: T$1 }\n')
	const head = surfaceOf('type T$1 = number;\ntype T$2 = string;\nexport interface A { t: T$1 }\n')
	assert.notDeepEqual(head, base)
})
