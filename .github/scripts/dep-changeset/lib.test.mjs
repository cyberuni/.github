// Run with `npm test` in this directory (after `npm ci`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	catalogChanges,
	checkEngines,
	checkPeers,
	classifyRangeChange,
	diffRuntimeDeps,
	diffSurface,
	expandGroups,
	isBot,
	isWorkspaceMember,
	LABEL_AUTO,
	LABEL_HUMAN,
	parseCatalogDiff,
	parseChangeset,
	parseWorkspaceYaml,
	plan,
	releaseGuard,
	renderChangeset,
	renderReport,
} from './lib.mjs'

test('isBot recognizes the bots that push to Renovate PRs', () => {
	assert.equal(isBot({ name: 'renovate[bot]', email: '29139614+renovate[bot]@users.noreply.github.com' }), true)
	assert.equal(isBot({ name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }), true)
	assert.equal(isBot({ name: 'Renovate Bot', email: 'bot@renovateapp.com' }), true)
	assert.equal(isBot({ name: 'unional', email: 'person@example.com' }), false)
})

test('diffRuntimeDeps ignores devDependencies', () => {
	const changes = diffRuntimeDeps(
		{ dependencies: { a: '^1.0.0' }, devDependencies: { t: '^5.0.0' } },
		{ dependencies: { a: '^1.1.0' }, devDependencies: { t: '^6.0.0' } },
	)
	assert.deepEqual(changes, [{ field: 'dependencies', name: 'a', from: '^1.0.0', to: '^1.1.0' }])
})

test('classifyRangeChange treats 0.x minor and unreadable specs as breaking', () => {
	assert.equal(classifyRangeChange('^1.2.0', '^1.3.0'), 'in-major')
	assert.equal(classifyRangeChange('1.2.0', '1.2.5'), 'in-major')
	assert.equal(classifyRangeChange('^1.2.0', '^2.0.0'), 'major')
	assert.equal(classifyRangeChange('^0.2.0', '^0.3.0'), 'major')
	assert.equal(classifyRangeChange('0.11.0', '0.12.0'), 'major')
	assert.equal(classifyRangeChange('^0.0.1', '^0.0.2'), 'major')
	assert.equal(classifyRangeChange('^0.2.0', '^0.2.4'), 'in-major')
	assert.equal(classifyRangeChange('workspace:*', 'workspace:^'), 'unknown')
	assert.equal(classifyRangeChange(undefined, '^1.0.0'), 'added')
	assert.equal(classifyRangeChange('^1.0.0', undefined), 'removed')
})

test('parseChangeset reads quoted and bare names', () => {
	const m = parseChangeset("---\n'a': patch\n\"@s/b\": major\nc: minor\n---\n\nbody\n")
	assert.deepEqual([...m], [['a', 'patch'], ['@s/b', 'major'], ['c', 'minor']])
	assert.equal(parseChangeset('no front matter').size, 0)
})

test('renderChangeset round-trips through parseChangeset', () => {
	const text = renderChangeset(['b', '@s/a'])
	assert.deepEqual([...parseChangeset(text)], [['@s/a', 'patch'], ['b', 'patch']])
})

const pkg = (name, changes = []) => ({ name, dir: `packages/${name}`, changes })
const dep = (name, from, to, field = 'dependencies') => ({ field, name, from, to })

test('plan: no runtime change and no label passes', () => {
	assert.equal(plan({ packages: [pkg('a')] }).mode, 'none')
})

test('plan: auto label with an in-major move goes to the leak checks', () => {
	const p = plan({ labels: [LABEL_AUTO], packages: [pkg('a', [dep('x', '^1.0.0', '^1.1.0')]), pkg('b')] })
	assert.equal(p.mode, 'auto')
	assert.deepEqual(p.targets, ['a'])
	assert.deepEqual(p.uncovered, ['a'])
})

test('plan: human label fails until a person covers every target', () => {
	const packages = [pkg('a', [dep('x', '^1.0.0', '^2.0.0')])]
	assert.deepEqual(plan({ labels: [LABEL_HUMAN], packages }).uncovered, ['a'])
	assert.deepEqual(plan({ labels: [LABEL_HUMAN], packages, covered: new Set(['a']) }).uncovered, [])
})

test('plan: human wins over auto when both labels are present', () => {
	assert.equal(plan({ labels: [LABEL_AUTO, LABEL_HUMAN], packages: [pkg('a', [dep('x', '^1.0.0', '^1.1.0')])] }).mode, 'human')
})

test('plan: an unlabeled runtime change fails closed', () => {
	const p = plan({ packages: [pkg('a', [dep('x', '^1.0.0', '^1.1.0')])] })
	assert.equal(p.mode, 'human')
	assert.match(p.reasons[0], /neither/)
})

test('plan: an auto label on a major, a peer, or an unreadable spec escalates to human', () => {
	for (const c of [dep('x', '^1.0.0', '^2.0.0'), dep('x', '^1.0.0', '^1.1.0', 'peerDependencies'), dep('x', 'workspace:*', 'workspace:^'), dep('x', undefined, '^1.0.0')]) {
		const p = plan({ labels: [LABEL_AUTO], packages: [pkg('a', [c])] })
		assert.equal(p.mode, 'human', JSON.stringify(c))
	}
})

test('plan: bundled lock-file update targets every public package', () => {
	const p = plan({ bundled: true, lockChanged: true, packages: [pkg('a'), pkg('b')] })
	assert.equal(p.mode, 'auto')
	assert.deepEqual(p.targets, ['a', 'b'])
	assert.equal(plan({ bundled: false, lockChanged: true, packages: [pkg('a')] }).mode, 'none')
})

test('plan: human label with no public package affected passes', () => {
	assert.equal(plan({ labels: [LABEL_HUMAN], packages: [pkg('a')] }).mode, 'none')
})

test('parseCatalogDiff and catalogChanges attribute catalog moves to packages', () => {
	const diff = [
		'diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml',
		'--- a/pnpm-workspace.yaml',
		'+++ b/pnpm-workspace.yaml',
		'@@ -10,2 +10,2 @@ catalog:',
		' catalog:',
		'-  typescript: ~7.0.0',
		'+  typescript: ~7.1.0',
		'-  zod: ^3.1.0',
		'+  zod: ^3.2.0',
		' catalogs:',
		'   react17:',
		"-    react: '^17.0.1'",
		"+    react: '^17.0.2'",
		' overrides:',
		'-  foo: ^1.0.0',
		'+  foo: ^1.0.1',
	].join('\n')
	const catalogs = parseCatalogDiff(diff)
	assert.deepEqual(catalogs.get('catalog:').get('zod'), { from: '^3.1.0', to: '^3.2.0' })
	assert.deepEqual(catalogs.get('catalog:react17').get('react'), { from: '^17.0.1', to: '^17.0.2' })
	assert.equal(catalogs.get('catalog:').has('foo'), false)
	const changes = catalogChanges({ dependencies: { zod: 'catalog:', react: 'catalog:react17' }, devDependencies: { typescript: 'catalog:' } }, catalogs)
	assert.deepEqual(
		changes.map((c) => [c.name, c.from, c.to]),
		[
			['zod', '^3.1.0', '^3.2.0'],
			['react', '^17.0.1', '^17.0.2'],
		],
	)
})

test('checkEngines: a floor at or under the package floor passes', () => {
	assert.equal(checkEngines({ pkgEngines: '>=20', depBase: { engines: { node: '>=18' } }, depHead: { engines: { node: '>=20' } } }), null)
	assert.equal(checkEngines({ pkgEngines: '>=20', depBase: {}, depHead: {} }), null)
})

test('checkEngines: a floor above the package floor trips', () => {
	assert.match(checkEngines({ pkgEngines: '>=20', depBase: { engines: { node: '>=18' } }, depHead: { engines: { node: '>=22' } } }), /above this package's floor 20\.0\.0/)
})

test('checkEngines: an already-high floor that does not rise passes', () => {
	assert.equal(checkEngines({ pkgEngines: '>=18', depBase: { engines: { node: '>=22' } }, depHead: { engines: { node: '>=22' } } }), null)
})

test('checkEngines: with no package floor, any rise trips', () => {
	assert.match(checkEngines({ depBase: { engines: { node: '>=18' } }, depHead: { engines: { node: '>=20' } } }), /declares no/)
	assert.match(checkEngines({ depBase: {}, depHead: { engines: { node: '>=20' } } }), /declares no/)
	assert.equal(checkEngines({ depBase: { engines: { node: '>=20' } }, depHead: { engines: { node: '>=20' } } }), null)
})

test('checkEngines: an unreadable range trips', () => {
	assert.match(checkEngines({ pkgEngines: '>=20', depBase: {}, depHead: { engines: { node: 'latest' } } }), /cannot be read/)
})

test('checkPeers: a new required peer or a narrowed range trips', () => {
	const r = checkPeers({
		depBase: { peerDependencies: { react: '^17 || ^18', vue: '^3' } },
		depHead: { peerDependencies: { react: '^18', vue: '^3', zod: '^3' } },
	})
	assert.equal(r.findings.length, 2)
	assert.match(r.findings.join('\n'), /react/)
	assert.match(r.findings.join('\n'), /adds peer dependency `zod/)
})

test('checkPeers: a widened range and a new optional peer pass', () => {
	const r = checkPeers({
		depBase: { peerDependencies: { react: '^18' } },
		depHead: { peerDependencies: { react: '^18 || ^19', vue: '^3' }, peerDependenciesMeta: { vue: { optional: true } } },
	})
	assert.deepEqual(r.findings, [])
	assert.equal(r.notes.length, 1)
})

test('checkPeers: optional to required trips', () => {
	const r = checkPeers({
		depBase: { peerDependencies: { vue: '^3' }, peerDependenciesMeta: { vue: { optional: true } } },
		depHead: { peerDependencies: { vue: '^3' } },
	})
	assert.match(r.findings[0], /required/)
})

test('diffSurface reports added and removed statements per package', () => {
	const d = diffSurface({ '(self)': ['a', 'b'], dep: ['x'] }, { '(self)': ['b', 'a'], dep: ['x', 'y'] })
	assert.deepEqual(d, [{ group: 'dep', removed: [], added: ['y'] }])
	assert.deepEqual(diffSurface({ x: ['a', 'a'] }, { x: ['a'] }), [{ group: 'x', removed: ['a'], added: [] }])
})

test('renderReport lists what a person must cover', () => {
	const md = renderReport({
		decision: 'fail',
		plan: { reasons: ['r'], uncovered: ['a'] },
		findings: [{ package: 'a', dep: 'x 1.0.0 → 1.1.0', check: 'engines', message: 'm' }],
		botChangeset: '.changeset/renovate-1.md',
	})
	assert.match(md, /^<!-- dep-changeset -->/)
	assert.match(md, /- `a` \(engines\), `x 1\.0\.0 → 1\.1\.0`: m/)
	assert.match(md, /To unblock/)
	assert.match(md, /renovate-1\.md` was written by a bot/)
})

test('releaseGuard: a major no person asked for fails', () => {
	const bad = releaseGuard({
		bumps: [{ name: 'a', from: '1.2.0', to: '2.0.0' }],
		changesets: [{ file: '.changeset/renovate-1.md', releases: new Map([['a', 'major']]), byPerson: false }],
	})
	assert.equal(bad.length, 1)
	assert.deepEqual(bad[0].botMajor, ['.changeset/renovate-1.md'])
})

test('releaseGuard: a person-written major passes, minor and patch bumps are ignored', () => {
	const bad = releaseGuard({
		bumps: [
			{ name: 'a', from: '1.2.0', to: '2.0.0' },
			{ name: 'b', from: '1.2.0', to: '1.3.0' },
		],
		changesets: [{ file: '.changeset/x.md', releases: new Map([['a', 'major']]), byPerson: true }],
	})
	assert.deepEqual(bad, [])
})

test('releaseGuard: a dependent raised to major by changesets fails', () => {
	const bad = releaseGuard({
		bumps: [{ name: 'dependent', from: '0.4.0', to: '1.0.0' }],
		changesets: [{ file: '.changeset/x.md', releases: new Map([['core', 'minor']]), byPerson: true }],
	})
	assert.equal(bad.length, 1)
	assert.deepEqual(bad[0].botMajor, [])
})

test('releaseGuard: a fixed-group member follows a person-written major', () => {
	const groups = expandGroups({ fixed: [['@s/*']] }, ['@s/a', '@s/b', 'c'])
	assert.deepEqual(groups, [['@s/a', '@s/b']])
	const bad = releaseGuard({
		bumps: [
			{ name: '@s/a', from: '1.0.0', to: '2.0.0' },
			{ name: '@s/b', from: '1.0.0', to: '2.0.0' },
		],
		changesets: [{ file: '.changeset/x.md', releases: new Map([['@s/a', 'major']]), byPerson: true }],
		groups,
	})
	assert.deepEqual(bad, [])
})

test('workspace membership follows pnpm-workspace.yaml globs', () => {
	const patterns = parseWorkspaceYaml("packages:\n  - apps/*\n  - 'packages/**'\n  - '!**/fixtures/**'\n\ncatalog:\n  a: ^1\n")
	assert.deepEqual(patterns, ['apps/*', 'packages/**', '!**/fixtures/**'])
	assert.equal(isWorkspaceMember('.', patterns), true)
	assert.equal(isWorkspaceMember('apps/web', patterns), true)
	assert.equal(isWorkspaceMember('apps/web/sub', patterns), false)
	assert.equal(isWorkspaceMember('packages/a/b', patterns), true)
	assert.equal(isWorkspaceMember('packages/a/fixtures/x', patterns), false)
	assert.equal(isWorkspaceMember('test/fixture', patterns), false)
	assert.equal(isWorkspaceMember('packages/a', []), false)
})
