// Pure decision logic for the dep-changeset and dep-changeset-release-guard workflows.
// Nothing here touches git, the network or the file system, so all of it is unit-tested
// in lib.test.mjs. The CLI (cli.mjs) gathers the facts and hands them to these functions.
import semver from 'semver'

export const LABEL_AUTO = 'dep-changeset:auto'
export const LABEL_HUMAN = 'dep-changeset:human'

// The package.json fields a consumer installs. A change to any of them can change what
// the published package does, so it needs a release entry.
export const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

export const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

// renovate[bot], github-actions[bot], dependabot[bot], and self-hosted Renovate's
// default "Renovate Bot <bot@renovateapp.com>".
export function isBot({ name = '', email = '' }) {
	return /\[bot\]/i.test(name) || /\[bot\]/i.test(email) || /^renovate( bot)?$/i.test(name) || /@renovateapp\.com$/i.test(email)
}

// Every added, removed or changed entry in the runtime fields of one package.json.
export function diffRuntimeDeps(basePkg = {}, headPkg = {}) {
	const changes = []
	for (const field of RUNTIME_FIELDS) {
		const before = basePkg[field] ?? {}
		const after = headPkg[field] ?? {}
		const names = new Set([...Object.keys(before), ...Object.keys(after)])
		for (const name of [...names].sort()) {
			if (before[name] === after[name]) continue
			changes.push({ field, name, from: before[name], to: after[name] })
		}
	}
	return changes
}

// Whether a range move is breaking under caret semantics. `unknown` covers anything
// semver cannot read (workspace:, catalog:, npm: aliases, git and file specs): the
// workflow cannot tell what moved, so it treats it like a major.
export function classifyRangeChange(from, to) {
	if (from === undefined) return 'added'
	if (to === undefined) return 'removed'
	const a = minVersion(from)
	const b = minVersion(to)
	if (!a || !b) return 'unknown'
	if (b.major !== a.major) return 'major'
	if (a.major === 0 && b.minor !== a.minor) return 'major'
	if (a.major === 0 && a.minor === 0 && b.patch !== a.patch) return 'major'
	return 'in-major'
}

function minVersion(range) {
	try {
		return semver.validRange(range) ? semver.minVersion(range) : null
	} catch {
		return null
	}
}

// Reads the package names and bump levels from a changeset's front matter.
export function parseChangeset(text) {
	const out = new Map()
	const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text)
	if (!m) return out
	for (const line of m[1].split(/\r?\n/)) {
		const l = /^\s*(['"]?)(.+?)\1\s*:\s*(major|minor|patch|none)\s*$/.exec(line)
		if (l) out.set(l[2], l[3])
	}
	return out
}

export function renderChangeset(names, summary = 'Update runtime dependencies.') {
	const lines = ['---', ...[...names].sort().map((n) => `'${n}': patch`), '---', '', summary, '']
	return lines.join('\n')
}

// Decides what a Renovate PR needs before any build runs.
//
// Returns `{ mode, targets, reasons, uncovered }` where mode is:
//   - `none`:  nothing published changed; the check passes.
//   - `human`: a person must commit a changeset for every target. Passes only when
//              `uncovered` is empty.
//   - `auto`:  the P8 leak checks decide. Clean means a patch changeset is written.
//
// `packages` lists the public workspace packages at head, each `{ name, dir, changes }`
// where `changes` comes from diffRuntimeDeps (plus catalog entries the package uses).
// `covered` holds the packages a person-written changeset in the PR already names.
export function plan({ labels = [], bundled = false, packages = [], lockChanged = false, covered = new Set() }) {
	const reasons = []
	const affected = packages.filter((p) => p.changes.length > 0)
	let targets = affected.map((p) => p.name)
	let mode
	if (labels.includes(LABEL_HUMAN)) {
		mode = 'human'
		reasons.push(`The PR is labeled \`${LABEL_HUMAN}\`.`)
	} else if (labels.includes(LABEL_AUTO)) {
		mode = 'auto'
	} else if (affected.length > 0) {
		// Fail closed: the preset should have labeled this. Without a label the workflow
		// cannot tell an oversight from a deliberate hold, so a person decides.
		mode = 'human'
		reasons.push(`Runtime dependencies changed but the PR has neither \`${LABEL_AUTO}\` nor \`${LABEL_HUMAN}\`.`)
	} else if (bundled && lockChanged) {
		mode = 'auto'
	} else {
		mode = 'none'
	}

	if (mode === 'auto') {
		if (bundled && lockChanged) {
			// The bundle inlines whatever the lock file resolves, so every public package
			// ships the update.
			targets = [...new Set([...targets, ...packages.map((p) => p.name)])]
		}
		for (const p of affected) {
			for (const c of p.changes) {
				const kind = c.field === 'peerDependencies' ? 'peer' : classifyRangeChange(c.from, c.to)
				if (kind === 'in-major') continue
				mode = 'human'
				reasons.push(`\`${p.name}\`: \`${c.field}.${c.name}\` ${describeChange(c)} is ${kind === 'peer' ? 'a peer dependency update' : `a ${kind} change`}, which needs a person.`)
			}
		}
	}

	if (targets.length === 0) {
		return { mode: 'none', targets: [], reasons: [...reasons, 'No published package changed a runtime dependency.'], uncovered: [] }
	}
	return { mode, targets, reasons, uncovered: targets.filter((t) => !covered.has(t)) }
}

// Changed entries of the default `catalog:` and named `catalogs:` in pnpm-workspace.yaml,
// read from a unified diff of that file. Returns Map(`catalog:<name>` → Map(dep → {from, to})).
// Only the simple one-entry-per-line form is read; that is what pnpm and Renovate write.
export function parseCatalogDiff(diff) {
	const out = new Map()
	let section = null // e.g. 'catalog:' or 'catalog:react17'
	let inCatalogs = false
	for (const raw of diff.split('\n')) {
		if (/^(\+\+\+|---|@@|diff |index )/.test(raw)) continue
		const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' '
		const line = raw.slice(1)
		if (/^\S/.test(line)) {
			inCatalogs = /^catalogs:\s*$/.test(line)
			section = /^catalog:\s*$/.test(line) ? 'catalog:' : null
			continue
		}
		if (inCatalogs) {
			const named = /^ {2}(['"]?)([^'":\s]+)\1:\s*$/.exec(line)
			if (named) {
				section = named[2] === 'default' ? 'catalog:' : `catalog:${named[2]}`
				continue
			}
		}
		if (!section || sign === ' ') continue
		const entry = /^\s+(['"]?)([^'"\s]+)\1:\s*(['"]?)(.+?)\3\s*(#.*)?$/.exec(line)
		if (!entry) continue
		const deps = out.get(section) ?? new Map()
		out.set(section, deps)
		const e = deps.get(entry[2]) ?? {}
		e[sign === '-' ? 'from' : 'to'] = entry[4]
		deps.set(entry[2], e)
	}
	return out
}

// The runtime entries of one package.json that point at a changed catalog entry.
export function catalogChanges(pkg = {}, catalogs = new Map()) {
	const changes = []
	for (const field of RUNTIME_FIELDS) {
		for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
			if (!spec.startsWith('catalog:')) continue
			const key = spec === 'catalog:' || spec === 'catalog:default' ? 'catalog:' : spec
			const e = catalogs.get(key)?.get(name)
			if (e && e.from !== e.to) changes.push({ field, name, from: e.from, to: e.to, via: key })
		}
	}
	return changes
}

export function describeChange(c) {
	if (c.from === undefined) return `added at \`${c.to}\``
	if (c.to === undefined) return `removed (was \`${c.from}\`)`
	return `\`${c.from}\` → \`${c.to}\``
}

// P8 (b). The dependency's engines.node floor must not exceed the package's own.
// When the package declares no floor, the dependency's floor must not rise.
export function checkEngines({ pkgEngines, depBase, depHead }) {
	const headRange = depHead?.engines?.node
	if (!headRange) return null
	const headFloor = minVersion(headRange)
	if (!headFloor) return `its \`engines.node\` \`${headRange}\` cannot be read`
	const baseRange = depBase?.engines?.node
	const baseFloor = baseRange ? minVersion(baseRange) : null
	if (baseRange && !baseFloor) return `its previous \`engines.node\` \`${baseRange}\` cannot be read`
	const rose = !baseFloor || semver.gt(headFloor, baseFloor)
	if (!rose) return null
	if (pkgEngines) {
		const pkgFloor = minVersion(pkgEngines)
		if (!pkgFloor) return `the package's own \`engines.node\` \`${pkgEngines}\` cannot be read`
		if (semver.lte(headFloor, pkgFloor)) return null
		return `its \`engines.node\` floor rose to ${headFloor.version} (\`${headRange}\`), above this package's floor ${pkgFloor.version} (\`${pkgEngines}\`)`
	}
	return `its \`engines.node\` floor rose from ${baseFloor ? `${baseFloor.version} (\`${baseRange}\`)` : 'none'} to ${headFloor.version} (\`${headRange}\`), and this package declares no \`engines.node\` to compare against`
}

// P8 (c). The dependency must not add or narrow a peer dependency. A new optional peer
// is reported but does not trip: nothing is installed or required for it.
export function checkPeers({ depBase = {}, depHead = {} }) {
	const findings = []
	const notes = []
	const before = depBase.peerDependencies ?? {}
	const after = depHead.peerDependencies ?? {}
	const optional = (pkg, n) => pkg.peerDependenciesMeta?.[n]?.optional === true
	for (const n of Object.keys(after).sort()) {
		const wasOptional = optional(depBase, n)
		const isOptional = optional(depHead, n)
		if (!(n in before)) {
			if (isOptional) notes.push(`adds optional peer \`${n}@${after[n]}\``)
			else findings.push(`adds peer dependency \`${n}@${after[n]}\``)
			continue
		}
		if (wasOptional && !isOptional) findings.push(`makes optional peer \`${n}\` required`)
		if (before[n] === after[n]) continue
		let widened = false
		try {
			widened = semver.validRange(before[n]) && semver.validRange(after[n]) ? semver.subset(before[n], after[n]) : false
		} catch {
			widened = false
		}
		if (!widened) findings.push(`changes peer \`${n}\` from \`${before[n]}\` to \`${after[n]}\`, which does not cover every version the old range allowed`)
	}
	return { findings, notes }
}

// Compares two type-surface snapshots (see type-surface.mjs). Returns the statements
// only in one side, grouped by the package they come from.
export function diffSurface(base, head) {
	const groups = new Set([...Object.keys(base), ...Object.keys(head)])
	const out = []
	for (const g of [...groups].sort()) {
		const a = countLines(base[g] ?? [])
		const b = countLines(head[g] ?? [])
		const removed = []
		const added = []
		for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) removed.push(line)
		for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) added.push(line)
		if (removed.length || added.length) out.push({ group: g, removed, added })
	}
	return out
}

function countLines(lines) {
	const m = new Map()
	for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
	return m
}

export const COMMENT_MARKER = '<!-- dep-changeset -->'

// The markdown posted on the PR and written to the job summary.
export function renderReport({ decision, plan: p, findings = [], notes = [], botChangeset }) {
	const out = [COMMENT_MARKER]
	if (decision === 'fail') {
		out.push('## dep-changeset: a person needs to write the changeset', '')
		out.push('This dependency update can change what a published package does, and the workflow could not show that it is safe to release as a patch. It wrote no changeset.', '')
	} else if (decision === 'write') {
		out.push('## dep-changeset: patch changeset written', '')
	} else {
		out.push('## dep-changeset: passed', '')
	}
	if (p.reasons.length) {
		out.push('**Why:**', '', ...p.reasons.map((r) => `- ${r}`), '')
	}
	if (findings.length) {
		out.push('**Leak-check findings:**', '')
		for (const f of findings) {
			out.push(`- \`${f.package}\` (${f.check})${f.dep ? `, \`${f.dep}\`` : ''}: ${f.message}`)
			if (f.detail) out.push('', '  <details><summary>detail</summary>', '', '  ```diff', ...f.detail.split('\n').map((l) => `  ${l}`), '  ```', '', '  </details>', '')
		}
		out.push('')
	}
	if (notes.length) out.push('**Notes:**', '', ...notes.map((n) => `- ${n}`), '')
	if (decision === 'fail') {
		out.push(
			'**To unblock:** commit a changeset (`pnpm changeset`) that names each package below with the level the change deserves. It must be committed by a person, not by renovate[bot] or github-actions[bot].',
			'',
			...p.uncovered.map((u) => `- \`${u}\``),
			'',
		)
		if (botChangeset) out.push(`\`${botChangeset}\` was written by a bot, so it does not count. Delete it or raise its level by hand.`, '')
	}
	return out.join('\n')
}

// P9. Which major bumps in a Version Packages PR no person asked for.
//
// `bumps`: [{ name, from, to }] for every package.json version change in the PR.
// `changesets`: [{ file, releases: Map(name → level), byPerson }] for every changeset
// the PR consumes. `groups`: the fixed and linked groups from .changeset/config.json,
// already expanded to package names.
export function releaseGuard({ bumps, changesets, groups = [] }) {
	const requested = new Set()
	for (const c of changesets) {
		if (!c.byPerson) continue
		for (const [name, level] of c.releases) if (level === 'major') requested.add(name)
	}
	const unrequested = []
	for (const b of bumps) {
		const from = semver.valid(b.from)
		const to = semver.valid(b.to)
		if (!from || !to || semver.major(to) <= semver.major(from)) continue
		if (requested.has(b.name)) continue
		if (groups.some((g) => g.includes(b.name) && g.some((n) => requested.has(n)))) continue
		const botMajor = changesets.filter((c) => !c.byPerson && c.releases.get(b.name) === 'major').map((c) => c.file)
		unrequested.push({ ...b, botMajor })
	}
	return unrequested
}

// Expands the `fixed` and `linked` entries of .changeset/config.json against the
// workspace package names. Entries may be exact names or globs with `*`.
export function expandGroups(config = {}, names = []) {
	const groups = [...(config.fixed ?? []), ...(config.linked ?? [])]
	return groups.map((g) =>
		names.filter((n) =>
			g.some((pattern) => {
				if (!pattern.includes('*')) return pattern === n
				const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
				return re.test(n)
			}),
		),
	)
}

// Workspace globs from pnpm-workspace.yaml's `packages:` list, read without a YAML
// parser: the list is one `- pattern` per line in every repo this serves.
export function parseWorkspaceYaml(text = '') {
	const out = []
	let inPackages = false
	for (const line of text.split(/\r?\n/)) {
		if (/^\S/.test(line)) {
			inPackages = /^packages:\s*$/.test(line)
			continue
		}
		if (!inPackages) continue
		const m = /^\s+-\s+(['"]?)(.+?)\1\s*(#.*)?$/.exec(line)
		if (m) out.push(m[2])
	}
	return out
}

// Whether a package directory (relative, '' for the root) is a workspace member.
// The root is always a member. `*` matches one path segment, `**` any number.
export function isWorkspaceMember(dir, patterns = []) {
	if (dir === '' || dir === '.') return true
	const toRe = (p) =>
		new RegExp(
			`^${p
				.replace(/^\.\//, '')
				.replace(/\/$/, '')
				.split('/')
				.map((seg) => (seg === '**' ? '.*' : seg.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')))
				.join('/')
				.replace(/\/\.\*/g, '(/.*)?')}$`,
		)
	let member = false
	for (const p of patterns) {
		if (p.startsWith('!')) {
			if (toRe(p.slice(1)).test(dir)) member = false
		} else if (toRe(p).test(dir)) member = true
	}
	return member
}
