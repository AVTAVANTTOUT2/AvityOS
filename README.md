# AvityOS

> Donnez un objectif logiciel. AvityOS organise le travail, exécute les
> missions, vérifie le résultat et prépare une livraison propre.

AvityOS est une plateforme **local-first** qui pilote des agents IA pour
réaliser des tâches de développement logiciel. Elle centralise les projets,
les décisions, les exécutions, les tests et les livraisons Git dans une seule
interface.

L’objectif est simple : permettre à une personne ou une équipe de décrire le
résultat attendu sans devoir coordonner manuellement plusieurs agents,
terminaux, branches et fournisseurs d’IA.

AvityOS est actuellement en version `0.1.0` et reste en développement actif.

## Pourquoi AvityOS ?

Utiliser plusieurs outils d’IA accélère le développement, mais crée aussi de
nouveaux problèmes : contexte dispersé, tâches dupliquées, changements non
testés, historique Git difficile à relire et supervision permanente.

AvityOS fournit un point de contrôle unique pour :

- transformer un objectif en plan de travail structuré ;
- distribuer les missions aux agents et modèles adaptés ;
- isoler les changements dans des branches et worktrees Git ;
- exécuter les builds, tests, vérifications de types et contrôles de sécurité ;
- corriger les échecs dans des boucles limitées ;
- préparer des commits et pull requests avec des preuves vérifiables ;
- conserver les décisions, événements et résultats après un redémarrage.

La priorité est donnée à la **qualité et à la traçabilité**, pas seulement à la
vitesse.

## Comment ça fonctionne ?

```text
Objectif
   ↓
Analyse du projet et questions éventuelles
   ↓
Plan versionné et missions ordonnées
   ↓
Exécution par les agents dans des espaces isolés
   ↓
Builds, tests, contrôles et revue indépendante
   ↓
Correction automatique si nécessaire
   ↓
Commit, pull request et rapport de livraison
```

1. Vous créez ou importez un projet et décrivez le résultat attendu.
2. AvityOS analyse le dépôt, les contraintes et les critères d’acceptation.
3. Si une décision importante manque, les questions sont regroupées en une
   seule clarification.
4. Le système produit un plan et un graphe de missions avec leurs dépendances.
5. Les agents exécutent chaque mission via le fournisseur IA autorisé.
6. Les changements sont validés par de vraies commandes et une revue distincte.
7. Le résultat validé est préparé pour GitHub ; les branches protégées ne sont
   jamais fusionnées automatiquement.

L’état du projet est stocké dans un moteur déterministe. Les modèles IA
réfléchissent et produisent du code, mais le control plane garde la maîtrise
des permissions, budgets, délais, reprises, dépendances et transitions d’état.

## Fonctionnalités principales

- **Gestion multi-projets** : plusieurs projets isolés peuvent avancer en
  parallèle sans partager leur mémoire ou leurs secrets.
- **Mémoire durable par projet** : objectifs, décisions, risques, plans,
  résultats et preuves restent disponibles après redémarrage.
- **Planification structurée** : découpage du travail en missions spécialisées
  pour le produit, l’architecture, le frontend, le backend, l’infrastructure,
  la sécurité, la QA, la revue et la documentation.
- **Plusieurs fournisseurs IA** : Codex CLI, Claude Code, Cursor CLI, OpenAI,
  Anthropic, DeepSeek, commande personnalisée et provider de test déterministe.
- **Exécution isolée** : worktrees Git, processus limités, sandboxes macOS ou
  Linux et workers locaux ou distants.
- **Validation réelle** : builds, tests, typecheck, critères d’acceptation,
  scans de sécurité et revue indépendante.
- **Correction et fallback** : nouvelle tentative contrôlée ou changement de
  fournisseur selon les règles du projet.
- **Workflow GitHub** : branches dédiées, commits atomiques, pull requests
  brouillon et historique vérifiable.
- **Supervision en direct** : projets, missions, agents, logs, terminaux,
  interventions, budgets et état GitHub depuis le Web, macOS ou la CLI.
- **Sécurité intégrée** : coffre de secrets chiffré, permissions explicites,
  masquage des secrets, TLS/mTLS, journal d’audit et actions dangereuses
  soumises à approbation.
- **Reprise après incident** : état persistant, checkpoints, sauvegarde et
  restauration certifiée.

## Cas d’utilisation

| Besoin | Exemple d’objectif | Ce qu’AvityOS orchestre |
| --- | --- | --- |
| Développer une fonctionnalité | « Ajouter une authentification par passkey avec tests » | Analyse, architecture, code, tests, revue et PR |
| Corriger un bug | « Corriger le panier vide sur mobile sans régression » | Reproduction, correctif ciblé, tests et validation |
| Moderniser un projet | « Migrer cette API vers Node.js 22 et mettre à jour la CI » | Inventaire, plan de migration, changements ordonnés et contrôles |
| Renforcer la qualité | « Ajouter les tests manquants sur le parcours de paiement » | Identification des risques, tests et rapport de couverture |
| Auditer la sécurité | « Vérifier les entrées utilisateur et corriger les failles critiques » | Analyse, corrections isolées, scans et revue indépendante |
| Maintenir plusieurs dépôts | « Mettre à jour la même convention de lint sur cinq projets » | Projets isolés, exécutions parallèles et suivi centralisé |
| Documenter une livraison | « Mettre à jour le guide d’installation et le changelog » | Analyse du code actuel, documentation et vérification des liens |

## Exemple concret

Un objectif utile indique le résultat attendu et la manière de le vérifier :

```text
Objectif : ajouter un mode sombre à l’application web.

Critères d’acceptation :
- le thème suit le réglage du système par défaut ;
- le choix manuel est conservé après rechargement ;
- les composants principaux restent accessibles ;
- les tests et la documentation sont à jour.
```

AvityOS peut alors créer les missions de conception, d’implémentation, de test
et de revue, les exécuter dans l’ordre requis et signaler uniquement les
décisions qui nécessitent réellement une intervention humaine.

Le même projet peut être créé en CLI :

```sh
node apps/cli/dist/main.js project create "Mode sombre" \
  --repo /chemin/absolu/vers/le-projet \
  --remote git@github.com:organisation/projet.git \
  --branch main \
  --objective "Ajouter un mode sombre accessible" \
  --criterion "Le thème suit le système par défaut" \
  --criterion "Le choix manuel est conservé" \
  --criterion "Les tests passent" \
  --autonomy autonomous_with_checkpoints
```

Commandes utiles pour suivre le travail :

```sh
node apps/cli/dist/main.js project list
node apps/cli/dist/main.js plan show <project-id>
node apps/cli/dist/main.js mission list <project-id>
node apps/cli/dist/main.js run list --project <project-id>
node apps/cli/dist/main.js intervention list
```

## Interfaces disponibles

- **Mission Control Web** : tableau de bord React pour piloter les projets,
  missions, agents, exécutions et interventions.
- **Application macOS** : client SwiftUI avec authentification Keychain,
  notifications, deep links, badge Dock et compagnon de barre des menus.
- **CLI `avity`** : cycle complet en terminal, avec sortie JSON pour les scripts
  et l’automatisation.

Toutes les interfaces utilisent le même control plane via REST et SSE.

## Architecture simplifiée

```text
 Web React/Vite       App macOS SwiftUI       CLI avity
        \                    |                   /
         +--------------- REST + SSE -----------+
                              |
                 Control plane Fastify
            orchestration + politiques + SQLite
                  /            |            \
         Providers IA       Git/worktrees    Workers
                  \            |            /
              Exécution, tests, revue et livraison
```

AvityOS fonctionne localement avec un workspace pnpm et une base SQLite. Des
workers authentifiés peuvent étendre l’exécution à d’autres machines.

## Stack technique

| Couche | Technologies principales |
| --- | --- |
| Web | React 18, TypeScript, Vite 6, Material UI, Radix UI, Tailwind CSS |
| macOS | Swift 5.9, SwiftUI, WebKit, Keychain, notifications natives |
| CLI | TypeScript, Node.js, sortie texte ou JSON |
| API et control plane | Node.js 22+, Fastify 5, REST, SSE |
| Données | SQLite avec WAL et migrations transactionnelles |
| Contrats | Zod, schémas partagés entre API, événements et clients |
| Orchestration | Machines à états, graphe de dépendances, scheduler déterministe |
| IA | Codex, Claude Code, Cursor, OpenAI, Anthropic, DeepSeek |
| Exécution | Git worktrees, subprocessus isolés, sandbox-exec, Bubblewrap, workers |
| Tests et qualité | Vitest, Playwright, XCTest, TypeScript strict, Gitleaks, SBOM SPDX |
| CI et livraison | GitHub Actions, commits conventionnels, pull requests brouillon |

## Démarrage rapide

### Prérequis

- macOS 14+ pour l’ensemble de la plateforme, ou Linux pour les services
  TypeScript ;
- Node.js `22.5` ou plus récent ;
- pnpm 11 ;
- Git ;
- Xcode 15+ uniquement pour l’application et les tests macOS.

### Installation

```sh
git clone https://github.com/AVTAVANTTOUT2/AvityOS.git
cd AvityOS
pnpm install --frozen-lockfile
pnpm verify
```

### Lancer la plateforme

Ouvrez deux terminaux :

```sh
# Terminal 1 — API sur http://127.0.0.1:7717
pnpm --filter @avityos/control-plane start
```

```sh
# Terminal 2 — interface sur http://localhost:5173
pnpm --filter @avityos/web dev
```

Services optionnels :

```sh
# Worker d’exécution
pnpm --filter @avityos/worker start

# Application macOS
cd apps/macos && swift run AvityOS
```

Copiez [`.env.example`](.env.example) uniquement si vous souhaitez modifier la
configuration par défaut. Ne placez jamais de clé réelle dans le dépôt : le
coffre chiffré `avity vault` est prévu pour les identifiants des providers.

Le provider `fake` permet de tester gratuitement et hors ligne le cycle
d’orchestration. Il valide le fonctionnement d’AvityOS, mais ne remplace pas un
provider IA réel pour développer un produit.

## Structure du dépôt

```text
apps/web                 Interface Mission Control React
apps/macos               Application native macOS
apps/cli                 CLI avity
services/control-plane   API, moteur d’orchestration et stockage SQLite
services/worker          Worker d’exécution local ou distant
packages/contracts       Schémas métier, API et événements
packages/orchestration   États, dépendances, scheduler et fallback
packages/providers       Adaptateurs des fournisseurs IA
packages/git             Opérations Git et worktrees sécurisés
packages/policy          Permissions, sandbox et masquage des secrets
packages/credential-vault Coffre chiffré des identifiants opérateur
packages/transport-security TLS et mTLS
docs                     Guides, architecture, sécurité et runbooks
deploy                   Exemples de services launchd et systemd
```

## Vérification

```sh
pnpm verify          # build + tests + typecheck strict
pnpm verify:full     # ajoute Playwright et les tests Swift
pnpm licenses:check  # inventaire et politique des licences
pnpm audit --audit-level high
```

## Documentation

- [Mode d’emploi complet](docs/MODE-D-EMPLOI.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Cycle de vie d’un projet](docs/PROJECT-LIFECYCLE.md)
- [Providers et fallback](docs/PROVIDER-ADAPTERS.md)
- [Sécurité](docs/SECURITY.md)
- [Développement local](docs/LOCAL-DEVELOPMENT.md)
- [Déploiement](docs/DEPLOYMENT.md)
- [Sauvegarde et restauration](docs/BACKUP-RESTORE.md)
- [Roadmap](docs/ROADMAP.md)
- [État des fonctionnalités et preuves](docs/TRACEABILITY.md)

## Limites importantes

AvityOS ne déploie pas silencieusement en production, n’achète pas de services,
n’élargit pas l’accès aux secrets et ne fusionne pas les branches protégées.
Les actions dangereuses ou irréversibles demandent une approbation selon la
politique du projet.

Les intégrations réelles nécessitent les identifiants fournis par l’opérateur.
L’état exact des fonctionnalités implémentées et des validations restantes est
maintenu dans [la matrice de traçabilité](docs/TRACEABILITY.md).
