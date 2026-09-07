#!/usr/bin/env bash
# CutLocal - installation des outils necessaires (Linux)
#
# Teste sur Kali. Fonctionne sur toute distribution a base de Debian/Ubuntu ;
# les autres familles sont detectees et l'utilisateur recoit la liste des
# paquets a installer lui-meme, plutot qu'une commande qui echouerait.
#
# Le script n'installe que ce qui manque, ne desinstalle jamais rien, et ne
# touche a aucun reglage du systeme.

set -u

vert()  { printf '  \033[32m[ok]\033[0m    %s\n' "$1"; }
gris()  { printf '  \033[90m...\033[0m     %s\n' "$1"; }
jaune() { printf '  \033[33m[!]\033[0m     %s\n' "$1"; }
rouge() { printf '  \033[31m[echec]\033[0m %s\n' "$1"; }
titre() { printf '\n  \033[36m%s\033[0m\n' "$1"; }

manque=()

printf '\n  \033[97mCutLocal - installation des outils\033[0m\n'
printf '  \033[90m----------------------------------\033[0m\n'

# ------------------------------------------------------------- gestionnaire
titre "Verification du systeme"

if command -v apt-get >/dev/null 2>&1; then
  APT=1
  vert "gestionnaire de paquets apt detecte"
else
  APT=0
  jaune "apt introuvable : les paquets manquants seront seulement signales"
fi

# sudo n'est demande que s'il y a reellement quelque chose a installer.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

installer_apt() {   # $1 = paquet
  if [ "$APT" -ne 1 ]; then return 1; fi
  if [ -z "${MAJ_FAITE:-}" ]; then
    gris "mise a jour de la liste des paquets"
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    MAJ_FAITE=1
  fi
  $SUDO apt-get install -y -qq "$1" >/dev/null 2>&1
}

verifier() {        # $1 = commande  $2 = paquet apt  $3 = role
  if command -v "$1" >/dev/null 2>&1; then vert "$1 deja present"; return 0; fi
  gris "$1 manquant - installation ($3)"
  if installer_apt "$2" && command -v "$1" >/dev/null 2>&1; then
    vert "$1 installe"; return 0
  fi
  rouge "$1 : installation impossible (paquet $2)"
  manque+=("$1")
  return 1
}

# ------------------------------------------------------------ installations
titre "Outils necessaires"

verifier node    nodejs   "fait tourner CutLocal"
verifier ffmpeg  ffmpeg   "apercus, vignettes, image + son"

# zenity ouvre les fenetres de choix de fichier. Sans lui tout marche encore :
# on importe par glisser-deposer et on exporte vers le dossier propose. Il est
# donc installe si possible, mais son absence ne bloque rien.
if command -v zenity >/dev/null 2>&1; then
  vert "zenity deja present"
else
  gris "zenity manquant - installation (fenetres de choix de fichier)"
  if installer_apt zenity && command -v zenity >/dev/null 2>&1; then
    vert "zenity installe"
  else
    jaune "zenity absent - facultatif, voir plus bas"
  fi
fi

# yt-dlp evolue vite : la version des depots a souvent plusieurs mois de retard,
# et les sites qu'elle telecharge changent tous les mois. On prend donc pipx,
# qui l'installe dans son propre environnement et se met a jour a la demande.
if command -v yt-dlp >/dev/null 2>&1; then
  vert "yt-dlp deja present"
else
  gris "yt-dlp manquant - installation (telechargement depuis un lien)"
  if command -v pipx >/dev/null 2>&1 || installer_apt pipx; then
    pipx install yt-dlp >/dev/null 2>&1 || pipx upgrade yt-dlp >/dev/null 2>&1
    pipx ensurepath >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if command -v yt-dlp >/dev/null 2>&1; then vert "yt-dlp installe"
  else rouge "yt-dlp : installation impossible"; manque+=("yt-dlp"); fi
fi

# ---------------------------------------------------------------- controles
titre "Controle final"

controle() {        # $1 = commande  $2 = argument de version  $3 = version mini
  if ! command -v "$1" >/dev/null 2>&1; then rouge "$1 introuvable"; manque+=("$1"); return; fi
  # On execute vraiment : un binaire present mais casse doit etre vu ici.
  local v
  if ! v=$("$1" "$2" 2>&1 | head -n1); then
    rouge "$1 present mais refuse de demarrer"; manque+=("$1"); return
  fi
  if [ -n "${3:-}" ]; then
    local maj
    maj=$(printf '%s' "$v" | sed 's/^v//' | cut -d. -f1)
    if [ "${maj:-0}" -lt "$3" ] 2>/dev/null; then
      jaune "$1 $v - la version $3 ou superieure est attendue"
      manque+=("$1"); return
    fi
  fi
  # ffmpeg annonce sa version suivie de tout son avis de droits d auteur.
  v=${v#ffmpeg version }
  v=${v%% Copyright*}
  vert "$1 $v"
}

controle node   --version 20
controle ffmpeg -version  ""
controle yt-dlp --version ""
if command -v zenity >/dev/null 2>&1; then vert "zenity present"
else jaune "zenity absent : le choix de fichier passera par le glisser-deposer"; fi

# ------------------------------------------------------------------- bilan
printf '\n'
if [ ${#manque[@]} -eq 0 ]; then
  printf '  \033[32mTout est pret.\033[0m\n'
  printf '  \033[90mLancez CutLocal avec :  ./lancer.sh\033[0m\n'
else
  printf '  \033[33mIl reste a regler : %s\033[0m\n' "${manque[*]}"
  printf '\n'
  printf '  \033[90mSur Debian/Ubuntu/Kali :\033[0m\n'
  printf '  \033[90m  sudo apt install nodejs ffmpeg zenity pipx && pipx install yt-dlp\033[0m\n'
  printf '  \033[90mSur Arch :   sudo pacman -S nodejs ffmpeg zenity yt-dlp\033[0m\n'
  printf '  \033[90mSur Fedora : sudo dnf install nodejs ffmpeg zenity yt-dlp\033[0m\n'
  printf '\n'
  printf '  \033[90mSi node est trop ancien, les depots en gardent souvent une vieille\033[0m\n'
  printf '  \033[90mversion : prenez-la sur https://nodejs.org ou avec nvm.\033[0m\n'
fi
printf '\n'
