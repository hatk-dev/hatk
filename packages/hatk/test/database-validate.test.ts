import { expect, test } from 'vitest'
import { validateRecordWithSpaces } from '../src/database/validate.ts'

const SPACE = 'at://did:plc:club/space/fyi.opensocial.forum/ride-planning'
const IN_SPACE = `${SPACE}/did:plc:dana/com.atmoboards.forum.thread/abc`
const PLAIN = 'at://did:plc:dana/com.atmoboards.forum.thread/abc'

const lexicons = [
  {
    lexicon: 1,
    id: 'test.post',
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: 10 },
            thread: {
              type: 'object',
              properties: { uri: { type: 'string', format: 'at-uri' } },
            },
            mentions: { type: 'array', items: { type: 'string', format: 'at-uri' } },
          },
        },
      },
    },
  },
]

test('a plain at-uri still validates as before', () => {
  expect(validateRecordWithSpaces(lexicons, 'test.post', { text: 'hi', thread: { uri: PLAIN } })).toBeNull()
})

test('a space record URI in an at-uri field is accepted', () => {
  expect(validateRecordWithSpaces(lexicons, 'test.post', { text: 'hi', thread: { uri: IN_SPACE } })).toBeNull()
})

test('a space ref in an at-uri field is accepted', () => {
  expect(validateRecordWithSpaces(lexicons, 'test.post', { text: 'hi', thread: { uri: SPACE } })).toBeNull()
})

test('a space URI inside an array is accepted, and several at once', () => {
  const record = { text: 'hi', thread: { uri: IN_SPACE }, mentions: [PLAIN, IN_SPACE, SPACE] }
  expect(validateRecordWithSpaces(lexicons, 'test.post', record)).toBeNull()
})

test('an at-uri that is not a space URI is still refused', () => {
  const error = validateRecordWithSpaces(lexicons, 'test.post', { text: 'hi', thread: { uri: 'https://nope' } })
  expect(error).toMatchObject({ path: 'thread.uri', message: 'invalid at-uri format' })
})

test('every other rule still applies once the space URI is put back', () => {
  const error = validateRecordWithSpaces(lexicons, 'test.post', { text: 'far too long a text', thread: { uri: IN_SPACE } })
  expect(error?.path).toBe('text')
})

test('the caller gets the record it passed, untouched', () => {
  const record = { text: 'hi', thread: { uri: IN_SPACE } }
  validateRecordWithSpaces(lexicons, 'test.post', record)
  expect(record.thread.uri).toBe(IN_SPACE)
})
