import { seed } from '$hatk'

const { createAccount, createRecord } = seed()

const alice = await createAccount('alice.test')

// await createRecord(alice, 'your.collection.here', {
//   field: 'value',
// }, { rkey: 'my-record' })

console.log('\n[seed] Done!')
