// Run with `node --test .github/scripts/publish-gate.test.mjs`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIRST_PARTY, isAllowed, parseAllowList, render } from './publish-gate.mjs'

function result(added, deps) {
	return {
		name: 'standard-log',
		version: '2.0.0',
		publishedVersion: '1.0.0',
		files: ['index.js'],
		risky: [],
		fileDiff: { added: [], removed: [] },
		depDiff: { added, removed: [] },
		deps,
	}
}

test('a new first-party dependency is reported, not blocked', () => {
	const { body, failed } = render([result(['unpartial'], { unpartial: '^1.0.8' })])
	assert.equal(failed, false)
	assert.match(body, /Allowed — new runtime dependencies/)
	assert.match(body, /`unpartial`@`\^1\.0\.8`/)
	assert.doesNotMatch(body, /Blocked/)
})

test('an unknown new dependency still blocks', () => {
	const { body, failed } = render([result(['left-pad'], { 'left-pad': '^1.0.0' })])
	assert.equal(failed, true)
	assert.match(body, /Blocked — new runtime dependencies:\*\*\n\n- `left-pad`/)
	assert.doesNotMatch(body, /Allowed/)
})

test('allowed and unknown additions are split, and the unknown one still blocks', () => {
	const { body, failed } = render([result(['@just-web/types', 'evil'], { '@just-web/types': '^1.0.0', evil: '1.0.0' })])
	assert.equal(failed, true)
	assert.match(body, /Blocked — new runtime dependencies:\*\*\n\n- `evil`/)
	assert.match(body, /Allowed — new runtime dependencies on the allow-list:\*\*\n\n- `@just-web\/types`/)
})

test('a scope pattern matches packages in that scope only', () => {
	assert.equal(isAllowed('@unional/fixture', FIRST_PARTY), true)
	assert.equal(isAllowed('@unional-evil/fixture', FIRST_PARTY), false)
	assert.equal(isAllowed('unional', FIRST_PARTY), false)
	assert.equal(isAllowed('type-plus-evil', FIRST_PARTY), false)
})

test('a caller-supplied allow-list extends the default', () => {
	const allow = [...FIRST_PARTY, ...parseAllowList('@acme/*, lodash\nzod\n')]
	const { failed } = render([result(['@acme/x', 'lodash', 'zod', 'unpartial'], { '@acme/x': '1', lodash: '4', zod: '3', unpartial: '1' })], { allow })
	assert.equal(failed, false)
})

test('parseAllowList accepts names and scope patterns', () => {
	assert.deepEqual(parseAllowList(' @acme/* ,lodash\n\n zod '), ['@acme/*', 'lodash', 'zod'])
	assert.deepEqual(parseAllowList(''), [])
	assert.deepEqual(parseAllowList(undefined), [])
})

test('parseAllowList rejects wildcards that are not a whole scope', () => {
	for (const bad of ['*', 'lodash*', '@acme/foo-*', '@*/x']) assert.throws(() => parseAllowList(bad), /invalid allow-list entry/)
})
