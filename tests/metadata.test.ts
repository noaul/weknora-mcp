import { describe, expect, it } from "vitest";

import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
} from "../src/metadata.js";

describe("OAuth protected-resource metadata", () => {
  it("advertises the resource, issuer, and required scope", () => {
    expect(
      buildProtectedResourceMetadata({
        resource: "https://wek.uov.me/mcp",
        issuer: "https://wek.uov.me/oauth/realms/weknora",
        scope: "weknora:read",
      }),
    ).toEqual({
      resource: "https://wek.uov.me/mcp",
      authorization_servers: [
        "https://wek.uov.me/oauth/realms/weknora",
      ],
      scopes_supported: ["weknora:read"],
      bearer_methods_supported: ["header"],
    });
  });

  it("builds a 401 challenge pointing at path-aware metadata", () => {
    expect(buildWwwAuthenticate("https://wek.uov.me/mcp")).toBe(
      'Bearer realm="mcp", resource_metadata="https://wek.uov.me/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
