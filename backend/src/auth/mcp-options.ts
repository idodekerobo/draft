export function mcpOptions(config: { mcpResourceUrl: string; appUrl: string }) {
  return {
    resource: config.mcpResourceUrl,
    loginPage: `${config.appUrl}/oauth/login`,
    consentPage: `${config.appUrl}/oauth/consent`,
    scopes: ["read", "write", "offline_access"],
    clientRegistrationDefaultScopes: ["read", "write", "offline_access"],
    clientRegistrationAllowedScopes: ["read", "write", "offline_access"],
  };
}
