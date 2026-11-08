# CutLocal

Éditeur vidéo local, dans l'esprit de CapCut : import instantané, masques de flou,
aperçu temps réel, export 4K 60 i/s. **Tout reste sur votre machine** : aucun compte,
aucun envoi de fichier, rien de ce que vous montez ne quitte le disque.

La seule connexion sortante est celle que vous demandez explicitement, en collant un
lien à télécharger — et elle va au site en question, jamais ailleurs.

Poids total : **~250 Ko de code**. Pas d'Electron, aucune dépendance npm.

Le montage, l'aperçu et l'export tournent entièrement dans le navigateur (WebGL2 +
WebCodecs). ffmpeg et yt-dlp ne servent qu'autour : préparer les copies d'aperçu
des rushes 4K, fabriquer les vignettes, et rapporter une vidéo depuis un lien.

---

## Installer

### Windows

Double-cliquez sur **`Installer.bat`**, une seule fois.

Il installe ce qui manque, et rien d'autre — il ne désinstalle jamais rien et ne
touche à aucun réglage du système. Tout passe par **winget**, le gestionnaire de
paquets fourni avec Windows : les programmes viennent donc de leurs éditeurs
officiels et se mettront à jour avec le reste du système.

| Outil | À quoi il sert | Sans lui |
|---|---|---|
| **Node.js** 20+ | fait tourner CutLocal | rien ne démarre |
| **ffmpeg** | copies d'aperçu, vignettes, recollage image + son | l'aperçu rame sur les rushes 4K, certains téléchargements échouent |
| **yt-dlp** | importer depuis un lien | le bouton « Télécharger » ne fonctionne pas |

Le script vérifie ensuite que chaque outil **démarre vraiment**, et pas seulement
qu'il est présent : sur Windows 11, le « Contrôle d'application intelligent »
peut laisser un programme installé tout en refusant de l'exécuter.

Si un outil vient d'être installé, il peut rester invisible dans la fenêtre en
cours : fermez-la, rouvrez-en une, relancez le script.

### Linux (Kali, Debian, Ubuntu…)

```sh
chmod +x installer.sh lancer.sh
./installer.sh
./lancer.sh
```

Mêmes outils, installés par **apt**, sauf yt-dlp qui passe par **pipx** : la
version des dépôts a souvent plusieurs mois de retard, or les sites qu'elle
télécharge changent tous les mois.

S'ajoute **zenity**, qui ouvre les fenêtres de choix de fichier. Il est
facultatif : sans lui, l'import se fait par glisser-déposer et l'export vers le
dossier proposé.

Sur une distribution sans apt, le script ne tente rien et affiche la commande
correspondant à votre gestionnaire de paquets, plutôt qu'une commande qui
échouerait.

> **Ce qui n'a pas pu être vérifié.** L'application a été développée et testée
> sous Windows. Le code spécifique à Linux — fenêtres de dialogue, ouverture de
> dossiers, installateur — a été écrit et testé dans ses chemins logiques, mais
> **jamais exécuté sur une vraie machine Linux**. Le point le plus incertain est
> l'export : il dépend de l'encodeur vidéo du navigateur (WebCodecs), dont le
> support varie selon la version de Chromium et le matériel. L'export interroge
> le navigateur avant de commencer et refuse clairement s'il ne trouve aucune
> configuration utilisable — vous le saurez tout de suite plutôt qu'à la fin.
>
> Ouvrez `selftest.html` après installation : la suite de tests vous dira en
> une minute ce qui fonctionne réellement sur votre machine.

---

## Démarrer

Double-cliquez sur **`Lancer CutLocal.bat`**.

Le navigateur s'ouvre sur l'éditeur. Laissez la fenêtre noire ouverte pendant le montage.

> Il faut un navigateur Chromium récent (Chrome ou Edge). Firefox ne sait pas
> encore encoder la vidéo (WebCodecs).

---

## Pourquoi c'est léger et rapide

| | CapCut | CutLocal |
|---|---|---|
| Espace disque | ~1,5 Go | ~250 Ko |
| Décodage / encodage | CPU + GPU | **GPU (NVENC / Quick Sync) via WebCodecs** |
| Effets | CPU | **shaders GPU WebGL2** |
| Copie des fichiers importés | oui (cache) | **aucune** — les vidéos sont lues sur place |
| Réseau | comptes, cloud | **aucun** |

L'aperçu et l'export utilisent **exactement les mêmes shaders**. Ce que vous voyez
est ce qui sort du fichier final.

L'aperçu n'affiche jamais une image qui ne correspond pas à la position de la tête de
lecture : tant qu'une source n'est pas prête, la dernière image correcte du clip est
conservée plutôt qu'une image prise ailleurs dans la vidéo. Et quand un seul clip
vidéo joue, la tête de lecture suit l'horloge de ce clip — image et son viennent de
la même source, sans dérive possible.

---

### Un aperçu fluide, même en 4K 60

Mesuré sur un rush 4K 60 i/s (RTX 3060), aussitôt après l'avoir glissé dans l'éditeur :

| | Avant | Maintenant |
|---|---|---|
| Glisser → clip sur la timeline | ~300 ms | **~25 ms** |
| Lecture d'un rush 4K 60 H.264 | ~10 images/s, à-coups de 0,7 s | **~178 rendus/s**, aucun à-coup |
| Montage à coupes de 0,5 s (deux rushes 4K) | 43 rendus/s, à-coups de 0,46 s | **165 rendus/s**, 0,07 s au pire |
| Montage à coupes de 0,25 s | 21 rendus/s, lecture à 85 % de la vitesse | **138 rendus/s** |

Quatre causes, toutes corrigées :

- **Le son ne décode plus l'image.** L'élément média qui joue le son de l'aperçu
  décodait aussi la vidéo 4K — même un `<audio>` — et volait le décodeur de l'image.
  Il lit maintenant un fichier *virtuel* qui ne déclare que la piste son, construit
  en mémoire autour du fichier d'origine **sans en copier un octet** (`sonseul.js`).
  Son vérifié identique à l'échantillon près.
- **Vignettes et pellicule par images clés.** Elles se fabriquaient en plaçant un
  `<video>` 4K à 24 instants, soit des centaines d'images décodées juste après
  l'import — pile quand on lance la lecture. Elles décodent maintenant une seule
  image clé chacune (WebCodecs), et se font discrètes pendant la lecture. La
  vignette n'est plus attendue pour poser le clip sur la timeline.
- **La vignette du projet ne déplace plus la tête de lecture.** L'enregistrement
  automatique la fabriquait en faisant sauter l'aperçu vers le quart du projet puis
  en revenant : un aller-retour en pleine lecture. Elle est rendue à part.
- **Le plan suivant est prêt avant la coupe** : son décodeur est ouvert et calé sur
  son point d'entrée une seconde à l'avance. Et la tête de lecture ne fait plus de
  bond en avant à chaque coupe en se recalant sur l'horloge du son : elle rattrape
  en douceur.

Le glisser-déposer de **plusieurs fichiers à la fois** les importe tous (seul le
premier entrait : les données d'un dépôt expirent dès la première attente).

## L'interface

Une barre d'icônes à gauche donne accès aux rubriques : **Médias** (vidéos, audio,
images), **Son**, **Texte**, **Masques**, **Transitions**. Presque tous les boutons
sont des icônes — survolez-les pour la légende et le raccourci.

**Tout est redimensionnable à la souris** : glissez la séparation entre deux zones
(médias / aperçu / propriétés, et la barre grise au-dessus de la timeline).

- La timeline descend jusqu'à **44 px** : l'aperçu prend alors presque tout l'écran.
  Elle reste utilisable, avec défilement vertical (`Maj+molette`).
- **Double-clic sur la barre au-dessus de la timeline** : ajuste sa hauteur
  exactement à celle des pistes, sans espace vide. Double-clic sur une séparation
  latérale : retour à la taille d'origine.
- Les bornes s'adaptent à la taille de la fenêtre : impossible d'écraser l'aperçu
  ou la colonne centrale.
- La **hauteur d'une piste** se règle en glissant le bas de son en-tête.
- Les tailles sont mémorisées d'une session à l'autre.
- **Les zones ne bougent qu'à la souris.** Sélectionner, supprimer un clip ou un
  média, retirer un effet, changer de rubrique ou annuler ne modifie jamais la
  taille des panneaux. Seuls votre glissement et un redimensionnement de la fenêtre
  la changent.

## Importer depuis un lien (TikTok / Instagram / YouTube…)

Deux boutons au centre de la barre du haut : **Télécharger vidéo** et
**Télécharger son**. Collez le lien, l'application détecte la plateforme, télécharge
et **place le fichier directement dans les Médias** (le son part dans la rubrique Son).

Cette fonction s'appuie sur **yt-dlp**, l'outil libre de référence, qui doit être
installé une fois :

```
python -m pip install -U yt-dlp
```

CutLocal ne l'installe pas tout seul. S'il est absent, le dialogue l'explique,
propose la commande à copier et un bouton « Vérifier à nouveau ».

Pas besoin de ffmpeg : l'application demande un format déjà prêt en un seul fichier
(MP4 progressif pour la vidéo, M4A/MP3 pour le son). Sur YouTube cela limite parfois
la résolution à 720p — installez ffmpeg si vous voulez mieux.

> N'importez que des contenus dont vous avez le droit de vous servir : vos propres
> publications, du contenu libre, ou une piste dont vous détenez la licence. La
> musique des vidéos TikTok ou YouTube appartient rarement à celui qui les publie.

## Gérer les médias

Dans le panneau **Médias** :

- **Glissez dans une zone vide** pour tracer un rectangle de sélection : toutes les
  vignettes touchées sont sélectionnées.
- **Clic** : un seul. **Maj+clic** : toute la plage. **Ctrl+clic** : ajoute ou retire.
  **Ctrl+A** : tout.
- **Suppr** retire les médias sélectionnés de la bibliothèque (avec confirmation).
  Vos fichiers sur le disque ne sont jamais touchés ; si un média est utilisé dans
  la timeline, ses clips sont supprimés et c'est annoncé.

La touche `Suppr` agit sur la **dernière zone où vous avez cliqué** : dans les médias
elle retire les médias, dans la timeline elle supprime les clips. Un liseré bleu à
gauche du panneau indique que les médias ont le focus, et le pied de panneau rappelle
le nombre d'éléments sélectionnés.

## Mes projets

Le bouton **maison** ouvre la liste **immédiatement** : elle s'affiche d'abord, se
remplit ensuite, et l'enregistrement du projet en cours se fait derrière. Attendre la
sauvegarde — vignette comprise — avant d'afficher quoi que ce soit donnait
l'impression que le bouton ne répondait pas.

La base garde un **index léger** séparé. Il doit contenir **chaque information
affichée sur une carte** — titre, vignette, dates, définition, cadence, durée, nombre
de clips — sans quoi la carte affiche des blancs, puisqu'elle n'a plus accès au projet
complet. Un index écrit par une version antérieure est détecté et reconstruit tout
seul au premier affichage.
Lister les projets chargeait jusque-là *chaque enregistrement en entier, fichiers
vidéo compris*, juste pour afficher un titre : le menu mettait des secondes à
s'ouvrir. Mesuré après : **1 ms**.

Au démarrage, l'application ouvre la page **Mes projets** : toutes vos créations,
avec vignette, durée, format et date. Cliquez pour reprendre, ou **Nouveau projet**.

Clic droit sur un projet : **renommer**, **dupliquer**, **supprimer**. Le bouton
maison de la barre du haut y revient à tout moment. L'enregistrement est automatique.

Les projets contiennent des **références** vers vos vidéos, jamais de copie :
supprimer un projet ne touche pas vos fichiers.

## Outils

Rubrique **Outils** dans la barre de gauche :

| | |
|---|---|
| **Inverser** | rejoue le clip à l'envers, son compris |
| **Figer** | insère l'image courante en photo, par-dessus |
| **Couper avant / après** | supprime tout ce qui précède / suit le curseur |
| **Miroir H / V** | retourne l'image |
| **Tourner 90°** | quart de tour |
| **Ralenti 0,5× / Rapide 2×** | vitesse en un clic |
| **Remplir / Contenir** | cadrage plein écran ou bandes noires |
| **Réinitialiser** | annule transformations, masques et étalonnage |

L'inversion fabrique un vrai fichier MP4 dans le dossier `cache/` : quelques
secondes de calcul (≈150 images/s en 720p), puis tout fonctionne normalement,
export compris. `Ctrl+Z` revient à la source d'origine.

## Effets appliqués : les voir et les enlever

Sélectionnez un clip : un **bandeau apparaît juste au-dessus de la timeline** avec
une pastille par effet appliqué — fondus, masques de flou, vitesse, étalonnage,
incrustation, transformation, rognage, keyframes, transition, son coupé. Chaque
pastille a une **croix** pour l'enlever, et un bouton **Tout enlever** est proposé
dès qu'il y en a plusieurs.

Les mêmes effets apparaissent aussi en **petites pastilles sur le clip** dans la
timeline : un clic dessus retire l'effet (l'info-bulle indique lequel).

### Fondus

Un clip sélectionné affiche un **point blanc** à chacun de ses deux coins hauts.
Tirez-le vers l'intérieur pour créer le fondu (vidéo et audio ensemble), ramenez-le
contre le bord pour **l'enlever**. La pastille du bandeau l'enlève aussi d'un clic.

## Couper à gauche / à droite

Comme sur CapCut, deux boutons dans la barre de la timeline coupent le clip au
curseur et jettent une moitié :

| | | |
|---|---|---|
| ✂ | **Couper** | coupe en deux, garde les deux morceaux (`S`) |
| ⇥ | **Couper la partie gauche** | ne garde que ce qui est à droite du curseur (`Q`) |
| ⇤ | **Couper la partie droite** | ne garde que ce qui est à gauche du curseur (`W`) |

Pour vider toute une piste avant ou après le curseur, la rubrique **Outils** propose
« Couper avant » et « Couper après ».

## Se déplacer dans la timeline

- **Molette** : défile horizontalement. **Ctrl+molette** : zoome autour du curseur.
- Le **curseur de zoom** et les boutons `＋` `－` recadrent toujours la vue : dès que
  tout le projet tient à l'écran, on revient à **0:00**. La vue ne peut jamais
  commencer avant 0:00 ni partir au-delà de la fin.
- `Origine` / `Fin` (et les boutons ⏮ ⏭) ramènent aussi la vue sur la tête de lecture.
- Pendant la lecture, la vue **suit** la tête de lecture.
- En **glissant un clip, un bord ou la tête de lecture vers un bord** de la timeline,
  la vue **défile automatiquement** et l'élément suit le temps — d'autant plus vite
  que vous approchez du bord.
- Quand vous revenez en arrière puis lancez la lecture, l'aperçu attend que **toutes
  les sources soient réellement prêtes** (image et son en tampon, calées au bon
  endroit) avant de démarrer, puis les lance ensemble. Le son part donc du premier
  instant, sans blanc ni décalage. Cette attente dure quelques millisecondes, et est
  plafonnée : si une source traîne, la lecture démarre quand même au bout de 0,9 s.

## Plein écran

Le bouton ⤢ de la barre de lecture (ou `Maj+F`) passe l'aperçu en plein écran, avec
les commandes de lecture. `Échap` en sort. Les masques et le cadre de transformation
restent utilisables en plein écran.

## Couper ce qu'on veut, seulement

**Avec un ou plusieurs clips sélectionnés**, `Couper` (`S`), `Couper la partie
gauche` (`Q`) et `Couper la partie droite` (`W`) n'agissent **que sur la sélection**.
C'est ainsi qu'on coupe la vidéo sans toucher au son posé sur une autre piste, ou
l'inverse.

**Sans sélection**, la coupe s'applique à tout ce qui se trouve sous la tête de
lecture, sur toutes les pistes. Un message confirme la portée à chaque coupe.

`Ctrl+clic` (ou `Maj+clic`) sur un clip l'ajoute ou le retire de la sélection, sans
le déplacer. `Suppr` ne supprime lui aussi que la sélection.

## En-têtes de pistes

Chaque piste a ses boutons : **œil** (masquer l'image, vidéo seulement),
**haut-parleur** (couper le son — y compris sur une piste **vidéo**, pour garder
l'image sans le son d'origine), **cadenas**, **aimant**, et `⋯` pour renommer,
vider, supprimer ou changer la hauteur.

Un bouton coupé ou masqué passe en rouge, et le nom de la piste aussi quand son son
est coupé.

## Piste collée (magnétique)

La **piste principale** est collée par défaut, comme la piste principale de CapCut :

- le premier clip commence toujours à **0:00** ;
- **aucun trou** entre les clips ;
- supprimer un clip **referme le trou** : supprimer le premier ramène tout à 0:00 ;
- raccourcir ou allonger un clip **décale les suivants** ;
- glisser un clip par-dessus un autre les **réordonne**.

Les transitions (recouvrements volontaires) sont conservées.

Le bouton **aimant** dans l'en-tête de chaque piste bascule entre collée (bord
gauche bleu) et libre. Les pistes audio et les pistes ajoutées sont libres par
défaut : une musique reste là où vous la posez.

## Prise en main rapide

1. **Glissez vos vidéos** dans le panneau de gauche (ou `Ctrl+I`).
   Le format du projet s'aligne automatiquement sur la première vidéo.
2. Elles sont ajoutées à la timeline. Déplacez, coupez (`S`), rognez les bords.
   **Glissez dans une zone vide de la timeline pour tracer un rectangle de
   sélection** et attraper plusieurs clips d'un coup (`Maj` pour ajouter à la
   sélection en cours). Les clips sélectionnés se déplacent ensemble.
3. Sélectionnez un clip → bouton **◍ Masque flou** (ou `M`).
4. **Déplacez le masque directement sur l'aperçu** : cercle bleu au centre pour
   bouger, poignées blanches pour la taille, poignée verte pour tourner,
   poignée violette pour le contour progressif.
5. Pour **couper le son d'une vidéo** : cliquez la pastille haut-parleur en haut à
   droite du clip dans la timeline (elle devient rouge), ou le bouton haut-parleur
   de la barre d'outils (`Ctrl+M`).
6. **Exporter** → choisissez 4K / 60 i/s → l'encodeur GPU fait le reste.

---

## Les masques (le cœur de l'outil)

Cinq formes : **rectangle**, **ellipse**, **linéaire**, **miroir**, **forme libre**
(sommets déplaçables ; clic sur un point médian pour en ajouter, clic droit pour retirer).

Cinq effets, au choix par masque :

| Effet | Usage |
|---|---|
| **Flou** | flouter un visage, une plaque, un logo |
| **Mosaïque** | pixelliser (rendu « censure ») |
| **Noir** | masquer complètement une zone |
| **Garder l'intérieur** | ne conserver que la zone du masque (incrustation) |
| **Masquer l'intérieur** | découper un trou dans le clip |

Chaque masque a son intensité, son contour progressif, sa rotation et son inversion.
Plusieurs masques par clip sont possibles (ils se combinent).

### Flouter une tête qui bouge (suivi de mouvement)

Rubrique **Masques** → gros bouton **« Flouter un visage »** (ou la touche `F`).
Un rond flou apparaît avec un premier point de suivi.

1. Placez le rond sur la tête.
2. Avancez de quelques dixièmes de seconde dans la timeline.
3. Redéplacez le rond sur la tête → **un point est ajouté automatiquement**.
4. Répétez aux endroits où le mouvement change de direction.

Entre deux points, le flou se déplace tout seul en douceur. Trois ou quatre points
suffisent pour un plan simple.

Sur l'aperçu vous voyez la **trajectoire** en vert pointillé et un **rond vert par
point** :

- **glisser un rond vert** corrige la position à cet instant précis (sans toucher
  aux autres) ;
- **cliquer** un rond vert amène la tête de lecture à cet instant ;
- **clic droit** sur un rond vert supprime ce point.

Le bloc « Suivi du mouvement » du panneau de droite compte les points, permet de
sauter de l'un à l'autre (`‹` `›`), d'en poser un, d'en retirer un, ou d'effacer
tout le suivi.

## Texte

**12 styles** prêts à l'emploi dans l'esprit TikTok : Classique, Contour, Fond noir,
Fond blanc, Jaune, Néon, Rose, Gros titre, Sous-titre, Machine à écrire, Vert vif,
Doux. Un clic dans la rubrique **Texte** pose le texte au curseur avec ce style.

**14 polices** (les polices de TikTok sont propriétaires ; ce sont les familles
Windows qui donnent le même rendu) : Classique, Gras, Titre, Condensé, Arrondi, Net,
Serif, Élégant, Massif, Machine, Manuscrit, BD, Technique, Large. La liste s'affiche
dans la police correspondante.

**Taille et emplacement** :

- grille **3×3** pour placer le texte dans un coin, sur un bord ou au centre ;
- **glisser le texte directement sur l'aperçu** pour le placer où vous voulez ;
- **coins jaunes** pour la taille, poignée verte pour la rotation ;
- réglages fins : taille, échelle, position X/Y, rotation — tous animables par keyframes.

Plus : couleur, contour et son épaisseur, ombre, **halo lumineux** coloré (néon),
fond, interligne, alignement, italique.

## Cliquer sur l'aperçu

Cliquez **directement sur l'élément** dans l'aperçu : la vidéo du fond, une
superposition, un texte, un masque — c'est celui du dessus sous le curseur qui est
sélectionné, et le même geste le déplace aussitôt.

Pendant le déplacement, un **quadrillage en tiers** apparaît et l'élément
**s'aimante** au centre, aux tiers, aux bords de l'image et aux marges de sécurité.
Un repère jaune indique l'alignement trouvé. Maintenez `Alt` pour placer librement,
sans aimant.

Les coins jaunes redimensionnent, la poignée verte fait tourner.

## Superposer des images et des vidéos

Trois façons, au choix :

1. **Glissez le média depuis la bibliothèque vers la bande du haut de la timeline.**
   Dès que vous entrez dans la timeline, une bande apparaît juste sous la règle :
   « ＋ Vidéo 2 — déposer ici pour superposer ». Les pistes descendent pour laisser
   la place ; lâchez, la couche est créée et le clip se pose là où vous l'avez mis.
2. Le bouton **calques** sur une carte de la bibliothèque (au survol).
3. Clic droit sur une carte → **Superposer par-dessus**.

Vous pouvez empiler **autant de couches vidéo que vous voulez** : Vidéo 2, Vidéo 3,
Vidéo 4… Chaque nouveau dépôt sur la bande du haut crée la couche suivante, et
celle du dessus dans la timeline est celle du dessus à l'image.

Pour poser plusieurs médias d'un coup, chacun sur sa propre piste : sélectionnez-les
dans la bibliothèque (Ctrl+clic ou rectangle), clic droit → **Empiler les N sur des
pistes séparées**. Ils démarrent tous à la tête de lecture.

Les couches de superposition sont **libres** : vous placez le clip où vous voulez,
il ne se recolle pas au début.

### Superposer plusieurs sons

Même principe, mais la bande apparaît **en bas**, sous les pistes : glissez un audio
dans la timeline et lâchez sur « ＋ Audio N — déposer ici pour un son en plus ».
Le bouton **calques** et le clic droit → **Ajouter sur une nouvelle piste audio**
font la même chose à la tête de lecture ; si une piste audio est libre à cet instant
le son y va, sinon une nouvelle piste est créée.

Toutes les pistes audio sont mixées ensemble, à l'aperçu comme à l'export. Chaque
piste a son propre volume et son bouton muet, et chaque clip aussi.

Les PNG transparents sont gérés correctement (alpha non prémultiplié, pas de liseré
sombre sur les bords). Position, échelle, rotation, opacité et masques s'appliquent
à la superposition comme à n'importe quel clip, et sont animables par keyframes.

Dans la timeline, les couches de superposition s'affichent **au-dessus** de la piste
principale, et l'audio en dessous — dans l'ordre où elles apparaissent à l'image.

---

## Ce que fait aussi l'éditeur

- Multi-pistes vidéo et audio, verrouillage / masquage / muet par piste
- Transformation : position, échelle, rotation, opacité, miroir, rognage, cadrage
- Étalonnage : exposition, contraste, saturation, température, teinte,
  hautes lumières, ombres, vignettage, netteté
- Incrustation couleur (fond vert) avec anti-débordement
- Vitesse 0,1× à 8×, fondus vidéo et audio, volume par clip
- Transitions par fondu enchaîné (poignée `⇄` entre deux clips, ou clic droit)
- Texte : police, taille, couleur, contour, ombre, alignement
- Keyframes sur position / échelle / rotation / opacité et sur toutes les
  propriétés de masque
- Annuler / refaire illimité (80 étapes), enregistrement automatique du projet

---

## En-tête de piste et import dans Photos

L'en-tête de piste (`tkhd`) faisait **88 octets au lieu de 92** : le champ réservé
entre l'identifiant de piste et la durée manquait. La durée tombait donc dans le
mauvais champ, et **tout ce qui suit était décalé de quatre octets** — matrice
d'affichage invalide (`0 0 0 65536 …` au lieu de `65536 0 0 0 65536 …`) et dimensions
de piste aberrantes (`3840 × 0,04`).

VLC n'y voyait rien : il lit les tables d'échantillons et ignore cet en-tête. **Photos
sur iPhone, lui, le lit** — et refusait d'importer la vidéo. Un fichier peut donc se
lire parfaitement partout et rester inimportable.

Après correction : `tkhd` de 92 octets, matrice identité, dimensions réelles. La
marque `mp42` a aussi été ajoutée au `ftyp`, celle qu'attendent les importeurs
stricts pour du H.264 + AAC.

## Envoyer sur l'iPhone (VLC)

Quand un export se termine, l'éditeur propose de déposer la vidéo sur **VLC iOS** —
deux boutons, **Oui** ou **Non**. Rien ne part sans ce clic : déposer un fichier sur
un téléphone, c'est le sortir de cette machine.

Sur l'iPhone : **VLC → Réseau → « Partage via Wi-Fi »**. VLC affiche une adresse
(`192.168.1.x`) — recopiez-la dans le champ, elle est retenue pour les fois suivantes.
Une fois la vidéo dans VLC : appui long dessus → **« Enregistrer dans Photos »**.

Le dépôt se fait en `multipart` sur `/upload.json` (puis `/upload`,
`/requests/upload.json` selon la version de VLC), en essayant les noms de champ
`file`, `files[]`, `files`. Le nom du fichier est conservé, ce qui permet de le
retrouver dans VLC.

**La cible est limitée au réseau local** (`10.x`, `192.168.x`, `172.16-31.x`,
`169.254.x`, `.local`). Une adresse publique est refusée : envoyer une vidéo vers
Internet serait la publier, ce qui n'est jamais l'intention ici.

## Export

Le bouton **Exporter** s'ouvre déjà réglé sur **4K, 60 i/s**, dans l'orientation du
projet : un projet vertical (TikTok, Reels, Shorts) part en 2160×3840, un projet
horizontal en 3840×2160. Un projet carré garde sa taille, faute de préréglage 4K carré.

### Fichiers .MOV d'iPhone

Les entrées son des `.MOV` QuickTime existent en **version 1** (et parfois 2), qui
glissent 16 (ou 36) octets avant les sous-boîtes. Lues à l'emplacement de la version 0,
la boîte `esds` est introuvable : le codec reste inconnu, la piste audio est ignorée
et **l'export sort muet**. Les trois versions sont maintenant gérées, et vérifiées par
un test qui convertit un fichier en entrée version 1 et contrôle que la piste audio
est bien retrouvée.

### La lecture ne démarre qu'au premier besoin

Le chemin « lecteur du navigateur » lit en temps réel. S'il démarrait dès
l'initialisation, il avancerait pendant les vérifications qui suivent, et les
premières images du montage seraient perdues avant même d'être demandées. La piste est
donc préparée à l'arrêt, brièvement mise en route pour vérifier qu'elle produit des
images, **rembobinée**, puis relancée au premier appel réel. Mesuré sur une source
1080×1920 à 60 i/s : la dérive en fin de vidéo passe de **82 images à 2**.

### Jamais de rendu accéléré

Le chemin « lecture par le lecteur du navigateur » avance en **temps réel**. Si
l'encodage prend du retard, la lecture, elle, continue : servir l'image courante
reviendrait à faire défiler le montage plus vite que le temps, et **la vidéo finale
sortirait accélérée** — avec pourtant la bonne durée, ce qui rend le défaut sournois.

Deux garde-fous :

- la lecture est **suspendue** dès que la file d'attente est pleine, c'est-à-dire dès
  que l'export prend du retard. Un export un peu plus long vaut mieux qu'un rendu faux ;
- une image **en avance** sur l'instant demandé n'est jamais servie : on redonne la
  précédente.

Vérifié par un test « code-barres » en 1080×1920 à 60 i/s où chaque image porte son
numéro : après ré-encodage complet et relecture, la **dérive en fin de vidéo est de
0,0 image** (WebCodecs) et **0,3 image** (lecteur), pour un écart maximum d'une image.

### La 4K 60 i/s encodée par la carte graphique

Chrome refuse l'encodeur matériel dès que la définition × la cadence dépasse ce
qu'annonce le pilote — typiquement la 4K à 60 i/s — alors que la carte l'encode
sans peine. L'export retombait donc en logiciel. En **qualité constante** (le mode
par défaut), la cadence déclarée à l'encodeur n'influe sur rien : chaque image reçoit
le même quantificateur. L'export lui annonce donc 30 i/s et lui donne les images au
vrai rythme ; le fichier reste en 60 i/s, image par image (vérifié : 1200 images sur
1200, chacune fidèle à sa source). Mesuré sur une source 4K 60 : **+15 à +21 %**
en export réparti, **+30 %** en mono-cœur. Au-delà, c'est l'encodeur de la carte
lui-même qui plafonne (~85 images 4K/s sur une RTX 3060).

### Le réglage par défaut est le plus rapide que votre carte accélère

Toutes les cartes n'encodent pas tout en matériel. Beaucoup s'arrêtent à la **4K 30 i/s**
ou au **1080p 60 i/s** ; au-delà (typiquement la 4K à 60 i/s), l'encodage bascule en
**logiciel**, cinq à dix fois plus lent. « Le codec est supporté » ne dit rien de la
vitesse : ce qui compte est de savoir si le **matériel** l'accepte.

À l'ouverture, l'export sonde votre carte et se règle sur le meilleur préréglage
**accéléré**, sans dépasser vos sources, en préservant d'abord la définition puis la
cadence. Pour une source iPhone 4K 60 i/s sur une carte qui plafonne à la 4K 30 :
l'export s'ouvre sur **4K 30 i/s** — pleine définition, accéléré. Mesuré : une vidéo
4K de 9,4 s exportée en **4,4 s** (65 i/s), avec le son.

Si vous forcez un réglage que la carte n'accélère pas, la boîte le dit sans détour :
« NON accéléré par votre carte (encodage logiciel, lent) — réglage rapide : 2160×3840
à 30 i/s ». À vous de choisir entre la vitesse et ce réglage précis.

**Le niveau H.264 est calculé correctement** (table des débits de macroblocs) : la 4K
à 60 i/s exige le niveau 5.2, et l'annoncer en 5.1 — hors-spec — faisait refuser le
matériel qui retombait en logiciel.

### Vidéos à débit variable (iPhone)

Les vidéos de téléphone ont un débit d'images **variable** : les images ne sont pas
espacées régulièrement. Le décodeur tolère donc un large retour arrière sans re-sauter
— un saut re-décode toute une GOP, et répété, il écroule le débit. À l'export (qui ne
va que vers l'avant) une micro-variation ne déclenche plus aucun saut : mesuré à
**0,00 saut par image** sur une source 4K, contre les nombreux sauts d'avant.

### Le réglage par défaut suit vos sources

L'export s'ouvre en **4K 60 i/s** dans l'orientation du projet — le réglage TikTok.
Le fichier est écrit **directement sur le Bureau** sous le nom saisi dans la boîte :
pas de seconde fenêtre pour redemander ce qui vient d'être tapé.

Si la carte n'accélère pas ce réglage, ou s'il agrandit vos sources, le message le dit
et propose le réglage rapide le plus proche — mais c'est bien le réglage demandé qui
reste affiché. Agrandir une vidéo 1080p en 4K quadruple le nombre
de pixels à encoder **sans ajouter le moindre détail** : les pixels n'existent pas
dans le fichier d'origine. Mesuré sur une vidéo verticale de 9,4 s au contenu très
détaillé : **2,8 s** à la définition de la source (accéléré par le GPU) contre
**11,9 s** en forçant la 4K (encodage logiciel) — **4,3 fois plus lent pour rien**.

La 4K reste à un clic dans la liste. Si le réglage choisi dépasse la définition de
vos sources, la boîte le dit : « agrandissement : 4,0× plus de pixels que vos
sources, donc un export bien plus long sans gain de qualité ».

Deux boutons **TikTok** et **YouTube** au-dessus du champ choisissent le préfixe —
`clip2ep_tiktok_` ou `clip2ep_youtube_`. Basculer de l'un à l'autre **ne remplace que
le préfixe** : ce que vous avez déjà tapé est conservé, et le curseur reste en fin de
ligne. Le choix est retenu d'un export à l'autre.

La boîte d'enregistrement s'ouvre sur le **Bureau** par défaut.

Le champ **Nom du fichier** est pré-rempli avec `clip2ep_tiktok_`, curseur à la fin :
il n'y a plus qu'à taper la suite. Le nom est nettoyé des caractères interdits par
Windows (`\ / : * ? " < > |` deviennent `_`) et l'extension `.mp4` est ajoutée. Ce
nom est ensuite proposé dans la boîte d'enregistrement Windows.

| Réglage | Valeurs |
|---|---|
| Résolution | 4K UHD, 2K, Full HD, HD, formats verticaux, carré, ou personnalisé |
| Cadence | 24 / 25 / 30 / 50 / 60 / 120 i/s |
| Codec | H.264 (compatible partout), H.265/HEVC, AV1 — selon le GPU |
| Débit | conseillé automatiquement, ajustable |
| Audio | AAC 128 / 192 / 320 kb/s, ou aucun |

L'export est **exact à l'image près** : chaque image est décodée à sa position
réelle (WebCodecs), composée sur le GPU, puis encodée. Aucun rééchantillonnage
approximatif par « seek » de lecteur vidéo.

Le fichier MP4 est écrit directement sur le disque au fil de l'encodage — un export
de plusieurs Go ne consomme pas de mémoire.

### Vitesse

**L'audio est préparé en parallèle de la vidéo.** Décoder puis encoder la bande son
est un travail indépendant : le faire d'abord ajoutait bêtement son temps à celui de
l'image. Il démarre maintenant en même temps que l'encodage vidéo, et n'est attendu
qu'au moment d'ouvrir le fichier — l'encodeur a alors déjà avalé ses premières images.

**Le choix du décodeur est borné dans le temps.** La sonde qui juge si WebCodecs
convient dispose d'un budget **total** de 1,2 s, pas d'un délai par image : sans cela,
six images à la limite du délai individuel coûtaient quinze secondes avant de conclure,
à chaque export. Mesuré sur une source 4K 59 i/s que WebCodecs ne sait pas décoder :
**31 s → 7 s** pour 5,6 s de vidéo.

**Les étages se recouvrent.** Le décodage de l'image suivante est lancé avant le rendu
et l'encodage de la courante : pendant qu'on attend l'encodeur ou le disque, le
décodeur travaille déjà. Sans ça chaque étage attend le précédent et les deux passent
la moitié du temps au repos. C'est ce que fait n'importe quel logiciel de montage.
Pour que ce soit possible, une image décodée est remise à l'appelant sous forme de
**clone** (un compteur de références, pas une copie des pixels), sinon on la lui
fermerait sous les pieds en décodant la suivante.

**Le décodage demande explicitement le GPU.** WebCodecs est en « no-preference » par
défaut, et le navigateur peut alors retenir le décodeur logiciel — catastrophique sur
du HEVC ou de l'AV1 en 4K, où une seule image peut coûter des secondes.

**Une image inchangée n'est pas renvoyée au GPU.** Quand la sortie est plus rapide que
la source (60 i/s depuis une vidéo à 30), une image sur deux est identique : la texture
est déjà là. En 4K cela économise plusieurs mégaoctets par image.

Rien n'attend « en tournant en rond » : le décodeur et l'encodeur matériels livrent
leurs images sur le thread principal, donc l'occuper à interroger leur file d'attente
revient à ralentir exactement ce qu'on attend. L'export **dort** sur l'événement
`dequeue` des codecs, décode quelques images d'avance pendant que le GPU compose la
précédente, et envoie les paquets au disque **sans attendre la réponse** (les requêtes
restent chaînées, donc l'ordre est garanti).

La barre d'avancement se met à jour sur le temps (toutes les 120 ms), pas tous les
N images : un passage un peu lent ne donne plus l'impression d'un blocage.

Elle compte les images **réellement encodées**, pas celles qui ont été soumises. La
file de l'encodeur avale les premières d'un coup : les compter donnait un débit
flatteur au démarrage (« 21 img/s ») qui s'effondrait ensuite, et une estimation de
durée qui ne cessait de grandir. Le chiffre affiché est maintenant le vrai débit dès
le début.

### Décalages de composition négatifs (.MOV iPhone)

La table `ctts` porte, pour chaque image, l'écart entre son ordre de décodage et
son ordre d'affichage. La norme dit : version 0 = valeurs **non signées**,
version 1 = **signées**. Or **Apple écrit une version 0 contenant des valeurs
négatives** — les images B en ont besoin.

Lues telles quelles, ces valeurs deviennent des nombres colossaux (2³² moins
quelques unités). Les horodatages partent à l'infini, le décodeur ne retrouve plus
l'image demandée et **renvoie sans cesse la même** : la vidéo exportée se fige.

Mesuré sur quatre enregistrements iPhone 4K 60 :

| | Avant | Après |
|---|---|---|
| Horodatages distincts | 2 / 120 | **120 / 120** |
| Images répétées | **118** | **0** |

Toute valeur frôlant 2³¹ est donc réinterprétée comme le négatif qu'elle est.

### Réserve d'images et réordonnancement

Les images B sortent du décodeur **dans le désordre** : il faut en garder plusieurs
sous la main pour les remettre en place. La réserve est dimensionnée en pixels (six
images de 1080p passent, six images de 4K épuisent les tampons du décodeur
matériel), mais avec un **plancher** dès que le fichier contient des images B —
sinon on attend indéfiniment une image déjà passée, et l'export se bloque.

### Seul WebCodecs est exact à l'image près

Mesuré sur une source 1080×1920 à 60 i/s dont chaque image porte son numéro,
en redemandant les 300 images une à une :

| Chemin de décodage | Débit | Images fausses |
|---|---|---|
| **WebCodecs** | 75 i/s | **0 / 300** |
| lecture par piste média | 60 i/s | 253 / 300 |
| lecture image par image (`seek`) | 19 i/s | 255 / 300 |

Les deux replis reposent sur le lecteur `<video>`, qui ne garantit pas de rendre
exactement l'image demandée à 60 i/s : ils conviennent à un aperçu, pas à un export.
Une vidéo qui les emprunte **ne peut pas** être fluide.

L'éditeur le signale donc systématiquement, en nommant le fichier concerné, au lieu
de livrer une vidéo qui saccade sans explication. La seule vraie solution pour un
fichier que WebCodecs refuse est de le convertir une fois en MP4 H.264.

### Battement d'image clé

Avec un débit cible, l'encodeur dépense d'un coup pour reconstruire chaque image clé :
la qualité remonte d'un cran puis redescend, et l'œil perçoit un à-coup **à intervalle
régulier** — une fois par seconde avec des clés chaque seconde. C'est très visible sur
un plan peu animé, et invisible sur un plan très mouvementé (le mouvement masque tout).

Mesuré sur une source quasi fixe, écart moyen aux images clés :

| Mode | Écart | Fichier |
|---|---|---|
| débit variable, 20 Mb/s | 20,2 | 8,1 Mo |
| débit variable, 55 Mb/s | 11,1 | 13,1 Mo |
| débit constant, 55 Mb/s | 0,69 | 11,6 Mo |
| **qualité constante (QP 22)** | **0,01** | **7,5 Mo** |

L'export demande donc à l'encodeur, dans l'ordre : **qualité constante** (`quantizer`),
puis **débit régulier** (`constant`), puis débit variable. La qualité constante donne
le meilleur résultat *et* le fichier le plus petit — mais elle n'est pas acceptée
partout : refusée en 4K sur cette machine, acceptée en 1080p.

En 4K, ce qui reste efficace est de ne pas serrer le débit : un plafond à 40 Mb/s
faisait remonter l'écart à 18,8 contre 7,2 à 55 Mb/s. Le plafond a donc été retiré.

### Rotation des vidéos de téléphone

Les téléphones filment à l'horizontale et inscrivent « tourner de 90° » dans la
matrice d'affichage du conteneur (`tkhd`). Le lecteur du navigateur obéit — donc
**l'aperçu est droit**. WebCodecs, lui, rend l'image brute : sans lire cette matrice,
**un clip de téléphone sort couché à l'export** alors qu'il est droit à l'aperçu.

La matrice est maintenant lue, la définition annoncée est celle qu'on voit (une vidéo
1920×1080 marquée 90° est présentée comme 1080×1920), et le compositeur applique la
rotation : le **cadrage** se calcule sur les dimensions redressées, le quadrilatère
garde les dimensions brutes, la rotation fait le lien. Vérifié en comparant côte à
côte le rendu du lecteur et l'export d'une source marquée 90° : mêmes repères, même
orientation, mêmes dimensions.

### Le décodeur n'est jugé que s'il est le goulot

Un garde-fou surveillait la cadence de l'export pour basculer un clip sur le
lecteur du navigateur quand WebCodecs traînait. Mais il mesurait la cadence de
**toute la boucle** — décodage, rendu, encodage, écriture — et l'imputait au
décodeur. Or en 4K 60 la boucle tombe sous 12 i/s par le seul fait de l'encodage :
**tous** les clips basculaient donc au bout d'une seconde et demie, avec les images
perdues du chemin temps réel. Et comme les deux chemins ne traitent pas la rotation
du conteneur de la même façon, l'orientation changeait **en cours de vidéo** — d'où
des premières images de travers. La bascule n'est désormais envisagée que si le
décodage représente vraiment plus de la moitié du temps.

### Choix de l'image : un test exact, pas un seuil

L'image courante était redonnée dès que l'instant demandé était à moins de 0,6 période
source. Ajouté à la tolérance d'acceptation de 0,45, cela acceptait **1,05 période au
lieu de 1,00** : sur les cadences NTSC — 59,94 exportée en 60, c'est-à-dire tous les
téléphones — il en sortait une vingtaine de doublons par millier d'images au lieu de
deux, en détruisant au passage de vraies images. C'était ça, le « pas vraiment 60 i/s ».

Le seuil est remplacé par un test exact : on ne redonne l'image courante que si la
**suivante dépasse réellement** l'instant demandé. Vérifié sur une vidéo TikTok 60 i/s
exportée en 4K 60 : **0 doublon sur 566 images**, séquentiel comme parallèle.

### Export réparti sur plusieurs cœurs

La timeline est découpée en tranches alignées sur les images clés, confiées chacune à
un Web Worker qui fait tout — décodage WebCodecs, rendu WebGL sur `OffscreenCanvas`,
encodage — puis le thread principal remet les paquets dans l'ordre. Chaque tranche
commençant par une image clé, les morceaux se recollent sans transition.

Le repli sur le lecteur `<video>` n'existe pas dans un worker (pas de DOM) : si un clip
en a besoin, le worker rend la main et l'export reprend le chemin classique.

### Débit plafonné à l'utile

La 4K 60 réclamait 55 Mb/s en qualité haute. Au-delà de 40 Mb/s le gain n'est plus
visible, et les plateformes recompressent tout de toute façon : le fichier est
simplement deux fois plus lourd et plus long à encoder. Le débit est donc plafonné
(40 Mb/s en « Haute », 60 en « Maximale »).

### Pas de sonde au démarrage

Une version précédente mesurait la vitesse de WebCodecs sur les premières images
avant de décider s'il convenait. **C'était une mauvaise idée** : juger un décodeur à
froid, en une poignée d'images, donnait un verdict faux — des fichiers que WebCodecs
décode à plus de 100 images/s étaient condamnés au chemin de secours, donc à des
images dupliquées et à une vidéo qui saccade. La sonde est supprimée : WebCodecs est
utilisé par défaut, et c'est le débit **réel**, mesuré pendant l'export, qui décide
d'une éventuelle bascule — après une période de mise en route non comptée, car les
premières images paient la configuration du décodeur.

### Deux chemins de décodage, et un filet de sécurité

Toutes les vidéos ne se décodent pas à la même vitesse, et « le codec est supporté »
ne dit **rien** de sa rapidité : sur certains fichiers (HEVC 4K, 10 bits, HDR),
WebCodecs peut mettre des secondes par image.

1. **WebCodecs** quand il est rapide — c'est le chemin normal, le plus véloce.
2. **Lecture par piste média** (`MediaStreamTrackProcessor` sur le lecteur du
   navigateur) sinon. C'est le décodeur qui fait tourner l'aperçu sans effort, même
   sur les formats que WebCodecs n'accélère pas. Contrairement à
   `requestVideoFrameCallback`, cette API **ne dépend pas de l'affichage** : elle
   fonctionne onglet caché. La lecture s'y fait en temps réel (`playbackRate` est
   ignoré par `captureStream`), donc une vidéo de 9 s prend 9 s à parcourir — sans
   commune mesure avec les minutes d'un décodage logiciel.

**Le filet de sécurité :** une mesure au démarrage ne garantit rien sur la durée. Si
le débit s'effondre en cours d'export (mémoire vidéo saturée, codec qui bascule en
logiciel…), l'éditeur **rebascule ce clip en cours de route** sur la lecture par piste
et le dit dans la fenêtre de progression.

Deux pièges de `captureStream`, trouvés en vérifiant image par image :

- ses horodatages sont ceux de la **capture**, pas du média — ils dérivent de
  plusieurs images. Les images sont donc numérotées par l'éditeur, avec
  resynchronisation sur la position réelle du lecteur si le navigateur en perd ;
- il émet un **instantané de l'image courante** à l'ouverture de la piste, avant que
  la lecture n'avance. Le garder décalait toute la vidéo d'une image.

Vérifié par un test « code-barres » (chaque image porte son numéro) qui contrôle,
**sans aucune tolérance**, que les deux chemins rendent bien la bonne image.

### Propriété des images décodées

Le décodeur rend un **clone** (un compteur de références, pas une copie de pixels) :
c'est ce qui permet de décoder l'image suivante pendant qu'on rend la courante, sans
se la fermer sous les pieds. En contrepartie, **l'appelant doit fermer ce clone**
(`if (got.owned) got.src.close()`). Une image oubliée épuise les tampons du décodeur
matériel, qui finit par se bloquer — la panne est silencieuse et se manifeste par un
export qui s'effondre après quelques secondes. Un traceur (page `leak.html` du dépôt
de test) permet de vérifier qu'aucune image ne survit à une passe complète : la suite
se termine à **0 image non fermée**.

### Quand c'est lent, l'éditeur dit pourquoi

Le temps passé est mesuré séparément pour la **lecture des sources**, le **rendu des
effets**, l'**encodage** et l'**écriture disque**. Si une étape domine nettement et que
le débit est faible, la fenêtre de progression la nomme.

Le cas le plus fréquent : une vidéo que WebCodecs ne sait pas décoder (typiquement un
**WebM/VP9** téléchargé depuis TikTok ou YouTube). L'éditeur retombe alors sur un
décodage par `seek`, une image à la fois — mesuré **6 fois plus lent** sur la même
source (18 i/s contre 121 i/s), et bien pire encore sur un vrai VP9. Le nom du fichier
en cause est affiché.

Pour éviter le problème à la source, le téléchargement par lien demande maintenant en
priorité du **MP4 H.264**, le seul format décodable image par image en accéléré.

Quand la lecture est le frein, la fenêtre précise **laquelle** des deux causes :

- le décodeur se repositionne plusieurs fois par image (la vidéo l'oblige à repartir
  d'une image clé sans arrêt) ;
- ou le disque qui contient la vidéo ne suit pas (débit affiché en Mo/s).

Les lectures se font par blocs de 4 Mo gardés en mémoire. Sur un disque externe, USB
ou réseau, chaque aller-retour coûte bien plus cher que les octets eux-mêmes : lire
peu et souvent y est catastrophique.

### Son des fichiers exotiques

Trois chemins, essayés dans l'ordre : **WebCodecs** (AAC, Opus), puis
**`decodeAudioData`**, puis la **piste audio du lecteur du navigateur**. Ce dernier
recours accepte tout ce que l'aperçu sait jouer — y compris les `.MOV` dont le son
n'est ni AAC ni Opus, qui sortaient jusqu'ici muets.

### Analyser une vidéo qui ralentit l'export

Ouvrez **`diagnostic.html`** (même adresse que l'éditeur, en remplaçant la fin par
`/diagnostic.html`) puis **« Analyser MA vidéo »** et choisissez le fichier. Le rapport
donne le débit du disque qui l'héberge, le conteneur, le codec, l'écart entre images
clés, si WebCodecs sait la décoder, le débit de décodage réel, le nombre de
repositionnements par image — et un verdict en une ligne.

Si une source n'est pas lisible en accélération matérielle, l'éditeur retombe sur un
décodage par `seek`, bien plus lent — il le **dit** dans la fenêtre de progression au
lieu de laisser croire à un plantage. Et si plus rien n'avance pendant 30 secondes,
l'export s'arrête en expliquant à quelle image, plutôt que de rester figé.

### Annuler

**Annuler** rend la main immédiatement (mesuré à 4 ms) : les codecs sont fermés et les
écritures en vol sont coupées net, au lieu d'attendre la fin de l'image en cours. Le
fichier temporaire est supprimé.

---

## Raccourcis

| | |
|---|---|
| `Espace` | lecture / pause |
| `←` `→` | image précédente / suivante (`Maj` = 1 s) |
| `Origine` / `Fin` | début / fin |
| `S` | couper au curseur |
| `Suppr` | supprimer — `Maj+Suppr` : supprimer et combler |
| `F` | flouter un visage (rond flou + suivi) |
| `T` | ajouter un texte |
| `M` | ajouter un masque flou |
| `Q` / `W` | couper la partie gauche / droite |
| `Maj+F` | plein ecran de l'apercu |
| `T` | ajouter un texte |
| `L` | lecture en boucle |
| `+` `-` | zoom timeline — `Maj+Z` : ajuster |
| `Ctrl+D` | dupliquer |
| `Ctrl+Z` / `Ctrl+Y` | annuler / refaire |
| `Ctrl+I` | importer |
| `Ctrl+E` | exporter |
| `Ctrl+S` | enregistrer le projet |
| `Ctrl+M` | couper / remettre le son du clip |
| `Ctrl+A` | tout sélectionner |
| `Ctrl+molette` | zoom timeline |
| glisser dans le vide | rectangle de sélection multiple |
| `Maj` + glisser | ajouter au rectangle de sélection |

---

## Formats d'entrée

Chemin rapide (décodage matériel image par image) : **MP4, MOV, M4V** en
H.264, H.265, AV1, VP9.

Les autres conteneurs (MKV, WEBM, AVI, WMV, FLV…) passent par un chemin de secours
plus lent à l'export mais fonctionnel, tant que le navigateur sait les lire.

Audio : MP3, WAV, M4A, AAC, FLAC, OGG, OPUS. Images : PNG, JPG, WEBP, BMP, GIF.

---

## Projets

Les projets sont enregistrés automatiquement dans le navigateur (IndexedDB). « Ouvrir »
liste les projets enregistrés.

**Aucune copie de vos vidéos n'est faite.** Un projet ne garde qu'une *autorisation
d'accès* au fichier d'origine (quelques octets) ; à la réouverture, le navigateur vous
demande simplement d'autoriser à nouveau la lecture. Les vidéos téléchargées par lien
sont retrouvées à leur emplacement sur le disque.

Les anciennes versions rangeaient au contraire une **copie complète** de chaque vidéo
importée dans le profil du navigateur, sur le disque C, invisible depuis l'explorateur
— mesuré sur une machine de test : plus de 20 Go. Le bouton de place occupée (en haut)
affiche ces copies sous « Copies des vidéos dans le navigateur » et permet de les
effacer ; la place est rendue à la prochaine ouverture du navigateur. Un ancien projet
qui en dépendait affiche alors ses vidéos comme introuvables : importez à nouveau le
même fichier, il est **rebranché** sur son clip, sans en ajouter un second.

Les copies d'aperçu ne sont plus fabriquées pour les MP4 / MOV, que l'aperçu décode
désormais directement en matériel (4K 60 compris) : elles coûtaient une copie
temporaire du rush entier, puis des centaines de Mo gardés. Elles ne servent plus
qu'aux formats que WebCodecs ne lit pas (WebM, MKV, AVI…), en 1280 px et sans son —
plus de deux fois plus légères — avec un plafond total de 1 Go.

Si vous déplacez ou supprimez un fichier source, le clip apparaît comme introuvable :
réimportez le fichier au même nom.

---

## Vérifier l'installation

- `http://127.0.0.1:4676/diagnostic.html?tk=…` — capacités GPU / codecs de votre machine
- `http://127.0.0.1:4676/selftest.html?tk=…` — 34 tests automatiques du moteur
  (muxage, démuxage, décodage exact, masques, mixage audio, export 4K)

Le jeton `tk` est celui affiché dans la fenêtre noire au démarrage.

---

## Structure

```
server/       serveur local (Node, bibliothèque standard uniquement)
  server.js   fichiers statiques, lecture disque par plages, dialogues Windows
  mp4mux.js   muxeur MP4 en flux (écrit le fichier final)
  dialogs.js  boîtes de dialogue natives via PowerShell
app/          interface (modules ES natifs, aucun bundler)
  js/mp4demux.js   démuxeur MP4/MOV, y compris fragmenté
  js/renderer.js   compositeur WebGL2
  js/shaders.js    masques, flou séparable, étalonnage, incrustation
  js/decode.js     décodage exact via WebCodecs
  js/exporter.js   chaîne d'export
  js/timeline.js   timeline canvas
projects/     (réservé)
```

## Limites connues

- L'accélération matérielle en 4K dépend du pilote GPU ; sinon l'encodage bascule
  en logiciel (plus lent, qualité identique).
- Le changement de vitesse modifie la hauteur du son (pas de correction de pitch).
- Pas de suivi automatique d'objet : le suivi de masque se fait par keyframes.
