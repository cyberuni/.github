// Entry point for the dep-changeset workflows. Each subcommand gathers facts from git,
// the installed node_modules or the GitHub API, and hands them to lib.mjs.
//
//   node cli.mjs plan            which mode a Renovate PR is in, before any install
//   node cli.mjs check           P8 leak checks on the base and head installs
//   node cli.mjs write           write .changeset/renovate-<PR>.md
//   node cli.mjs release-guard   P9 on a Version Packages PR
//
// Inputs come from the environment; see each function. Outputs go to $GITHUB_OUTPUT,
// files in $DEP_CHANGESET_OUT, and the job summary.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
	catalogChanges,
	checkEngines,
	checkPeers,
	diffRuntimeDeps,
	diffSurface,
	expandGroups,
	isBot,
	isWorkspaceMember,
	LOCK_FILES,
	parseCatalogDiff,
	parseChangeset,
	parseWorkspaceYaml,
	plan,
	releaseGuard,
	renderChangeset,
	renderReport,
} from './lib.mjs'
import { snapshot } from './type-surface.mjs'

const env = process.env
const OUT = env.DEP_CHANGESET_OUT ?? join(env.RUNNER_TEMP ?? '/tmp', 'dep-changeset')

function git(args, cwd = '.') {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()
}

function tryGit(args, cwd = '.') {
	try {
		return git(args, cwd)
	} catch {
		return null
	}
}

function output(name, value) {
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
	console.log(`${name}=${value}`)
}

function summary(md) {
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`)
}

function readJsonAt(rev, path) {
	const text = tryGit(['show', `${rev}:${path}`])
	if (text === null) return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

// Public workspace packages: the root package.json and the workspace members named by
// pnpm-workspace.yaml or the root `workspaces` field, when they have a name and are not
// private. Other package.json files (test fixtures, examples) are not released.
function publicPackages(rev) {
	const rootJson = readJsonAt(rev, 'package.json') ?? {}
	const ws = rootJson.workspaces
	const patterns = [
		...parseWorkspaceYaml(tryGit(['show', `${rev}:pnpm-workspace.yaml`]) ?? ''),
		...(Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : []),
	]
	const files = git(['ls-tree', '-r', '--name-only', rev]).split('\n')
	return files
		.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'))
		.map((file) => ({ file, dir: dirname(file), json: readJsonAt(rev, file) }))
		.filter((p) => isWorkspaceMember(p.dir, patterns) && p.json?.name && !p.json.private)
}

// Changeset files the PR added or changed that a person committed, and the packages they
// name. Bot commits (renovate[bot], github-actions[bot]) do not count.
function personChangesets(base, head = 'HEAD') {
	const files = git(['diff', '--name-only', '--diff-filter=AM', `${base}...${head}`, '--', '.changeset'])
		.split('\n')
		.filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && !/readme\.md$/i.test(f))
	const covered = new Set()
	const byPerson = []
	for (const f of files) {
		const authors = git(['log', '--format=%an%x09%ae', `${base}..${head}`, '--', f])
			.split('\n')
			.filter(Boolean)
			.map((l) => {
				const [name, email] = l.split('\t')
				return { name, email }
			})
		if (!authors.some((a) => !isBot(a))) continue
		const text = tryGit(['show', `${head}:${f}`])
		if (text === null) continue
		byPerson.push(f)
		for (const [name, level] of parseChangeset(text)) if (level !== 'none') covered.add(name)
	}
	return { covered, files: byPerson }
}

function readLabels() {
	if (env.LABELS) return JSON.parse(env.LABELS)
	if (!env.PR_NUMBER) return []
	// Read the labels live rather than from the event payload: Renovate opens the PR and
	// labels it in two calls, so the `opened` payload often has none.
	const out = execFileSync('gh', ['pr', 'view', env.PR_NUMBER, '--json', 'labels', '--jq', '[.labels[].name]'], { encoding: 'utf8' })
	return JSON.parse(out)
}

function cmdPlan() {
	const baseRef = env.BASE_REF ?? 'origin/main'
	const mergeBase = git(['merge-base', baseRef, 'HEAD'])
	const changed = git(['diff', '--name-only', `${mergeBase}...HEAD`]).split('\n').filter(Boolean)
	const lockChanged = changed.some((f) => LOCK_FILES.includes(f.split('/').pop()))
	const catalogs = changed.includes('pnpm-workspace.yaml')
		? parseCatalogDiff(git(['diff', '-U0', `${mergeBase}...HEAD`, '--', 'pnpm-workspace.yaml']))
		: new Map()
	const packages = publicPackages('HEAD').map((p) => {
		const before = changed.includes(p.file) ? (readJsonAt(mergeBase, p.file) ?? {}) : p.json
		const changes = [...diffRuntimeDeps(before, p.json), ...catalogChanges(p.json, catalogs)]
		return { name: p.json.name, dir: p.dir, changes, engines: p.json.engines?.node }
	})
	const labels = readLabels()
	const bundled = env.BUNDLED === 'true'
	const { covered, files } = personChangesets(mergeBase)
	const result = plan({ labels, bundled, packages, lockChanged, covered })
	const botFile = `.changeset/renovate-${env.PR_NUMBER}.md`
	const botChangeset = existsSync(botFile) ? botFile : null
	const needsChecks = result.mode === 'auto' && result.uncovered.length > 0
	mkdirSync(OUT, { recursive: true })
	const data = { ...result, labels, bundled, lockChanged, mergeBase, packages, personChangesets: files, botChangeset }
	writeFileSync(join(OUT, 'plan.json'), JSON.stringify(data, null, 2))
	console.log(JSON.stringify(data, null, 2))
	output('mode', result.mode)
	output('merge-base', mergeBase)
	output('needs-checks', String(needsChecks))
	if (!needsChecks) finish(data, [], [])
}

// Finds an installed dependency the way Node does: the nearest node_modules/<name> from
// the package directory upward, stopping at the checkout root.
function readInstalled(root, pkgDir, name) {
	let dir = resolve(root, pkgDir)
	const top = resolve(root)
	for (;;) {
		const f = join(dir, 'node_modules', name, 'package.json')
		if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
		if (dir === top) return null
		dir = dirname(dir)
	}
}

function cmdCheck() {
	const p = JSON.parse(readFileSync(join(OUT, 'plan.json'), 'utf8'))
	const baseDir = env.BASE_DIR
	const headDir = env.HEAD_DIR ?? '.'
	const findings = []
	const notes = []
	if (env.SETUP_FAILED === 'true') {
		findings.push({ package: '(all)', check: 'setup', message: 'installing or building the base or head commit failed, so nothing could be verified. See the job log.' })
	} else {
		for (const name of p.uncovered) {
			const pkg = p.packages.find((x) => x.name === name)
			checkPackage(pkg, { baseDir, headDir, findings, notes })
		}
	}
	finish(p, findings, notes)
}

function checkPackage(pkg, { baseDir, headDir, findings, notes }) {
	if (!existsSync(join(baseDir, pkg.dir, 'package.json'))) {
		findings.push({ package: pkg.name, check: 'setup', message: 'the package does not exist on the base commit' })
		return
	}
	for (const c of pkg.changes) {
		if (c.field === 'peerDependencies') continue
		const depBase = readInstalled(baseDir, pkg.dir, c.name)
		const depHead = readInstalled(headDir, pkg.dir, c.name)
		if (!depBase || !depHead) {
			findings.push({ package: pkg.name, dep: c.name, check: 'setup', message: `not installed on the ${!depBase ? 'base' : 'head'} commit, so its engines and peers cannot be read` })
			continue
		}
		const label = `${depBase.version} → ${depHead.version}`
		const eng = checkEngines({ pkgEngines: pkg.engines, depBase, depHead })
		if (eng) findings.push({ package: pkg.name, dep: `${c.name} ${label}`, check: 'engines', message: eng })
		const peers = checkPeers({ depBase, depHead })
		for (const m of peers.findings) findings.push({ package: pkg.name, dep: `${c.name} ${label}`, check: 'peers', message: m })
		for (const m of peers.notes) notes.push(`\`${pkg.name}\`, \`${c.name} ${label}\`: ${m}`)
	}
	let base
	let head
	try {
		base = snapshot(join(baseDir, pkg.dir))
		head = snapshot(join(headDir, pkg.dir))
	} catch (e) {
		findings.push({ package: pkg.name, check: 'types', message: `the type surface could not be read: ${e.message}` })
		return
	}
	for (const [side, s] of [['base', base], ['head', head]]) {
		if (s.missing.length) findings.push({ package: pkg.name, check: 'types', message: `declared declaration files are missing on the ${side} build: ${s.missing.map((m) => `\`${m}\``).join(', ')}` })
	}
	if (base.entries.length === 0 && head.entries.length === 0) {
		notes.push(`\`${pkg.name}\` publishes no declaration files, so its type surface was not compared.`)
		return
	}
	const diff = diffSurface(base.surface, head.surface)
	if (diff.length) {
		const detail = diff
			.flatMap((d) => [`# ${d.group}`, ...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)])
			.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
		const shown = detail.length > 80 ? [...detail.slice(0, 80), `… ${detail.length - 80} more lines`] : detail
		findings.push({
			package: pkg.name,
			check: 'types',
			message: `the public type surface changed in ${diff.map((d) => `\`${d.group}\``).join(', ')}`,
			detail: shown.join('\n'),
		})
	}
}

// Settles the decision, writes the report and the outputs.
//   pass:  nothing to do, or every target is covered.
//   write: P8 is clean; write a patch changeset for the targets.
//   fail:  a person must write the changeset.
function finish(p, findings, notes) {
	let decision
	const reasons = [...p.reasons]
	if (p.mode === 'none' || p.uncovered.length === 0) decision = 'pass'
	else if (p.mode === 'human') decision = 'fail'
	else if (findings.length) {
		decision = 'fail'
		reasons.push('A leak check tripped or could not run, so the workflow fails closed.')
	} else {
		const existing = p.botChangeset ? parseChangeset(readFileSync(p.botChangeset, 'utf8')) : new Map()
		decision = p.uncovered.every((t) => existing.has(t)) ? 'pass' : 'write'
		reasons.push('Every leak check passed on the base and head commits.')
	}
	const report = renderReport({ decision, plan: { ...p, reasons }, findings, notes, botChangeset: decision === 'fail' ? p.botChangeset : null })
	mkdirSync(OUT, { recursive: true })
	writeFileSync(join(OUT, 'report.md'), report)
	writeFileSync(join(OUT, 'decision.json'), JSON.stringify({ decision, targets: p.uncovered, findings, notes }, null, 2))
	summary(report)
	console.log(report)
	output('decision', decision)
	output('targets', JSON.stringify(decision === 'write' ? p.uncovered : []))
}

function cmdWrite() {
	const targets = JSON.parse(env.TARGETS ?? '[]')
	if (targets.length === 0) return
	const file = `.changeset/renovate-${env.PR_NUMBER}.md`
	const existing = existsSync(file) ? parseChangeset(readFileSync(file, 'utf8')) : new Map()
	const names = new Set([...existing.keys(), ...targets])
	const text = renderChangeset(names)
	mkdirSync('.changeset', { recursive: true })
	writeFileSync(file, text)
	console.log(text)
}

// P9. Fails when the Version Packages PR raises a package's major version and no
// person-written changeset among those the PR consumes asked for it.
function cmdReleaseGuard() {
	const baseRef = env.BASE_REF ?? 'origin/main'
	const mergeBase = git(['merge-base', baseRef, 'HEAD'])
	const bumps = []
	for (const f of git(['diff', '--name-only', `${mergeBase}...HEAD`]).split('\n')) {
		if (!/(^|\/)package\.json$/.test(f) || f.includes('node_modules/')) continue
		const a = readJsonAt(mergeBase, f)
		const b = readJsonAt('HEAD', f)
		if (a?.version && b?.version && a.version !== b.version) bumps.push({ name: b.name, from: a.version, to: b.version })
	}
	const consumed = git(['diff', '--name-only', '--diff-filter=D', `${mergeBase}...HEAD`, '--', '.changeset'])
		.split('\n')
		.filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && !/readme\.md$/i.test(f))
	const changesets = consumed.map((file) => ({
		file,
		releases: parseChangeset(git(['show', `${mergeBase}:${file}`])),
		byPerson: writtenByPerson(file, mergeBase),
	}))
	const config = readJsonAt(mergeBase, '.changeset/config.json') ?? {}
	const groups = expandGroups(config, publicPackages('HEAD').map((p) => p.json.name))
	const bad = releaseGuard({ bumps, changesets, groups })
	const lines = ['## dep-changeset release guard', '']
	if (bad.length === 0) {
		lines.push(
			bumps.length ? 'Every major bump in this release was asked for by a person-written changeset.' : 'This release has no version bumps.',
		)
	} else {
		lines.push('These packages get a major bump that no person-written changeset asked for:', '')
		for (const b of bad) {
			lines.push(`- \`${b.name}\` ${b.from} → ${b.to}${b.botMajor.length ? ` (a bot wrote \`major\` in ${b.botMajor.map((f) => `\`${f}\``).join(', ')})` : ' (changesets raised it, for example because a peer dependency range moved)'}`)
		}
		lines.push(
			'',
			'A major release has to be a person\'s decision. Either add a changeset on the default branch that names the package with `major`, written by a person, or lower the level of the changeset that caused it.',
		)
	}
	lines.push('', '| Changeset | Written by a person | Releases |', '|---|---|---|')
	for (const c of changesets) lines.push(`| \`${c.file}\` | ${c.byPerson ? 'yes' : 'no'} | ${[...c.releases].map(([n, l]) => `\`${n}\`: ${l}`).join(', ')} |`)
	const md = lines.join('\n')
	summary(md)
	console.log(md)
	if (bad.length) {
		console.log(`::error::${bad.length} major bump(s) not requested by a person-written changeset: ${bad.map((b) => b.name).join(', ')}`)
		process.exitCode = 1
	}
}

// A changeset counts as person-written when any commit that added or edited it on the
// default branch came from a person. Squash merges make the merged commit's author the
// PR author, so a person's commit inside a Renovate PR is only visible through the PR:
// look the PR up, then its commits.
function writtenByPerson(file, rev) {
	const commits = git(['log', '--format=%H%x09%an%x09%ae', rev, '--', file]).split('\n').filter(Boolean)
	for (const line of commits) {
		const [sha, name, email] = line.split('\t')
		const prs = ghJson(`repos/${env.GITHUB_REPOSITORY}/commits/${sha}/pulls`)
		if (!prs || prs.length === 0) {
			if (!isBot({ name, email })) return true
			continue
		}
		for (const pr of prs) {
			if (pr.user?.type !== 'Bot' && !isBot({ name: pr.user?.login })) return true
			const prCommits = ghJson(`repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}/commits?per_page=100`) ?? []
			for (const c of prCommits) {
				const person = c.author ? c.author.type !== 'Bot' && !isBot({ name: c.author.login }) : !isBot({ name: c.commit.author.name, email: c.commit.author.email })
				if (!person) continue
				const detail = ghJson(`repos/${env.GITHUB_REPOSITORY}/commits/${c.sha}`)
				if (detail?.files?.some((f) => f.filename === file)) return true
			}
		}
	}
	return false
}

function ghJson(path) {
	try {
		return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
	} catch (e) {
		console.log(`::warning::gh api ${path} failed: ${e.message.split('\n')[0]}`)
		return null
	}
}

const commands = { plan: cmdPlan, check: cmdCheck, write: cmdWrite, 'release-guard': cmdReleaseGuard }
const cmd = commands[process.argv[2]]
if (!cmd) {
	console.error(`usage: cli.mjs ${Object.keys(commands).join('|')}`)
	process.exit(2)
}
cmd()
