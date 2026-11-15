# Installe la clé Google Maps dans l'application, sans avoir à la saisir.
#
# Avant de lancer : sur la page Google Cloud (Identifiants > « Afficher la clé »), cliquez sur l'icône de copie.
# Ce script prend la clé dans le presse-papiers et :
#   1. l'écrit dans config.js (version sur ce PC ; ce fichier n'est pas envoyé dans le dépôt) ;
#   2. l'enregistre comme secret du dépôt GitHub, pour que la version en ligne (iPhone) l'utilise ;
#   3. relance la mise en ligne.
# La clé n'est jamais affichée.
#
# Usage :  powershell -ExecutionPolicy Bypass -File tools/set_key.ps1

$ErrorActionPreference = 'Stop'
$repo = 'mazizbk/cap-navigation'
$app = Split-Path -Parent $PSScriptRoot

$key = Get-Clipboard -Raw
if ($null -eq $key) { $key = '' }
$key = $key.Trim()
if ($key -notmatch '^AIza[\w-]{20,}$') {
  Write-Host "Le presse-papiers ne contient pas de cle Google Maps (elle commence par AIza)." -ForegroundColor Red
  Write-Host "Copiez-la depuis la page Google (icone de copie a droite de la cle), puis relancez."
  exit 1
}

$content = "// Configuration locale (non versionnee). Cle limitee a Maps Embed API et aux adresses de l'application.`nwindow.CAP_CONFIG = { googleKey: '$key' };`n"
[System.IO.File]::WriteAllText((Join-Path $app 'config.js'), $content, (New-Object System.Text.UTF8Encoding $false))
Write-Host "1/3  Cle ecrite dans config.js (application sur ce PC)." -ForegroundColor Green

$key | gh secret set GOOGLE_MAPS_KEY --repo $repo
if ($LASTEXITCODE -ne 0) { Write-Host "Echec de l'enregistrement du secret GitHub." -ForegroundColor Red; exit 1 }
Write-Host "2/3  Cle enregistree comme secret du depot en ligne." -ForegroundColor Green

gh workflow run publier.yml --repo $repo
Write-Host "3/3  Mise en ligne relancee : la version iPhone aura la cle dans 1 a 2 minutes." -ForegroundColor Green
