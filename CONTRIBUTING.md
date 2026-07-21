# Contribuer à AvityOS

Merci de contribuer à AvityOS.

AvityOS est un projet **local-first** : le control plane, les données et l’orchestration
tournent en local, avec une intervention humaine uniquement quand une décision
l’exige vraiment. Les contributions doivent rester **ciblées**. La sécurité, la
traçabilité et la reproductibilité priment sur la vitesse.

Toute modification passe par une **branche dédiée** et une **pull request**.
Aucune fusion autonome d’une PR par son auteur.

Documentation complémentaire utile :

- [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md)
- [docs/TRACEABILITY.md](docs/TRACEABILITY.md)

---

## Prérequis

Valeurs exigées par le dépôt (`package.json`, CI, documentation locale) :

### Communs

- **Node.js ≥ 22.5.0** (le control plane utilise le module intégré `node:sqlite`)
- **pnpm 11** (version pinée : `pnpm@11.11.0` via `packageManager`)
- **Git**
- Un éditeur capable de travailler dans un monorepo TypeScript

Activer pnpm via Corepack si besoin :

```sh
corepack enable
```

### macOS

- **macOS 14+** pour l’application SwiftUI
- **Xcode 15+** ou les **Xcode Command Line Tools** avec le SDK macOS
- `sandbox-exec` (disponible sur macOS) pour le confinement des processus de checks

### Linux

- Stack TypeScript (control plane, worker, web, CLI, packages)
- **Bubblewrap** (`bwrap`) pour le confinement OS des checks exécutés par le worker
  et par le control plane en local ; sans Bubblewrap, le sandbox Linux échoue de
  façon fermée (`sandbox_unavailable`). Les tests unitaires hermétiques du
  command adapter (`@avityos/providers`) n’exigent pas Bubblewrap ; la suite
  complète `pnpm -r test` (y compris les E2E fixture control-plane) l’exige sur
  Linux, comme la CI (`ci-linux.yml`). Bubblewrap n’est **pas** requis sur macOS.

### Optionnels

- **SQLite CLI** (`sqlite3`) pour les opérations de sauvegarde / restauration
  documentées dans [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)
- Clients providers (Codex, Claude Code, Cursor, etc.) et credentials associés,
  uniquement pour des tests live hors CI standard
- `gh` pour les flux GitHub réels exercés par le moteur
- `gitleaks` en local (également exécuté en CI)

---

## Installation locale

```sh
git clone https://github.com/AVTAVANTTOUT2/AvityOS.git
cd AvityOS
pnpm install --frozen-lockfile
```

Utilisez `--frozen-lockfile` pour une installation reproductible alignée sur la CI.
Ne modifiez pas le lockfile lors d’une installation normale.

Les variables d’environnement se préparent à partir de [`.env.example`](.env.example).
Copiez uniquement ce dont vous avez besoin en local. **Ne committez jamais** de
fichier `.env` ni de secret.

Voir aussi [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md).

---

## Commandes de développement

Exécutez ces commandes depuis la racine du dépôt, sauf indication contraire.
Les scripts racine sont préférés lorsqu’ils existent.

### Build, tests et typecheck

| Commande | Rôle |
| --- | --- |
| `pnpm build` | Compile tous les packages et services TypeScript du workspace |
| `pnpm test` | Exécute les tests Vitest de chaque package/service |
| `pnpm typecheck` | Typecheck TypeScript strict sur tout le workspace |
| `pnpm verify` | Enchaîne build, tests et typecheck (validation locale standard) |
| `pnpm verify:full` | `pnpm verify` + E2E Playwright web + `swift test` (macOS) |

Pour un seul composant :

```sh
pnpm --filter @avityos/<nom> build
pnpm --filter @avityos/<nom> test
pnpm --filter @avityos/<nom> typecheck
```

Noms courants : `contracts`, `orchestration`, `providers`, `policy`, `git`,
`control-plane`, `worker`, `web`, `cli`.

Après modification d’un package dépendant, reconstruisez-le avant de tester les
consommateurs (`pnpm --filter <dep> build`) : les tests importent les artefacts
compilés du workspace.

### Tests E2E

| Commande | Rôle |
| --- | --- |
| `pnpm --filter @avityos/web test:e2e` | Parcours navigateur Playwright |
| `pnpm verify:full` | Suite complète incluant E2E web et tests Swift |

En CI, Chromium est installé via Playwright avant l’E2E. En local, installez le
navigateur si nécessaire :

```sh
pnpm --filter @avityos/web exec playwright install chromium
```

### Licences et audit de sécurité

| Commande | Rôle |
| --- | --- |
| `pnpm licenses:check` | Inventaire / politique de licences des dépendances installées |
| `pnpm audit --audit-level high` | Audit des vulnérabilités de dépendances (seuil high) |

### Application web

| Commande | Rôle |
| --- | --- |
| `pnpm dev` | Démarre le client Vite (`@avityos/web`) |
| `pnpm --filter @avityos/web dev` | Équivalent explicite |
| `pnpm --filter @avityos/web build` | Build de production Vite |
| `pnpm --filter @avityos/web test` | Tests unitaires Vitest du client |
| `pnpm --filter @avityos/web test:e2e` | Tests E2E Playwright |

L’UI affiche **Live**, **Hors ligne**, ou **Démo** (uniquement si
`VITE_AVITY_DEMO=1`).

### Control plane

| Commande | Rôle |
| --- | --- |
| `pnpm --filter @avityos/control-plane build` | Compile le service |
| `pnpm --filter @avityos/control-plane start` | Démarre l’API (défaut `127.0.0.1:7717`) |
| `pnpm --filter @avityos/control-plane test` | Tests du control plane |

Le script `start` exécute `node dist/main.js` : construisez d’abord le package
si `dist/` est absent.

### Worker

| Commande | Rôle |
| --- | --- |
| `pnpm --filter @avityos/worker build` | Compile le worker |
| `pnpm --filter @avityos/worker start` | Démarre le worker de terminaux / sous-processus |
| `pnpm --filter @avityos/worker test` | Tests du worker |

### CLI

| Commande | Rôle |
| --- | --- |
| `pnpm --filter @avityos/cli build` | Compile le binaire `avity` |
| `pnpm --filter @avityos/cli test` | Tests d’intégration CLI |
| `node apps/cli/dist/main.js doctor` | Vérifie l’environnement local |
| `node apps/cli/dist/main.js project create "Mon projet"` | Crée un projet |
| `node apps/cli/dist/main.js objective submit <project-id> "…" "critère"` | Soumet un objectif |

### Application macOS

Depuis `apps/macos` (macOS uniquement) :

| Commande | Rôle |
| --- | --- |
| `swift build` | Compile l’app SwiftUI |
| `swift test` | Exécute les tests XCTest |
| `swift run AvityOS` | Lance l’app contre le control plane local |

Démarrez le control plane avant l’app. Le packaging signé / notarié n’est pas
requis pour le développement local.

---

## Structure du dépôt

```
apps/                  Surfaces utilisateur
  web/                 Client React/Vite
  cli/                 Client en ligne de commande `avity`
  macos/               Application SwiftUI + companion menu bar
services/
  control-plane/       Orchestration durable (Fastify + SQLite)
  worker/              Exécution terminaux / sous-processus
packages/
  contracts/           Schémas zod : modèle, API, événements (référence)
  orchestration/       Machines d’état, DAG, scheduler, fallback
  providers/           Adaptateurs providers (fake, CLI, APIs)
  policy/              Moteur de politique, allowlists, redaction
  git/                 Opérations git/worktree sûres
docs/                  Architecture, sécurité, runbooks, ADR
.github/               Workflows CI
scripts/               Utilitaires (ex. inventaire de licences)
```

Placez le code au plus près de son bounded context. Les contrats partagés
vivent dans `packages/contracts`, pas en duplication dans les clients.

---

## Création d’une branche

Toujours partir du dernier état de `main` :

```sh
git checkout main
git pull origin main
git checkout -b <type>/<description-courte>
```

Préfixes recommandés :

| Préfixe | Usage |
| --- | --- |
| `feat/` | Nouvelle fonctionnalité |
| `fix/` | Correction de bug |
| `refactor/` | Refactoring sans changement de comportement voulu |
| `test/` | Ajout ou renforcement de tests |
| `docs/` | Documentation uniquement |
| `ci/` | Intégration continue |
| `chore/` | Maintenance diverse |
| `security/` | Correctif ou durcissement sécurité |
| `ops/` | Exploitation / runbooks opérationnels |
| `build/` | Build system / packaging |

Exemples : `feat/web-live-terminals`, `fix/control-plane-session-cookie`,
`docs/update-runbook`, `ci/linux-verification`.

---

## Règles de périmètre

Une pull request doit :

- traiter **un seul chantier** ;
- éviter les refactorings non nécessaires ;
- ne pas mélanger correction, formatage et nouvelle fonctionnalité ;
- limiter les fichiers modifiés au strict nécessaire ;
- annoncer explicitement les dépendances avec d’autres PR ;
- éviter les modifications générées inutiles (artefacts, lockfile hors sujet, etc.).

Ne modifiez pas un fichier uniquement pour le reformater en entier.

---

## Style des commits

Messages proches de [Conventional Commits](https://www.conventionalcommits.org/) :

```text
feat(web): display live terminal sessions
fix(api): validate project autonomy mode
test(macos): cover API model decoding
docs: update deployment guide
ci: add Linux verification workflow
```

Un seul commit ciblé suffit lorsqu’il couvre clairement le chantier. Plusieurs
commits restent utiles pour séparer des étapes indépendantes, sans obligation.

---

## Tests obligatoires

Chaque contributeur exécute les validations **pertinentes** pour son changement.

Checklist générique :

- [ ] Build du composant modifié
- [ ] Tests unitaires / d’intégration concernés
- [ ] Typecheck TypeScript (`pnpm typecheck` ou filtre équivalent)
- [ ] Tests E2E si l’UI ou un parcours utilisateur change
- [ ] `swift build` et `swift test` si l’application macOS change
- [ ] Vérification manuelle du comportement
- [ ] `git diff --check`

Interdit :

- désactiver un test pour obtenir une CI verte ;
- utiliser `continue-on-error` pour masquer une erreur ;
- remplacer une validation réelle par un faux mock sans justification ;
- déclarer un test exécuté s’il ne l’a pas été.

---

## Tests et données

- Ne jamais utiliser de credentials réels dans les tests.
- Ne jamais appeler un provider payant dans la suite standard ; le provider
  **fake** et les fixtures suffisent pour vérifier l’orchestration.
- Utiliser des fixtures minimales.
- Expurger les logs (secrets, tokens, contenus sensibles).
- Ne pas committer de base SQLite contenant des données personnelles.
- Supprimer les fichiers temporaires avant le commit.

---

## Contrats API

`packages/contracts` est la **référence** des échanges entre control plane,
worker, web, CLI et modèles wire macOS.

Lors d’un changement de contrat :

- mettez à jour les schémas zod **avant ou avec** les implémentations ;
- évitez de dupliquer manuellement les types TypeScript à côté des schémas ;
- ajoutez ou étendez les tests de compatibilité / validation ;
- documentez les changements incompatibles (et un bump de version de schéma
  lorsque pertinent) ;
- ne cassez pas silencieusement les clients web, CLI ou macOS.

Le client macOS maintient des structs Codable alignées sur le format wire ;
mettez-les à jour ensemble. Il n’existe pas aujourd’hui de génération
automatique complète de clients à partir des contrats.

---

## Base de données et migrations

Les migrations SQLite vivent dans `services/control-plane/src/db.ts` et sont
appliquées transactionnellement au démarrage.

Règles :

- migrations **append-only** ;
- **ne jamais réécrire** une migration déjà publiée / appliquée ;
- créer une **nouvelle** migration pour toute évolution de schéma ;
- conserver la compatibilité avec les bases existantes autant que possible ;
- prévoir sauvegarde et rollback (voir [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)) ;
- tester l’application de la migration sur une base temporaire
  (`AVITY_DB_PATH` pour isoler) ;
- ne pas committer une base de production ni `~/.avity/*.sqlite`.

---

## Sécurité

- Aucun secret dans Git.
- Aucun token dans les logs.
- Aucun cookie ou header d’authentification dans les captures d’écran / fixtures.
- Aucun fichier `.env` committé.
- Permissions minimales (principe du moindre privilège).
- Validation des entrées via les contrats partagés et les contrôles du control plane.
- Redaction des erreurs et détails sensibles.
- Prudence particulière pour les commandes shell, chemins de fichiers et dépôts
  externes (entrées non fiables).

Pour une vulnérabilité sensible : **n’ouvrez pas** une issue publique contenant
l’exploit, le secret ou un chemin de reproduction dangereux. Consultez
[docs/SECURITY.md](docs/SECURITY.md) pour le modèle de menace et les contrôles
existants, et signalez le problème de façon privée aux mainteneurs du dépôt
(par exemple via les canaux de sécurité du dépôt GitHub lorsqu’ils sont
configurés). Aucune adresse email ni programme de bug bounty n’est inventé ici.

---

## Pull requests

Une bonne PR contient :

1. **Objectif** — pourquoi ce changement existe
2. **Périmètre** — ce qui est inclus / exclu
3. **Résumé des changements** — faits, pas marketing
4. **Commandes exécutées** — liste honnête
5. **Preuves** — sorties, captures non sensibles, liens CI
6. **Risques** — régressions possibles
7. **Rollback** — comment revenir en arrière
8. **Migrations** — le cas échéant
9. **Dépendances** avec d’autres PR

La description doit être honnête sur :

- les tests non exécutés ;
- les limitations ;
- les comportements encore partiels ou fictifs ;
- les incertitudes restantes.

---

## Revue et fusion

- Une **revue humaine** est requise avant fusion.
- Un agent autonome **ne doit pas** fusionner sa propre PR.
- Une CI verte **ne remplace pas** la revue.
- Les commentaires de revue doivent être traités ou explicitement discutés.
- La branche doit être à jour avec `main` avant fusion lorsque nécessaire
  (rebase ou merge selon la pratique des mainteneurs).

Ne présumez pas qu’une protection de branche GitHub est active sans preuve
dans les paramètres du dépôt.

---

## Dépendances

- Toute nouvelle dépendance doit être justifiée dans la PR.
- Préférez la bibliothèque standard ou une dépendance déjà présente.
- Les licences doivent rester compatibles avec la politique du dépôt
  (`pnpm licenses:check`).
- Le lockfile (`pnpm-lock.yaml`) n’est mis à jour **que** lorsqu’une
  dépendance change réellement.
- Les mises à jour majeures exigent une revue attentive.
- N’ajoutez pas de mises à jour de dépendances « au passage » dans une PR
  sans rapport.

---

## Documentation

Mettez à jour la documentation lorsque le changement affecte :

- l’installation ;
- les variables d’environnement ;
- l’API / les contrats ;
- l’architecture ;
- la sécurité ;
- le déploiement ;
- les commandes ;
- le comportement utilisateur visible.

Le [CHANGELOG.md](CHANGELOG.md) doit recevoir une entrée sous `[Unreleased]`
pour toute modification notable destinée aux utilisateurs ou contributeurs.

---

## Checklist avant ouverture de PR

- [ ] Ma branche part du dernier état pertinent de `main`
- [ ] La PR couvre un seul chantier
- [ ] Aucun secret ou fichier local n’est inclus
- [ ] Les contrats ont été mis à jour si nécessaire
- [ ] Les migrations sont append-only
- [ ] Les tests pertinents ont été exécutés
- [ ] Le typecheck passe
- [ ] La documentation est à jour
- [ ] Le diff a été relu intégralement
- [ ] Les limites et tests non exécutés sont déclarés
- [ ] La PR attend une revue humaine
