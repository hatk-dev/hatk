export class OAuthClient {
  constructor(opts: { server: string; clientId?: string; redirectUri?: string; scope?: string })
  init(): Promise<void>
  login(handle?: string): Promise<void>
  handleCallback(): Promise<boolean>
  logout(): Promise<void>
  fetch(path: string, opts?: RequestInit): Promise<Response>
  get isLoggedIn(): boolean
  get did(): string | null
  get handle(): string | null
}
