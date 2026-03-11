// xrpc-client.ts — Typed XRPC client
// Generic over a Schema type (auto-generated from lexicons).

type ExtractParams<T> = T extends { params: infer P } ? P : Record<string, string>
type ExtractOutput<T> = T extends { output: infer O } ? O : T

interface ClientOptions {
  fetch?: typeof globalThis.fetch
}

export function createClient<S>(baseUrl: string, opts: ClientOptions = {}) {
  const fetchFn = opts.fetch || globalThis.fetch.bind(globalThis)

  function buildQs(params?: unknown): string {
    if (!params || typeof params !== 'object') return ''
    const obj = params as Record<string, any>
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return ''
    return (
      '?' +
      new URLSearchParams(
        entries.reduce(
          (acc, [k, v]) => {
            acc[k] = String(v)
            return acc
          },
          {} as Record<string, string>,
        ),
      )
    )
  }

  return {
    async query<K extends keyof S & string>(
      nsid: K,
      params?: ExtractParams<S[K]> & Record<string, unknown>,
    ): Promise<ExtractOutput<S[K]>> {
      const qs = buildQs(params)
      const res = await fetchFn(`${baseUrl}/xrpc/${nsid}${qs}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `XRPC ${nsid}: ${res.status}`)
      }
      return res.json()
    },

    async call<K extends keyof S & string>(
      nsid: K,
      input?: S[K] extends { input: infer I } ? I : undefined,
      params?: ExtractParams<S[K]>,
    ): Promise<ExtractOutput<S[K]>> {
      const qs = buildQs(params)
      const res = await fetchFn(`${baseUrl}/xrpc/${nsid}${qs}`, {
        method: 'POST',
        headers: input ? { 'Content-Type': 'application/json' } : {},
        body: input ? JSON.stringify(input) : undefined,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `XRPC ${nsid}: ${res.status}`)
      }
      return res.json()
    },

    async upload<K extends keyof S & string>(
      nsid: K,
      data: Blob | ArrayBuffer,
      contentType: string,
    ): Promise<ExtractOutput<S[K]>> {
      const res = await fetchFn(`${baseUrl}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: data,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `XRPC ${nsid}: ${res.status}`)
      }
      return res.json()
    },
  }
}
