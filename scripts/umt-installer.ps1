<#
.SYNOPSIS
    Universal MCP Toolkit installer for Windows (winget).

.DESCRIPTION
    Installs universal-mcp-toolkit globally via npm.
    Designed to be invoked by Windows Package Manager (winget).

.PARAMETER Silent
    Suppress all output except errors.

.PARAMETER Uninstall
    Uninstall universal-mcp-toolkit instead of installing.

.EXAMPLE
    .\umt-installer.ps1
    .\umt-installer.ps1 -Silent
    .\umt-installer.ps1 -Uninstall
#>

param(
    [switch]$Silent,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$PackageName = "universal-mcp-toolkit"
$Version = "1.2.0"

function Write-Info {
    param([string]$Message)
    if (-not $Silent) {
        Write-Host $Message
    }
}

function Write-Error-Exit {
    param([string]$Message, [int]$ExitCode = 1)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit $ExitCode
}

# --- Uninstall ---
if ($Uninstall) {
    try {
        Write-Info "Uninstalling $PackageName..."
        & npm uninstall -g $PackageName 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Info "$PackageName has been uninstalled successfully."
        } else {
            Write-Error-Exit "Failed to uninstall $PackageName. Is it installed?" $LASTEXITCODE
        }
    } catch {
        Write-Error-Exit "Uninstall failed: $_"
    }
    exit 0
}

# --- Install ---
try {
    # Check Node.js
    Write-Info "Checking for Node.js..."
    $nodeVersion = $null
    try {
        $nodeVersionRaw = & node --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "node not found"
        }
        # Parse major version from "v20.x.x" format
        $nodeVersionRaw = $nodeVersionRaw.ToString().Trim()
        $majorVersion = [int]($nodeVersionRaw -replace '^v', '' -split '\.')[0]
        if ($majorVersion -lt 18) {
            Write-Error-Exit "Universal MCP Toolkit requires Node.js 18 or later. Found: $nodeVersionRaw. Install from https://nodejs.org"
        }
        Write-Info "Found Node.js $nodeVersionRaw"
    } catch {
        Write-Error-Exit "Universal MCP Toolkit requires Node.js 18 or later. Install from https://nodejs.org"
    }

    # Check npm
    Write-Info "Checking for npm..."
    try {
        $npmVersion = & npm --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "npm not found"
        }
        Write-Info "Found npm $npmVersion"
    } catch {
        Write-Error-Exit "npm is required but was not found. Install Node.js from https://nodejs.org"
    }

    # Install package
    Write-Info "Installing $PackageName@$Version..."
    $installOutput = & npm install -g "$PackageName@$Version" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error-Exit "npm install failed: $installOutput"
    }
    Write-Info "$installOutput"

    # Verify installation
    Write-Info "Verifying installation..."
    try {
        $umtVersion = & umt --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "umt command not found after install"
        }
        Write-Info "umt version: $umtVersion"
    } catch {
        Write-Error-Exit "Installation completed but 'umt' command could not be found. Check your PATH."
    }

    Write-Info ""
    Write-Info "Universal MCP Toolkit installed! Run 'umt init' to get started."
    Write-Info "Documentation: https://github.com/Markgatcha/universal-mcp-toolkit"
    exit 0

} catch {
    Write-Error-Exit "Installation failed: $_"
}
