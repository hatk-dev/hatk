import { describe, expect, test } from 'vitest'
import { getLoopbackClientMetadata, isLoopbackClient, resolveClient, validateRedirectUri } from '../src/oauth/client.ts'
import type { OAuthClientConfig } from '../src/config.ts'

// Who may start an authorization, and where they may be sent back to. A
// loopback client (local dev) is trusted by origin alone per RFC 8252; every
// other client has to be registered in config with an explicit redirect list.

const registered: OAuthClientConfig[] = [
  {
    client_id: 'https://app.example/oauth-client-metadata.json',
    client_name: 'Example',
    scope: 'atproto',
    redirect_uris: ['https://app.example/oauth/callback', 'https://app.example/alt'],
  } as OAuthClientConfig,
]

describe('isLoopbackClient', () => {
  test('recognises localhost and the loopback IPs', () => {
    expect(isLoopbackClient('http://localhost:3000')).toBe(true)
    expect(isLoopbackClient('http://127.0.0.1:3000/callback')).toBe(true)
    expect(isLoopbackClient('http://[::1]:3000')).toBe(true)
    expect(isLoopbackClient('http://LOCALHOST')).toBe(true)
  })

  test('a hosted URL is not loopback', () => {
    expect(isLoopbackClient('https://app.example')).toBe(false)
    // A hostname that merely contains "localhost" would be a cheap forgery.
    expect(isLoopbackClient('https://localhost.attacker.example')).toBe(false)
  })

  test('something that is not a URL is not loopback', () => {
    expect(isLoopbackClient('not a url')).toBe(false)
    expect(isLoopbackClient('')).toBe(false)
  })
})

describe('resolveClient', () => {
  test('a loopback client needs no registration', () => {
    const client = resolveClient('http://localhost:3000', [])

    expect(client).toEqual(getLoopbackClientMetadata('http://localhost:3000'))
    expect(client!.redirect_uris).toEqual(['http://localhost:3000'])
    expect(client!.token_endpoint_auth_method).toBe('none')
    expect(client!.dpop_bound_access_tokens).toBe(true)
  })

  test('a registered client resolves to its configured name and redirects', () => {
    const client = resolveClient('https://app.example/oauth-client-metadata.json', registered)

    expect(client).toMatchObject({
      client_id: 'https://app.example/oauth-client-metadata.json',
      client_name: 'Example',
      redirect_uris: ['https://app.example/oauth/callback', 'https://app.example/alt'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      dpop_bound_access_tokens: true,
    })
  })

  test('an unregistered hosted client is refused', () => {
    expect(resolveClient('https://stranger.example/metadata.json', registered)).toBeNull()
    expect(resolveClient('https://stranger.example/metadata.json', [])).toBeNull()
  })
})

describe('validateRedirectUri', () => {
  test('a loopback client may redirect anywhere on its own origin', () => {
    // The port is fixed by the client_id; the path is the dev server's business.
    const client = getLoopbackClientMetadata('http://localhost:3000')

    expect(validateRedirectUri(client, 'http://localhost:3000/oauth/callback')).toBe(true)
    expect(validateRedirectUri(client, 'http://localhost:3000/anything?x=1')).toBe(true)
  })

  test('a loopback client may not redirect to a different port or host', () => {
    const client = getLoopbackClientMetadata('http://localhost:3000')

    expect(validateRedirectUri(client, 'http://localhost:4000/oauth/callback')).toBe(false)
    expect(validateRedirectUri(client, 'https://attacker.example/')).toBe(false)
  })

  test('a malformed redirect for a loopback client is refused rather than thrown', () => {
    const client = getLoopbackClientMetadata('http://localhost:3000')
    expect(validateRedirectUri(client, 'not a url')).toBe(false)
  })

  test('a registered client is held to its exact redirect list', () => {
    const client = resolveClient('https://app.example/oauth-client-metadata.json', registered)!

    expect(validateRedirectUri(client, 'https://app.example/oauth/callback')).toBe(true)
    expect(validateRedirectUri(client, 'https://app.example/alt')).toBe(true)
    // Same origin is not enough for a hosted client — the code would go to a
    // path the app never registered.
    expect(validateRedirectUri(client, 'https://app.example/other')).toBe(false)
    expect(validateRedirectUri(client, 'https://app.example/oauth/callback?extra=1')).toBe(false)
  })
})
