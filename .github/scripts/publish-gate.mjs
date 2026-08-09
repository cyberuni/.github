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

function sh(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function localPack(dir) {
	// `npm pack --dry-run --json` reports the exact file list npm would publish,
	// honouring `files`, .npmignore and all the built-in rules. Reimplementing that
	// resolution would be its own source of bugs.
	const out = sh('npm', ['pack', '--dry-run', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
	const parsed = JSON.parse(out)
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

export function render(results) {
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

		if (r.depDiff?.added.length) {
			failed = true
			lines.push('**Blocked — new runtime dependencies:**', '')
			for (const d of r.depDiff.added) lines.push(`- \`${d}\`@\`${r.deps[d]}\``)
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
