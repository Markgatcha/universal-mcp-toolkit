# Winget Submission Guide

Step-by-step instructions for submitting Universal MCP Toolkit to the [Windows Package Manager Community Repository](https://github.com/microsoft/winget-pkgs).

## Prerequisites

- A GitHub account
- The `wingetcreate` tool or manual fork workflow (described below)
- `winget` installed on your Windows machine (comes with Windows 11 or App Installer on Windows 10)

## 1. Fork microsoft/winget-pkgs

1. Go to https://github.com/microsoft/winget-pkgs
2. Click **Fork** in the top-right corner
3. Clone your fork locally:

```powershell
git clone https://github.com/YOUR_USERNAME/winget-pkgs.git
cd winget-pkgs
```

## 2. Copy Manifest Files

Copy the three manifest files from this repo into the correct folder structure in your fork:

```powershell
# Create the target directory
New-Item -ItemType Directory -Force -Path "manifests/c/ContextCore/UniversalMcpToolkit/1.2.0"

# Copy manifest files
Copy-Item "..\universal-mcp-toolkit\manifests\c\ContextCore\UniversalMcpToolkit\1.2.0\*" `
    "manifests/c/ContextCore/UniversalMcpToolkit/1.2.0/"
```

Your fork should now contain:

```
manifests/c/ContextCore/UniversalMcpToolkit/1.2.0/
    ContextCore.UniversalMcpToolkit.installer.yaml
    ContextCore.UniversalMcpToolkit.locale.en-US.yaml
    ContextCore.UniversalMcpToolkit.yaml
```

## 3. Generate the Real SHA256 Hash

The installer manifest contains a placeholder hash. You must compute the real hash of the installer file:

```powershell
# If downloading from a release
Invoke-WebRequest -Uri "https://github.com/Markgatcha/universal-mcp-toolkit/releases/download/v1.2.0/umt-installer.ps1" `
    -OutFile ".\umt-installer.ps1"
Get-FileHash .\umt-installer.ps1 -Algorithm SHA256
```

Or if the script is local:

```powershell
Get-FileHash "..\universal-mcp-toolkit\scripts\umt-installer.ps1" -Algorithm SHA256
```

Copy the resulting hash and replace the `0000000000000000000000000000000000000000000000000000000000000000` placeholder in `ContextCore.UniversalMcpToolkit.installer.yaml` with the real value.

## 4. Validate Manifests Locally

Before submitting, validate your manifests:

```powershell
winget validate --manifest "manifests/c/ContextCore/UniversalMcpToolkit/1.2.0/"
```

You can also use the [winget-create](https://github.com/microsoft/winget-create) validation:

```powershell
wingetcreate validate "manifests/c/ContextCore/UniversalMcpToolkit/1.2.0/"
```

Fix any errors before proceeding.

## 5. Create a Branch and Commit

```powershell
git checkout -b "contextcore-universalmcptoolkit-1.2.0"
git add manifests/c/ContextCore/UniversalMcpToolkit/1.2.0/
git commit -m "New package: ContextCore.UniversalMcpToolkit version 1.2.0"
```

## 6. Push and Open a PR

```powershell
git push origin contextcore-universalmcptoolkit-1.2.0
```

Then go to your fork on GitHub and open a Pull Request against `microsoft/winget-pkgs`:

- **Title format**: `New package: ContextCore.UniversalMcpToolkit version 1.2.0`
- **Description**: Briefly describe the tool and link to the source repo

## 7. What the Winget Team Checks

The winget reviewers will verify:

- All three manifest files are present and correctly structured
- `PackageIdentifier` follows the `Publisher.PackageName` format
- `InstallerSha256` matches the actual file at `InstallerUrl`
- `InstallerUrl` is a direct download link (not a webpage)
- No conflicts with existing packages
- Manifests pass schema validation

**Typical review timeline**: 3-7 business days. The team may request changes if any fields are incorrect.

## 8. Updating for Future Releases

For each new version, create a new version folder:

```
manifests/c/ContextCore/UniversalMcpToolkit/1.3.0/
    ContextCore.UniversalMcpToolkit.installer.yaml
    ContextCore.UniversalMcpToolkit.locale.en-US.yaml
    ContextCore.UniversalMcpToolkit.yaml
```

Steps:

1. Copy the previous version's manifests into the new version folder
2. Update `PackageVersion` in all three files
3. Update `InstallerUrl` to point to the new release
4. Recompute and update `InstallerSha256`
5. Update `ReleaseNotesUrl` if the changelog has moved
6. Submit a new PR with title: `New version: ContextCore.UniversalMcpToolkit version 1.3.0`

## Resources

- [Winget manifest schema documentation](https://github.com/microsoft/winget-cli/tree/master/doc/Manifest)
- [Winget manifest validator](https://github.com/microsoft/winget-create)
- [Winget-pkgs contribution guide](https://github.com/microsoft/winget-pkgs/blob/master/README.md)
- [Manifest spec (v1.6)](https://github.com/microsoft/winget-cli/blob/master/schemas/JSON/manifests/v1.6.0/manifest.installer.1.6.0.json)
