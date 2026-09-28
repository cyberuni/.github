// Publish gate: compares what a release PR is about to publish against what is
// currently on the registry, and fails on the differences that are almost always
// a mistake or an attack.
//
// Runs against the "Version Packages" PR, which is the only point where the exact
// contents of the next release are knowable and still reviewable.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Files that have no business in a published tarball. Precedent: color-map shipped
// compiled .spec.js files in its 2.1.0 tarball without anyone noticing.
const RISKY = [
	{ re: /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i, why: 'test file' },
	{ re: /(^|\/)\.env(\.|$)/i, why: 'env file' },
	{ re: /\.(pem|key|p12|pfx|ppk)$/i, why: 'key material' },
	{ re: /(^|\/)\.npmrc$/i, why: 'npmrc (may carry a token)' },
	{ re: /(^|\/)\.git(hub|ignore|attributes)?\//i, why: 'repo metadata' },
	{ re: /(^|\/)id_(rsa|ed25519)/i, why: 'ssh key' },
]

// Packages the owner publishes. A new runtime dependency on one of these is a
// deliberate move within the owner's own graph, not a supply-chain surprise, so it is
// reported under its own heading instead of blocking. Precedent: type-plus 8 dropped
// its `unpartial` export, and standard-log's release was blocked for depending on the
// owner's own `unpartial` package instead.
//
// This is the one place the list lives. Callers extend it with the workflow's
// `allowed-new-dependencies` input; they cannot shrink it.
export const FIRST_PARTY = [
	'@unional/*',
	'@repobuddy/*',
	'@just-web/*',
	'@just-func/*',
	'@mocktomata/*',
	'@cyberuni/*',
	'type-plus',
	'unpartial',
	'tersify',
	'satisfier',
	'assertron',
	'iso-error',
	'iso-error-web',
	'google-cloud-api',
	'standard-log',
	'standard-log-color',
	'async-fp',
	'just-func',
	'clibuilder',
	'mocktomata',
	'progress-str',
	'fsa-emitter',
]

// Accepts a newline- or comma-separated list of exact package names and `@scope/*`
// patterns. Anything else containing `*` throws: a stray `*` or `foo-*` would quietly
// let arbitrary packages through, and a misconfigured gate should fail loudly.
export function parseAllowList(text) {
	const entries = (text ?? '')
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean)
	for (const e of entries) {
		if (e.includes('*') && !/^@[^/*]+\/\*$/.test(e)) throw new Error(`invalid allow-list entry \`${e}\`: use an exact package name or \`@scope/*\``)
	}
	return entries
}

export function isAllowed(name, allowList) {
	return allowList.some((p) => (p.endsWith('/*') ? name.startsWith(p.slice(0, -1)) : name === p))
}

function sh(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function localPack(dir) {
	// `npm pack --dry-run --json` reports the exact file list npm would publish,
	// honouring `files`, .npmignore and all the built-in rules. Reimplementing that
	// resolution would be its own source of bugs.
	//
	// `--ignore-scripts` because a lifecycle script's own stdout lands in the same
	// stream as the JSON: these repos run `prepack: pinst --disable`, whose "pinst
	// disabled" line made JSON.parse throw and the whole package report as
	// "inspection failed". The gate is an inspection — it should not be running the
	// package's scripts at all, and the caller workflow already builds beforehand.
	const out = sh('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
	// npm also emits notices on stdout in some versions, so slice from the first
	// structural character rather than trusting the whole stream to be JSON.
	const start = out.search(/[[{]/)
	if (start < 0) throw new Error(`npm pack produced no JSON in ${dir}`)
	const parsed = JSON.parse(out.slice(start))
	// npm has shipped both shapes: an array of entries, and an object keyed by
	// package name. Accept either — guessing wrong makes the gate silently report
	// zero files, which reads as "clean".
	const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
	const files = entry?.files
	if (!Array.isArray(files)) throw new Error(`could not read file list from npm pack in ${dir}`)
	return files.map((f) => f.path).sort()
}

function publishedInfo(name) {
	try {
		const out = sh('npm', ['view', `${name}@latest`, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })
		const parsed = JSON.parse(out)
		// `npm view` wraps in an array when the spec matches more than one version.
		const j = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
		if (!j?.dist?.tarball) throw new Error(`no tarball for ${name}`)
		return { version: j.version, tarball: j.dist.tarball, dependencies: j.dependencies ?? {} }
	} catch {
		return null // never published
	}
}

function publishedFiles(tarball) {
	const dir = mkdtempSync(join(tmpdir(), 'pg-'))
	const tgz = join(dir, 'p.tgz')
	sh('curl', ['-sSL', '-o', tgz, tarball])
	const listing = sh('tar', ['-tzf', tgz])
	return listing
		.split('\n')
		.filter(Boolean)
		.map((p) => p.replace(/^package\//, ''))
		.filter((p) => !p.endsWith('/'))
		.sort()
}

function diff(before, after) {
	const b = new Set(before)
	const a = new Set(after)
	return {
		added: after.filter((x) => !b.has(x)),
		removed: before.filter((x) => !a.has(x)),
	}
}

export function gatePackage(dir) {
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	if (pkg.private || !pkg.name) return null

	const files = localPack(dir)
	const deps = pkg.dependencies ?? {}
	const pub = publishedInfo(pkg.name)

	const risky = files.flatMap((f) => {
		const hit = RISKY.find((r) => r.re.test(f))
		return hit ? [{ file: f, why: hit.why }] : []
	})

	let fileDiff = null
	let depDiff = null
	if (pub?.tarball) {
		fileDiff = diff(publishedFiles(pub.tarball), files)
		depDiff = diff(Object.keys(pub.dependencies), Object.keys(deps))
	}

	return { name: pkg.name, version: pkg.version, publishedVersion: pub?.version ?? null, files, risky, fileDiff, depDiff, deps }
}

export function render(results, { allow = FIRST_PARTY } = {}) {
	const lines = []
	let failed = false

	for (const r of results) {
		lines.push(`### \`${r.name}\` — ${r.publishedVersion ?? '(unpublished)'} → ${r.version}`, '')

		if (r.risky.length) {
			failed = true
			lines.push('**Blocked — files that must not ship:**', '')
			for (const x of r.risky) lines.push(`- \`${x.file}\` — ${x.why}`)
			lines.push('')
		}

		const addedDeps = r.depDiff?.added ?? []
		const blockedDeps = addedDeps.filter((d) => !isAllowed(d, allow))
		const allowedDeps = addedDeps.filter((d) => isAllowed(d, allow))

		if (blockedDeps.length) {
			failed = true
			lines.push('**Blocked — new runtime dependencies:**', '')
			for (const d of blockedDeps) lines.push(`- \`${d}\`@\`${r.deps[d]}\``)
			lines.push('')
		}

		// Still listed, so an allowed addition stays visible in every release report.
		if (allowedDeps.length) {
			lines.push('**Allowed — new runtime dependencies on the allow-list:**', '')
			for (const d of allowedDeps) lines.push(`- \`${d}\`@\`${r.deps[d]}\``)
			lines.push('')
		}

		if (r.depDiff?.removed.length) lines.push(`Runtime deps removed: ${r.depDiff.removed.map((d) => `\`${d}\``).join(', ')}`, '')

		if (r.fileDiff) {
			const { added, removed } = r.fileDiff
			if (!added.length && !removed.length) lines.push('Tarball contents unchanged.', '')
			else {
				if (added.length) lines.push(`<details><summary>${added.length} file(s) added to the tarball</summary>`, '', ...added.map((f) => `- \`${f}\``), '', '</details>', '')
				if (removed.length) lines.push(`<details><summary>${removed.length} file(s) removed</summary>`, '', ...removed.map((f) => `- \`${f}\``), '', '</details>', '')
			}
		} else {
			lines.push(`First publish — ${r.files.length} file(s), no baseline to diff.`, '')
		}
	}

	lines.push(failed ? '**Result: blocked.**' : '**Result: clean.**')
	return { body: lines.join('\n'), failed }
}
