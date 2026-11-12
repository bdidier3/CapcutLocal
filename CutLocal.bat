<# : -- partie batch : relance ce meme fichier dans PowerShell --
@echo off
setlocal
title CutLocal
set "CUTLOCAL_BAT=%~f0"
set "CUTLOCAL_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:CUTLOCAL_BAT))"
if errorlevel 1 pause
exit /b
#>
# =============================================================================
#  CutLocal - lanceur autonome pour Windows
#
#  Un seul fichier, a poser n'importe ou (Bureau, cle USB...) et a lancer.
#  Il installe, met a jour et lance CutLocal, sur n'importe quel PC Windows 10/11,
#  sans droits administrateur et sans rien installer dans le systeme :
#
#    %LOCALAPPDATA%\CutLocal\app    le logiciel (~1 Mo)
#    %LOCALAPPDATA%\CutLocal\node   node.exe seul, SI le PC n'a pas deja Node.js
#    %LOCALAPPDATA%\CutLocal\bin    ffmpeg / yt-dlp, seulement avec l'option "complet"
#
#  Options :  CutLocal.bat complet    ajoute ffmpeg + yt-dlp (import par lien)
#             CutLocal.bat desinstaller
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'      # la barre de progression divise la vitesse par 10
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Ou trouver le logiciel. CUTLOCAL_SOURCE permet de pointer vers une archive
# locale (tests, ou PC sans acces a GitHub).
$Depot   = 'bdidier3/CapcutLocal'
$Branche = 'main'
$Port    = if ($env:CUTLOCAL_PORT) { [int]$env:CUTLOCAL_PORT } else { 4676 }
$Racine  = if ($env:CUTLOCAL_HOME) { $env:CUTLOCAL_HOME } else { Join-Path $env:LOCALAPPDATA 'CutLocal' }
$AppDir  = Join-Path $Racine 'app'
$NodeDir = Join-Path $Racine 'node'
$BinDir  = Join-Path $Racine 'bin'
$Args_   = "$env:CUTLOCAL_ARGS".ToLower()

function Info($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fin($m)  { Write-Host ""; Write-Host "  $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Taille($octets) { if ($octets -ge 1MB) { '{0:N0} Mo' -f ($octets / 1MB) } else { '{0:N0} Ko' -f ($octets / 1KB) } }

function Telecharger($url, $dest) {
    $tmp = "$dest.part"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers @{ 'User-Agent' = 'CutLocal-lanceur' }
    Move-Item -Force $tmp $dest
}

Write-Host ""
Write-Host "  CutLocal - editeur video local" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------- desinstallation
if ($Args_ -match 'desinstaller') {
    if (Test-Path $Racine) {
        $poids = (Get-ChildItem $Racine -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        Remove-Item $Racine -Recurse -Force
        Ok "CutLocal retire ($(Taille $poids) liberes). Vos videos d'origine ne sont pas touchees."
    } else { Info "Rien a retirer." }
    exit 0
}

# --------------------------------------------- deja lance ? on rouvre l'onglet
$deja = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($deja) {
    Ok "CutLocal tourne deja : ouverture dans le navigateur."
    Start-Process "http://127.0.0.1:$Port/"
    exit 0
}

New-Item -ItemType Directory -Force $Racine | Out-Null

# ------------------------------------------------------------------- logiciel
# On ne retelecharge que si GitHub a une version plus recente. Sans Internet,
# on lance la version deja installee.
$versionFichier = Join-Path $AppDir '.version'
$installee = if (Test-Path $versionFichier) { (Get-Content $versionFichier -Raw).Trim() } else { '' }
$derniere = $null
if ($env:CUTLOCAL_SOURCE) {
    $derniere = 'local:' + (Get-Item $env:CUTLOCAL_SOURCE).LastWriteTimeUtc.Ticks
} else {
    try {
        $derniere = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 `
            -Uri "https://api.github.com/repos/$Depot/commits/$Branche" `
            -Headers @{ 'Accept' = 'application/vnd.github.sha'; 'User-Agent' = 'CutLocal-lanceur' }).Content.Trim()
    } catch {
        if (-not $installee) {
            Fin ("Impossible de joindre GitHub ($Depot). Verifiez la connexion Internet" +
                 " - et que le depot est public.")
        }
        Warn "Pas de connexion a GitHub : lancement de la version deja installee."
    }
}

if ($derniere -and $derniere -ne $installee) {
    Info ($(if ($installee) { 'Mise a jour du logiciel...' } else { 'Telechargement du logiciel...' }))
    $zip = Join-Path $Racine 'app.zip'
    if ($env:CUTLOCAL_SOURCE) { Copy-Item $env:CUTLOCAL_SOURCE $zip -Force }
    else { Telecharger "https://codeload.github.com/$Depot/zip/refs/heads/$Branche" $zip }
    $poidsZip = (Get-Item $zip).Length

    # On n'extrait que ce qui sert a faire tourner le logiciel (pas la doc ni
    # les installateurs), et on remplace app\ et server\ SANS toucher a
    # projects\ ni a cache\ : vos videos telechargees et vos projets restent.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $neuf = Join-Path $Racine 'app.neuf'
    if (Test-Path $neuf) { Remove-Item $neuf -Recurse -Force }
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($e in $archive.Entries) {
            # l'archive GitHub range tout sous "CapcutLocal-main/"
            # (certains outils ecrivent les chemins avec des barres inverses)
            $rel = (($e.FullName -replace '\\', '/') -replace '^[^/]+/', '')
            if (-not $e.Name) { continue }
            if ($rel -notmatch '^(app/|server/|package\.json$)') { continue }
            $cible = Join-Path $neuf ($rel -replace '/', '\')
            New-Item -ItemType Directory -Force (Split-Path $cible) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $cible, $true)
        }
    } finally { $archive.Dispose() }
    Remove-Item $zip -Force
    if (-not (Test-Path (Join-Path $neuf 'server\server.js'))) { Fin "Archive inattendue : server\server.js absent." }

    New-Item -ItemType Directory -Force $AppDir | Out-Null
    foreach ($d in 'app', 'server') {
        $p = Join-Path $AppDir $d
        if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        Move-Item (Join-Path $neuf $d) $p
    }
    Copy-Item (Join-Path $neuf 'package.json') $AppDir -Force -ErrorAction SilentlyContinue
    Remove-Item $neuf -Recurse -Force
    Set-Content -Path $versionFichier -Value $derniere -Encoding ASCII
    Ok "Logiciel a jour ($(Taille $poidsZip) telecharges)"
} elseif ($installee) {
    Ok "Logiciel a jour"
}

# -------------------------------------------------------------------- Node.js
# Celui du PC s'il convient (rien a telecharger). Sinon node.exe SEUL - pas
# d'installation, pas de npm : ~85 Mo au lieu de plusieurs centaines.
$node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and -not $env:CUTLOCAL_FORCE_NODE) {
    try {
        $v = (& $sys.Source --version) -replace '^v', ''
        if ([int]($v.Split('.')[0]) -ge 20) { $node = $sys.Source; Ok "Node.js $v (deja present sur ce PC)" }
    } catch { }
}
if (-not $node) {
    $local = Join-Path $NodeDir 'node.exe'
    if (Test-Path $local) {
        $node = $local
        Ok "Node.js $((& $local --version))"
    } else {
        Info "Telechargement de Node.js (une seule fois)..."
        $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
        $lts = $index | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
        if (-not $lts) { Fin "Version de Node.js introuvable sur nodejs.org." }
        $ver = $lts.version
        $nomZip = "node-$ver-win-x64.zip"
        $zipNode = Join-Path $Racine $nomZip
        Telecharger "https://nodejs.org/dist/$ver/$nomZip" $zipNode
        # verification de l'empreinte publiee par nodejs.org
        $sommes = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
        $attendu = ($sommes -split "`n" | Where-Object { $_ -match [regex]::Escape($nomZip) } | Select-Object -First 1) -replace '\s.*$', ''
        $obtenu = (Get-FileHash $zipNode -Algorithm SHA256).Hash.ToLower()
        if (-not $attendu -or $obtenu -ne $attendu.ToLower()) { Remove-Item $zipNode -Force; Fin "Empreinte de Node.js incorrecte : telechargement refuse." }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $za = [IO.Compression.ZipFile]::OpenRead($zipNode)
        try {
            $e = $za.Entries | Where-Object { $_.FullName -match '[/\\]node\.exe$' } | Select-Object -First 1
            New-Item -ItemType Directory -Force $NodeDir | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $local, $true)
        } finally { $za.Dispose() }
        Remove-Item $zipNode -Force
        $node = $local
        Ok "Node.js $ver ($(Taille (Get-Item $local).Length), verifie)"
    }
}

# ------------------------------------------------- ffmpeg + yt-dlp (facultatif)
# Ils ne servent qu'a l'import depuis un lien et aux formats WebM/MKV. On ne les
# telecharge que sur demande ("CutLocal.bat complet") ; deja presents sur le PC,
# ils sont utilises tels quels.
if ($Args_ -match 'complet') {
    New-Item -ItemType Directory -Force $BinDir | Out-Null
    $yt = Join-Path $BinDir 'yt-dlp.exe'
    if (-not (Test-Path $yt)) {
        Info "Telechargement de yt-dlp..."
        Telecharger 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $yt
    }
    Ok "yt-dlp ($(Taille (Get-Item $yt).Length))"
    $ff = Join-Path $BinDir 'ffmpeg.exe'
    if (-not (Test-Path $ff)) {
        # ffmpeg.exe seul : ffprobe ne sert qu'a afficher un pourcentage pendant
        # la fabrication d'une copie d'apercu, et pese autant que ffmpeg.
        Info "Telechargement de ffmpeg (ffmpeg.exe seul)..."
        $zf = Join-Path $Racine 'ffmpeg.zip'
        Telecharger 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zf
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $za = [IO.Compression.ZipFile]::OpenRead($zf)
        try {
            foreach ($e in $za.Entries) {
                if ($e.FullName -match '[/\\]bin[/\\]ffmpeg\.exe$') {
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $BinDir $e.Name), $true)
                }
            }
        } finally { $za.Dispose() }
        Remove-Item $zf -Force
    }
    Ok "ffmpeg ($(Taille ((Get-ChildItem $BinDir -Filter 'ff*.exe' | Measure-Object Length -Sum).Sum)))"
}
if (Test-Path $BinDir) { $env:PATH = "$BinDir;$env:PATH" }
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
    Info "Import depuis un lien desactive (relancez avec : CutLocal.bat complet)"
}

# ----------------------------------------------------------------- lancement
$poids = (Get-ChildItem $Racine -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike (Join-Path $AppDir 'cache') + '*' } | Measure-Object Length -Sum).Sum
Info "Place occupee par CutLocal : $(Taille $poids)  ($Racine)"
Write-Host ""
Write-Host "  Le navigateur va s'ouvrir. Laissez cette fenetre ouverte pendant le montage." -ForegroundColor White
Write-Host "  (Chrome ou Edge recommande)" -ForegroundColor Gray
Write-Host ""
Set-Location $AppDir
$env:PORT = "$Port"
& $node (Join-Path $AppDir 'server\server.js')
exit $LASTEXITCODE
