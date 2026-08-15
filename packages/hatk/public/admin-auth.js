//#region ../oauth-client/src/crypto.js
function e(e) {
	let t = e instanceof Uint8Array ? e : new Uint8Array(e), n = "";
	for (let e = 0; e < t.length; e++) n += String.fromCharCode(t[e]);
	return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function t(t = 32) {
	return e(crypto.getRandomValues(new Uint8Array(t)));
}
async function n(e) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e)));
}
async function r(t) {
	return e(await n(t));
}
async function i(t, n, r) {
	let i = new TextEncoder(), a = `${e(i.encode(JSON.stringify(t)))}.${e(i.encode(JSON.stringify(n)))}`;
	return `${a}.${e(await crypto.subtle.sign({
		name: "ECDSA",
		hash: "SHA-256"
	}, r, i.encode(a)))}`;
}
//#endregion
//#region ../oauth-client/src/dpop.js
var a = "dpop-keys", o = "dpop-key", s = /* @__PURE__ */ new Map();
function c(e) {
	let t = s.get(e);
	if (t) return t;
	let n = new Promise((t, n) => {
		let r = indexedDB.open(`appview-oauth-${e}`, 1);
		r.onerror = () => n(r.error), r.onsuccess = () => t(r.result), r.onupgradeneeded = (e) => {
			let t = e.target.result;
			t.objectStoreNames.contains(a) || t.createObjectStore(a, { keyPath: "id" });
		};
	});
	return s.set(e, n), n;
}
async function l(e) {
	let t = await c(e);
	return new Promise((e, n) => {
		let r = t.transaction(a, "readonly").objectStore(a).get(o);
		r.onsuccess = () => e(r.result || null), r.onerror = () => n(r.error);
	});
}
async function u(e, t, n) {
	let r = await c(e);
	return new Promise((e, i) => {
		let s = r.transaction(a, "readwrite").objectStore(a).put({
			id: o,
			privateKey: t,
			publicJwk: n,
			createdAt: Date.now()
		});
		s.onsuccess = () => e(), s.onerror = () => i(s.error);
	});
}
async function d(e) {
	let t = await l(e);
	if (t) return t;
	let n = await crypto.subtle.generateKey({
		name: "ECDSA",
		namedCurve: "P-256"
	}, !1, ["sign"]), r = await crypto.subtle.exportKey("jwk", n.publicKey);
	return await u(e, n.privateKey, r), {
		id: o,
		privateKey: n.privateKey,
		publicJwk: r,
		createdAt: Date.now()
	};
}
async function f(e) {
	let t = await c(e);
	return new Promise((e, n) => {
		let r = t.transaction(a, "readwrite").objectStore(a).delete(o);
		r.onsuccess = () => e(), r.onerror = () => n(r.error);
	});
}
async function p(e, n, a, o) {
	let s = await d(e), { kty: c, crv: l, x: u, y: f } = s.publicJwk, p = {
		alg: "ES256",
		typ: "dpop+jwt",
		jwk: {
			kty: c,
			crv: l,
			x: u,
			y: f
		}
	}, m = {
		jti: t(16),
		htm: n,
		htu: a.split("?")[0],
		iat: Math.floor(Date.now() / 1e3)
	};
	return o && (m.ath = await r(o)), i(p, m, s.privateKey);
}
//#endregion
//#region ../oauth-client/src/storage.js
function m(e) {
	let t = (t) => `appview_${e}_${t}`, n = /* @__PURE__ */ new Set([
		"codeVerifier",
		"oauthState",
		"redirectUri"
	]);
	return {
		get(e) {
			return (n.has(e) ? sessionStorage : localStorage).getItem(t(e));
		},
		set(e, r) {
			(n.has(e) ? sessionStorage : localStorage).setItem(t(e), r);
		},
		remove(e) {
			(n.has(e) ? sessionStorage : localStorage).removeItem(t(e));
		},
		clear() {
			for (let e of n) sessionStorage.removeItem(t(e));
			for (let e of [
				"accessToken",
				"refreshToken",
				"tokenExpiresAt",
				"userDid",
				"clientId"
			]) localStorage.removeItem(t(e));
		}
	};
}
var h = 5e3;
async function g(e, t) {
	let n = `appview_${e}_lock_${t}`, r = `${Date.now()}_${Math.random()}`, i = Date.now() + h;
	for (; Date.now() < i;) {
		let e = localStorage.getItem(n);
		if (e) {
			let t = parseInt(e.split("_")[0]);
			if (Date.now() - t > h) localStorage.removeItem(n);
			else {
				await new Promise((e) => setTimeout(e, 50));
				continue;
			}
		}
		if (localStorage.setItem(n, r), await new Promise((e) => setTimeout(e, 10)), localStorage.getItem(n) === r) return r;
	}
	return null;
}
function _(e, t, n) {
	let r = `appview_${e}_lock_${t}`;
	localStorage.getItem(r) === n && localStorage.removeItem(r);
}
//#endregion
//#region ../oauth-client/src/client.js
var v = 6e4, y = class {
	constructor({ server: e, clientId: t, redirectUri: n, scope: r }) {
		this.server = e.replace(/\/$/, ""), this.clientId = t || window.location.origin, this.redirectUri = n || window.location.origin + window.location.pathname, this.scope = r || "atproto", this.namespace = this.clientId.replace(/[^a-z0-9]/gi, "_").slice(0, 32), this.storage = m(this.namespace), this._initPromise = null, this._refreshPromise = null;
	}
	async init() {
		return this._initPromise ||= d(this.namespace), this._initPromise;
	}
	async login(e) {
		await this.init();
		let n = t(32), i = await r(n), a = t(16);
		this.storage.set("codeVerifier", n), this.storage.set("oauthState", a), this.storage.set("clientId", this.clientId), this.storage.set("redirectUri", this.redirectUri);
		let o = `${this.server}/oauth/par`, s = await p(this.namespace, "POST", o), c = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			code_challenge: i,
			code_challenge_method: "S256",
			scope: this.scope,
			state: a
		});
		e && c.set("login_hint", e);
		let l = await fetch(o, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				DPoP: s
			},
			body: c.toString()
		});
		if (!l.ok) {
			let e = await l.json().catch(() => ({}));
			throw Error(`PAR failed: ${e.error || l.status}`);
		}
		let { request_uri: u } = await l.json(), d = new URLSearchParams({
			request_uri: u,
			client_id: this.clientId
		});
		window.location.href = `${this.server}/oauth/authorize?${d}`;
	}
	async handleCallback() {
		let e = new URLSearchParams(window.location.search), t = e.get("code"), n = e.get("state"), r = e.get("error");
		if (r) throw Error(`OAuth error: ${r} - ${e.get("error_description") || ""}`);
		if (!t || !n) return !1;
		if (n !== this.storage.get("oauthState")) throw Error("OAuth state mismatch");
		let i = this.storage.get("codeVerifier"), a = this.storage.get("clientId"), o = this.storage.get("redirectUri");
		if (!i || !a || !o) throw Error("Missing OAuth session data");
		await this.init();
		let s = `${this.server}/oauth/token`, c = await p(this.namespace, "POST", s), l = await fetch(s, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				DPoP: c
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: t,
				redirect_uri: o,
				client_id: a,
				code_verifier: i
			})
		});
		if (!l.ok) {
			let e = await l.json().catch(() => ({}));
			throw Error(`Token exchange failed: ${e.error_description || l.statusText}`);
		}
		let u = await l.json();
		return this._storeTokens(u), this.storage.remove("codeVerifier"), this.storage.remove("oauthState"), this.storage.remove("redirectUri"), window.history.replaceState({}, document.title, window.location.pathname), !0;
	}
	get isLoggedIn() {
		return !!this.storage.get("accessToken") && !!this.storage.get("userDid");
	}
	get did() {
		return this.storage.get("userDid");
	}
	get handle() {
		return this.storage.get("userHandle");
	}
	async fetch(e, t = {}) {
		await this.init();
		let n = e.startsWith("http") ? e : `${this.server}${e}`, r = (t.method || "GET").toUpperCase(), i = await this._getValidToken();
		if (!i) throw Error("Not authenticated");
		let a = await p(this.namespace, r, n, i), o = {
			...t.headers,
			Authorization: `DPoP ${i}`,
			DPoP: a
		}, s = await fetch(n, {
			...t,
			method: r,
			headers: o
		});
		if (s.status === 403 && (await s.clone().json().catch(() => ({}))).error === "ScopeMissingError") throw this.login(this.did), Error("Re-authenticating with updated scopes");
		return s;
	}
	async logout() {
		this.storage.clear(), await f(this.namespace), this._initPromise = null;
	}
	_storeTokens(e) {
		this.storage.set("accessToken", e.access_token), e.refresh_token && this.storage.set("refreshToken", e.refresh_token), e.sub && this.storage.set("userDid", e.sub), e.handle && this.storage.set("userHandle", e.handle);
		let t = Date.now() + (e.expires_in || 3600) * 1e3;
		this.storage.set("tokenExpiresAt", t.toString());
	}
	async _getValidToken() {
		let e = this.storage.get("accessToken"), t = parseInt(this.storage.get("tokenExpiresAt") || "0");
		return e && Date.now() < t - v ? e : (this._refreshPromise ||= this._refresh().finally(() => {
			this._refreshPromise = null;
		}), this._refreshPromise);
	}
	async _refresh() {
		let e = this.storage.get("refreshToken");
		if (!e) return null;
		let t = await g(this.namespace, "refresh");
		if (!t) return await new Promise((e) => setTimeout(e, 150)), this.storage.get("accessToken");
		try {
			let t = this.storage.get("accessToken"), n = parseInt(this.storage.get("tokenExpiresAt") || "0");
			if (t && Date.now() < n - v) return t;
			let r = `${this.server}/oauth/token`, i = await p(this.namespace, "POST", r), a = await fetch(r, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: i
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: e,
					client_id: this.storage.get("clientId") || this.clientId
				})
			});
			if (!a.ok) return this.storage.clear(), null;
			let o = await a.json();
			return this._storeTokens(o), o.access_token;
		} finally {
			_(this.namespace, "refresh", t);
		}
	}
};
//#endregion
export { y as OAuthClient };
