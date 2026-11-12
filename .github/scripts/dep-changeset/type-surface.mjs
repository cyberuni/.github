// P8 (a): a snapshot of a package's public type surface, for comparing a base build with
// a head build.
//
// Method. Start from the declaration files the package publishes as entry points (its
// `types`/`typings` field and every `types` target in `exports`). Load them into a
// TypeScript program, which follows every import, so the program holds the full set of
// declaration files the public API reaches: the package's own emitted chunks and the
// declarations of every dependency those chunks import. Print each top-level statement
// of every such file with comments stripped, and group the statements by the package
// they belong to.
//
// Why this and not a plain diff of the emitted .d.ts files:
//   - A dependency bump usually leaves the package's own .d.ts text unchanged. The leak
//     is in the dependency's declarations that the package re-exports or references.
//     Following imports catches that; diffing the package's own files does not.
//   - tsdown and rolldown name chunks by content hash (`index-BxYz12_3.d.mts`), so the
//     file names move between builds. Grouping by package and comparing statements as a
//     multiset ignores file names, and hash-shaped segments inside import specifiers are
//     normalized away.
//   - A dependency the public types never import is not in the program at all, so a
//     bump of an implementation-only dependency produces no finding.
//
// Why not API Extractor: it needs a per-package config and a single rolled-up entry, and
// it refuses many real setups (multiple entry points, `export *` from externals). Here
// a refusal means "cannot verify", which fails closed, so a tool that refuses often
// would send nearly every PR to a person.
//
// The snapshot is conservative: any change to a reachable dependency declaration trips,
// even a new member the package does not use. That sends the PR to a person, which is
// the safe direction.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const DTS = /\.d\.[cm]?ts$/

// Every declaration entry point the package publishes, as absolute paths.
// Returns { entries, missing } where `missing` lists declared paths that do not exist.
export function declarationEntries(pkgDir) {
	const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
	const declared = new Set()
	for (const f of [pkg.types, pkg.typings]) if (typeof f === 'string') declared.add(f)
	collectExportTargets(pkg.exports, false, declared)
	const entries = new Set()
	const missing = []
	for (const rel of declared) {
		if (rel.includes('*')) {
			for (const f of expandPattern(pkgDir, rel)) entries.add(f)
			continue
		}
		const abs = resolve(pkgDir, rel)
		if (DTS.test(abs)) {
			if (existsSync(abs)) entries.add(abs)
			else missing.push(rel)
		} else {
			// A JS target under a `types`-less condition: TypeScript looks for a sibling
			// declaration file, so do the same.
			const sibling = siblingDeclaration(abs)
			if (sibling) entries.add(sibling)
		}
	}
	if (entries.size === 0 && missing.length === 0) {
		const fallback = siblingDeclaration(resolve(pkgDir, typeof pkg.main === 'string' ? pkg.main : 'index.js'))
		if (fallback) entries.add(fallback)
	}
	return { entries: [...entries].sort(), missing }
}

function collectExportTargets(node, underTypes, out) {
	if (typeof node === 'string') {
		if (underTypes || DTS.test(node) || /\.[cm]?js$/.test(node)) out.add(node)
		return
	}
	if (Array.isArray(node)) {
		for (const n of node) collectExportTargets(n, underTypes, out)
		return
	}
	if (node && typeof node === 'object') {
		for (const [k, v] of Object.entries(node)) {
			if (k === './package.json') continue
			collectExportTargets(v, underTypes || k === 'types' || k.startsWith('types@'), out)
		}
	}
}

function siblingDeclaration(jsPath) {
	const base = jsPath.replace(/\.[cm]?[jt]sx?$/, '')
	const ext = jsPath.endsWith('.mjs') ? ['.d.mts', '.d.ts'] : jsPath.endsWith('.cjs') ? ['.d.cts', '.d.ts'] : ['.d.ts']
	for (const e of ext) if (existsSync(base + e)) return base + e
	return null
}

function expandPattern(pkgDir, pattern) {
	const rel = pattern.replace(/^\.\//, '')
	const re = new RegExp(`^${rel.split('*').map(escapeRe).join('.*')}$`)
	const out = []
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules') continue
			const abs = join(dir, name)
			if (statSync(abs).isDirectory()) walk(abs)
			else {
				const r = relative(pkgDir, abs).split(sep).join('/')
				if (!re.test(r)) continue
				if (DTS.test(r)) out.push(abs)
				else {
					const s = siblingDeclaration(abs)
					if (s) out.push(s)
				}
			}
		}
	}
	const root = join(pkgDir, rel.split('*')[0].replace(/[^/]*$/, ''))
	if (existsSync(root)) walk(root)
	return out
}

function escapeRe(s) {
	return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

// The package a file belongs to: the path segment after the last `node_modules`, or
// `self` for the package's own files.
export function ownerOf(file) {
	const parts = file.split(sep).join('/').split('/')
	const i = parts.lastIndexOf('node_modules')
	if (i === -1) return '(self)'
	return parts[i + 1]?.startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : (parts[i + 1] ?? '(unknown)')
}

// Hash-shaped segments in chunk names, e.g. `./index-BxYz12_3.js` or `chunk.Dk2f9aQ1.d.mts`.
export function normalizeSpecifiers(text) {
	return text.replace(/([-.])[A-Za-z0-9_-]{8}(?=\.(?:d\.)?[cm]?[jt]sx?\b)/g, '$1[hash]')
}

// A bundler that rolls declarations into one file renames colliding names `X$1`, `X$2`,
// numbered in the order it meets them. A dependency bump can change that order and so
// renumber every alias with nothing a consumer sees changing. Each numbered name is
// replaced by what it binds to: `X$[from "mod"]` for an import alias, `X$[local]` for
// the only numbered local declaration of `X` in the file. Two numbered locals sharing a
// base name cannot be told apart by name, so they keep their numbers, and a swap trips.
const NUMBERED = /^(.+)\$\d+$/

export function aliasNames(sf) {
	const names = new Map()
	const locals = new Map()
	for (const st of sf.statements) {
		if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
			const from = normalizeSpecifiers(st.moduleSpecifier.text)
			const bindings = st.importClause?.namedBindings
			if (bindings && ts.isNamedImports(bindings)) {
				for (const el of bindings.elements) {
					const m = NUMBERED.exec(el.name.text)
					if (m) names.set(el.name.text, `${(el.propertyName ?? el.name).text}$[from "${from}"]`)
				}
			} else if (bindings && ts.isNamespaceImport(bindings)) {
				const m = NUMBERED.exec(bindings.name.text)
				if (m) names.set(bindings.name.text, `${m[1]}$[* from "${from}"]`)
			}
			continue
		}
		for (const name of declaredNames(st)) {
			const m = NUMBERED.exec(name)
			if (!m) continue
			const seen = locals.get(m[1]) ?? new Set()
			seen.add(name)
			locals.set(m[1], seen)
		}
	}
	for (const [base, seen] of locals) {
		if (seen.size === 1) names.set([...seen][0], `${base}$[local]`)
	}
	return names
}

function declaredNames(st) {
	if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
	return st.name && ts.isIdentifier(st.name) ? [st.name.text] : []
}

export function renameAliases(text, names) {
	if (names.size === 0) return text
	const re = new RegExp(`(?<![\\w$])(${[...names.keys()].map(escapeRe).join('|')})(?![\\w$])`, 'g')
	return text.replace(re, (n) => names.get(n))
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

// Returns { surface: { [owner]: string[] }, entries, missing, error }.
export function snapshot(pkgDir) {
	pkgDir = realpathSync(resolve(pkgDir))
	const { entries, missing } = declarationEntries(pkgDir)
	if (entries.length === 0) return { surface: {}, entries, missing }
	const program = ts.createProgram({
		rootNames: entries,
		options: {
			noEmit: true,
			allowJs: false,
			skipLibCheck: true,
			types: [],
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ESNext,
			noLib: true,
		},
	})
	const surface = {}
	for (const sf of program.getSourceFiles()) {
		if (program.isSourceFileDefaultLibrary(sf)) continue
		const owner = ownerOf(sf.fileName)
		if (owner === 'typescript') continue
		const lines = (surface[owner] ??= [])
		const isEntry = entries.includes(resolve(sf.fileName)) || entries.some((e) => safeReal(e) === resolve(sf.fileName))
		const names = aliasNames(sf)
		for (const st of sf.statements) {
			let text = printer.printNode(ts.EmitHint.Unspecified, st, sf).replace(/\s+/g, ' ').trim()
			text = renameAliases(normalizeSpecifiers(text), names)
			// Entry statements say which entry they are in, so moving an export from one
			// entry point to another shows up. Chunk statements do not, since chunk files
			// are renamed freely.
			lines.push(isEntry ? `[${relative(pkgDir, sf.fileName).split(sep).join('/')}] ${text}` : text)
		}
	}
	for (const k of Object.keys(surface)) surface[k].sort()
	return { surface, entries: entries.map((e) => relative(pkgDir, e)), missing }
}

function safeReal(p) {
	try {
		return realpathSync(p)
	} catch {
		return p
	}
}

// CLI for local use: `node type-surface.mjs <pkgDir>` prints the snapshot as JSON.
if (import.meta.url === `file://${process.argv[1]}`) {
	const dir = process.argv[2] ?? '.'
	console.log(JSON.stringify(snapshot(dir), null, 2))
}

