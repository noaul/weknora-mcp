import {
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
  type JWSHeaderParameters,
} from "jose";

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  readonly errorCode = "invalid_token";

  constructor(message = "Invalid access token") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  readonly errorCode = "insufficient_scope";

  constructor(message = "Required scope is missing") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthenticatedPrincipal {
  subject: string;
  clientId?: string;
  scopes: string[];
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  requiredScope: string;
  requiredRole?: string;
  jwks: (header: JWSHeaderParameters) => Promise<JWK>;
}

function assertRequiredRole(payload: JWTPayload, requiredRole?: string): void {
  if (!requiredRole) return;
  const realmAccess = payload.realm_access;
  const roles =
    realmAccess && typeof realmAccess === "object"
      ? (realmAccess as Record<string, unknown>).roles
      : undefined;
  if (
    !Array.isArray(roles) ||
    !roles.some((role) => typeof role === "string" && role === requiredRole)
  ) {
    throw new AuthorizationError("Required realm role is missing");
  }
}

export function createJwtAccessTokenVerifier(options: JwtVerifierOptions) {
  return async (token: string): Promise<AuthenticatedPrincipal> => {
    try {
      const result = await jwtVerify(
        token,
        async (header) => importJWK(await options.jwks(header), header.alg),
        { issuer: options.issuer, audience: options.audience },
      );

      const subject = result.payload.sub;
      if (!subject) throw new AuthenticationError("Token subject is missing");

      const scopes = String(result.payload.scope ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (!scopes.includes(options.requiredScope)) {
        throw new AuthorizationError();
      }
      assertRequiredRole(result.payload, options.requiredRole);

      const clientIdClaim = result.payload.azp ?? result.payload.client_id;
      const principal: AuthenticatedPrincipal = { subject, scopes };
      if (typeof clientIdClaim === "string") principal.clientId = clientIdClaim;
      return principal;
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  };
}

export function createRemoteJwtAccessTokenVerifier(options: {
  issuer: string;
  audience: string;
  requiredScope: string;
  requiredRole?: string;
  jwksUrl: URL;
}) {
  const remoteJwks = createRemoteJWKSet(options.jwksUrl, {
    cooldownDuration: 10_000,
    cacheMaxAge: 600_000,
    timeoutDuration: 5_000,
  });

  return async (token: string): Promise<AuthenticatedPrincipal> => {
    try {
      const result = await jwtVerify(token, remoteJwks, {
        issuer: options.issuer,
        audience: options.audience,
      });
      const subject = result.payload.sub;
      if (!subject) throw new AuthenticationError("Token subject is missing");
      const scopes = String(result.payload.scope ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (!scopes.includes(options.requiredScope)) throw new AuthorizationError();
      assertRequiredRole(result.payload, options.requiredRole);
      const clientIdClaim = result.payload.azp ?? result.payload.client_id;
      const principal: AuthenticatedPrincipal = { subject, scopes };
      if (typeof clientIdClaim === "string") principal.clientId = clientIdClaim;
      return principal;
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  };
}
