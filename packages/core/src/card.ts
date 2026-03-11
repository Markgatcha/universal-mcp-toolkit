import type { ToolkitServerCard, ToolkitServerMetadata } from "./types.js";

export function createServerCard(metadata: ToolkitServerMetadata): ToolkitServerCard {
  const card: ToolkitServerCard = {
    name: metadata.id,
    title: metadata.title,
    description: metadata.description,
    version: metadata.version,
    packageName: metadata.packageName,
    homepage: metadata.homepage,
    transports: metadata.transports,
    authentication: {
      mode: "environment-variables",
      required: metadata.envVarNames,
    },
    capabilities: {
      tools: metadata.toolNames.length > 0,
      resources: metadata.resourceNames.length > 0,
      prompts: metadata.promptNames.length > 0,
    },
    tools: metadata.toolNames,
    resources: metadata.resourceNames,
    prompts: metadata.promptNames,
  };

  if (metadata.repositoryUrl) {
    card.repositoryUrl = metadata.repositoryUrl;
  }

  if (metadata.documentationUrl) {
    card.documentationUrl = metadata.documentationUrl;
  }

  return card;
}
