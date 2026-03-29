<#
.SYNOPSIS
    Universal MCP Toolkit silent installer for Windows (winget silent mode).

.DESCRIPTION
    Installs universal-mcp-toolkit globally via npm.
    All non-error output is suppressed by default.

.PARAMETER Uninstall
    Uninstall universal-mcp-toolkit instead of installing.

.EXAMPLE
    .\umt-installer-silent.ps1
    .\umt-installer-silent.ps1 -Uninstall
#>

param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$PackageName = "universal-mcp-toolkit"
$Version = "1.2.0"

# --- Uninstall ---
if ($Uninstall) {
    try {
        & npm uninstall -g $PackageName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to uninstall $PackageName." -ForegroundColor Red
            exit $LASTEXITCODE
        }
    } catch {
        Write-Host "ERROR: Uninstall failed: $_" -ForegroundColor Red
        exit 1
    }
    exit 0
}

# --- Install ---
try {
    # Check Node.js
    $nodeVersionRaw = $null
    try {
        $nodeVersionRaw = & node --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "node not found"
        }
        $nodeVersionRaw = $nodeVersionRaw.ToString().Trim()
        $majorVersion = [int]($nodeVersionRaw -replace '^v', '' -split '\.')[0]
        if ($majorVersion -lt 18) {
            Write-Host "ERROR: Universal MCP Toolkit requires Node.js 18 or later. Found: $nodeVersionRaw. Install from https://nodejs.org" -ForegroundColor Red
            exit 1
        }
    } catch {
        Write-Host "ERROR: Universal MCP Toolkit requires Node.js 18 or later. Install from https://nodejs.org" -ForegroundColor Red
        exit 1
    }

    # Check npm
    try {
        $npmVersion = & npm --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "npm not found"
        }
    } catch {
        Write-Host "ERROR: npm is required but was not found. Install Node.js from https://nodejs.org" -ForegroundColor Red
        exit 1
    }

    # Install package (suppress output)
    $null = & npm install -g "$PackageName@$Version" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed for $PackageName@$Version" -ForegroundColor Red
        exit 1
    }

    # Verify installation
    try {
        $umtVersion = & umt --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "umt command not found after install"
        }
    } catch {
        Write-Host "ERROR: Installation completed but 'umt' command could not be found. Check your PATH." -ForegroundColor Red
        exit 1
    }

    exit 0

} catch {
    Write-Host "ERROR: Installation failed: $_" -ForegroundColor Red
    exit 1
}
