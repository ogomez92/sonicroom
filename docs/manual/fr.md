---
title: SonicRoom — le manuel pour lecteurs d'écran
subtitle: Comment régler votre lecteur d'écran, comment fonctionne le clavier et tous les raccourcis
lang: fr
---

# À lire avant tout le reste

**SonicRoom est une application, pas une page web.**

Cette seule phrase explique presque tous les problèmes que rencontrent les gens.
SonicRoom s'exécute dans un navigateur, mais rien à l'intérieur ne se comporte
comme un article qu'on lit. Il n'y a pas de document à parcourir. Il y a des
barres d'outils, des listes et des boîtes de dialogue, et cela se pilote comme on
pilote un logiciel de bureau : **la tabulation passe d'une partie à l'autre, les
flèches se déplacent à l'intérieur d'une partie**.

Les lecteurs d'écran ne le savent pas tout seuls. Tels qu'ils sont livrés, NVDA,
JAWS, le Narrateur et Orca placent devant vous une _copie virtuelle_ de la page
et interceptent vos touches, si bien que `H` saute à un titre et `B` à un bouton.
C'est exactement ce qu'il faut sur un site d'actualité, et exactement ce qu'il ne
faut pas ici, car dans SonicRoom `M` coupe votre micro, `R` lance un
enregistrement et `W` vous dit qui vient de parler. Si votre lecteur d'écran
avale ces touches, elles n'atteindront jamais l'application.

La première chose à faire — avant même de rejoindre un salon — est donc de mettre
votre lecteur d'écran dans le mode où l'application reçoit vos frappes. Chaque
lecteur d'écran l'appelle autrement. La section suivante explique comment.

Si vous ne retenez qu'une chose : **quand une lettre seule ne fait rien, c'est
que vous êtes dans le mauvais mode.**

---

# Régler votre lecteur d'écran

## NVDA

NVDA appelle ses deux modes **mode navigation** et **mode formulaire**.

- Le mode navigation est le mode de lecture. Les lettres seules sont des
  commandes de déplacement et n'atteignent jamais la page.
- Le mode formulaire transmet chaque frappe directement à l'application. C'est ce
  mode-là qu'il faut à SonicRoom.

**On bascule avec `NVDA` + `Espace`.** Vous entendez un son grave et bref en
entrant en mode formulaire, et un son plus aigu en revenant au mode navigation.
Certaines voix annoncent aussi « mode formulaire » et « mode navigation ».

NVDA passe déjà tout seul en mode formulaire quand vous arrivez sur une zone
d'édition ou un contrôle du même genre, donc vous y serez souvent sans l'avoir
demandé. Ce qu'il ne fera **pas** tout seul, c'est basculer quand vous êtes posé
sur un simple bouton — et c'est justement le moment où vous voulez appuyer sur
`M` ou `R`. Appuyez sur `NVDA` + `Espace` et restez en mode formulaire pendant
tout l'appel.

Si vous voulez que NVDA soit plus zélé, ouvrez **menu NVDA → Préférences →
Paramètres → Mode navigation** (ou appuyez sur `NVDA` + `Ctrl` + `B`) et activez
_Passage automatique en mode formulaire au changement du focus_ et _Passage
automatique en mode formulaire au déplacement du curseur_.

## JAWS

JAWS appelle son mode de lecture le **curseur virtuel** (parfois « curseur
virtuel PC ») et son mode de transmission le **mode formulaire**.

**Ce qui est recommandé pour SonicRoom, c'est de désactiver complètement le
curseur virtuel : appuyez sur `touche JAWS` + `Z`** (la touche JAWS est `Insert`
par défaut, ou `Verr. Maj` en disposition portable). JAWS annonce « curseur
virtuel PC désactivé ». À partir de là, toutes vos touches vont à SonicRoom.

Vous _pouvez_ vous reposer sur le mode formulaire automatique — JAWS y entre
quand vous appuyez sur `Entrée` sur un contrôle et en sort avec le `+` du pavé
numérique. Cela fonctionne, mais deux choses vous gênent ici : les commandes à
une lettre de SonicRoom ne sont pas attachées à des contrôles de formulaire, donc
le mode formulaire automatique ne se déclenchera pas pour elles ; et SonicRoom se
sert d'`Échap` pour de vraies actions (fermer le chat, fermer une boîte de
dialogue, arrêter un fichier en cours de lecture), touche que le mode formulaire
peut intercepter.

Désactiver le curseur virtuel avec `touche JAWS` + `Z` évite les deux problèmes.
Réappuyez dessus pour le retrouver en quittant l'appel.

## Narrateur (Windows)

Le Narrateur appelle son mode de lecture le **mode Scan**. **Désactivez-le** avec
`Verr. Maj` + `Espace`. Le Narrateur annonce « Scan désactivé ». Le mode Scan
désactivé, la tabulation et les flèches se comportent comme le décrit ce manuel
et les lettres seules atteignent l'application.

## VoiceOver (macOS)

Le piège équivalent sous VoiceOver s'appelle la **Navigation rapide**. Quand elle
est activée, les flèches sont des commandes VoiceOver et n'atteignent jamais la
page.

**Désactivez-la en appuyant simultanément sur les flèches gauche et droite.**
VoiceOver annonce « Navigation rapide désactivée ».

Ensuite :

- `Tab` et `Maj` + `Tab` passent d'une partie de l'application à l'autre.
- Les flèches se déplacent dans une barre d'outils ou une liste, comme décrit
  plus bas.
- Les lettres seules (`M`, `A`, `R`, `W`…) atteignent SonicRoom tant que le focus
  clavier n'est pas dans un champ de texte.

`VO` dans les raccourcis signifie `Contrôle` + `Option`. Il vous faudra
peut-être `VO` + `Maj` + `Flèche bas` pour interagir avec le groupe de contenu web
avant que VoiceOver ne suive le focus dans l'application.

## Orca (Linux)

Orca dispose d'un **mode navigation** et d'un **mode focus** dans le contenu web,
comme NVDA. Orca bascule tout seul en mode focus sur les contrôles de
formulaire ; pour basculer à la main, appuyez sur `modificateur Orca` + `A` (le
modificateur Orca est `Insert` en disposition bureau et `Verr. Maj` en
disposition portable).

## iPhone, iPad et Android

SonicRoom fonctionne avec VoiceOver et TalkBack, et tous les boutons, listes et
dialogues sont étiquetés. Les raccourcis à une lettre demandent un clavier
physique : sur un écran tactile, servez-vous des boutons — tout ce que fait un
raccourci a un bouton quelque part dans la barre d'outils ou la liste des
participants.

Deux choses diffèrent sous iOS : Safari ne sait pas afficher la vidéo en plein
écran (l'application le dit à voix haute plutôt que de laisser un bouton mort),
et le moteur audio ne démarre qu'après une première touche sur l'écran, ce dont
SonicRoom se charge à votre premier appui.

## Un test de dix secondes

Rejoignez un salon tout seul, assurez-vous que le focus n'est **pas** dans la
zone de chat, et appuyez sur `M`. Si vous entendez le son de coupure micro et
« Micro coupé », vous êtes prêt. Si votre lecteur d'écran parle d'un titre, d'une
liste ou dit « pas d'élément suivant », vous êtes encore en mode lecture :
revenez en arrière et basculez.

---

# Comment le clavier fonctionne partout dans SonicRoom

Trois règles couvrent toute l'application.

**1. La tabulation passe d'une partie à l'autre. Les flèches se déplacent à
l'intérieur d'une partie.**

Une barre d'outils de onze boutons est **un seul** arrêt de tabulation, pas onze.
Une liste de vingt participants est un seul arrêt. C'est délibéré : vous
traversez toute l'application en cinq ou six tabulations au lieu de quarante, et
c'est ainsi que fonctionnent les logiciels de bureau depuis toujours. Cela veut
aussi dire qu'appuyer sur `Tab` dans une barre d'outils ne vous emmène **pas** au
bouton suivant : c'est la `Flèche droite` qui le fait.

**2. Barres d'outils : `Flèche gauche` et `Flèche droite`.**

SonicRoom a deux barres d'outils, toutes deux en bas de l'appel : les commandes
audio (toujours) et les commandes vidéo (appels vidéo seulement). Dans l'une
comme dans l'autre :

| Touche               | Effet                                                  |
| -------------------- | ------------------------------------------------------ |
| `Flèche droite`      | Bouton suivant (revient au premier après le dernier)   |
| `Flèche gauche`      | Bouton précédent (revient au dernier avant le premier) |
| `Début`              | Premier bouton                                         |
| `Fin`                | Dernier bouton                                         |
| `Entrée` ou `Espace` | Actionner le bouton où vous êtes                       |
| `Tab`                | Sortir complètement de la barre d'outils               |

**3. Listes : `Flèche haut` et `Flèche bas`, puis `Entrée`.**

La liste des participants, l'historique du chat, la liste des salons publics dans
le hall et l'explorateur de fichiers du serveur sont toutes des listes du même
type :

| Touche                       | Effet                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `Flèche bas` / `Flèche haut` | Élément suivant / précédent                                             |
| `Début` / `Fin`              | Premier / dernier élément                                               |
| `Entrée` ou `Espace`         | Ouvrir ou activer l'élément                                             |
| `Échap` ou `Retour arrière`  | Revenir d'un niveau (options d'un participant, explorateur de fichiers) |

Votre lecteur d'écran annonce chaque élément au fur et à mesure, avec son état :
micro coupé, en train de parler, partage sa vidéo, etc.

**Les curseurs de réglage** (votre niveau de micro, le volume de quelqu'un
d'autre) se trouvent dans la liste des options d'un participant. Sur un curseur,
la `Flèche gauche` et la `Flèche droite` changent la valeur et annoncent le
nouveau pourcentage ; `Début` et `Fin` vont au minimum et au maximum. Les flèches
haut et bas gardent leur rôle habituel : passer à l'option suivante.

**`Échap` ferme les choses.** Le panneau de chat, les réglages audio, les
réglages de diffusion, le sélecteur de source audio, la zone de clé d'API, le
lecteur de fichier et le plein écran vidéo se ferment tous avec `Échap`, et le
focus retourne au contrôle depuis lequel vous les aviez ouverts. Seule exception :
la boîte « quelqu'un veut entrer », à laquelle il faut répondre.

---

# Le hall

Le hall est le premier écran. C'est un formulaire ordinaire, donc vous pouvez le
lire en mode navigation si vous préférez — mais la liste des salons publics a
besoin des flèches, donc le mode formulaire reste plus commode.

Dans l'ordre, de haut en bas :

1. **Langue** — une liste déroulante. En changer réétiquette tout
   immédiatement, dans le hall comme en appel, sans rechargement.
2. **Nom du salon** — lettres, chiffres, traits d'union et tirets bas, jusqu'à 64
   caractères. Tout le reste est retiré au fil de la frappe. Si personne n'est
   dans un salon de ce nom, le taper le crée.
3. **Type de salon** — deux boutons radio, **Appel audio** et **Appel vidéo**.
   L'audio est toujours la valeur par défaut. On choisit avec les flèches. Ce
   choix est définitif pour toute la vie du salon, et il décide si des caméras
   existent, tout simplement.
4. **Arrière-plan vidéo** — n'apparaît que si vous avez choisi _Appel vidéo_.
   Voir [Appels vidéo](#appels-video).
5. **Nom affiché** — le nom que tout le monde entendra quand vous entrez, parlez
   ou envoyez un message.
6. **Salons publics** — la liste des salons actuellement ouverts à tous, avec qui
   se trouve dans chacun. Affichée seulement s'il en existe au moins un. Allez
   sur un salon avec les flèches et appuyez sur `Entrée` : son nom est rempli
   pour vous et le focus revient au nom affiché, il ne vous reste qu'à taper
   votre nom.
7. **Niveau du micro** — un bouton **Tester**, un curseur de **niveau du micro**
   et un vumètre en direct. Appuyez sur Tester : vous vous entendez (utilisez un
   casque) et votre lecteur d'écran vous signale les passages entre _silencieux_,
   _faible_, _correct_ et _élevé_. Montez le curseur jusqu'à ce qu'il annonce
   correct. Ce niveau est repris dans l'appel. Cela vaut la peine de le faire une
   fois : énormément de micros d'ordinateur portable sont beaucoup trop faibles
   d'origine.
8. **Désactiver le P2P** — une case à cocher. À deux, SonicRoom vous relie
   normalement en direct. Cochez ceci pour toujours passer par le serveur. Presque
   personne n'en a besoin.
9. **Rendre ce salon public** — une case à cocher. Le salon est listé
   publiquement et les règles de « frapper à la porte » et de vote d'exclusion
   décrites plus bas s'appliquent. Dès que quelqu'un rend un salon public, il le
   reste jusqu'à ce que tout le monde soit parti ; décocher la case ensuite n'y
   change rien.
10. **Rejoindre sans microphone** — une case à cocher. Vous écoutez et utilisez le
    chat écrit, et le navigateur ne demande jamais l'autorisation du micro. Si
    vous n'avez pas de micro, ou si vous refusez l'autorisation, vous vous
    retrouvez de toute façon dans ce mode.
11. **Rejoindre le salon** — le bouton de validation. `Entrée` depuis n'importe
    quel champ de texte fonctionne aussi.

---

# Le salon, partie par partie

## En-tête

Annonce le nom du salon et le nom de cette instance de SonicRoom, puis les
badges qui s'appliquent — **VIDÉO** pour un appel vidéo, **REC** pendant
l'enregistrement, **LIVE** pendant une diffusion vers l'extérieur —, puis le
nombre de personnes présentes, puis le bouton **chat** (dont le nom porte aussi
le nombre de messages non lus), et enfin la liste déroulante de langue.

## Liste des participants

Le cœur de l'application. C'est **une** liste qui contient **vous d'abord, puis
tous les autres**, puis une ligne pour chaque chose supplémentaire envoyée dans
le salon : un diffuseur de musique, le son d'un écran partagé, un fichier que
quelqu'un diffuse, un micro supplémentaire.

Chaque ligne se lit comme le nom de la personne suivi de ce qui est vrai à cet
instant, par exemple :

> Ana (vous), micro coupé, partage sa vidéo, appuyez sur Entrée pour ouvrir les
> options de ce participant

Les fragments possibles sont : _vous_, _texte seulement_ (a rejoint sans micro),
_micro coupé_, _parle_, _partage sa vidéo_, _partage son écran_, _épinglé_,
_coupé par vous_, et un décompte de voix quand un vote d'exclusion est en cours
contre cette personne.

Appuyez sur `Entrée` sur une ligne pour ouvrir les options de cette personne.
Cela remplace la liste par une seconde liste, et `Échap` ou `Retour arrière` vous
ramène.

## Options d'un participant

Ce que vous y trouvez dépend de la ligne que vous avez ouverte.

**Sur votre propre ligne :**

- **Votre niveau de micro** — un curseur. `Gauche`/`Droite` pour changer,
  `Début`/`Fin` pour le minimum et le maximum. C'est un gain appliqué avant que
  votre voix ne quitte votre machine : cela change donc ce que tout le monde
  entend.
- **Décrire ma vidéo** et **Épingler ma vidéo** — appels vidéo uniquement.

**Sur la ligne de quelqu'un d'autre :**

- **Volume de _nom_** — un curseur. Ne change que ce que _vous_ entendez.
- **Couper _nom_ pour moi** / **Réactiver _nom_ pour moi** — la personne est
  muette pour vous seul. Elle n'en est pas informée. L'intitulé bascule pour dire
  ce que fera le prochain appui.
- **Épingler la vidéo de _nom_** / **Épingler l'écran de _nom_** — appels vidéo
  uniquement, et c'est purement un changement sur votre écran ; la personne
  épinglée n'en sait jamais rien.
- **Décrire la vidéo de _nom_** / **Décrire l'écran de _nom_** — appels vidéo
  uniquement. Voir [Appels vidéo](#appels-video).
- **Exclure _nom_** — uniquement dans les salons publics à trois personnes ou
  plus. Voir
  [Salons publics, frapper à la porte et voter](#salons-publics-frapper-a-la-porte-et-voter).
- **Exclure le diffuseur** — retire une source qui diffuse de la musique.
- **Arrêter ce flux** — arrête un fichier partagé, le son d'un écran partagé ou
  un micro supplémentaire.

## Panneau de chat

Il s'ouvre avec le bouton chat de l'en-tête. Le panneau est disposé avec
**l'historique d'abord et la zone de saisie ensuite**, à dessein, pour que vous
arriviez sur ce qui a été dit et non sur un champ vide.

- La liste des messages est une liste : `Haut`/`Bas`, `Début`/`Fin`.
- `Ctrl` + `C` (ou `Cmd` + `C`) sur un message le copie.
- Dans la zone de saisie, `Entrée` envoie et `Maj` + `Entrée` insère un retour à
  la ligne.
- **Annoncer les nouveaux messages** est une liste déroulante dans l'en-tête du
  panneau, avec quatre réglages : _Poli_ (annoncé à la prochaine pause de votre
  lecteur d'écran), _Assertif_ (interrompt), _À voix haute_ (la voix du
  navigateur lui-même, pour qui n'utilise pas de lecteur d'écran) et _Désactivé_.
- `Échap` ferme le panneau et remet le focus sur le bouton chat.

Vous n'êtes pas obligé de laisser le panneau ouvert. Tout ce qui se passe dans le
salon est aussi écrit dans l'historique du chat en plus d'être annoncé, et `Alt`
plus un chiffre le relit d'où que vous soyez — voir
[Savoir ce qui se passe](#savoir-ce-qui-se-passe).

## La barre des commandes audio

En bas de la fenêtre. Un seul arrêt de tabulation ; `Gauche`/`Droite` pour la
parcourir. Dans l'ordre :

| Bouton                  | Raccourci   | Ce qu'il fait                                                                                                                   |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Couper le micro         | `M`         | Vous coupe et vous réactive. Désactivé, mais toujours lisible, si vous avez rejoint sans micro.                                 |
| Partager l'audio        | `A`         | Partage le son d'un écran ou d'un onglet. Le navigateur demande lequel, et il faut cocher sa case de partage du son.            |
| Diffuser de l'audio     | `F`         | Ouvre le sélecteur de source : un fichier de votre ordinateur, un lien, ou un fichier stocké sur le serveur.                    |
| Atténuation automatique | `D`         | Active ou désactive la baisse automatique de la musique quand quelqu'un parle, **pour tout le salon**.                          |
| Enregistrer l'appel     | `R`         | Démarre et arrête un enregistrement de tout le monde, côté serveur.                                                             |
| Télécharger             | —           | Apparaît dès qu'un enregistrement existe. Télécharge tout l'appel mixé.                                                         |
| Pistes                  | —           | Apparaît dès qu'un enregistrement existe. Télécharge un zip avec un fichier par personne, alignés et complétés à la même durée. |
| Diffusion en direct     | —           | Ouvre le panneau où vous saisissez les informations d'un serveur Icecast et lancez la diffusion de l'appel vers l'extérieur.    |
| Qui parle               | `W`         | Annonce qui parle en ce moment ou vient de parler, avec des numéros.                                                            |
| Notes partagées         | `Alt` + `N` | Ouvre le bloc-notes partagé du salon dans un nouvel onglet. Présent seulement si cette instance a la fonction configurée.       |
| Réglages audio          | —           | Choix du micro et des haut-parleurs, traitement de la voix, voix haute-fidélité, micros supplémentaires.                        |
| Quitter                 | —           | Quitte l'appel et revient au hall.                                                                                              |

## Pied de page

Un lien vers le projet SonicRoom, et le lien vers ce manuel.

---

# Tous les raccourcis clavier

Ils fonctionnent partout dans l'appel **tant que le focus clavier n'est pas dans
une zone de texte** et que votre lecteur d'écran laisse passer les touches. Ils
sont suspendus tant qu'une boîte « quelqu'un veut entrer » est ouverte, car il
faut d'abord y répondre.

## Lettres seules

| Touche | Action                                                                |
| ------ | --------------------------------------------------------------------- |
| `M`    | Couper / réactiver votre micro                                        |
| `A`    | Démarrer / arrêter le partage du son d'un écran ou d'un onglet        |
| `F`    | Ouvrir le sélecteur « Diffuser de l'audio »                           |
| `D`    | Atténuation automatique activée / désactivée pour tout le salon       |
| `R`    | Démarrer / arrêter l'enregistrement                                   |
| `W`    | Qui parle — annonce les dernières personnes à avoir parlé, numérotées |
| `V`    | Caméra activée / désactivée — **appels vidéo uniquement**             |
| `E`    | Vidéo en plein écran — **appels vidéo uniquement**                    |

`V` et `E` ne font rien dans un appel audio : ces lettres y restent libres.

## Avec Alt

Sur un Mac, `Alt` désigne la touche **Option** (celle à côté de Commande) : tout
ce qui suit fonctionne de la même façon avec elle, et l'application y nomme ces
raccourcis « Option ».

| Touche                                     | Action                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Alt` + `1` … `Alt` + `9`                  | Relit les derniers messages. `1` est le plus récent, `2` le précédent, et ainsi de suite.     |
| `Alt` + `0`                                | Relit le dixième message le plus récent.                                                      |
| Le même `Alt` + chiffre deux fois de suite | Copie ce message dans le presse-papiers.                                                      |
| `Alt` + `N`                                | Ouvre les notes partagées du salon dans un nouvel onglet.                                     |
| `Ctrl` + `Maj` + `M`                       | Coupe les micros de tout le monde : **salons modérés seulement**, et si vous y êtes autorisé. |

La relecture `Alt` + chiffre est le seul jeu de raccourcis qui **fonctionne aussi
pendant que vous tapez dans la zone de chat**, et il marche que le panneau soit
ouvert ou fermé. Il lit les touches numériques physiques : **cela fonctionne donc
en AZERTY**, où les chiffres demandent normalement la touche Maj, comme sur
n'importe quelle autre disposition.

## Navigation et fermeture

| Touche                                  | Action                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| `Tab` / `Maj` + `Tab`                   | D'une partie de l'application à l'autre                   |
| `Gauche` / `Droite`                     | Parcourir une barre d'outils ; régler un curseur          |
| `Haut` / `Bas`                          | Parcourir une liste                                       |
| `Début` / `Fin`                         | Premier / dernier ; minimum / maximum                     |
| `Entrée` / `Espace`                     | Activer ce sur quoi vous êtes                             |
| `Échap`                                 | Fermer le panneau, la boîte de dialogue ou le plein écran |
| `Retour arrière`                        | Sortir des options ; remonter d'un dossier                |
| `Entrée` dans la zone de saisie         | Envoyer                                                   |
| `Maj` + `Entrée` dans la zone de saisie | Retour à la ligne                                         |
| `Ctrl` / `Cmd` + `C` sur un message     | Le copier                                                 |

---

# Savoir ce qui se passe {#savoir-ce-qui-se-passe}

SonicRoom est bâti autour d'une règle : **tout ce qui est annoncé au salon peut
être relu ensuite.**

Chaque événement du salon — quelqu'un est arrivé, quelqu'un a coupé son micro, un
enregistrement a commencé, un fichier s'est lancé, quelqu'un a été exclu — est
annoncé par une région active _et_ écrit dans l'historique du chat comme message
système. Rien n'est annoncé une fois puis perdu. Si votre lecteur d'écran était
occupé, si vous étiez en train de taper, ou si cela vous a simplement échappé,
appuyez sur `Alt` + `1` et remontez le fil.

Trois choses sont annoncées mais volontairement _non_ écrites dans le chat, parce
qu'elles concernent votre vue à vous et non le salon : vos changements de volume
locaux, le fait de couper quelqu'un pour vous seul, et l'épinglage d'une vidéo.
Personne d'autre n'est concerné, elles n'ont donc rien à faire dans une chronologie
partagée.

**Signaux sonores.** De brefs sons accompagnent la coupure et la réactivation du
micro, l'arrivée et le départ de quelqu'un, un nouveau message, le début et la
fin d'un partage, quelqu'un qui frappe à la porte, et une caméra qui s'allume ou
s'éteint. Ils sont locaux — le salon ne les entend jamais — et sont conçus pour
se distinguer de la parole.

**« Qui parle » (`W`).** Les voix vont et viennent, et un lecteur d'écran ne peut
pas les suivre. Appuyez sur `W` et SonicRoom nomme les personnes qui parlent ou
viennent de parler, numérotées « 1. Ana, 2. Luis, 3. Marta », de la plus récente
à la plus ancienne. Les mêmes numéros apparaissent brièvement sur leurs vignettes,
donc une personne voyante à côté de vous voit la même liste.

---

# Parler et écouter

**Coupez-vous** avec `M`, ou le premier bouton de la barre. La coupure ne touche
que votre voix. Si vous diffusez par ailleurs un fichier, le son d'un écran
partagé ou des micros supplémentaires, tout cela continue : on les arrête en les
arrêtant, pas en se coupant.

**Votre propre niveau** est le curseur de votre ligne dans la liste des
participants, ainsi que celui du hall. Montez-le si on vous dit qu'on vous entend
mal.

**Le niveau de quelqu'un d'autre** est le curseur de _sa_ ligne dans la liste des
participants. Celui-là ne change que ce que vous entendez.

**L'atténuation automatique (`D`)** fait baisser la musique dès que quelqu'un
parle et la fait remonter quand il s'arrête. Elle est active par défaut et
s'applique à tout le salon : la désactiver la désactive pour tout le monde.
Annoncé dans les deux sens.

**Les réglages audio** (l'engrenage de la barre) contiennent :

- **Microphone** et **Haut-parleurs** — des listes déroulantes de périphériques.
  Les changements s'appliquent immédiatement, en plein appel, et sont mémorisés.
  Les noms des périphériques n'apparaissent qu'une fois l'autorisation du micro
  accordée.
- **Traitement de la voix** — annulation d'écho, réduction de bruit et mise à
  niveau automatique. Actif par défaut. Désactivez-le si vous envoyez de la
  musique ou jouez d'un instrument, car il vous contrariera.
- **Voix haute-fidélité (stéréo)** — envoie de la stéréo à un débit plus élevé.
  Inactif par défaut, car la plupart des micros sont mono et cela coûte de la
  bande passante à tous les autres. Cela s'applique à votre **prochain** appel,
  pas à celui en cours.
- **Micros supplémentaires à diffuser** — une liste de cases à cocher, une par
  périphérique d'entrée autre que votre micro principal, chacune avec une paire
  de boutons radio **Mono** / **Stéréo**. Cochez-en un et il est envoyé dans le
  salon comme un flux à part entière, à côté de votre voix, et apparaît comme une
  ligne à lui dans la liste des participants de chacun. C'est ainsi qu'on envoie
  une table de mixage, un instrument ou un câble audio virtuel. Vous couper ne
  les coupe pas ; pour les arrêter, décochez-les.

---

# Envoyer du son dans le salon

## Son d'un écran ou d'un onglet (`A`)

Appuyez sur `A` : le navigateur ouvre son propre sélecteur — une boîte de
dialogue du système, pas de SonicRoom, que votre lecteur d'écran traite donc
comme une fenêtre séparée. Choisissez un écran, une fenêtre ou un onglet **et
cochez la case qui partage son son** ; sans cette case, le partage est muet.
Chrome et Edge s'en sortent le mieux ; la prise en charge du partage du son
système par Firefox est limitée ou absente selon la plateforme.

Le son partagé contourne le traitement et le limiteur de votre micro, pour que la
musique garde sa dynamique. Dans un appel audio, l'image est jetée et seul le son
est envoyé. `A` de nouveau arrête le partage.

## Un fichier, un lien ou un fichier du serveur (`F`)

`F` ouvre la boîte **Diffuser de l'audio**, qui propose trois sources :

- **Choisir sur l'ordinateur** — un sélecteur de fichiers.
- **URL audio** — une zone d'édition. Collez n'importe quel lien public : un MP3
  direct, une radio en ligne, ou une page d'un site de vidéo ou de musique, dont
  le serveur extrait le son pour vous.
- **Fichiers du serveur** — une arborescence de dossiers audio stockés sur le
  serveur. Parcourez-la avec les flèches, `Entrée` sur un dossier pour y entrer,
  `Entrée` sur un fichier pour le lire, `Retour arrière` pour remonter d'un
  dossier. Les noms longs sont tronqués visuellement mais lus en entier.

Dès que quelque chose est lancé, une petite fenêtre **Diffusion de fichier**
apparaît et le focus se pose sur son bouton lecture/pause : `Espace` met donc en
pause immédiatement. Elle a aussi un curseur **votre volume**, qui ne change que
votre propre écoute — le salon entend toujours le fichier à plein niveau — et un
bouton d'arrêt. `Échap` n'importe où dans cette fenêtre arrête la diffusion et la
ferme.

Réappuyer sur `F` pendant une lecture rouvre le sélecteur et permet de changer de
source sans relancer la diffusion.

---

# Enregistrer et diffuser en direct

**L'enregistrement (`R`)** se fait sur le serveur : il capture donc tout le monde
en pleine qualité, quoi que fasse votre machine. Le démarrage et l'arrêt sont
annoncés à tout le salon et un badge **REC** apparaît dans l'en-tête — personne
n'est enregistré sans en être averti.

Dès qu'un enregistrement existe, deux boutons de plus apparaissent dans la
barre :

- **Télécharger** — tout l'appel mixé en un seul fichier. Vous pouvez l'utiliser
  pendant que l'enregistrement tourne encore : il télécharge tout ce qui a été
  capté jusque-là et l'enregistrement continue.
- **Pistes** — un zip avec un fichier par personne, chacun complété et aligné
  dans le temps pour qu'ils se superposent une fois déposés dans un éditeur
  audio.

Dans un appel vidéo, le téléchargement de l'appel entier est un fichier vidéo
avec toutes les caméras et tous les écrans en grille ; dans un appel audio, c'est
un fichier audio, comme toujours.

**La diffusion en direct** (le bouton radio de la barre) envoie tout l'appel mixé
vers un serveur Icecast que vous indiquez. Le panneau demande l'hôte, le port, le
point de montage, l'utilisateur, le mot de passe, le format et le débit, et les
mémorise dans ce navigateur. Ces informations ne sont jamais montrées au reste du
salon : tout ce qu'il reçoit, c'est un badge **LIVE** et l'annonce que la
diffusion a commencé, et par qui.

---

# Appels vidéo {#appels-video}

Un salon n'est un appel vidéo que s'il a été créé comme tel — le bouton radio
**Appel vidéo** dans le hall, sur lequel on ne peut plus revenir ensuite. Dans un
appel audio, rien de tout cela n'existe : pas de caméra, pas de `V`, pas de `E`,
et partager votre écran n'envoie toujours que son son.

**Tout le monde entre caméra éteinte**, à chaque fois. Rien n'allume votre caméra
sauf vous.

- **`V`** allume et éteint votre caméra. Tout le monde en est informé, à voix
  haute et dans l'historique du chat.
- **`E`** fait occuper tout l'écran à la zone vidéo ; `E` de nouveau ou `Échap`
  en sort. Annoncé dans les deux sens. Sous Safari iOS, qui ne connaît pas le
  plein écran d'un élément de page, SonicRoom le dit au lieu de ne rien faire.
- **L'épinglage** fait remplir la zone vidéo par une caméra ou un écran, pour vous
  seul. C'est dans les options de chaque participant (« Épingler la vidéo de
  _nom_ »), ce n'est signalé à personne, et la personne épinglée n'en est pas
  informée. Si elle éteint sa caméra, l'épinglage est conservé et attend : on vous
  dit qu'il attend, et on vous le redit quand l'image revient.

**L'aide au cadrage du visage** est le bouton situé à côté de celui de la caméra,
actif par défaut. Pendant que votre caméra est allumée, SonicRoom observe votre
propre image et énonce de courtes corrections — « déplacez-vous vers votre
droite », « montez », « vous êtes bien cadré », « votre visage n'est pas visible
dans le cadre » — sur une région active assertive, pour qu'elles interrompent au
lieu de s'empiler. Les directions sont données de votre point de vue, pas de
celui de l'image. La même indication est répétée toutes les trois secondes tant
qu'elle reste valable, « bien cadré » est dit une fois quand vous y êtes, puis
c'est le silence. Coupez-la avec le même bouton une fois que vous avez fini de
vous placer.

**« Décrire la vidéo de _nom_ »** se trouve dans les options de chaque
participant, y compris les vôtres. Cela prend une seule image et demande à Claude
de la décrire en quelques phrases, en lisant le texte visible, dans la langue où
est réglée l'interface. La description est consignée dans le chat comme tout le
reste, donc `Alt` + `1` la relit.

Cela demande **votre propre clé d'API Claude**, saisie avec le bouton clé de la
barre vidéo. Elle est conservée uniquement dans ce navigateur et la requête part
de votre navigateur directement vers Claude : elle ne passe jamais par le serveur
SonicRoom.

**Les arrière-plans vidéo** se choisissent dans le **hall**, sous le bouton radio
_Appel vidéo_, et jamais pendant l'appel — ainsi l'image est fixée avant que quoi
que ce soit ne parte. Les choix sont : aucun arrière-plan, flou, l'une des six
images fournies, ou une image à vous. Tout se fait dans votre navigateur : le
salon ne reçoit jamais que l'image finie, jamais votre véritable environnement. Si
votre navigateur n'en est pas capable, SonicRoom le dit à voix haute et envoie
votre caméra telle quelle plutôt que d'échouer en silence.

---

# Salons publics, frapper à la porte et voter {#salons-publics-frapper-a-la-porte-et-voter}

**Il n'y a ni modérateurs ni propriétaire dans un salon ordinaire de
SonicRoom.** Personne ne peut exclure qui que ce soit tout seul. En échange, les
salons publics ont deux règles collectives. (Les **salons modérés**, qui ont des
administrateurs, sont autre chose : voir le chapitre suivant.)

**Frapper à la porte.** Quand un salon est public et que quelqu'un de nouveau
demande à entrer, tous ceux qui sont déjà là entendent des coups frappés et
reçoivent une boîte de dialogue nommant la personne, avec les boutons
**Autoriser** et **Refuser** (et **Tout autoriser** / **Tout refuser** quand
plusieurs attendent). Le focus va droit au premier bouton Autoriser, et la
tabulation tourne en boucle dans la boîte. On ne peut pas la fermer avec `Échap` :
c'est la seule boîte à laquelle il faut répondre. N'importe qui peut répondre ;
c'est la première réponse qui compte. Refuser quelqu'un lui interdit aussi de
revenir dans ce salon.

Pendant ce temps, la personne qui frappe entend « En attente que quelqu'un dans
le salon vous laisse entrer… » et dispose d'un bouton Annuler.

**Voter pour exclure.** Uniquement dans les salons publics, et uniquement à
**trois personnes ou plus**. En dessous de trois, l'option n'est même pas
proposée : elle ne peut donc jamais servir à une personne contre une autre. Le
seuil est _au moins la moitié_, la personne concernée comprise : 2 voix sur 3, 2
sur 4, 3 sur 5.

L'option est dans la liste des options de chaque participant. Son intitulé porte
le décompte en cours — « Exclure Ana (2 voix) » — et chaque vote et chaque retrait
est annoncé à tout le salon, avec les noms. La choisir de nouveau retire votre
voix. Comme le seuil dépend du nombre de personnes présentes, un départ peut être
ce qui fait basculer un vote déjà entamé.

---

# Salons modérés (avec administrateurs) {#salons-moderes-avec-administrateurs}

En plus des salons privés et publics, qui n'ont pas de modérateurs, vous pouvez
créer un **salon modéré** : un salon avec des **administrateurs**, pensé pour
les émissions et débats avec présentateur, où quelqu'un doit pouvoir couper le
micro de la personne qui a oublié de le faire ou exclure un troll sur-le-champ.
Tout ce qui suit n'existe que dans ce type de salon ; un salon ordinaire ne
change en rien.

**Le créer.** Dans le vestibule, cochez **« Options d'administrateur »**. Un
groupe nommé **« Privilèges des participants »** se déplie, avec une case
(« Autoriser plusieurs administrateurs ») et une liste déroulante par action :
enregistrer, partager l'audio, diffuser de l'audio, activer ou désactiver
l'atténuation automatique, diffuser en direct, approuver les nouveaux
participants, utiliser le chat, ouvrir les notes partagées, couper le micro
d'un participant pour tous, couper les micros de tout le monde et exclure. Pour chacune vous choisissez
**Administrateurs seulement**, **Tout le monde** ou **Personne** (exclure propose
aussi **par vote**). La dernière case masque le lien « Propulsé par SonicRoom »
dans le salon. Ces choix sont fixés à la création du salon et ne changent plus
tant qu'il existe ; le navigateur retient votre dernière configuration pour la
prochaine fois.

**Qui est administrateur.** La personne qui crée le salon. Si vous avez
autorisé plusieurs administrateurs, les options de chaque participant
comprennent **« Nommer administrateur »** (et **« Retirer administrateur »**
pour l'annuler). Les administrateurs portent le mot « administrateur » dans leur
ligne de la liste. Si vous rechargez ou perdez la connexion, vous retrouvez le
rôle en revenant.

**Si tous les administrateurs partent** alors qu'il reste des gens, le salon
**cesse d'être modéré** : c'est annoncé à tout le monde (« Le dernier
administrateur est parti : ce salon n'est plus modéré »), chacun retrouve tous
les boutons, le chat rouvre et le salon continue comme un salon privé ou public
ordinaire jusqu'à sa fin. Personne n'est nommé à leur place, et un ancien
administrateur qui revient entre comme simple participant. Si vous voulez que le
salon survive à votre absence avec ses règles intactes, nommez un second
administrateur avant de partir.

**La porte.** Dans un salon modéré, les nouveaux venus frappent **toujours** à
la porte, salon public ou non. Le réglage « Approuver les nouveaux participants »
décide qui entend les coups et reçoit le dialogue Autoriser / Refuser : les
administrateurs seulement, ou tout le monde. Les administrateurs entrent sans
frapper.

**Couper le micro de quelqu'un pour tous.** Dans les options du participant :
**« Couper le micro pour tous »**. Son micro est coupé pour tout le salon et on
lui dit qui l'a fait. C'est une coupure _douce_ : la personne peut réactiver son
micro avec `M` quand elle veut parler (ce qui règle le classique « on t'entend
parler avec ta voisine » sans lever la main). Dans la barre de contrôles, qui y
est autorisé voit aussi **« Couper les micros de tout le monde »**, qui fait la
même chose à tous les autres d'un coup. Son raccourci est `Ctrl` + `Maj` + `M` :
un accord de trois touches, exprès, pour qu'on ne le déclenche pas par erreur à
côté du `M`. Il n'existe que dans un salon modéré ; ailleurs, le navigateur garde
cette combinaison.

**Exclure.** Selon le réglage : les administrateurs (ou tout le monde) excluent
directement depuis les options du participant avec **« Exclure du salon »**,
sans vote ; ou bien le salon vote comme un salon public (avec **au moins trois**
votants éligibles ; si seuls les administrateurs votent, seuls eux comptent).
Personne ne peut s'exclure soi-même. Un administrateur ne peut être coupé ou
exclu que par un autre administrateur.

**Ce que vous ne pouvez pas faire n'apparaît pas.** Si votre rôle n'autorise pas
d'enregistrer, de partager ou diffuser de l'audio, de changer l'atténuation, de
diffuser en direct ou d'écrire dans le chat, ce bouton n'est pas dans la barre
et la lettre correspondante (`R`, `A`, `F`, `D`) répond « Vous ne pouvez pas
faire cela dans ce salon ». Le panneau de chat s'ouvre quand même si vous ne
pouvez pas écrire, car toutes les annonces continuent d'y arriver. Il en va de
même des boutons **Télécharger** et **Pistes** d'un enregistrement : ils
n'apparaissent que pour les personnes autorisées à enregistrer — les autres
entendent bien que l'appel est enregistré et voient le badge **REC**, mais le
fichier ne leur est jamais remis. Une personne nommée administrateur alors qu'un
enregistrement réservé aux administrateurs existe est prévenue qu'elle peut
désormais le télécharger.

Le salon porte le badge **MOD** dans l'en-tête, et à l'entrée il est annoncé
comme modéré, avec le nom des administrateurs. Chaque changement (nominations,
coupures de micro, exclusions) est annoncé et consigné dans le chat.

## Salons réservés (un salon qu'on vous a attribué à l'avance)

Normalement un salon n'existe que tant que quelqu'un s'y trouve, et c'est la
première personne arrivée qui le crée. C'est un problème quand vous annoncez
un lien à l'avance : n'importe qui pourrait ouvrir « votre » salon avant vous
et en devenir l'administrateur, ou le salon modéré pourrait tout simplement
disparaître dès qu'il se vide. Un **salon réservé** règle cela. L'opérateur de
l'instance réserve un nom de salon pour vous et vous donne **deux liens** :

- le **lien d'hôte**, qui contient une clé secrète. Gardez-le pour vous ;
  quiconque ouvre le salon avec ce lien en est l'**administrateur**, à chaque
  fois, même après être parti et revenu ;
- le **lien public**, l'adresse normale du salon, celle que vous annoncez.

Tant que vous n'avez pas ouvert le salon avec le lien d'hôte, toute personne
qui suit le lien public entend « Ce salon est réservé et son hôte ne l'a pas
encore ouvert » et attend sur cet écran ; elle entre automatiquement dès votre
arrivée (puis frappe à la porte comme quiconque rejoint un salon modéré, donc
c'est vous qui décidez qui entre). Un salon réservé est toujours un salon
modéré, avec les privilèges des participants fixés par l'opérateur lors de la
réservation, et il **reste modéré** en votre absence : personne ne peut se
l'approprier, et vous revenez en administrateur.

Votre navigateur retient la clé pour cet onglet : vous pouvez recharger la page
ou passer par le hall pour donner votre nom sans la perdre, et elle est retirée
de la barre d'adresse immédiatement pour qu'un lien copié ne la contienne
jamais. Si vous perdez le lien d'hôte, demandez-en un nouveau à l'opérateur
(l'ancien cesse de fonctionner).

---

# Notes partagées

Si cette instance de SonicRoom a les notes configurées, la barre comporte un
bouton **Notes partagées**, et `Alt` + `N` fait la même chose. Cela ouvre un
unique bloc-notes collaboratif pour le salon **dans un nouvel onglet du
navigateur** — jamais dans un cadre à l'intérieur de l'appel, votre lecteur
d'écran a donc affaire à un document éditable tout à fait ordinaire.

Le premier appui crée la note ; celui de tous les autres ouvre la même, et son
existence est annoncée et consignée dans le chat avec le lien. Revenez à l'onglet
SonicRoom et l'appel est toujours en cours.

---

# Options à mettre dans la barre d'adresse

Tout ce qui suit le `?` dans un lien de salon règle une option, et plusieurs
peuvent être combinées avec `&`.

| Option             | Effet                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `?displayName=Ana` | Rejoint sous ce nom, sans passer par le hall                                                              |
| `?video=on`        | En fait un appel vidéo                                                                                    |
| `?public=true`     | Rend le salon public                                                                                      |
| `?mic=off`         | Rejoint sans micro : écoute et chat seulement                                                             |
| `?p2p=off`         | Passe toujours par le serveur, même à deux                                                                |
| `?lang=fr`         | Force la langue de l'interface (`en`, `es`, `fr`)                                                         |
| `?ios=on`          | Force le chemin audio iOS sur n'importe quel navigateur (contournement pour des problèmes de son tenaces) |
| `?host=…`          | Ouvre un salon réservé en tant qu'hôte (voir « Salons réservés ») ; retiré de la barre d'adresse aussitôt |

Par exemple, un lien qui dépose quelqu'un directement dans un appel vidéo en
français sous le nom « Ana » :

```
https://votre-instance.example/room/studio?video=on&lang=fr&displayName=Ana
```

---

# Quand quelque chose ne marche pas

**Une lettre seule n'écrit rien et ne fait rien.**
Votre lecteur d'écran est en mode lecture et avale la touche. `NVDA` + `Espace`,
`touche JAWS` + `Z`, `Verr. Maj` + `Espace` pour le Narrateur, ou désactivez la
navigation rapide sous VoiceOver. C'est de très loin le problème le plus fréquent.

**La lettre s'écrit dans la zone de chat.**
Le focus est dans la zone de saisie. C'est voulu : il faut bien pouvoir taper la
lettre M dans un message. Appuyez sur `Échap` pour fermer le chat, ou sortez de
la zone avec la tabulation, puis réessayez. `Alt` + chiffre est le seul raccourci
qui fonctionne encore depuis la zone de saisie.

**La tabulation ne m'emmène pas au bouton suivant de la barre.**
Ce n'est pas son rôle. Toute la barre est un seul arrêt ; utilisez la `Flèche
droite`. La tabulation sort de la barre.

**`Alt` + un chiffre dit « Aucun message 1 ».**
Rien n'a encore été dit dans le salon. Les événements du salon comptent comme des
messages : la première arrivée le remplira.

**Je n'entends personne.**
Vérifiez la liste **Haut-parleurs** dans les réglages audio : les navigateurs ne
suivent pas toujours le périphérique par défaut du système. Vérifiez ensuite que
vous n'avez pas coupé cette personne pour vous : sa ligne dirait « coupé par
vous ».

**On me dit qu'on m'entend très mal.**
Montez **votre niveau de micro** dans votre propre ligne de la liste des
participants, ou servez-vous du bouton Tester du hall, qui annonce la plage de
niveau au fur et à mesure du réglage.

**Mon micro supplémentaire n'a pas démarré.**
SonicRoom demande exactement ce périphérique-là plutôt que d'accepter un
remplaçant : s'il est occupé par un autre logiciel ou débranché, cela échoue au
lieu d'envoyer discrètement votre micro principal en double. Fermez ce qui
occupait le périphérique et recochez-le.

**Je partage un écran et il n'y a pas de son.**
La case audio de la boîte de partage du navigateur n'a pas été cochée. Cette
boîte appartient au navigateur, pas à SonicRoom. Essayez Chrome ou Edge si le
vôtre ne propose même pas l'option.

**« Décrire la vidéo » me demande d'ajouter une clé d'API.**
Cette fonction utilise votre propre clé d'API Claude, saisie avec le bouton clé
de la barre vidéo. Elle n'est conservée que dans ce navigateur.

---

# Référence clavier sur une page

| Touche                                  | Action                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `M`                                     | Couper / réactiver le micro                                     |
| `A`                                     | Partager / arrêter de partager le son d'un écran ou d'un onglet |
| `F`                                     | Diffuser de l'audio : ouvre le sélecteur de source              |
| `D`                                     | Atténuation automatique (tout le salon)                         |
| `R`                                     | Démarrer / arrêter l'enregistrement                             |
| `W`                                     | Qui parle                                                       |
| `V`                                     | Caméra (appels vidéo)                                           |
| `E`                                     | Vidéo en plein écran (appels vidéo)                             |
| `Alt` + `1`…`9`, `0`                    | Relire les dix derniers messages, du plus récent au plus ancien |
| Le même `Alt` + chiffre deux fois       | Copier ce message                                               |
| `Alt` + `N`                             | Notes partagées dans un nouvel onglet                           |
| `Ctrl` + `Maj` + `M`                    | Couper tous les micros (salons modérés)                         |
| `Tab` / `Maj` + `Tab`                   | D'une partie de l'application à l'autre                         |
| `Gauche` / `Droite`                     | Parcourir une barre ; régler un curseur                         |
| `Haut` / `Bas`                          | Parcourir une liste                                             |
| `Début` / `Fin`                         | Premier / dernier ; minimum / maximum                           |
| `Entrée` / `Espace`                     | Activer                                                         |
| `Échap`                                 | Fermer un panneau, une boîte de dialogue ou le plein écran      |
| `Retour arrière`                        | Sortir des options ; remonter d'un dossier                      |
| `Entrée` dans la zone de saisie         | Envoyer                                                         |
| `Maj` + `Entrée` dans la zone de saisie | Retour à la ligne                                               |
| `Ctrl` / `Cmd` + `C` sur un message     | Le copier                                                       |
| `NVDA` + `Espace`                       | NVDA : mode navigation ↔ mode formulaire                        |
| `touche JAWS` + `Z`                     | JAWS : curseur virtuel désactivé / activé                       |
| `Verr. Maj` + `Espace`                  | Narrateur : mode Scan désactivé / activé                        |
| `Gauche` + `Droite` ensemble            | VoiceOver : navigation rapide désactivée / activée              |
| `modificateur Orca` + `A`               | Orca : mode navigation ↔ mode focus                             |
