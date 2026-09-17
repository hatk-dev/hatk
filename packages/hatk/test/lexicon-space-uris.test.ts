import { validateRecord } from '@bigmoves/lexicon'
import { expect, test } from 'vitest'

// hatk validates every record it indexes with the lexicon library, and a
// record inside a permissioned space names the things it points at through
// the space. The library has to accept that form or every reply, vote and
// RSVP is skipped; this pins the version hatk depends on to one that does.

const lexicons: any[] = [
  {
    lexicon: 1,
    id: 'test.hatk.reply',
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['thread'],
          properties: {
            thread: { type: 'ref', ref: 'com.atproto.repo.strongRef' },
            about: { type: 'string', format: 'at-uri' },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.strongRef',
    defs: {
      main: {
        type: 'object',
        required: ['uri', 'cid'],
        properties: { uri: { type: 'string', format: 'at-uri' }, cid: { type: 'string', format: 'cid' } },
      },
    },
  },
]

const SPACE = 'at://did:plc:club/space/fyi.opensocial.forum/ride-planning'
const IN_SPACE = `${SPACE}/did:plc:dana/com.atmoboards.forum.thread/abc`
const CID = 'bafyreih2dtcuctxfti4a4wzejehecpxyyde5y4vuiupxvacelowhmmrpbu'

test('a record that names a space, or a record in one, validates', () => {
  expect(validateRecord(lexicons, 'test.hatk.reply', { thread: { uri: IN_SPACE, cid: CID }, about: SPACE })).toBeNull()
})

test('an at-uri that is neither still fails', () => {
  expect(validateRecord(lexicons, 'test.hatk.reply', { thread: { uri: 'https://nope', cid: CID } })).toMatchObject({
    path: 'thread.uri',
  })
})
