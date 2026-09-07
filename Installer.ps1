<#
    CutLocal - installation des outils necessaires
    ----------------------------------------------
    A lancer une seule fois. Le script n'installe que ce qui manque, ne
    desinstalle jamais rien, et ne touche a aucun reglage du systeme.

    Trois outils sont necessaires :
      - Node.js  : fait tourner CutLocal
      - ffmpeg   : copies d'apercu, vignettes, recollage image + son
      - yt-dlp   : telechargement depuis un lien

    Tout passe par winget, le gestionnaire de paquets fourni avec Windows :
    les paquets viennent donc de leurs editeurs officiels, et se mettront a
    jour avec le reste du systeme.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Titre($t) { Write-Host ""; Write-Host "  $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  [ok]    $t" -ForegroundColor Green }
function Info($t)  { Write-Host "  ...     $t" -ForegroundColor DarkGray }
function Avert($t) { Write-Host "  [!]     $t" -ForegroundColor Yellow }
function Rate($t)  { Write-Host "  [echec] $t" -ForegroundColor Red }

# Une installation par winget ajoute le programme au PATH, mais la fenetre en
# cours garde l'ancien : sans cette relecture, on croirait l'installation ratee.
function RelirePath {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($m, $u | Where-Object { $_ }) -join ';'
}

function Presente($exe) {
    RelirePath
    return [bool](Get-Command $exe -ErrorAction SilentlyContinue)
}

function Installer($nom, $exe, $paquet, $role) {
    if (Presente $exe) { Ok "$nom deja present"; return $true }
    Info "$nom manquant - installation ($role)"
    try {
        winget install --id $paquet --exact --silent `
            --accept-package-agreements --accept-source-agreements | Out-Null
    } catch {
        Rate "$nom : winget a echoue ($($_.Exception.Message))"
        return $false
    }
    # Un programme externe qui echoue ne leve pas d'exception en PowerShell : il
    # se contente d'un code de sortie. Sans le lire, un paquet introuvable
    # passerait pour une installation reussie.
    if ($LASTEXITCODE -ne 0) {
        Rate "$nom : winget a echoue (code $LASTEXITCODE)"
        return $false
    }
    if (Presente $exe) { Ok "$nom installe"; return $true }
    # Installe mais absent du PATH de cette fenetre : le controle final tranchera.
    Avert "$nom installe, mais pas encore visible dans cette fenetre"
    return $true
}

Write-Host ""
Write-Host "  CutLocal - installation des outils" -ForegroundColor White
Write-Host "  ----------------------------------" -ForegroundColor DarkGray

# --------------------------------------------------------------- prealables
Titre "Verification du systeme"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Rate "winget est introuvable."
    Write-Host ""
    Write-Host "  winget est fourni avec Windows 10 (2021+) et Windows 11." -ForegroundColor Gray
    Write-Host "  Installez le Programme d'installation d'application depuis" -ForegroundColor Gray
    Write-Host "  le Microsoft Store, puis relancez ce script." -ForegroundColor Gray
    Write-Host ""
    Read-Host "  Entree pour fermer" | Out-Null
    exit 1
}
Ok "winget disponible"

# ------------------------------------------------------------ installations
Titre "Outils necessaires"

$resultats = [ordered]@{}
$resultats['Node.js'] = Installer 'Node.js' 'node'   'OpenJS.NodeJS.LTS' 'fait tourner CutLocal'
$resultats['ffmpeg']  = Installer 'ffmpeg'  'ffmpeg' 'Gyan.FFmpeg'       'apercus, vignettes, image + son'
$resultats['yt-dlp']  = Installer 'yt-dlp'  'yt-dlp' 'yt-dlp.yt-dlp'     'telechargement depuis un lien'

# --------------------------------------------------------------- controles
Titre "Controle final"

RelirePath
$bilan = @()
foreach ($o in @(
        @{ nom = 'Node.js'; exe = 'node';   arg = '--version';  min = 20 },
        @{ nom = 'ffmpeg';  exe = 'ffmpeg'; arg = '-version';   min = $null },
        @{ nom = 'yt-dlp';  exe = 'yt-dlp'; arg = '--version';  min = $null })) {

    $cmd = Get-Command $o.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { Rate "$($o.nom) introuvable"; $bilan += $o.nom; continue }

    # Un executable refuse par la securite de Windows echoue au lancement meme
    # s'il est bien present : il faut donc l'executer, pas seulement le trouver.
    try   { $v = (& $o.exe $o.arg 2>&1 | Select-Object -First 1) }
    catch { Rate "$($o.nom) present mais refuse de demarrer"; $bilan += $o.nom; continue }

    if ($o.min) {
        $maj = [int](($v -replace '^v', '') -split '\.')[0]
        if ($maj -lt $o.min) {
            Avert "$($o.nom) $v - la version $($o.min) ou superieure est attendue"
            $bilan += $o.nom
            continue
        }
    }
    Ok "$($o.nom) $($v -replace 'ffmpeg version ', '' -replace ' Copyright.*', '')"
}

# ------------------------------------------------------------------- bilan
Write-Host ""
if ($bilan.Count -eq 0) {
    Write-Host "  Tout est pret." -ForegroundColor Green
    Write-Host "  Lancez CutLocal avec le fichier : Lancer CutLocal.bat" -ForegroundColor Gray
} else {
    Write-Host "  Il reste a regler : $($bilan -join ', ')" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Deux causes possibles :" -ForegroundColor Gray
    Write-Host "   1. La fenetre ne voit pas encore les nouveaux programmes." -ForegroundColor Gray
    Write-Host "      Fermez-la, rouvrez-en une, et relancez ce script." -ForegroundColor Gray
    Write-Host "   2. Le Controle d'application intelligent bloque yt-dlp." -ForegroundColor Gray
    Write-Host "      Securite Windows > Controle des applications et du navigateur" -ForegroundColor Gray
    Write-Host "      > Controle d'application intelligent. Attention : une fois" -ForegroundColor Gray
    Write-Host "      desactive, il ne peut plus etre reactive sans reinstaller Windows." -ForegroundColor Gray
}
Write-Host ""
Read-Host "  Entree pour fermer" | Out-Null
