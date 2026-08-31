export interface ProtectedResourceMetadataInput {
  resource: string;
  issuer: string;
  scope: string;
}

export function buildProtectedResourceMetadata(input: ProtectedResourceMetadataInput) {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    scopes_supported: [input.scope],
    bearer_methods_supported: ["header"],
  };
}

export function protectedResourceMetadataUrl(publicMcpUrl: string): string {
  const resource = new URL(publicMcpUrl);
  const path = resource.pathname.replace(/^\/+/, "");
  resource.pathname = `/.well-known/oauth-protected-resource${path ? `/${path}` : ""}`;
  resource.search = "";
  resource.hash = "";
  return resource.toString();
}

export function buildWwwAuthenticate(publicMcpUrl: string): string {
  return `Bearer realm="mcp", resource_metadata="${protectedResourceMetadataUrl(publicMcpUrl)}"`;
}
