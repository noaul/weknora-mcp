import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWSHeaderParameters,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthorizationError,
  createJwtAccessTokenVerifier,
} from "../src/auth.js";

const issuer = "https://wek.uov.me/oauth/realms/weknora";
const audience = "https://wek.uov.me/mcp";
let privateKey: CryptoKey;
let verifier: ReturnType<typeof createJwtAccessTokenVerifier>;
let publicJwk: JWK;

async function verifierJwks(header: JWSHeaderParameters): Promise<JWK> {
  if (header.kid !== "test-key") throw new Error("unknown kid");
  return { ...publicJwk, kid: "test-key", alg: "RS256" };
}

async function token(
  overrides: Record<string, unknown> = {},
  options: { kid?: string; expiresIn?: string } = {},
) {
  const {
    iss = issuer,
    aud = audience,
    sub = "user-1",
    ...claims
  } = overrides;
  return new SignJWT({ scope: "openid weknora:mcp", azp: "chatgpt", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test-key" })
    .setIssuer(String(iss))
    .setAudience(aud as string | string[])
    .setSubject(String(sub))
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  verifier = createJwtAccessTokenVerifier({
    issuer,
    audience,
    requiredScope: "weknora:mcp",
    jwks: verifierJwks,
  });
});

describe("JWT access-token verification", () => {
  it("returns the authenticated principal", async () => {
    await expect(verifier(await token())).resolves.toEqual({
      subject: "user-1",
      clientId: "chatgpt",
      scopes: ["openid", "weknora:mcp"],
    });
  });

  it("rejects a token from another issuer", async () => {
    await expect(verifier(await token({ iss: "https://evil.example" }))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects a token for another audience", async () => {
    await expect(verifier(await token({ aud: "account" }))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("distinguishes insufficient scope from invalid authentication", async () => {
    await expect(verifier(await token({ scope: "openid" }))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejects expired tokens and unknown signing keys", async () => {
    await expect(
      verifier(await token({}, { expiresIn: "0s" })),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      verifier(await token({}, { kid: "unknown" })),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("can additionally require a configured realm role", async () => {
    const roleVerifier = createJwtAccessTokenVerifier({
      issuer,
      audience,
      requiredScope: "weknora:mcp",
      requiredRole: "weknora-admin",
      jwks: verifierJwks,
    });

    await expect(
      roleVerifier(
        await token({
          aud: audience,
          scope: "openid weknora:mcp",
          realm_access: { roles: ["weknora-admin"] },
        }),
      ),
    ).resolves.toMatchObject({ subject: "user-1" });
    await expect(
      roleVerifier(
        await token({
          aud: audience,
          scope: "openid weknora:mcp",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
