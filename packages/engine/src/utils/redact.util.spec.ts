import { REDACTED, redactText } from './redact.util'

test('redacts longest secrets first, repeated values and every HTTP URL', () => {
	expect(
		redactText(
			'secret-long secret secret-long https://api.example.test/v1 http://other.example.test/a',
			['secret', 'secret-long', '']
		)
	).toBe(Array.from({ length: 5 }, () => REDACTED).join(' '))
	expect(
		redactText('("HTTPS://example.test/a") [https://example.test/b] safe', [])
	).toBe(`("${REDACTED}") [${REDACTED}] safe`)
})
