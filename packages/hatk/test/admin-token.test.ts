import { beforeAll, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { insertReport, queryReports, setRepoStatus, getRepoStatus } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION, PRIVATE_COLLECTION } from './fixture.ts'

// The admin token lets a service, such as a support agent acting on a
// maintainer's word, use the /admin API with no account of its own. It must
// open /admin and nothing more.

const TOKEN = 'a-long-random-token-for-tests'
const SPAMMER = 'did:plc:spammer'

const handler = createHandler({
  collections: [PUBLIC_COLLECTION, PRIVATE_COLLECTION],
  publicDir: null,
  oauth: null,
  admins: ['did:plc:admin'],
  adminToken: { token: TOKEN, actor: 'support-agent' },
})
const post = (path: string, body: unknown, auth?: string) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: auth ? { authorization: auth } : {},
    }),
  )

beforeAll(async () => {
  await setupFixtureDatabase()
  await setRepoStatus(SPAMMER, 'active', undefined, { handle: 'spammer.test' })
})

test('the token acts on the review queue, and the report records who closed it', async () => {
  await insertReport({ subjectUri: SPAMMER, subjectDid: SPAMMER, label: 'spam', reportedBy: 'system:spam' })

  const res = await post('/admin/review/act', { did: SPAMMER, action: 'takedown' }, `Bearer ${TOKEN}`)
  expect(res.status).toBe(200)
  expect(await getRepoStatus(SPAMMER)).toBe('takendown')

  const { reports } = await queryReports({ status: 'resolved' })
  expect(reports.find((r: any) => r.subject_uri === SPAMMER)?.resolved_by).toBe('support-agent')
})

test('a wrong or missing token is refused', async () => {
  expect((await post('/admin/review/act', { did: SPAMMER, action: 'dismiss' }, `Bearer ${TOKEN}x`)).status).toBe(401)
  expect((await post('/admin/review/act', { did: SPAMMER, action: 'dismiss' }, TOKEN)).status).toBe(401)
  expect((await post('/admin/review/act', { did: SPAMMER, action: 'dismiss' })).status).toBe(401)
})

test('an actor that is a DID is refused, so no account can be the token', () => {
  expect(() =>
    createHandler({
      collections: [],
      publicDir: null,
      oauth: null,
      admins: [],
      adminToken: { token: TOKEN, actor: 'did:plc:admin' },
    }),
  ).toThrow('must not be a DID')
})
