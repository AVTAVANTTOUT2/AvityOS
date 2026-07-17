# Modèles systemd AvityOS

## Présentation

Ce répertoire fournit des **modèles** d’unités systemd pour exécuter sur Linux :

- **`avity-control-plane.service`** — API et moteur d’orchestration AvityOS (SQLite, missions, leases) ;
- **`avity-worker.service`** — agent d’exécution qui poll le control plane, prend des leases et lance les commandes dans un sandbox OS (Bubblewrap).

Ce sont des gabarits à adapter (placeholders) **avant** toute installation. Cette documentation ne déploie rien : elle ne crée pas d’utilisateur, n’écrit pas dans `/etc` et ne démarre aucun service.

## Distributions compatibles

Les unités ciblent les distributions Linux qui utilisent **systemd** (Debian, Ubuntu, Fedora, RHEL, Arch, etc.). La syntaxe a été vérifiée avec `systemd-analyze` lorsque l’outil est disponible. Aucune garantie n’est donnée pour toutes les variantes Linux ni pour les systèmes sans systemd.

## Prérequis

- Linux avec systemd
- **Node.js** `>= 22.5.0` (voir `engines` du dépôt) — binaire référencé par `__NODE_BINARY__`
- **pnpm** pour installer les dépendances et produire les builds
- **Git** (worktrees / clones utilisés par le control plane et le worker)
- **SQLite** via `node:sqlite` (intégré à Node ; aucun démon SQLite séparé)
- **Bubblewrap** (`bwrap`) pour l’isolation Linux des commandes du worker / des checks sandboxed
- **curl** (`/usr/bin/curl`) pour l’attente bornée du healthcheck dans `ExecStartPre` du worker

## Placeholders

Tous les placeholders utilisent la syntaxe `__NOM__`. Remplacez-les de façon cohérente dans les unités et les fichiers d’environnement avant installation.

| Placeholder | Rôle | Exemple |
|---|---|---|
| `__AVITY_USER__` | Utilisateur système non-root | `avityos` |
| `__AVITY_GROUP__` | Groupe principal du service | `avityos` |
| `__AVITY_ROOT__` | Racine du dépôt installé (code) | `/opt/avityos` |
| `__AVITY_DATA_DIR__` | Données durables (SQLite, token) | `/var/lib/avityos` |
| `__AVITY_WORKSPACE_ROOT__` | Racine des dépôts / workspaces traités | `/var/lib/avityos/workspaces` |
| `__NODE_BINARY__` | Binaire Node.js | `/usr/bin/node` |
| `__CONTROL_PLANE_ENTRYPOINT__` | JS compilé du control plane | `/opt/avityos/services/control-plane/dist/main.js` |
| `__WORKER_ENTRYPOINT__` | JS compilé du worker | `/opt/avityos/services/worker/dist/main.js` |
| `__CONTROL_PLANE_ENV_FILE__` | Fichier d’environnement du control plane | `/etc/avityos/control-plane.env` |
| `__WORKER_ENV_FILE__` | Fichier d’environnement du worker | `/etc/avityos/worker.env` |
| `__CONTROL_PLANE_HEALTH_URL__` | URL du healthcheck (sans token) | `http://127.0.0.1:7717/v1/health` |

Entrypoints réels produits par le build du dépôt :

- Control plane : `services/control-plane/dist/main.js` (`pnpm --filter @avityos/control-plane start` → `node dist/main.js`)
- Worker : `services/worker/dist/main.js` (`pnpm --filter @avityos/worker start` → `node dist/main.js`)

## Construction

Les services doivent lancer le **JavaScript compilé**, jamais un serveur de développement (`pnpm dev`, `tsx`, `nodemon`, etc.).

Depuis la racine du dépôt (après clonage sous `__AVITY_ROOT__`) :

```sh
pnpm install --frozen-lockfile
pnpm -r build
```

Vérification locale recommandée avant mise en service :

```sh
pnpm -r test
pnpm -r typecheck
```

Lancement manuel de référence (hors systemd), tel que documenté dans `docs/DEPLOYMENT.md` :

```sh
node services/control-plane/dist/main.js
node services/worker/dist/main.js
```

## Utilisateur dédié

AvityOS ne doit **pas** tourner en root : une compromission du control plane ou d’une commande exécutée par le worker aurait alors tous les droits de la machine.

Exemple de création d’un utilisateur système (ne pas exécuter depuis cette mission de gabarits ; à faire sur la machine cible) :

```sh
sudo useradd \
  --system \
  --create-home \
  --home-dir /var/lib/avityos \
  --shell /usr/sbin/nologin \
  avityos
```

Cette forme (`useradd --system --create-home --home-dir --shell`) est supportée sur les distributions courantes basées sur shadow-utils (Debian/Ubuntu, Fedora/RHEL, Arch). Sur certaines variantes, le shell « nologin » peut être `/sbin/nologin` ; vérifiez avec `command -v nologin` ou `ls /usr/sbin/nologin /sbin/nologin`.

Les unités utilisent `User=__AVITY_USER__` et `Group=__AVITY_GROUP__` (jamais `User=root`).

## Arborescence recommandée

| Chemin | Contenu |
|---|---|
| `/opt/avityos` | Code applicatif (`__AVITY_ROOT__`) — lecture pour le service |
| `/etc/avityos` | Configuration et secrets (`*.env`) — hors dépôt git |
| `/var/lib/avityos` | Données (`__AVITY_DATA_DIR__`) : SQLite, éventuel token généré |
| `/var/lib/avityos/workspaces` | Workspaces / clones Git (`__AVITY_WORKSPACE_ROOT__`) |

Distinguer clairement :

- **code** → `/opt/avityos`
- **configuration / secrets** → `/etc/avityos`
- **données** → `/var/lib/avityos`
- **workspaces** → `/var/lib/avityos/workspaces`

Ne stockez **pas** de secrets sous `/opt/avityos`.

## Permissions

Exemple restrictif (adaptez utilisateur/groupe) :

```sh
sudo mkdir -p /opt/avityos /etc/avityos /var/lib/avityos/workspaces
sudo chown -R root:avityos /opt/avityos
sudo chmod -R u=rwX,g=rX,o= /opt/avityos
sudo chown -R avityos:avityos /var/lib/avityos
sudo chmod -R u=rwX,g=,o= /var/lib/avityos
sudo chown root:avityos /etc/avityos
sudo chmod 750 /etc/avityos
sudo chown root:avityos /etc/avityos/*.env
sudo chmod 640 /etc/avityos/*.env
```

Le service (groupe `avityos`) doit pouvoir **lire** les fichiers d’environnement sans qu’ils soient world-readable. Préférez `chmod 600` si l’utilisateur du service est propriétaire du fichier, ou `640` + `root:avityos` comme ci-dessus.

## Préparation des fichiers d’environnement

```sh
sudo mkdir -p /etc/avityos
sudo cp deploy/systemd/control-plane.env.example \
  /etc/avityos/control-plane.env
sudo cp deploy/systemd/worker.env.example \
  /etc/avityos/worker.env
```

Remplacez **tous** les placeholders et valeurs `replace-with-…`. Protégez les fichiers (`chmod 600` ou `640` selon le modèle de propriété). **Ne committez jamais** les fichiers réels.

Variables réellement utilisées par le code (voir `.env.example` et les `main.ts`) :

**Control plane (obligatoires en production typique)** : `NODE_ENV`, `AVITY_DB_PATH`, `AVITY_HOST`, `AVITY_PORT`, `AVITY_API_TOKEN`

**Worker (obligatoires après enrollment)** : `NODE_ENV`, `AVITY_CONTROL_PLANE_URL`, `AVITY_WORKER_ID`, `AVITY_WORKER_TOKEN`

Port HTTP par défaut du control plane : **7717**. Healthcheck sans authentification : `GET /v1/health`.

Authentification worker ↔ control plane : en-têtes `x-worker-id` / `x-worker-token` (token renvoyé une seule fois à l’enrollment ; le serveur ne stocke qu’un hash).

## Installation des unités

1. Remplacez tous les placeholders dans les copies des unités.
2. Copiez vers systemd :

```sh
sudo cp deploy/systemd/avity-control-plane.service \
  /etc/systemd/system/
sudo cp deploy/systemd/avity-worker.service \
  /etc/systemd/system/
```

Les fichiers de ce dépôt restent des modèles : ne les installez pas tant que `__…__` n’a pas été remplacé.

## Validation

```sh
sudo systemd-analyze verify \
  /etc/systemd/system/avity-control-plane.service \
  /etc/systemd/system/avity-worker.service
```

## Rechargement

```sh
sudo systemctl daemon-reload
```

## Activation et démarrage

Vérifiez d’abord le control plane, puis le worker :

```sh
sudo systemctl enable --now avity-control-plane.service
curl --fail --silent http://127.0.0.1:7717/v1/health
sudo systemctl enable --now avity-worker.service
```

`After=` ordonne le démarrage mais **ne garantit pas** que l’API est prête ; le worker utilise `ExecStartPre` (curl, 6 tentatives, pause 5 s) contre `__CONTROL_PLANE_HEALTH_URL__`.

Le worker déclare `Wants=avity-control-plane.service` (et non `Requires=`) : il peut continuer à poller pendant un redémarrage du control plane et se reconnecte automatiquement.

## État

```sh
systemctl status avity-control-plane.service
systemctl status avity-worker.service
```

## Logs

Les unités envoient stdout/stderr à **journald** (`StandardOutput=journal`). Ne redirigez pas les logs vers le dépôt git.

```sh
journalctl -u avity-control-plane.service
journalctl -u avity-worker.service
journalctl -u avity-worker.service -f
```

Ne publiez pas de journaux non expurgés (tokens, clés provider, chemins sensibles).

## Redémarrage

```sh
sudo systemctl restart avity-control-plane.service
sudo systemctl restart avity-worker.service
```

## Arrêt

Arrêtez le worker **avant** le control plane :

```sh
sudo systemctl stop avity-worker.service
sudo systemctl stop avity-control-plane.service
```

## Mise à jour d’AvityOS

Procédure sûre (aucune commande destructive) :

1. Arrêter le worker : `sudo systemctl stop avity-worker.service`
2. Arrêter le control plane : `sudo systemctl stop avity-control-plane.service`
3. Sauvegarder la base SQLite (et fichiers `-wal` / `-shm` s’ils existent) hors de la zone de mise à jour
4. Mettre à jour le code sous `__AVITY_ROOT__` (git pull / artefact de release)
5. Installer les dépendances : `pnpm install --frozen-lockfile`
6. Reconstruire : `pnpm -r build`
7. Exécuter les tests pertinents : `pnpm -r test` (et `pnpm -r typecheck` si possible)
8. Vérifier les migrations : elles s’appliquent au démarrage du control plane (`schema_migrations` dans SQLite) — consulter les logs au relancement
9. Relancer le control plane : `sudo systemctl start avity-control-plane.service`
10. Vérifier le healthcheck : `curl --fail --silent http://127.0.0.1:7717/v1/health`
11. Relancer le worker : `sudo systemctl start avity-worker.service`
12. Consulter les logs : `journalctl -u avity-control-plane.service -u avity-worker.service -n 200`

## Désinstallation

```sh
sudo systemctl disable --now avity-worker.service
sudo systemctl disable --now avity-control-plane.service
sudo rm -f /etc/systemd/system/avity-worker.service \
  /etc/systemd/system/avity-control-plane.service
sudo systemctl daemon-reload
```

Conservez séparément `/var/lib/avityos` (données) et `/etc/avityos` (configuration). **Ne supprimez pas automatiquement** la base SQLite.

## Diagnostic

| Symptôme | Pistes |
|---|---|
| Unité invalide | `systemd-analyze verify …` ; placeholders non remplacés (`__…__` restants) |
| Placeholder non remplacé | `grep -R '__' /etc/systemd/system/avity-*.service /etc/avityos/` |
| Utilisateur inexistant | `getent passwd __AVITY_USER__` ; créer l’utilisateur système dédié |
| Permission refusée | propriétaire/mode de `__AVITY_DATA_DIR__`, workspaces, `*.env` (640/600) |
| Node introuvable | chemin `__NODE_BINARY__` ; `test -x __NODE_BINARY__` |
| Entrypoint absent | build manquant : `pnpm -r build` ; présence de `services/*/dist/main.js` |
| Fichier d’environnement illisible | `EnvironmentFile=` path, mode, groupe `avityos` |
| Base SQLite inaccessible | `AVITY_DB_PATH`, droits d’écriture sur le répertoire parent |
| Port déjà utilisé | `ss -ltnp \| grep 7717` ou équivalent ; changer `AVITY_PORT` |
| Healthcheck en échec | control plane down ; URL ; pare-feu local ; `journalctl -u avity-control-plane` |
| Worker en boucle de redémarrage | `StartLimit*` ; logs worker ; credentials enrollment ; URL control plane |
| Bubblewrap indisponible | installer `bubblewrap` ; le sandbox échoue sans `bwrap` sur Linux |
| Workspace non accessible | `ReadWritePaths=__AVITY_WORKSPACE_ROOT__` ; `repoPath` des projets sous ce préfixe |

## Sécurité

- Exécution **non-root** (`User=` / `Group=` dédiés)
- Permissions minimales sur code, données et `*.env`
- Secrets **hors** des unités `.service` (fichiers `EnvironmentFile` protégés)
- Logs via journald ; ne pas journaliser de tokens dans `ExecStartPre`
- Control plane lié à **127.0.0.1** par défaut (`AVITY_HOST`)
- Pare-feu / reverse proxy TLS obligatoire pour toute exposition réseau
- Tokens longs et aléatoires (`openssl rand -hex 32`) ; rotation après fuite
- Sauvegardes SQLite protégées (mêmes droits que les données)
- Prudence sur les workspaces : le worker y écrit via les leases ; limitez `__AVITY_WORKSPACE_ROOT__`
- Protections systemd : `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`, `UMask=0077`
- **Non utilisé** volontairement : `MemoryDenyWriteExecute` (peut casser le moteur JS de Node), `ProtectHome` (accès dépôts / home de service), `PrivateDevices` (non validé pour Git / CLI providers), `Restart=always` (préférer `on-failure`)
