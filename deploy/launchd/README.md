# Modèles launchd pour AvityOS (macOS)

Ce dossier fournit des **modèles** pour lancer automatiquement le control plane
et le worker AvityOS via LaunchAgents utilisateur.

Les fichiers `*.plist.example` **ne doivent pas** être chargés tels quels.
Remplacez d’abord tous les placeholders (`__AVITY_ROOT__`, `__AVITY_LOG_DIR__`,
`__HOME__`) par des chemins absolus valides, puis validez le XML avec `plutil`.

Cette documentation **n’installe rien automatiquement**. Aucun secret ne doit
être placé dans les plists ni commités dans le dépôt.

## Présentation

| Service | Label launchd | Script | Entrypoint de production |
| --- | --- | --- | --- |
| Control plane | `com.avityos.control-plane` | `run-control-plane.sh` | `services/control-plane/dist/main.js` |
| Worker | `com.avityos.worker` | `run-worker.sh` | `services/worker/dist/main.js` |

- Le **control plane** écoute par défaut sur `127.0.0.1:7717` (`AVITY_PORT`) et
  persiste SQLite via `AVITY_DB_PATH` (défaut applicatif : `~/.avity/avity.sqlite`).
- Le **worker** interroge le control plane (`AVITY_CONTROL_PLANE_URL`) et attend
  d’abord un healthcheck borné sur `/v1/health` avant de démarrer.
- Les deux services sont prévus pour un build de production (`node …/dist/main.js`),
  pas pour `pnpm dev`.

## Prérequis

- macOS (LaunchAgents)
- Node.js ≥ 22.5 (binaire absolu recommandé via `NODE_BINARY`)
- pnpm 11 pour construire le monorepo
- Git
- dépôt AvityOS déjà cloné et **déjà construit** (`pnpm -r build`)
- accès en écriture aux dossiers de config/logs/base SQLite
- terminal avec les permissions nécessaires pour lire les dépôts de travail
  (launchd n’accorde **pas** automatiquement les permissions TCC macOS)

## Construction du projet

Depuis la racine du dépôt :

```sh
pnpm install --frozen-lockfile
pnpm -r build
```

Vérifications utiles (recommandées avant activation durable) :

```sh
pnpm --filter @avityos/control-plane test
pnpm --filter @avityos/worker test
```

Les entrypoints attendus après build :

```text
services/control-plane/dist/main.js
services/worker/dist/main.js
```

Démarrage manuel de référence (hors launchd) :

```sh
pnpm --filter @avityos/control-plane start
pnpm --filter @avityos/worker start
```

## Préparation des dossiers

```sh
mkdir -p ~/.config/avityos
mkdir -p ~/.avity/logs
```

Adaptez si vous utilisez d’autres chemins absolus pour `AVITY_LOG_DIR` ou
`AVITY_DB_PATH`.

## Création des fichiers d’environnement

```sh
cp deploy/launchd/env.example ~/.config/avityos/control-plane.env
cp deploy/launchd/env.example ~/.config/avityos/worker.env
chmod 600 ~/.config/avityos/control-plane.env
chmod 600 ~/.config/avityos/worker.env
```

Éditez chaque fichier séparément : le control plane a besoin de `AVITY_PORT`,
`AVITY_DB_PATH`, `AVITY_API_TOKEN`, etc. ; le worker a besoin de
`AVITY_CONTROL_PLANE_URL`, `AVITY_WORKER_ID`, `AVITY_WORKER_TOKEN`, etc.

Renseignez aussi `AVITY_ROOT` et `NODE_BINARY` avec des **chemins absolus**.

Ne committez jamais ces fichiers `.env` réels.

Les scripts refusent de démarrer si le fichier est absent ou si ses permissions
laissent un accès au groupe ou aux autres utilisateurs. Corrigez avec :

```sh
chmod 600 ~/.config/avityos/control-plane.env
chmod 600 ~/.config/avityos/worker.env
```

## Remplacement des placeholders

Dans les copies destinées à `~/Library/LaunchAgents/`, remplacez explicitement :

| Placeholder | Exemple de valeur |
| --- | --- |
| `__AVITY_ROOT__` | `/absolute/path/to/AvityOS` |
| `__AVITY_LOG_DIR__` | `/Users/votre-utilisateur/.avity/logs` |
| `__HOME__` | `/Users/votre-utilisateur` |

Utilisez un remplacement ciblé (éditeur, `sed` sur une **copie temporaire**),
jamais un remplacement aveugle qui pourrait casser la structure XML du plist.

Exemple prudent :

```sh
AVITY_ROOT="/absolute/path/to/AvityOS"
AVITY_LOG_DIR="${HOME}/.avity/logs"

sed \
  -e "s|__AVITY_ROOT__|${AVITY_ROOT}|g" \
  -e "s|__AVITY_LOG_DIR__|${AVITY_LOG_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  deploy/launchd/com.avityos.control-plane.plist.example \
  > ~/Library/LaunchAgents/com.avityos.control-plane.plist

sed \
  -e "s|__AVITY_ROOT__|${AVITY_ROOT}|g" \
  -e "s|__AVITY_LOG_DIR__|${AVITY_LOG_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  deploy/launchd/com.avityos.worker.plist.example \
  > ~/Library/LaunchAgents/com.avityos.worker.plist
```

## Installation

Installation utilisateur typique :

```sh
mkdir -p ~/Library/LaunchAgents
```

Puis créez les plists installés (après remplacement des placeholders), par
exemple :

```sh
cp deploy/launchd/com.avityos.control-plane.plist.example \
  ~/Library/LaunchAgents/com.avityos.control-plane.plist
cp deploy/launchd/com.avityos.worker.plist.example \
  ~/Library/LaunchAgents/com.avityos.worker.plist
```

Remplacez les placeholders **avant** le chargement.

Rendez les scripts exécutables si besoin :

```sh
chmod +x deploy/launchd/run-control-plane.sh deploy/launchd/run-worker.sh
```

## Validation des plist

```sh
plutil -lint ~/Library/LaunchAgents/com.avityos.control-plane.plist
plutil -lint ~/Library/LaunchAgents/com.avityos.worker.plist
```

## Chargement

Préférez les commandes modernes `bootstrap` / `bootout` :

```sh
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.avityos.control-plane.plist
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.avityos.worker.plist
```

Chargez d’abord le control plane, puis le worker. Le script worker attend
`/v1/health` de façon bornée ; s’il expire, launchd pourra relancer plus tard
grâce à `KeepAlive` + `ThrottleInterval`.

## État des services

```sh
launchctl print gui/$(id -u)/com.avityos.control-plane
launchctl print gui/$(id -u)/com.avityos.worker
```

Healthcheck applicatif :

```sh
curl -fsS http://127.0.0.1:7717/v1/health
```

## Redémarrage

Procédure propre :

```sh
launchctl bootout gui/$(id -u)/com.avityos.worker
launchctl bootout gui/$(id -u)/com.avityos.control-plane

# modifier les plists / fichiers d’environnement si nécessaire
plutil -lint ~/Library/LaunchAgents/com.avityos.control-plane.plist
plutil -lint ~/Library/LaunchAgents/com.avityos.worker.plist

launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.avityos.control-plane.plist
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.avityos.worker.plist
```

## Logs

Les plists redirigent stdout/stderr hors du dépôt Git, typiquement vers :

```text
__AVITY_LOG_DIR__/control-plane.stdout.log
__AVITY_LOG_DIR__/control-plane.stderr.log
__AVITY_LOG_DIR__/worker.stdout.log
__AVITY_LOG_DIR__/worker.stderr.log
```

Exemples :

```sh
tail -f ~/.avity/logs/control-plane.stderr.log
tail -f ~/.avity/logs/worker.stderr.log
```

Les messages applicatifs Node (écoute HTTP, enrollment worker, erreurs de
démarrage) apparaissent dans ces flux. Les scripts ne journalisent jamais le
contenu des fichiers d’environnement.

## Désinstallation

```sh
launchctl bootout gui/$(id -u)/com.avityos.worker || true
launchctl bootout gui/$(id -u)/com.avityos.control-plane || true
rm -f ~/Library/LaunchAgents/com.avityos.worker.plist
rm -f ~/Library/LaunchAgents/com.avityos.control-plane.plist
```

Les logs (`~/.avity/logs`) et la base SQLite (`AVITY_DB_PATH`, souvent
`~/.avity/avity.sqlite`) sont **indépendants** : ne les supprimez pas
automatiquement lors de la désinstallation des LaunchAgents.

## Mise à jour d’AvityOS

Procédure sûre :

1. Arrêter les services (`launchctl bootout` worker puis control plane).
2. Sauvegarder la base SQLite (`AVITY_DB_PATH`).
3. Mettre à jour le dépôt (`git pull` sur la branche voulue).
4. Installer les dépendances (`pnpm install --frozen-lockfile`).
5. Reconstruire (`pnpm -r build`).
6. Exécuter les tests pertinents (`pnpm --filter @avityos/control-plane test`,
   `pnpm --filter @avityos/worker test`, ou `pnpm verify`).
7. Relancer les services (`launchctl bootstrap`).
8. Vérifier le healthcheck (`curl -fsS http://127.0.0.1:7717/v1/health`).

N’utilisez pas de commandes destructives (`rm` de la base, `git reset --hard`
non demandé, etc.).

## Diagnostic

| Symptôme | Pistes |
| --- | --- |
| Node introuvable | Définir `NODE_BINARY` en chemin absolu dans le fichier d’environnement ; le PATH interactif n’est pas disponible sous launchd. |
| Entrypoint compilé absent | Exécuter `pnpm -r build` et vérifier `services/*/dist/main.js`. |
| Fichier d’environnement absent | Créer `~/.config/avityos/*.env` à partir de `env.example`. |
| Permissions incorrectes | `chmod 600` sur les fichiers d’environnement ; les scripts refusent group/other. |
| Port déjà utilisé | Changer `AVITY_PORT` ou libérer le processus sur `7717`. |
| Control plane indisponible | Démarrer/diagnostiquer le control plane ; le worker échoue après `AVITY_HEALTH_MAX_ATTEMPTS`. |
| Worker en boucle de redémarrage | Lire `worker.stderr.log` ; vérifier tokens, URL, healthcheck ; `ThrottleInterval` limite la cadence. |
| Erreur de syntaxe plist | `plutil -lint` sur la copie installée après remplacement des placeholders. |
| Permissions macOS / TCC | Accorder manuellement l’accès aux dossiers/outils requis ; launchd ne les accorde pas automatiquement. |

## Sécurité

- Protégez les fichiers d’environnement avec `chmod 600`.
- Ne committez aucun secret (tokens, clés providers, cookies).
- N’exposez pas le control plane publiquement sans TLS/proxy et auth adaptés ;
  le défaut `AVITY_HOST=127.0.0.1` reste la posture recommandée.
- Utilisez des tokens aléatoires pour `AVITY_API_TOKEN` et `AVITY_WORKER_TOKEN`.
- Protégez les logs (ils peuvent contenir des chemins ou messages d’erreur).
- Ne lancez **pas** ces services en root ; LaunchAgents utilisateur suffisent.
- Ne stockez aucun secret dans les fichiers plist.
