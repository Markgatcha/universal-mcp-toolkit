export function createWorkspaceBuildArgs(packageNames: readonly string[]): string[] {
  const uniquePackageNames = [...new Set(packageNames)];
  if (uniquePackageNames.length === 0) {
    return [];
  }

  return [...uniquePackageNames.flatMap((packageName) => ["--filter", packageName]), "build"];
}
