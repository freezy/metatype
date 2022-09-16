import { OAuth2Client, Tokens } from "https://deno.land/x/oauth2_client/mod.ts";
import config from "./config.ts";
import { signJWT, signKey as nativeSignKey, verifyJWT } from "./crypto.ts";
import { envOrFail } from "./utils.ts";
import { deleteCookie, setCookie } from "std/http/cookie.ts";
import { crypto } from "std/crypto/mod.ts";
import * as jwt from "jwt";

export type AuthDS = {
  name: string;
  protocol: "oauth2" | "jwk";
  auth_data: Record<string, unknown>;
};

type JWTClaims = {
  provider: string;
  accessToken: string;
  refreshToken: string;
  refreshAt: number;
};

// localhost:7890/biscuicuits/auth/github?redirect_uri=localhost:7890/biscuicuits
export const nextAuthorizationHeader = "Next-Authorization";

export abstract class Auth {
  typegraphName: string;
  authDS: AuthDS;

  static async init(typegraphName: string, auth: AuthDS): Promise<Auth> {
    switch (auth.protocol) {
      case "oauth2":
        return await OAuth2Auth.init(typegraphName, auth);
      case "jwk":
        return await JWKAuth.init(typegraphName, auth);
      default:
        throw new Error(`${auth.protocol} not yet supported`);
    }
  }

  constructor(typegraphName: string, auth: AuthDS) {
    this.typegraphName = typegraphName;
    this.authDS = auth;
  }

  abstract authMiddleware(request: Request): Promise<Response>;

  abstract jwtMiddleware(
    jwt: string,
  ): Promise<[Record<string, unknown>, Headers]>;
}

export class JWKAuth extends Auth {
  signKey: CryptoKey;

  static async init(typegraphName: string, auth: AuthDS): Promise<Auth> {
    if (auth.name === "native") {
      return new JWKAuth(typegraphName, auth, nativeSignKey);
    }
    const jwk = envOrFail(typegraphName, `${auth.name}_JWK`);
    const signKey = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      auth.auth_data as unknown as
        | AlgorithmIdentifier
        | HmacImportParams
        | RsaHashedImportParams
        | EcKeyImportParams,
      false,
      ["verify"],
    );
    return new JWKAuth(typegraphName, auth, signKey);
  }

  constructor(typegraphName: string, auth: AuthDS, signKey: CryptoKey) {
    super(typegraphName, auth);
    this.signKey = signKey;
  }

  // deno-lint-ignore require-await
  async authMiddleware(_request: Request): Promise<Response> {
    return new Response("not found", {
      status: 404,
    });
  }

  async jwtMiddleware(
    token: string,
  ): Promise<[Record<string, unknown>, Headers]> {
    const claims = await jwt.verify(token, this.signKey);
    return [claims, new Headers()];
  }
}

export class OAuth2Auth extends Auth {
  client: OAuth2Client;
  profileUrl: string;

  static async init(typegraphName: string, auth: AuthDS): Promise<Auth> {
    const clientId = envOrFail(typegraphName, `${auth.name}_CLIENT_ID`);
    const clientSecret = envOrFail(
      typegraphName,
      `${auth.name}_CLIENT_SECRET`,
    );
    const { authorize_url, access_url, scopes, profile_url } = auth.auth_data;
    const client = new OAuth2Client({
      clientId,
      clientSecret,
      authorizationEndpointUri: authorize_url as string,
      tokenUri: access_url as string,
      redirectUri:
        `${config.tg_external_url}/${typegraphName}/auth/${auth.name}`,
      defaults: {
        scope: scopes as string,
      },
    });
    return await new OAuth2Auth(
      typegraphName,
      auth,
      client,
      profile_url as string,
    );
  }

  constructor(
    typegraphName: string,
    auth: AuthDS,
    client: OAuth2Client,
    profileUrl: string,
  ) {
    super(typegraphName, auth);
    this.profileUrl = profileUrl;
    this.client = client;
  }

  async authMiddleware(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());

    if (query.code && query.state) {
      try {
        const redirectUri = await this.verifyState(query.state);
        const headers = await this.createJWTHeaders(
          url,
          config.cookies_max_age_sec,
        );
        headers.set("location", redirectUri);
        return new Response(null, {
          status: 302,
          headers,
        });
      } catch (e) {
        return new Response(`oauth error: ${e}`, {
          status: 400,
        });
      }
    }

    if (!query.redirect_uri) {
      return new Response("missing redirect_uri query parameter", {
        status: 400,
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        location: await this.getAuthorizationUri(query.redirect_uri),
      },
    });
  }

  async jwtMiddleware(
    jwt: string,
  ): Promise<[Record<string, unknown>, Headers]> {
    const clearCookie = (): Headers => {
      const hs = new Headers();
      hs.set(nextAuthorizationHeader, "");
      if (jwt) {
        deleteCookie(hs, this.typegraphName);
      }
      return hs;
    };

    if (!jwt) {
      return [{}, clearCookie()];
    }

    try {
      const claims = await verifyJWT(jwt) as JWTClaims;
      if (!claims) {
        return [{}, clearCookie()];
      }

      if (new Date().valueOf() / 1000 > claims.refreshAt) {
        const hs = await this.renewJWTCookie(
          claims.refreshToken,
          config.cookies_max_age_sec,
        );
        return [claims, hs];
      }

      return [claims, new Headers()];
    } catch (e) {
      //console.error(e);
      return [{}, clearCookie()];
    }
  }

  private async getAuthorizationUri(redirectUri: string): Promise<string> {
    const state = await signJWT({ redirectUri }, 3600);
    return this.client.code.getAuthorizationUri({ state }).toString();
  }

  private async getToken(url: URL): Promise<Tokens> {
    return await this.client.code.getToken(url);
  }

  private async verifyState(state: string): Promise<string> {
    const payload = await verifyJWT(state);
    return payload.redirectUri as string;
  }

  private async refreshToken(refreshToken: string): Promise<Tokens> {
    return await this.client.refreshToken.refresh(refreshToken);
  }

  async getProfile(token: string): Promise<unknown> {
    if (!this.profileUrl) {
      return {};
    }

    const profile = await fetch(
      this.profileUrl,
      { headers: { authorization: `Bearer ${token}` } },
    );

    return await profile.json();
  }

  private async createJWT(token: Tokens, maxAge: number): Promise<string> {
    const payload: JWTClaims = {
      provider: this.authDS.name,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken as string,
      refreshAt: Math.ceil(
        new Date().valueOf() / 1000 +
          (token.expiresIn ?? config.cookies_min_refresh_sec),
      ),
    };
    return await signJWT(payload, maxAge);
  }

  private createHeaders(jwt: string, maxAge: number): Headers {
    const hs = new Headers();
    const name = this.typegraphName;
    setCookie(hs, {
      name,
      value: jwt,
      maxAge,
      domain: new URL(config.tg_external_url).hostname,
      path: `/${name}`,
      secure: !config.debug,
      sameSite: "Lax",
    });
    hs.set(nextAuthorizationHeader, jwt);
    return hs;
  }

  private async createJWTHeaders(
    urlWithToken: URL,
    maxAge: number,
  ): Promise<Headers> {
    const token = await this.getToken(urlWithToken);
    const jwt = await this.createJWT(token, maxAge);
    return this.createHeaders(jwt, maxAge);
  }

  private async renewJWT(
    refreshToken: string,
    maxAge: number,
  ): Promise<string | null> {
    const token = await this.refreshToken(refreshToken);
    return await this.createJWT(token, maxAge);
  }

  private async renewJWTCookie(
    refreshToken: string,
    maxAge: number,
  ): Promise<Headers> {
    const jwt = await this.renewJWT(refreshToken, maxAge);
    if (jwt) {
      return this.createHeaders(jwt, maxAge);
    }
    const hs = new Headers();
    const name = this.typegraphName;
    deleteCookie(hs, name);
    return hs;
  }
}